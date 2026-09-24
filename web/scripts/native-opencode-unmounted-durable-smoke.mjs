import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4195
const DAEMON_PORT = 4445
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-opencode-unmounted-durable"
const DIRECTORY = "/work/opencode-unmounted-durable"
const SESSION_A = "opencode-unmounted-a"
const SESSION_B = "opencode-unmounted-b"
const TITLE_A = "OpenCode Unmounted A"
const TITLE_B = "OpenCode Ready B"
const PROMPT = "OPENCODE-UNMOUNTED-DURABLE-PROMPT"
const FINAL = "OPENCODE-UNMOUNTED-DURABLE-FINAL"
const ERROR = "Provider failed before delayed durable recovery"

let sessions
let statuses
let transcripts
let promptBodies
let sseResponses
let clock

function resetState() {
  clock = 70_000
  promptBodies = []
  sseResponses = new Set()
  statuses = new Map([[SESSION_A, { type: "idle" }], [SESSION_B, { type: "idle" }]])
  transcripts = new Map([[SESSION_A, []], [SESSION_B, []]])
  sessions = new Map([
    [SESSION_A, { id: SESSION_A, title: TITLE_A, directory: DIRECTORY, time: { created: 2_000, updated: 4_000 } }],
    [SESSION_B, { id: SESSION_B, title: TITLE_B, directory: DIRECTORY, time: { created: 1_000, updated: 3_000 } }]
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

function json(response, status, value, extra = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(), ...extra })
  response.end(JSON.stringify(value))
}

async function readJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

function emit(type, properties) {
  const frame = `data: ${JSON.stringify({ directory: DIRECTORY, payload: { type, properties } })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) } catch { sseResponses.delete(response) }
  }
}

function appendUser(text) {
  const created = clock++
  transcripts.get(SESSION_A).push({
    info: { id: `user-${created}`, role: "user", sessionID: SESSION_A, time: { created }, model: { providerID: "openai", modelID: "gpt-5.6-codex" } },
    parts: [{ id: `user-${created}-text`, type: "text", text }]
  })
  sessions.get(SESSION_A).time.updated = created
}

function appendFinalWithoutEvents() {
  const created = clock++
  transcripts.get(SESSION_A).push({
    info: {
      id: `assistant-${created}`,
      role: "assistant",
      sessionID: SESSION_A,
      time: { created, completed: created },
      finish: "stop",
      providerID: "openai",
      modelID: "gpt-5.6-codex"
    },
    parts: [{ id: `assistant-${created}-text`, type: "text", text: FINAL }]
  })
  sessions.get(SESSION_A).time.updated = created
  // Deliberately no message.updated/session.updated/session.status edge. Only the durable transcript
  // knows that the terminal-looking live error later recovered while Session A was unmounted.
}

function emitBusy() {
  statuses.set(SESSION_A, { type: "busy" })
  emit("session.status", { sessionID: SESSION_A, status: { type: "busy" } })
}

function emitTerminalError() {
  emit("session.error", {
    sessionID: SESSION_A,
    error: { name: "ApiError", data: { message: ERROR } }
  })
  statuses.set(SESSION_A, { type: "idle" })
  emit("session.status", { sessionID: SESSION_A, status: { type: "idle" } })
}

function startDaemon() {
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)

    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: MACHINE_ID, name: "OpenCode unmounted durable", createdAt: new Date().toISOString() },
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
        projects: [{ id: "project-unmounted", machineId: MACHINE_ID, name: "opencode-unmounted", path: DIRECTORY, kind: "git", configured: true }]
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
        models: [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-5.6-codex", modelName: "GPT-5.6 Codex", isDefault: true, tools: true }],
        stale: false,
        refreshedAt: new Date().toISOString(),
        source: "unmounted-durable-smoke"
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
      const limit = Number(url.searchParams.get("limit")) || all.length
      json(response, 200, all.slice(Math.max(0, all.length - limit)), { "X-Has-More": "0" })
      return
    }

    const promptMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      const sessionID = decodeURIComponent(promptMatch[1])
      assert.equal(sessionID, SESSION_A)
      const body = await readJSON(request)
      promptBodies.push(body)
      appendUser(body.text || "")
      emitBusy()
      json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId })
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
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Preview did not become ready: ${url}`)
}

async function seed(page) {
  await page.addInitScript(({ key, port, machineID }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: machineID,
      name: "OpenCode unmounted durable",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT, machineID: MACHINE_ID })
}

async function waitForRowState(button, state, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await button.evaluate((element, expected) => element.classList.contains(expected), state)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Session row did not become ${state}; class=${await button.getAttribute("class")}`)
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
  try { server?.closeAllConnections?.() } catch {}
  try { server?.close() } catch {}
}

let daemon
let preview
let browser
let context
try {
  resetState()
  daemon = await startDaemon()
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

  const composer = page.getByRole("textbox", { name: "Message OpenCode" })
  await composer.waitFor({ state: "visible", timeout: 5_000 })
  await composer.fill(PROMPT)
  await page.getByRole("button", { name: "Send" }).click()
  const dispatchDeadline = Date.now() + 1_500
  while (Date.now() < dispatchDeadline && promptBodies.length < 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(promptBodies.length, 1, "prompt must dispatch exactly once")
  await waitForRowState(aButton, "working")

  emitTerminalError()
  await waitForRowState(aButton, "attention", 2_500)
  await page.getByText(ERROR, { exact: false }).first().waitFor({ state: "visible", timeout: 2_500 })

  // Opening the same real terminal error must not erase it just because the detail stream mounted.
  await bButton.click()
  await aButton.click()
  await page.getByText(ERROR, { exact: false }).first().waitFor({ state: "visible", timeout: 2_500 })
  await waitForRowState(aButton, "attention", 2_500)

  // Now unmount A again and let only its durable transcript recover. No live event announces success.
  await bButton.click()
  assert.equal(await bButton.getAttribute("aria-current"), "page")
  appendFinalWithoutEvents()
  await page.waitForTimeout(250)
  assert.equal(await aButton.getAttribute("aria-current"), null)

  // Reopening A must inspect the newest native turn, recognize the durable final assistant envelope,
  // retire the older live session.error bridge and render Ready without another provider lifecycle edge.
  await aButton.click()
  await page.getByText(FINAL, { exact: true }).waitFor({ state: "visible", timeout: 4_000 })
  await waitForRowState(aButton, "ready", 4_000)
  assert.equal(await page.getByText(ERROR, { exact: false }).count(), 0, "durable completion after unmount must retire the stale live error")
  assert.equal(await page.getByText(FINAL, { exact: true }).count(), 1, "durable final reply must render exactly once")
  assert.equal(promptBodies.length, 1, "remount recovery must never redispatch the prompt")

  console.log("native OpenCode unmounted durable smoke: true error survives remount, then durable final without events wins on reopen")
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
