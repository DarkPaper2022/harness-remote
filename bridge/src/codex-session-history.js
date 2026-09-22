import { createReadStream } from "node:fs"
import { open, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { scanLinesBackward } from "./backward-line-scan.js"

const MODEL_CONTEXT_LOOKBACK_BYTES = 4 * 1024 * 1024

function trimCarriageReturn(buffer) {
  return buffer.length > 0 && buffer[buffer.length - 1] === 0x0d ? buffer.subarray(0, -1) : buffer
}

function recordFromLine(line) {
  try {
    return JSON.parse(trimCarriageReturn(line).toString("utf8"))
  } catch {
    return undefined
  }
}

function textFromCompletedItem(item) {
  if (item?.type === "Reasoning") {
    return Array.isArray(item.summary_text)
      ? item.summary_text.filter((text) => typeof text === "string" && text).join("\n\n")
      : ""
  }
  if (item?.type !== "UserMessage" && item?.type !== "AgentMessage") return ""
  return Array.isArray(item.content)
    ? item.content
      .filter((part) => typeof part?.text === "string" && part.text)
      .map((part) => part.text)
      .join("\n\n")
    : ""
}

function messageFromRecord(sessionID, record, offset) {
  if (record?.type !== "event_msg") return undefined
  const payload = record.payload
  const completedItem = payload?.type === "item_completed" ? payload.item : undefined
  const role = payload?.type === "user_message" || completedItem?.type === "UserMessage" ? "user"
    : payload?.type === "agent_message" || payload?.type === "agent_reasoning"
      || completedItem?.type === "AgentMessage" || completedItem?.type === "Reasoning" ? "assistant"
      : undefined
  if (!role) return undefined

  const type = payload.type === "agent_reasoning" || completedItem?.type === "Reasoning" ? "reasoning" : "text"
  const text = completedItem ? textFromCompletedItem(completedItem)
    : payload.type === "agent_reasoning" ? payload.text
      : payload.message
  if (typeof text !== "string" || !text) return undefined

  // Rollouts are append-only. A byte offset is therefore both unique inside the file and stable as
  // later turns are appended. The paged tail reader can derive it without first scanning all older
  // lines, unlike the old ordinal-based id.
  const messageID = `${sessionID}:byte:${offset}`
  const created = Date.parse(record.timestamp ?? "")
  const nativePhase = completedItem?.phase ?? payload.phase
  const phase = nativePhase === "final"
    ? "final_answer"
    : nativePhase === "commentary" || nativePhase === "final_answer" ? nativePhase : undefined
  return {
    info: {
      id: messageID,
      role,
      sessionID,
      time: { created: Number.isFinite(created) ? created : Date.now() }
    },
    parts: [{ id: `${messageID}:${type}:0`, messageID, type, text, ...(type === "text" && phase ? { phase } : {}) }]
  }
}

function messageFromLine(sessionID, line, offset) {
  return messageFromRecord(sessionID, recordFromLine(line), offset)
}

/**
 * Codex persists the model and reasoning effort that own a turn in `turn_context`. Reading that
 * record is lock-free, unlike ACP session/load, and is the same native rollout authority used for
 * transcript recovery. The app presents Codex's bare model ids under the synthetic `codex` provider,
 * matching the ACP catalog's fallback provider id.
 */
function modelFromTurnContext(record) {
  if (record?.type !== "turn_context") return undefined
  const modelID = typeof record.payload?.model === "string" ? record.payload.model.trim() : ""
  if (!modelID) return undefined
  const effortValue = record.payload?.effort ?? record.payload?.collaboration_mode?.reasoning_effort
  const variant = typeof effortValue === "string" && effortValue.trim() ? effortValue.trim() : undefined
  return { providerID: "codex", modelID, ...(variant ? { variant } : {}) }
}

async function* forwardLines(file) {
  let pending = Buffer.alloc(0)
  let pendingStart = 0
  for await (const chunk of createReadStream(file)) {
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    let lineStart = 0
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue
      yield { line: data.subarray(lineStart, index), offset: pendingStart + lineStart }
      lineStart = index + 1
    }
    pending = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : Buffer.alloc(0)
    pendingStart += lineStart
  }
  if (pending.length > 0) yield { line: pending, offset: pendingStart }
}

