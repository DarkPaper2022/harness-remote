import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createSessionClaimServer } from "../src/session-claim-server.js"
import { SessionOperationLedger } from "../src/session-operation-ledger.js"

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function withLedger(run) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-session-route-"))
  try {
    const ledger = new SessionOperationLedger({ machineID: "machine-test", stateDirectory })
    return await run(ledger)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
}

function promptBody(overrides = {}) {
  return {
    clientRequestId: "request-1",
    text: "Continue the native session once",
    directory: "/repo",
    ...overrides
  }
}

function commandBody(overrides = {}) {
  return {
    clientRequestId: "command-request-1",
    command: "help",
    arguments: "models",
    directory: "/repo",
    ...overrides
  }
}

function stopBody(overrides = {}) {
  return {
    clientRequestId: "stop-request-1",
    directory: "/repo",
    operationToken: "turn-message-42",
    ...overrides
  }
}

async function postPrompt(port, body = promptBody()) {
  return fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
}

async function postCommand(port, body = commandBody()) {
  return fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
}

async function postStop(port, body = stopBody()) {
  return fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
}

async function postRelease(port, body = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
}

test("native Session release authenticates, succeeds, and maps release conflicts to 409", async () => withLedger(async (operationLedger) => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "user", password: "secret", corsOrigins: [] },
    operationLedger,
    async releaseSession(agentID, sessionID) { calls.push([agentID, sessionID]) }
  })
  const port = await listen(server)
  try {
    const unauthorized = await postRelease(port)
    assert.equal(unauthorized.status, 401)
    const success = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/release`, {
      method: "POST", headers: { Authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`, "Content-Type": "application/json" }, body: "{}"
    })
    assert.equal(success.status, 200)
    assert.deepEqual(await success.json(), { released: true, sessionID: "native-123" })
    assert.deepEqual(calls, [["codex", "native-123"]])
  } finally { await close(server) }
}))

test("native Session release reports a conflict", async () => {
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(), config: { username: "", password: "", corsOrigins: [] },
    async releaseSession() { const error = new Error("Cannot release a busy Session"); error.code = "session_release_rejected"; throw error }
  })
  const port = await listen(server)
  try { assert.equal((await postRelease(port)).status, 409) } finally { await close(server) }
})

test("native Session claim targets the exact agent and existing Session id", async () => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession(agentID, sessionID) { calls.push([agentID, sessionID]) }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-123/claim`, { method: "POST" })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { claimed: true, sessionID: "native-123" })
    assert.deepEqual(calls, [["codex", "native-123"]])
  } finally {
    await close(server)
  }
})

test("native writer refusal is a conflict and never falls through to another route", async () => {
  const innerServer = new EventEmitter()
  let delegated = false
  innerServer.on("request", () => { delegated = true })
  const server = createSessionClaimServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() { throw new Error("session is already active in another writer") }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/session/native-locked/claim`, { method: "POST" })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /active in another writer/)
    assert.equal(delegated, false)
  } finally {
    await close(server)
  }
})

test("replaying one accepted client request id dispatches one native prompt", async () => withLedger(async (operationLedger) => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession(agentID, sessionID, input) { calls.push([agentID, sessionID, input.text, input.directory]) }
  })
  const port = await listen(server)
  try {
    const first = await postPrompt(port)
    const replay = await postPrompt(port)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal((await replay.json()).status, "accepted")
    assert.deepEqual(calls, [["codex", "native-123", "Continue the native session once", "/repo"]])
  } finally {
    await close(server)
  }
}))

test("replaying one accepted slash command dispatches once and changed arguments conflict", async () => withLedger(async (operationLedger) => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async commandSession(agentID, sessionID, input) {
      calls.push([agentID, sessionID, input.command, input.arguments, input.directory])
    }
  })
  const port = await listen(server)
  try {
    const first = await postCommand(port)
    const replay = await postCommand(port)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.deepEqual(calls, [["codex", "native-123", "help", "models", "/repo"]])

    const conflict = await postCommand(port, commandBody({ arguments: "agents" }))
    assert.equal(conflict.status, 409)
    assert.equal(calls.length, 1)
  } finally {
    await close(server)
  }
}))

