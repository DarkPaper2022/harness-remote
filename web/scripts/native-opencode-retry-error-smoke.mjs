import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4191
const DAEMON_PORT = 4441
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-opencode-retry-error"
const DIRECTORY = "/work/opencode-retry-error"
const SESSION_A = "opencode-retry-error-a"
const SESSION_B = "opencode-retry-error-b"
const TITLE_A = "OpenCode Retry Error A"
const TITLE_B = "OpenCode Ready B"
const FAILING_PROMPT = "TRIGGER-OPENCODE-RETRY-ERROR"
const RECOVERED_REPLY = "OPENCODE-RECOVERED-AFTER-RETRY"
const SECOND_PROMPT = "OPENCODE-SECOND-SEND-AFTER-RECOVERY"
const SECOND_REPLY = "OPENCODE-SECOND-SEND-REPLY"
const DURABLE_AFTER_ERROR_PROMPT = "OPENCODE-DURABLE-ANSWER-AFTER-ERROR"
const DURABLE_AFTER_ERROR_REPLY = "OPENCODE-DURABLE-ANSWER-WINS"
const PROVIDER_ERROR = "No available channel"

let sessions
let statuses
let transcripts
let sseResponses
let promptBodies
let clock

function resetState() {
  clock = 30_000
  sseResponses = new Set()
  promptBodies = []
  statuses = new Map([
    [SESSION_A, { type: "idle" }],
    [SESSION_B, { type: "idle" }]
  ])
  transcripts = new Map([
    [SESSION_A, []],
    [SESSION_B, []]
  ])
  sessions = new Map([
    [SESSION_A, {
      id: SESSION_A,
      title: TITLE_A,
      directory: DIRECTORY,
      time: { created: 2_000, updated: 4_000 }
    }],
    [SESSION_B, {
      id: SESSION_B,
      title: TITLE_B,
      directory: DIRECTORY,
      time: { created: 1_000, updated: 3_000 }
    }]
  ])
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders })
  response.end(JSON.stringify(value))
}

async function requestJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : null
}