async function readCodexPage(file, sessionID, { limit = 100, before } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const handle = await open(file, "r")
  try {
    const { size } = await handle.stat()
    let end = size
    if (before !== undefined && before !== null && before !== "") {
      const parsed = Number(before)
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > size) {
        throw new Error("Invalid Codex history cursor")
      }
      end = parsed
    }

    const found = []
    let currentModel
    const modelSearchFloor = Math.max(0, end - MODEL_CONTEXT_LOOKBACK_BYTES)
    const needMore = (chunkEnd) => found.length <= boundedLimit
      || (!before && !currentModel && chunkEnd > modelSearchFloor)

    for await (const { line, offset, chunkEnd } of scanLinesBackward(handle, { from: end })) {
      if (!needMore(chunkEnd)) break
      const record = recordFromLine(line)
      // Only the newest-page read describes the Session's current model. Older page requests
      // deliberately omit model metadata so paging cannot rewind the picker to a historical turn.
      if (!before && !currentModel) currentModel = modelFromTurnContext(record)
      if (found.length <= boundedLimit) {
        const message = messageFromRecord(sessionID, record, offset)
        if (message) found.push({ message, offset })
      }
      if (found.length > boundedLimit && (before || currentModel)) break
    }

    const hasMore = found.length > boundedLimit
    const newest = found.slice(0, boundedLimit)
    const messages = newest.map((entry) => entry.message).reverse()
    const nextBefore = hasMore && newest.length > 0 ? String(newest[newest.length - 1].offset) : null
    return {
      messages,
      before: nextBefore,
      hasMore,
      ...(currentModel ? { model: currentModel } : {})
    }
  } finally {
    await handle.close()
  }
}

/**
 * Codex allows a single writer per thread and takes the lock for the whole time a client holds the
 * thread open, so `session/load` answers "thread <id> already has an active writer" for every
 * session the Codex desktop app or a `codex` CLI is sitting on, which is precisely the sessions a
 * user wants to look at from their phone. Reading the rollout the harness already wrote takes no
 * lock, so those sessions can be shown even while Codex itself owns them.
 *
 * The transcript comes from the `event_msg` records rather than the `response_item` ones: only the
 * former carry what the user actually saw. Current Codex versions wrap visible turns in
 * `item_completed` (`UserMessage`, `AgentMessage`, and `Reasoning`), while older rollouts use the
 * direct `user_message`, `agent_message`, and `agent_reasoning` event types. The `response_item`
 * records also hold instruction blocks Codex feeds the model, AGENTS.md, the plugin list and desktop
 * app context under the `user` role, which would surface as the user's own turns.
 */
const CODEX_STATE_DATABASE = /^state_(\d+)\.sqlite$/
const CODEX_LIST_PAGE_LIMIT = 50
const CODEX_LIST_CURSOR_PREFIX = "codex-created:"

/**
 * `codex app-server` answers `thread/list` by materialising every preview for the page, which costs
 * seconds once a user has a few hundred threads. The same rows are already indexed in the small
 * `state_<n>.sqlite` database, so reading them directly is the difference between a six-second
 * startup stall and a few milliseconds. `node:sqlite` is only available on Node 22.5+, and the
 * schema is Codex-owned, so every failure here must fall back to the ACP listing rather than throw.
 */
let sqliteModulePromise
function loadSqliteModule() {
  sqliteModulePromise ??= import("node:sqlite").catch(() => null)
  return sqliteModulePromise
}

async function threadTableColumns(file) {
  const sqlite = await loadSqliteModule()
  if (!sqlite?.DatabaseSync) return undefined
  let database
  try {
    database = new sqlite.DatabaseSync(file, { readOnly: true })
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map((row) => row.name))
    return columns.size > 0 ? columns : undefined
  } catch {
    return undefined
  } finally {
    database?.close()
  }
}

async function codexStateDatabase(codexHome) {
  let entries
  try {
    entries = await readdir(codexHome)
  } catch {
    return undefined
  }
  const candidates = entries
    .map((name) => {
      const match = CODEX_STATE_DATABASE.exec(name)
      return match ? { name, version: Number(match[1]) } : undefined
    })
    .filter(Boolean)
    .sort((left, right) => right.version - left.version)
  for (const candidate of candidates) {
    const columns = await threadTableColumns(path.join(codexHome, candidate.name))
    if (columns) return { file: path.join(codexHome, candidate.name), columns }
  }
  return undefined
}

/** Only a top-level `model_provider` matters; a section-scoped one belongs to a profile. */
async function codexConfiguredModelProvider(codexHome) {
  let text
  try {
    text = await readFile(path.join(codexHome, "config.toml"), "utf8")
  } catch {
    return undefined
  }
  let section = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("[")) {
      section = true
      continue
    }
    if (section) continue
    const match = /^model_provider\s*=\s*["']([^"']+)["']/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

