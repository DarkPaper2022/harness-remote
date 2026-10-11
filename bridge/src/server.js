import http from "node:http"
import { readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { selectableAcpModelValue } from "./agent-model-catalog.js"
import { AcpPromptEchoFilter } from "./acp-prompt-echo-filter.js"
import { AcpService } from "./acp-service.js"
import { harnessProfile } from "./harness-profiles.js"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, writeJSON } from "./http-policy.js"

const ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 15 * 1024 * 1024
const MAX_MESSAGE_PAGE = 500

/**
 * Claude's ACP adapter can leave the service bookkeeping flag active after the visible turn has
 * stopped producing protocol traffic. The prompt watchdog itself gives up after 300s, so this
 * reporting grace is deliberately longer: it cannot make a legitimately active Claude turn idle
 * before the transport would already consider that turn stale.
 */
export const CLAUDE_REPORTED_BUSY_STALE_MS = 360_000

/**
 * Correct only Claude's public presentation status. Internal AcpService busy state remains untouched
 * because it also protects queueing, transcript merge and cache semantics.
 *
 * The previous version also trusted the bridge's Session activity timestamp. That timestamp is
 * deliberately refreshed by generic session.updated events, including reconciliation work, so a
 * historical Session could look "recent" forever even though Claude had no prompt in flight. For
 * Claude the live transport request is the narrow corroboration signal we actually need: if there is
 * no pending session/prompt, a leftover busy flag is stale presentation state and must read idle.
 */
export function corroborateClaudeSessionStatus(status, sessionID, pendingRequests, _lastActivityAt, now = Date.now()) {
  if (!status || status.type !== "busy") return status
  const prompts = (Array.isArray(pendingRequests) ? pendingRequests : []).filter(
    (pending) => pending?.method === "session/prompt" && pending.sessionID === sessionID
  )
  if (prompts.length === 0) return { ...status, type: "idle" }

  let newestProtocolActivity = 0
  for (const pending of prompts) {
    if (!Number.isFinite(pending.idleMs)) continue
    newestProtocolActivity = Math.max(newestProtocolActivity, now - Math.max(0, pending.idleMs))
  }
  if (newestProtocolActivity && now - newestProtocolActivity >= CLAUDE_REPORTED_BUSY_STALE_MS) {
    return { ...status, type: "idle" }
  }
  return status
}

/** base64 carries 3 bytes per 4 characters, so measure it rather than decoding megabytes to count them. */
function base64ByteLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length / 4) * 3 - padding
}

function attachmentPayload(url) {
  const match = typeof url === "string" ? /^data:[^;,]+;base64,(.+)$/s.exec(url) : null
  if (!match) throw new Error("An attachment must be a base64 data URL")
  return match[1]
}

/**
 * Attachments are validated before the prompt reaches the agent: a mime type the harness
 * cannot read, or a payload large enough to stall the turn, is a client mistake worth
 * naming rather than a failure to discover mid-stream.
 */