test("native Session prompt validates and includes image attachments in the idempotent operation", async () => withLedger(async (operationLedger) => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession(agentID, sessionID, input) { calls.push([agentID, sessionID, input.attachments]) }
  })
  const port = await listen(server)
  const attachment = { mime: "image/png", filename: "screen.png", url: "data:image/png;base64,aGVsbG8=" }
  try {
    const first = await postPrompt(port, promptBody({ attachments: [attachment] }))
    assert.equal(first.status, 200)
    assert.deepEqual(calls, [["codex", "native-123", [attachment]]])

    const replay = await postPrompt(port, promptBody({ attachments: [attachment] }))
    assert.equal(replay.status, 200)
    assert.equal(calls.length, 1)

    const conflict = await postPrompt(port, promptBody({
      attachments: [{ ...attachment, url: "data:image/png;base64,d29ybGQ=" }]
    }))
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /already used for a different native Session operation/)
    assert.equal(calls.length, 1)
  } finally {
    await close(server)
  }
}))

test("native Session prompt rejects unsupported or oversized attachment input before dispatch", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() { dispatches += 1 }
  })
  const port = await listen(server)
  try {
    const unsupported = await postPrompt(port, promptBody({
      attachments: [{ mime: "text/plain", filename: "note.txt", url: "data:text/plain;base64,aGVsbG8=" }]
    }))
    assert.equal(unsupported.status, 400)

    const malformed = await postPrompt(port, promptBody({
      attachments: [{ mime: "image/png", filename: "screen.png", url: "https://example.invalid/image.png" }]
    }))
    assert.equal(malformed.status, 400)
    assert.equal(dispatches, 0)
  } finally {
    await close(server)
  }
}))

test("concurrent retries converge before a second native prompt can start", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  let releaseDispatch
  let markStarted
  const dispatchStarted = new Promise((resolve) => { markStarted = resolve })
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve })
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() {
      dispatches += 1
      markStarted()
      await dispatchGate
    }
  })
  const port = await listen(server)
  try {
    const firstPromise = postPrompt(port)
    await dispatchStarted
    const retry = await postPrompt(port)
    assert.equal(retry.status, 202)
    assert.equal((await retry.json()).status, "pending")
    assert.equal(dispatches, 1)

    releaseDispatch()
    const first = await firstPromise
    assert.equal(first.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal(dispatches, 1)
  } finally {
    releaseDispatch?.()
    await close(server)
  }
}))

test("same client request id with different prompt is rejected without redispatch", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() { dispatches += 1 }
  })
  const port = await listen(server)
  try {
    assert.equal((await postPrompt(port)).status, 200)
    const conflict = await postPrompt(port, promptBody({ text: "A different prompt" }))
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /already used for a different native Session operation/)
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("ambiguous native delivery is retained as uncertain and is never replayed", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() {
      dispatches += 1
      const error = new Error("native transport disconnected after dispatch")
      error.ambiguous = true
      throw error
    }
  })
  const port = await listen(server)
  try {
    const first = await postPrompt(port)
    assert.equal(first.status, 202)
    assert.equal((await first.json()).status, "uncertain")
    const replay = await postPrompt(port)
    assert.equal(replay.status, 202)
    assert.equal((await replay.json()).status, "uncertain")
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("definite pre-accept rejection removes the ledger entry so the same request can retry", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async promptSession() {
      dispatches += 1
      if (dispatches === 1) {
        const error = new Error("native Session rejected before prompt acceptance")
        error.code = "session_prompt_rejected"
        throw error
      }
    }
  })
  const port = await listen(server)
  try {
    const rejected = await postPrompt(port)
    assert.equal(rejected.status, 409)
    const retry = await postPrompt(port)
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).status, "accepted")
    assert.equal(dispatches, 2)
  } finally {
    await close(server)
  }
}))