function decodeCodexListCursor(cursor) {
  if (typeof cursor !== "string" || !cursor.startsWith(CODEX_LIST_CURSOR_PREFIX)) return undefined
  const value = Number(cursor.slice(CODEX_LIST_CURSOR_PREFIX.length))
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

async function listCodexThreads({ codexHome, cursor, sinceMs, limit = CODEX_LIST_PAGE_LIMIT }) {
  const database = await codexStateDatabase(codexHome)
  if (!database) return undefined
  const { file, columns } = database
  for (const required of ["id", "cwd", "created_at_ms", "updated_at_ms", "archived", "source"]) {
    if (!columns.has(required)) return undefined
  }
  const titleExpression = columns.has("name") && columns.has("preview")
    ? "COALESCE(NULLIF(name, ''), preview, '')"
    : columns.has("name")
      ? "COALESCE(name, '')"
      : columns.has("preview")
        ? "COALESCE(preview, '')"
        : "''"
  const modelProvider = columns.has("model_provider") ? await codexConfiguredModelProvider(codexHome) : undefined
  const beforeCreatedAt = cursor === undefined ? undefined : decodeCodexListCursor(cursor)
  if (cursor !== undefined && beforeCreatedAt === undefined) return undefined
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || CODEX_LIST_PAGE_LIMIT))

  const sqlite = await loadSqliteModule()
  let databaseHandle
  try {
    databaseHandle = new sqlite.DatabaseSync(file, { readOnly: true })
    const conditions = ["archived = 0", "(source IS NULL OR source NOT LIKE '{%')"]
    const parameters = []
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      conditions.push("updated_at_ms >= ?")
      parameters.push(sinceMs)
    }
    if (modelProvider) {
      conditions.push("model_provider = ?")
      parameters.push(modelProvider)
    }
    if (beforeCreatedAt !== undefined) {
      conditions.push("created_at_ms < ?")
      parameters.push(beforeCreatedAt)
    }
    const rows = databaseHandle.prepare(`SELECT id, cwd, ${titleExpression} AS title, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs FROM threads WHERE ${conditions.join(" AND ")} ORDER BY created_at_ms DESC LIMIT ?`).all(...parameters, boundedLimit + 1)
    const hasMore = rows.length > boundedLimit
    const page = hasMore ? rows.slice(0, boundedLimit) : rows
    const sessions = page.map((row) => ({
      sessionId: row.id,
      cwd: row.cwd,
      title: row.title || null,
      updatedAt: Number.isFinite(row.updatedAtMs) ? new Date(row.updatedAtMs).toISOString() : undefined
    }))
    const last = page[page.length - 1]
    return {
      sessions,
      ...(hasMore && last ? { nextCursor: `${CODEX_LIST_CURSOR_PREFIX}${last.createdAtMs}` } : {})
    }
  } catch {
    return undefined
  } finally {
    databaseHandle?.close()
  }
}

export function createCodexHistoryLoader(sessionRoot = path.join(homedir(), ".codex", "sessions")) {
  const codexHome = process.env.CODEX_HOME || path.dirname(sessionRoot)
  const sessionFiles = new Map()

  async function locateSession(sessionID) {
    const known = sessionFiles.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined
    try {
      // Rollouts are filed under sessions/<year>/<month>/<day>/rollout-<timestamp>-<id>.jsonl.
      const suffix = `-${sessionID}.jsonl`
      const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
      const entry = entries.find((candidate) => candidate.isFile() && candidate.name.endsWith(suffix))
      if (!entry) return undefined
      const file = path.join(entry.parentPath ?? entry.path, entry.name)
      sessionFiles.set(sessionID, file)
      return file
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
  }

  const loadCodexHistory = async function loadCodexHistory(sessionID) {
    const file = await locateSession(sessionID)
    if (!file) return []
    const messages = []
    for await (const { line, offset } of forwardLines(file)) {
      const message = messageFromLine(sessionID, line, offset)
      if (message) messages.push(message)
    }
    return messages
  }

  loadCodexHistory.page = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    // Absence is not proof of an empty Session: a rollout may live outside this installation's
    // local tree while ACP session/load can still replay it. Let AcpService distinguish that from a
    // located, genuinely empty rollout and fall through to the protocol source.
    if (!file) return undefined
    return readCodexPage(file, sessionID, options)
  }

  // Reading metadata must not take the single-writer lock from a desktop/CLI client.
  loadCodexHistory.readOnlyExternalMetadata = true
  // A direct, indexed read of the Codex state database. Returns `undefined` whenever the schema or
  // runtime cannot support it, which makes the caller fall back to the ACP `session/list` path.
  loadCodexHistory.listSessions = (options = {}) => listCodexThreads({ codexHome, ...options })
  loadCodexHistory.listSessionDirectories = async ({ sinceMs } = {}) => {
    const database = await codexStateDatabase(codexHome)
    if (!database) return []
    const sqlite = await loadSqliteModule()
    let databaseHandle
    try {
      databaseHandle = new sqlite.DatabaseSync(database.file, { readOnly: true })
      const conditions = ["archived = 0", "cwd IS NOT NULL", "cwd <> ''"]
      const parameters = []
      if (Number.isFinite(sinceMs) && sinceMs > 0) {
        conditions.push("updated_at_ms >= ?")
        parameters.push(sinceMs)
      }
      return databaseHandle.prepare(`SELECT DISTINCT cwd FROM threads WHERE ${conditions.join(" AND ")}`).all(...parameters).map((row) => row.cwd)
    } catch {
      return []
    } finally {
      databaseHandle?.close()
    }
  }
  return loadCodexHistory
}