function parseAttachments(parts) {
  const files = (Array.isArray(parts) ? parts : []).filter((part) => part?.type === "file")
  if (files.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per prompt`)
  let total = 0
  return files.map((file) => {
    const mime = typeof file.mime === "string" ? file.mime.toLowerCase() : ""
    if (!ATTACHMENT_MIME_TYPES.has(mime)) {
      throw new Error(`Unsupported attachment type ${mime || "unknown"}: accepted types are image/png, image/jpeg, image/webp and image/gif`)
    }
    const data = attachmentPayload(file.url)
    if (base64ByteLength(data) > MAX_ATTACHMENT_BYTES) throw new Error("Each attachment must stay under 5MB")
    total += base64ByteLength(data)
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error("Attachments must stay under 15MB in total")
    return { mime, filename: typeof file.filename === "string" ? file.filename : "attachment", data }
  })
}

async function readBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 25_000_000) throw new Error("Request body is too large")
  }
  return body ? JSON.parse(body) : {}
}

function writeSSE(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * The daemon no longer depends on a configured `--root` to know where work happens. Project roots
 * are learned from the working directories of the Sessions the harnesses already reported, so the
 * boundary check has to accept those dynamic roots alongside any explicitly configured ones.
 */
async function allowedDirectory(candidate, config, extraRoots) {
  const resolved = await realpath(candidate)
  const configured = config.roots.length ? config.roots : [process.cwd()]
  const learned = typeof extraRoots === "function" ? await extraRoots() : extraRoots
  const candidates = [...configured, ...(Array.isArray(learned) ? learned : [])]
  const roots = (await Promise.all(candidates.map((root) => realpath(root).catch(() => undefined)))).filter(Boolean)
  if (!roots.some((root) => resolved === root || !path.relative(root, resolved).startsWith(`..${path.sep}`) && path.relative(root, resolved) !== "..")) {
    throw new Error("Directory is outside the configured --root boundary")
  }
  return resolved
}

function modelWireName(model) {
  if (!model) return undefined
  const modelID = model.modelID ?? model.id
  return model.providerID && modelID ? `${model.providerID}/${modelID}` : undefined
}

/**
 * The default recent-activity window is an operator setting; a single request may still ask for the
 * whole history (`?all=1`) or a different window (`?days=30`, `?days=0` for everything). Rejecting a
 * malformed value keeps a typo from silently widening the result to the entire journal.
 */
function requestedWindowMs(url, defaultWindowMs) {
  const days = url.searchParams.get("days")
  if (days !== null && days.trim() !== "") {
    const parsed = Number(days)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Session days must be a non-negative number")
    return parsed > 0 ? parsed * 24 * 60 * 60 * 1000 : 0
  }
  const all = (url.searchParams.get("all") ?? "").toLowerCase()
  if (all === "1" || all === "true" || all === "yes") return 0
  return defaultWindowMs
}

function sameListedDirectory(left, right) {
  if (!left || !right) return false
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function listedSessionView(session, status, liveUpdatedAt = 0) {
  const listedUpdated = Date.parse(session.updatedAt ?? "")
  const listedTimestamp = Number.isFinite(listedUpdated) ? listedUpdated : 0
  const timestamp = Math.max(listedTimestamp, liveUpdatedAt)
  return {
    id: session.sessionId,
    title: session.title || `Session ${String(session.sessionId).slice(0, 8)}`,
    directory: session.cwd,
    time: { created: timestamp, updated: timestamp },
    summary: { additions: 0, deletions: 0, files: 0 },
    model: undefined,
    status
  }
}

function messageLimit(url) {
  const raw = url.searchParams.get("limit")
  if (raw === null || raw === "") return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error("Message limit must be a positive integer")
  return Math.min(value, MAX_MESSAGE_PAGE)
}

/**
 * The app's model API is OpenCode's, which names a model `provider/model`. ACP has no such rule:
 * OMP and PI happen to use that shape, while Claude Code's adapter offers bare ids, `sonnet`,
 * `opus[1m]`. Splitting on "/" and requiring both halves silently dropped every one of them, which
 * is why that backend looked like it exposed no models at all.
 *
 * A bare id is presented under the backend's own name instead, so it reads and behaves like the
 * others, `claude/sonnet`. `AcpService.setModel` puts it back to the id the agent knows.
 */
function providersResponse(models, fallbackProviderID) {
  const providers = new Map()
  const defaults = {}
  const modelOption = { options: models }
  for (const option of models) {
    const value = selectableAcpModelValue(option.value, modelOption, fallbackProviderID)
    const separator = value.indexOf("/")
    const flat = separator <= 0
    const providerID = flat ? fallbackProviderID : value.slice(0, separator)
    const modelID = flat ? value : value.slice(separator + 1)
    if (!providerID || !modelID) continue
    const provider = providers.get(providerID) ?? { id: providerID, name: providerID, models: {} }
    provider.models[modelID] = {
      id: modelID,
      name: option.name ?? modelID,
      description: option.description || undefined,
      status: "active"
    }
    providers.set(providerID, provider)
    if (option.currentValue) defaults[providerID] = modelID
  }
  return { providers: [...providers.values()], default: defaults }
}

export function createBridgeServer({ config, acp, serviceOptions, machineRegistry, dynamicRoots }) {
  const backend = config.backend ?? "omp"
  const profile = harnessProfile(backend)
  const historyLoader = serviceOptions?.historyLoader
  // A default recent-activity window keeps a years-old journal from being replayed into the app on
  // every launch. `0` disables it entirely, which is what the direct `createBridgeServer` tests and
  // an operator who wants the whole history both need. A per-request `?days=`/`?all=` overrides it.
  const sessionWindowDays = Number(config.sessionDays)
  const defaultWindowMs = Number.isFinite(sessionWindowDays) && sessionWindowDays > 0 ? sessionWindowDays * 24 * 60 * 60 * 1000 : 0
  const cacheTtlMs = Number.isFinite(Number(config.sessionCacheTtlMs)) ? Math.max(0, Number(config.sessionCacheTtlMs)) : 3_000
  const serviceAcp = new AcpPromptEchoFilter(acp)
  const service = new AcpService(serviceAcp, {
    ...serviceOptions,
    actionProviders: profile.actionProviders,
    preferListedTitles: profile.preferListedTitles,
    nativeRenameCommand: profile.nativeRenameCommand,
    journalPageWhileOwned: profile.journalPageWhileOwned !== false,
    modelVariantConfigIDs: profile.modelVariantConfigIDs ?? []
  })
  const hiddenSessionIDs = serviceOptions?.hiddenSessionIDs
  const liveSessionActivity = new Map()
  let sseClients = 0
  const unsubscribeActivity = service.subscribe((event) => {
    if (!event?.sessionId) return
    if (event.type === "session.deleted") {
      liveSessionActivity.delete(event.sessionId)
      return
    }
    if (["session.created", "session.updated", "message.updated", "todo.updated"].includes(event.type)) {
      liveSessionActivity.set(event.sessionId, Date.now())
    }
  })
  const publicSessionStatus = (sessionID, fallbackActivityAt = 0) => {
    const status = service.status(sessionID)
    if (backend !== "claude") return status
    const pendingRequests = acp.diagnostics?.()?.pendingRequests ?? []
    const lastActivityAt = Math.max(liveSessionActivity.get(sessionID) ?? 0, Number(fallbackActivityAt) || 0)
    const corroborated = corroborateClaudeSessionStatus(status, sessionID, pendingRequests, lastActivityAt)
    // The transcript is part of the same presentation: a Session that is reported idle must not keep
    // its Activity sections on Working, which is what correcting the status alone left on screen.
    if (status?.type === "busy" && corroborated.type === "idle") service.settleReportedIdleActivity(sessionID)
    return corroborated
  }
  const listVisibleSessions = async (directory, query = "") => {
    let sessions = await service.listSessions(directory)
    if (backend === "claude") {
      sessions = sessions.map((session) => ({
        ...session,
        status: publicSessionStatus(session.id, session.time?.updated)
      }))
    }
    if (query) {
      const lower = query.toLowerCase()
      sessions = sessions.filter((s) =>
        (typeof s.title === "string" && s.title.toLowerCase().includes(lower)) ||
        (typeof s.id === "string" && s.id.toLowerCase().includes(lower)) ||
        (typeof s.directory === "string" && s.directory.toLowerCase().includes(lower))
      )
    }
    if (!hiddenSessionIDs?.size) return sessions
    return sessions.filter((session) => !hiddenSessionIDs.has(session.id))
  }
  // One in-flight native listing is shared by every caller asking for the same page. A short TTL on
  // the resolved page additionally absorbs the burst of listing/status requests a client makes while
  // the startup screen is still settling. The cache stores the raw harness page so late filtering
  // (window, hidden, deleted, ownership) still happens per request and cannot go stale.
  const nativePageCache = new Map()
  const loadNativePage = (cursor, windowMs, query = "") => {
    // Cache by the requested window, not its moving millisecond cutoff. The exact window filter
    // still runs per response, and the database cutoff is refreshed when the short TTL expires.
    const key = `${cursor ?? ""}\u0000${windowMs}\u0000${query ?? ""}`
    const entry = nativePageCache.get(key)
    const now = Date.now()
    if (entry?.value && now - entry.at < cacheTtlMs) return Promise.resolve(entry.value)
    if (entry?.promise) return entry.promise
    for (const [cachedKey, cached] of nativePageCache) {
      if (cached.value && now - cached.at >= cacheTtlMs) nativePageCache.delete(cachedKey)
    }
    const sinceMs = windowMs > 0 ? now - windowMs : 0
    const promise = (async () => {
      // The Codex state database can answer the listing without paying for `thread/list`, which
      // materialises every preview. `undefined` means the fast path is unavailable, not empty.
      const fast = typeof historyLoader?.listSessions === "function"
        ? await historyLoader.listSessions({ cursor, sinceMs: sinceMs || undefined, query: query || undefined })
        : undefined
      const page = fast ?? (typeof acp.listSessionPage === "function"
        ? await acp.listSessionPage(cursor)
        : cursor
          ? { sessions: [] }
          : await acp.listSessions().then((sessions) => ({ sessions })))
      serviceOptions?.onSessionDirectories?.(page.sessions.map((session) => session.cwd).filter((cwd) => typeof cwd === "string" && cwd))
      return page
    })()
    nativePageCache.set(key, { promise })
    while (nativePageCache.size > 128) nativePageCache.delete(nativePageCache.keys().next().value)
    promise.then((page) => {
      // A mutation may have invalidated this read while it was in flight.
      if (nativePageCache.get(key)?.promise === promise) {
        nativePageCache.set(key, { value: page, at: Date.now() })
      }
    }, () => {
      if (nativePageCache.get(key)?.promise === promise) nativePageCache.delete(key)
    })
    return promise
  }

  // PI's ACP adapter leaves `updatedAt` undefined, so the file modification time is the only signal
  // that a Session was used recently. Recover it before the window filter runs, otherwise a Session
  // the user just finished would be hidden as "inactive".
  const recoverMissingUpdatedAt = async (sessions) => {
    if (typeof historyLoader?.sessionUpdatedAt !== "function") return
    await Promise.all(sessions.map(async (session) => {
      if (Number.isFinite(Date.parse(session.updatedAt ?? ""))) return
      const recovered = await historyLoader.sessionUpdatedAt(session.sessionId).catch(() => undefined)
      if (recovered) session.updatedAt = recovered
    }))
  }

  // TaskDesk only needs index metadata to render the Sessions list and status counts. Calling
  // AcpService.listSessions here used to restore every persisted transcript snapshot into memory,
  // so merely opening the app could retain gigabytes of historical messages. The experimental
  // global listing and status route deliberately stay on the harness's lightweight session index.
  // Live activity is tracked separately so an active Session still sorts to the top without reading
  // its transcript. Invalid or missing harness timestamps stay at zero instead of pretending to be
  // freshly updated on every poll.
  const listVisibleSessionMetadata = async (directory, cursor, windowMs = defaultWindowMs, query = "") => {
    const cutoff = Number.isFinite(windowMs) && windowMs > 0 ? Date.now() - windowMs : 0
    const [page, deletedSessionIDs] = await Promise.all([
      loadNativePage(cursor, windowMs, query),
      service.deletedSessionIDs()
    ])
    await recoverMissingUpdatedAt(page.sessions)
    service.rememberListedSessions(page.sessions)
    const lowerQuery = query ? query.toLowerCase() : ""
    const matchesQuery = (title, id, cwd) => {
      if (!lowerQuery) return true
      return (typeof title === "string" && title.toLowerCase().includes(lowerQuery)) ||
             (typeof id === "string" && id.toLowerCase().includes(lowerQuery)) ||
             (typeof cwd === "string" && cwd.toLowerCase().includes(lowerQuery))
    }
    const visible = new Map(
      page.sessions
        .filter((session) => !directory || sameListedDirectory(session.cwd, directory))
        .filter((session) => !hiddenSessionIDs?.has(session.sessionId))
        .filter((session) => !deletedSessionIDs.has(session.sessionId))
        .filter((session) => matchesQuery(session.title, session.sessionId, session.cwd))
        .map((session) => {
          const liveUpdatedAt = liveSessionActivity.get(session.sessionId) ?? 0
          const listedUpdated = Date.parse(session.updatedAt ?? "")
          const listedTimestamp = Number.isFinite(listedUpdated) ? listedUpdated : 0
          const view = listedSessionView(
            session,
            publicSessionStatus(session.sessionId, Math.max(liveUpdatedAt, listedTimestamp)),
            liveUpdatedAt
          )
          return [view.id, view]
        })
    )

    // PI can create a valid writer Session before its lightweight ACP listing exposes it. Add that
    // missing identity only to page one. A title override, however, must decorate whichever native
    // page contains the Session; otherwise loading its older page would overwrite the title page
    // one already supplied. No transcript snapshot is restored merely to draw either view.
    for (const { session, titleOverride } of service.ownedSessionIndex(directory)) {
      if (hiddenSessionIDs?.has(session.id) || deletedSessionIDs.has(session.id)) continue
      const title = titleOverride || session.title
      if (!matchesQuery(title, session.id, session.directory)) continue
      const listed = visible.get(session.id)
      if (listed && titleOverride) {
        visible.set(session.id, { ...listed, title: titleOverride })
      } else if (!cursor && !listed) {
        visible.set(session.id, {
          ...session,
          status: publicSessionStatus(session.id, session.time?.updated)
        })
      }
    }
    const sessions = [...visible.values()]
    return {
      // The window is applied to the rendered view so a Session that only looks active because of
      // bridge-tracked live activity is kept even when the harness timestamp is older than the
      // window. The harness-side fast path already narrowed its own query for the common case.
      sessions: cutoff ? sessions.filter((session) => (session.time?.updated ?? 0) >= cutoff) : sessions,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }
  }

  const server = http.createServer(async (request, response) => {
    applyCorsHeaders(request, response, config)
    if (request.method === "OPTIONS") {
      response.writeHead(allowedOrigin(request, config) ? 204 : 403)
      response.end()
      return
    }
    if (!matchesCredentials(request, config)) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Harness Remote Bridge"' })
      response.end()
      return
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const directory = url.searchParams.get("directory") || undefined
    // A create/rename/delete/prompt must be visible on the very next read, so any cached native page
    // is dropped before and after the mutation. A read during a mutation must not populate a stale
    // page that survives its completion. Reads keep the short TTL that absorbs startup bursts.
    if (request.method !== "GET") {
      nativePageCache.clear()
      response.once("finish", () => nativePageCache.clear())
    }
    if (config.logRequests && url.pathname === "/config/providers") process.stderr.write(`[bridge] ${request.method} ${url.pathname}${url.search}\n`)
    try {
      if (request.method === "GET" && (url.pathname === "/v1/machine" || url.pathname === "/global/machine")) {
        if (!machineRegistry) {
          writeJSON(response, 503, { error: "Machine registry is not configured" })
          return
        }
        writeJSON(response, 200, machineRegistry.snapshot())
        return
      }
      if (request.method === "GET" && url.pathname === "/v1/diagnostics") {
        const memory = process.memoryUsage()
        writeJSON(response, 200, {
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          memory: {
            rss: memory.rss,
            heapTotal: memory.heapTotal,
            heapUsed: memory.heapUsed,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers
          },
          sseClients,
          service: service.diagnostics()
        })
        return
      }
      if (request.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/global/health")) {
        await acp.start()
        // A machine daemon exposes several harnesses behind one endpoint. Its ACP primary is an
        // internal routing choice, not the identity of the whole server. Omitting `backend` here
        // prevents legacy connection tests from rejecting OpenCode/PI/OMP/Claude merely because
        // Codex (or another ACP harness) happens to be the daemon primary. Single-backend bridge
        // servers still report their backend exactly as before.
        writeJSON(response, 200, {
          healthy: true,
          ...(machineRegistry ? {} : { backend }),
          version: acp.agentInfo?.version ?? "unknown"
        })
        return
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        await acp.start()
        writeJSON(response, 200, { ...profile.capabilities, attachments: Boolean(acp.promptCapabilities?.image) })
        return
      }
      if (request.method === "GET" && (url.pathname === "/v1/events" || url.pathname === "/global/event")) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        })
        sseClients += 1
        const unsubscribe = service.subscribe((event) => writeSSE(response, event.type, event))
        // Subscribe before acknowledging the stream. A turn can emit between the HTTP connection
        // opening and the listener registration; acknowledging first would make that event
        // unrecoverable until the client's next safety reconciliation.
        response.write(": connected\n\n")
        const heartbeat = setInterval(() => response.write(": ping\n\n"), config.heartbeatMs ?? 10_000)
        heartbeat.unref?.()
        request.on("close", () => {
          clearInterval(heartbeat)
          unsubscribe()
          sseClients = Math.max(0, sseClients - 1)
        })
        return
      }
      if (request.method === "GET" && url.pathname === "/experimental/session") {
        const query = url.searchParams.get("q")?.trim() || ""
        const windowMs = query && !url.searchParams.has("days") ? 0 : requestedWindowMs(url, defaultWindowMs)
        const page = await listVisibleSessionMetadata(directory, url.searchParams.get("cursor") || undefined, windowMs, query)
        if (page.nextCursor) response.setHeader("x-next-cursor", page.nextCursor)
        writeJSON(response, 200, page.sessions)
        return
      }
      if (request.method === "GET" && (url.pathname === "/v1/sessions" || url.pathname === "/session")) {
        const query = url.searchParams.get("q")?.trim() || ""
        writeJSON(response, 200, await listVisibleSessions(directory, query))
        return
      }
      if (request.method === "GET" && url.pathname === "/session/status") {
        const page = await listVisibleSessionMetadata(directory, undefined, requestedWindowMs(url, defaultWindowMs))
        const statuses = Object.fromEntries(page.sessions.map((session) => [session.id, session.status]))
        writeJSON(response, 200, statuses)
        return
      }
      if (request.method === "GET" && url.pathname === "/path") {
        const selected = await allowedDirectory(directory ?? config.roots[0] ?? process.cwd(), config, dynamicRoots)
        writeJSON(response, 200, { home: selected, state: "", config: "", worktree: selected, directory: selected })
        return
      }
      if (request.method === "GET" && url.pathname === "/file") {
        const selected = await allowedDirectory(url.searchParams.get("path") ?? config.roots[0] ?? process.cwd(), config, dynamicRoots)
        const entries = await readdir(selected, { withFileTypes: true })
        writeJSON(response, 200, entries.map((entry) => ({
          name: entry.name,
          path: path.join(selected, entry.name),
          absolute: path.join(selected, entry.name),
          type: entry.isDirectory() ? "directory" : "file",
          ignored: false
        })))
        return
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await readBody(request)
        const selected = await allowedDirectory(directory ?? config.roots[0] ?? process.cwd(), config, dynamicRoots)
        const created = await service.createSession({ directory: selected, title: body.title, model: modelWireName(body.model) })
        writeJSON(response, 200, created)
        return
      }

      const sessionMatch = /^\/session\/([^/]+)(?:\/(message|prompt_async|abort|todo|diff|action|command)(?:\/([^/]+))?)?$/.exec(url.pathname)
      if (sessionMatch) {
        const [, sessionID, operation, actionID] = sessionMatch
        if (request.method === "PATCH" && !operation) {
          const body = await readBody(request)
          writeJSON(response, 200, await service.renameSession(sessionID, typeof body.title === "string" ? body.title : ""))
          return
        }
        if (request.method === "DELETE" && !operation) {
          await service.deleteSession(sessionID)
          writeJSON(response, 200, true)
          return
        }
        if (request.method === "GET" && operation === "message") {
          const limit = messageLimit(url)
          // TaskDesk used to ask for the latest message of 18 sessions every four seconds. On ACP
          // those reads materialise complete harness journals before slicing, so one tiny preview
          // could cost an entire transcript. In daemon mode previews are intentionally omitted until
          // the session index carries its own lightweight preview field. The UI already falls back
          // to directory/summary metadata, and opening the session still loads the real transcript.
          if (machineRegistry && limit === 1 && url.searchParams.get("refresh") !== "1") {
            writeJSON(response, 200, [])
            return
          }
          if (limit !== undefined || url.searchParams.has("before")) {
            const page = await service.messagePage(sessionID, {
              limit: limit ?? 100,
              before: url.searchParams.get("before") || undefined,
              refresh: url.searchParams.get("refresh") === "1"
            })
            if (page.before) response.setHeader("X-Next-Cursor", page.before)
            response.setHeader("X-Has-More", page.hasMore ? "1" : "0")
            if (page.model) response.setHeader("X-Session-Model", encodeURIComponent(JSON.stringify(page.model)))
            writeJSON(response, 200, page.messages)
            return
          }
          writeJSON(response, 200, await service.messages(sessionID, url.searchParams.get("refresh") === "1"))
          return
        }
        if (request.method === "GET" && operation === "todo") {
          writeJSON(response, 200, await service.todos(sessionID))
          return
        }
        if (request.method === "GET" && operation === "diff") {
          writeJSON(response, 200, [])
          return
        }
        if (request.method === "GET" && operation === "action" && !actionID) {
          writeJSON(response, 200, await service.actions(sessionID))
          return
        }
        if (request.method === "POST" && operation === "action" && actionID) {
          writeJSON(response, 200, await service.invokeAction(sessionID, actionID))
          return
        }
        if (request.method === "POST" && operation === "prompt_async") {
          const body = await readBody(request)
          const text = body.parts?.find((part) => part.type === "text")?.text ?? ""
          const attachments = parseAttachments(body.parts)
          if (!text && !attachments.length) throw new Error("A text prompt is required")
          await service.prompt(sessionID, text, modelWireName(body.model), attachments)
          writeJSON(response, 200, true)
          return
        }
        if (request.method === "POST" && operation === "command") {
          const body = await readBody(request)
          if (typeof body.command !== "string" || !body.command) throw new Error("A command name is required")
          const argumentsText = typeof body.arguments === "string" ? body.arguments.trim() : ""
          const text = argumentsText ? `/${body.command} ${argumentsText}` : `/${body.command}`
          await service.prompt(sessionID, text, modelWireName(body.model))
          writeJSON(response, 200, true)
          return
        }
        if (request.method === "POST" && operation === "abort") {
          service.abort(sessionID)
          writeJSON(response, 200, true)
          return
        }
      }
      if (request.method === "GET" && url.pathname === "/command") {
        writeJSON(response, 200, await service.commands(url.searchParams.get("sessionID") ?? undefined))
        return
      }
      if (request.method === "GET" && url.pathname === "/agent") {
        writeJSON(response, 200, [])
        return
      }
      if (request.method === "GET" && url.pathname === "/config/providers") {
        const sessionID = url.searchParams.get("sessionID")
        if (!sessionID) {
          writeJSON(response, 200, { providers: [], default: {} })
          return
        }
        writeJSON(response, 200, providersResponse(await service.models(sessionID), backend))
        return
      }
      writeJSON(response, 404, { error: "Not found" })
    } catch (error) {
      writeJSON(response, 400, { error: error instanceof Error ? error.message : "Request failed" })
    }
  })
  server.on("close", unsubscribeActivity)
  // The machine task launcher must use this exact service so task-created ACP sessions retain
  // their title, prompt, live messages, and ownership when the user switches harnesses.
  server.acpService = service
  return server
}