test("replaying one accepted Stop request dispatches one native cancel", async () => withLedger(async (operationLedger) => {
  const calls = []
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession(agentID, sessionID, input) { calls.push([agentID, sessionID, input.directory, input.operationToken]) }
  })
  const port = await listen(server)
  try {
    const first = await postStop(port)
    const replay = await postStop(port)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal((await replay.json()).status, "accepted")
    assert.deepEqual(calls, [["codex", "native-123", "/repo", "turn-message-42"]])
  } finally {
    await close(server)
  }
}))

test("concurrent Stop retries converge before a second native cancel can start", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  let releaseDispatch
  let markStarted
  const dispatchStarted = new Promise((resolve) => { markStarted = resolve })
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve })
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() {
      dispatches += 1
      markStarted()
      await dispatchGate
    }
  })
  const port = await listen(server)
  try {
    const firstPromise = postStop(port)
    await dispatchStarted
    const retry = await postStop(port)
    assert.equal(retry.status, 202)
    assert.equal((await retry.json()).status, "pending")
    assert.equal(dispatches, 1)

    releaseDispatch()
    const first = await firstPromise
    assert.equal(first.status, 200)
    assert.equal((await first.json()).status, "accepted")
    assert.equal(dispatches, 1)
  } finally {
    releaseDispatch?.()
    await close(server)
  }
}))

test("a Stop request id cannot be reused for a later turn token", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() { dispatches += 1 }
  })
  const port = await listen(server)
  try {
    assert.equal((await postStop(port)).status, 200)
    const conflict = await postStop(port, stopBody({ operationToken: "later-turn-message-99" }))
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /already used for a different native Session operation/)
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("ambiguous Stop delivery is retained as uncertain and never replayed", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() {
      dispatches += 1
      const error = new Error("cancel transport disconnected after dispatch")
      error.ambiguous = true
      throw error
    }
  })
  const port = await listen(server)
  try {
    const first = await postStop(port)
    assert.equal(first.status, 202)
    assert.equal((await first.json()).status, "uncertain")
    const replay = await postStop(port)
    assert.equal(replay.status, 202)
    assert.equal((await replay.json()).status, "uncertain")
    assert.equal(dispatches, 1)
  } finally {
    await close(server)
  }
}))

test("Stop before ACP claim is a conflict and never becomes accepted", async () => withLedger(async (operationLedger) => {
  let dispatches = 0
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {},
    operationLedger,
    async stopSession() {
      dispatches += 1
      const error = new Error("native Session must be claimed before Stop")
      error.code = "session_not_claimed"
      throw error
    }
  })
  const port = await listen(server)
  try {
    const rejected = await postStop(port)
    assert.equal(rejected.status, 409)
    assert.equal(dispatches, 1)
    const retry = await postStop(port)
    assert.equal(retry.status, 409)
    assert.equal(dispatches, 2)
  } finally {
    await close(server)
  }
}))

test("unknown agent maps to 404 and unrelated requests delegate unchanged", async () => {
  const innerServer = new EventEmitter()
  innerServer.on("request", (_request, response) => {
    response.writeHead(204)
    response.end()
  })
  const server = createSessionClaimServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {
      const error = new Error("Unknown agent: missing")
      error.code = "unknown_agent"
      throw error
    }
  })
  const port = await listen(server)
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/v1/agents/missing/session/native-1/claim`, { method: "POST" })
    assert.equal(missing.status, 404)
    const delegated = await fetch(`http://127.0.0.1:${port}/v1/projects`)
    assert.equal(delegated.status, 204)
  } finally {
    await close(server)
  }
})

test("native Session operation routes accept POST only", async () => {
  const server = createSessionClaimServer({
    innerServer: new EventEmitter(),
    config: { username: "", password: "", corsOrigins: [] },
    async claimSession() {}
  })
  const port = await listen(server)
  try {
    for (const action of ["claim", "prompt", "command", "stop", "release"]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/agents/pi/session/native-1/${action}`)
      assert.equal(response.status, 405)
      assert.equal(response.headers.get("allow"), "POST, OPTIONS")
    }
  } finally {
    await close(server)
  }
})