function emit(type, properties) {
  const frame = `data: ${JSON.stringify({
    directory: DIRECTORY,
    payload: { type, properties }
  })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) }
    catch { sseResponses.delete(response) }
  }
}

function appendUser(sessionID, text) {
  const created = clock++
  const list = transcripts.get(sessionID) || []
  list.push({
    info: {
      id: `user-${created}`,
      role: "user",
      sessionID,
      time: { created },
      model: { providerID: "openai", modelID: "gpt-5.6-codex" }
    },
    parts: [{ id: `user-${created}-text`, type: "text", text }]
  })
  transcripts.set(sessionID, list)
  const session = sessions.get(sessionID)
  if (session) session.time.updated = created
}

function appendAssistant(sessionID, text) {
  const created = clock++
  const list = transcripts.get(sessionID) || []
  list.push({
    info: {
      id: `assistant-${created}`,
      role: "assistant",
      sessionID,
      time: { created, completed: created },
      finish: "stop",
      providerID: "openai",
      modelID: "gpt-5.6-codex"
    },
    parts: [{ id: `assistant-${created}-text`, type: "text", text }]
  })
  transcripts.set(sessionID, list)
  const session = sessions.get(sessionID)
  if (session) session.time.updated = created
}

function emitBusy(sessionID) {
  statuses.set(sessionID, { type: "busy" })
  emit("session.status", { sessionID, status: { type: "busy" } })
}

function emitRetry(sessionID, attempt = 1) {
  const status = { type: "retry", attempt, message: PROVIDER_ERROR, next: Date.now() + 2_000 }
  // Keep the legacy status endpoint deliberately stale. The streamed retry must remain authoritative
  // across navigation; opening Session B must not erase A's live retry just because B creates another
  // detail subscription to the same endpoint.
  statuses.set(sessionID, { type: "idle" })
  emit("session.status", { sessionID, status })
}

function emitTerminalError(sessionID) {
  emit("session.error", {
    sessionID,
    error: {
      name: "ApiError",
      data: { message: PROVIDER_ERROR }
    }
  })
  // OpenCode may settle its status endpoint back to idle around the same failure. The terminal event
  // must still win until a real retry/busy edge or durable transcript proves recovery.
  statuses.set(sessionID, { type: "idle" })
  emit("session.status", { sessionID, status: { type: "idle" } })
}

function finishRecoveredTurn(sessionID, text) {
  appendAssistant(sessionID, text)
  emit("message.updated", { info: { sessionID } })
  statuses.set(sessionID, { type: "idle" })
  emit("session.status", { sessionID, status: { type: "idle" } })
}

function startFakeDaemon() {
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }

    const url = new URL(request.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)

    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: MACHINE_ID, name: "OpenCode retry-error machine", createdAt: new Date().toISOString() },
        agents: [{
          id: "opencode",
          label: "OpenCode",
          backend: "opencode",
          transport: "http",
          managed: true,
          state: "available",
          capabilities: {
            sessions: true,
            prompt: true,
            abort: true,
            streaming: true,
            models: true,
            commands: true,
            sessionRename: true,
            sessionDelete: true
          },
          contract: { sessions: { stop: "native-abort" } }
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{
          id: "project-opencode-retry-error",
          machineId: MACHINE_ID,
          name: "opencode-retry-error",
          path: DIRECTORY,
          kind: "git",
          configured: true
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/experimental/session") {
      json(response, 200, [...sessions.values()])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/session/status") {
      json(response, 200, Object.fromEntries(statuses))
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/models") {
      json(response, 200, {
        models: [{
          providerID: "openai",
          providerName: "OpenAI",
          modelID: "gpt-5.6-codex",
          modelName: "GPT-5.6 Codex",
          isDefault: true,
          tools: true
        }],
        stale: false,
        refreshedAt: new Date().toISOString(),
        source: "opencode-retry-error-smoke"
      })
      return
    }

    if (request.method === "GET" && url.pathname.includes("/global/event")) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      })
      response.write(": connected\n\n")
      sseResponses.add(response)
      request.on("close", () => sseResponses.delete(response))
      return
    }

    const messageMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (request.method === "GET" && messageMatch) {
      const sessionID = decodeURIComponent(messageMatch[1])
      const all = transcripts.get(sessionID) || []
      const requestedLimit = Number(url.searchParams.get("limit")) || all.length
      json(response, 200, all.slice(Math.max(0, all.length - requestedLimit)), { "X-Has-More": "0" })
      return
    }

    const promptMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      const sessionID = decodeURIComponent(promptMatch[1])
      const body = await requestJSON(request)
      promptBodies.push(body)
      appendUser(sessionID, body?.text || "")
      emitBusy(sessionID)
      json(response, 200, { status: "accepted", clientRequestId: body?.clientRequestId })

      if (body?.text === SECOND_PROMPT) {
        setTimeout(() => finishRecoveredTurn(sessionID, SECOND_REPLY), 350)
      }
      return
    }

    if (request.method === "GET" && (url.pathname.includes("/question") || url.pathname.includes("/permission"))) {
      json(response, 200, [])
      return
    }

    if (request.method === "GET" && url.pathname.endsWith("/vcs")) {
      json(response, 200, {})
      return
    }

    json(response, 404, { error: `No fake route for ${request.method} ${url.pathname}` })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(DAEMON_PORT, "127.0.0.1", () => resolve(server))
  })
}

function startPreview() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm"
  return spawn(command, ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  })
}

async function ready(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return }
    catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Preview did not become ready: ${url}`)
}

function stopPreview(child) {
  if (!child || child.killed || !child.pid) return
  try {
    if (process.platform === "win32") child.kill("SIGTERM")
    else process.kill(-child.pid, "SIGTERM")
  } catch {
    try { child.kill("SIGTERM") } catch {}
  }
}

function stopServer(server) {
  try { server.closeAllConnections?.() } catch {}
  try { server.close() } catch {}
}

async function seed(page) {
  await page.addInitScript(({ key, port, machineID }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: machineID,
      name: "OpenCode retry-error machine",
      config: {
        backend: "opencode",
        host: "127.0.0.1",
        port,
        username: "harness",
        password: "testpw"
      }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT, machineID: MACHINE_ID })
}

async function waitForRowState(button, state, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await button.evaluate((element, expected) => element.classList.contains(expected), state)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const className = await button.getAttribute("class")
  throw new Error(`Session row did not become ${state}; class=${className}`)
}

async function waitForPromptCount(count, timeout = 1_500) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && promptBodies.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(promptBodies.length, count, `expected ${count} prompt dispatches without a pre-Send stall`)
}

let daemon
let preview
let browser
let context
try {
  resetState()
  daemon = await startFakeDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible" })
  const aButton = page.getByRole("button", { name: new RegExp(`Open ${TITLE_A}`) })
  const bButton = page.getByRole("button", { name: new RegExp(`Open ${TITLE_B}`) })
  await aButton.waitFor({ state: "visible", timeout: 5_000 })
  await bButton.waitFor({ state: "visible", timeout: 5_000 })

  await aButton.click()
  await page.locator(".uw-composer-shell").waitFor({ state: "visible" })
  const streamDeadline = Date.now() + 5_000
  while (Date.now() < streamDeadline && sseResponses.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(sseResponses.size > 0, "OpenCode event stream did not connect")

  const composer = page.getByRole("textbox", { name: "Message OpenCode" })
  await composer.fill(FAILING_PROMPT)
  await page.getByRole("button", { name: "Send" }).click()
  await waitForPromptCount(1)
  await waitForRowState(aButton, "working")

  // Real OpenCode retry envelope: the exact provider reason must be visible while the Session is open,
  // rather than an unexplained long-lived "OpenCode is getting started" state.
  emitRetry(SESSION_A, 1)
  const retryNotice = page.locator(".tdw-connection-notice")
  await retryNotice.getByText(PROVIDER_ERROR, { exact: false }).waitFor({ state: "visible", timeout: 2_000 })
  assert.match(await retryNotice.textContent(), /OpenCode is retrying/i)

  // Leave A while it is retrying. The status endpoint is deliberately stale-idle, so A can stay
  // Working here only if the persistent machine stream retained the streamed retry. Mounting B's
  // detail stream must not erase A's live lifecycle cache.
  await bButton.click()
  assert.equal(await bButton.getAttribute("aria-current"), "page")
  await waitForRowState(aButton, "working", 2_000)

  // The terminal provider error then arrives while another Session is selected, exactly matching the
  // real failure reported from RC2.
  emitTerminalError(SESSION_A)
  await waitForRowState(aButton, "attention")
  assert.equal(await aButton.getAttribute("aria-current"), null, "A must become attention without reopening it")

  // Reopening A creates a fresh detail subscription. That must not erase the terminal lifecycle error
  // before OpenCode has persisted an assistant error envelope.
  await aButton.click()
  await page.getByText(PROVIDER_ERROR, { exact: false }).first().waitFor({ state: "visible", timeout: 2_500 })
  await page.getByText("Needs attention", { exact: true }).first().waitFor({ state: "visible", timeout: 2_500 })

  // Automatic provider recovery is allowed. A real retry/busy edge retracts the temporary terminal
  // lifecycle error, then a durable final assistant reply + idle settles the Session normally.
  emitRetry(SESSION_A, 2)
  emitBusy(SESSION_A)
  await waitForRowState(aButton, "working")
  finishRecoveredTurn(SESSION_A, RECOVERED_REPLY)
  await page.getByText(RECOVERED_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
  await waitForRowState(aButton, "ready", 4_000)
  assert.equal(await page.getByText(PROVIDER_ERROR, { exact: false }).count(), 0, "recovered Session must not retain the old provider error")

  // A later ordinary Send must still dispatch promptly and complete; the old error must not resurrect
  // two or three interactions later.
  await composer.fill(SECOND_PROMPT)
  await page.getByRole("button", { name: "Send" }).click()
  await waitForPromptCount(2)
  await page.getByText(SECOND_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
  await waitForRowState(aButton, "ready", 4_000)
  assert.equal(await page.getByText(PROVIDER_ERROR, { exact: false }).count(), 0, "prior provider error must not reappear on a later successful turn")

  // Harder missed-lifecycle case: a terminal-looking session.error is observed, then the durable
  // assistant answer appears without a later busy/retry/idle lifecycle edge to rescue presentation.
  // Once the Session-scoped controller proves the final transcript, that durable state must retire
  // the temporary error bridge and become Ready by itself.
  await composer.fill(DURABLE_AFTER_ERROR_PROMPT)
  await page.getByRole("button", { name: "Send" }).click()
  await waitForPromptCount(3)
  await waitForRowState(aButton, "working")
  emitTerminalError(SESSION_A)
  await page.getByText(PROVIDER_ERROR, { exact: false }).first().waitFor({ state: "visible", timeout: 2_500 })
  appendAssistant(SESSION_A, DURABLE_AFTER_ERROR_REPLY)
  emit("message.updated", { info: { sessionID: SESSION_A } })
  await page.getByText(DURABLE_AFTER_ERROR_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
  await waitForRowState(aButton, "ready", 4_000)
  assert.equal(await page.getByText(PROVIDER_ERROR, { exact: false }).count(), 0, "durable final reply must retire the live terminal-looking error without another lifecycle edge")

  // Remount once more after success: durable transcript must stay authoritative and still show all
  // recovered replies without restoring stale retry/error presentation.
  await bButton.click()
  await aButton.click()
  await page.getByText(RECOVERED_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 2_500 })
  await page.getByText(SECOND_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 2_500 })
  await page.getByText(DURABLE_AFTER_ERROR_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 2_500 })
  assert.equal(await page.getByText(PROVIDER_ERROR, { exact: false }).count(), 0)

  console.log("native OpenCode retry/error smoke: retry detail, stale status, navigate-away error, remount, recovery and durable settlement are coherent")
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
