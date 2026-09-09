import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

class FakeAcp extends EventEmitter {
  constructor() {
    super()
    this.requests = []
    this.notifications = []
    this.failLoads = 0
    this.promptCapabilities = { image: false }
  }

  async start() {}

  async listSessions() {
    return [{
      sessionId: "native-1",
      cwd: "/repo",
      title: "Native Session",
      updatedAt: "2026-08-24T10:00:00.000Z"
    }]
  }

  async request(method, params) {
    this.requests.push([method, params])
    if (method === "session/load") {
      if (this.failLoads > 0) {
        this.failLoads -= 1
        throw new Error("session is already active in another writer")
      }
      return {
        configOptions: [{
          id: "model",
          currentValue: "model-a",
          options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }]
        }]
      }
    }
    return {}
  }

  notify(method, params) {
    this.notifications.push([method, params])
  }
}

function persistedAssistantMessage() {
  return {
    info: {
      id: "persisted-assistant",
      role: "assistant",
      sessionID: "native-1",
      time: { created: 1 }
    },
    parts: [{ id: "persisted-text", type: "text", text: "Existing native history" }]
  }
}

function journalLoader() {
  const loader = async () => [persistedAssistantMessage()]
  loader.claimOnLoad = false
  return loader
}

function loadRequests(acp) {
  return acp.requests.filter(([method]) => method === "session/load")
}

test("journal observation stays read-only until explicit claim, then prompt reuses the acquired writer", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, { historyLoader: journalLoader() })

  const observed = await service.messages("native-1")
  assert.equal(observed.length, 1)
  assert.equal(loadRequests(acp).length, 0, "reading native journal history must not acquire the ACP writer")
  assert.equal((await service.listSessions())[0].external, true)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1)
  assert.equal((await service.listSessions())[0].external, undefined)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1, "repeated explicit claim must be idempotent")

  await service.prompt("native-1", "Continue in this exact Session")
  assert.equal(loadRequests(acp).length, 1, "the first prompt after claim must not acquire the writer again")
  assert.equal(acp.requests.filter(([method]) => method === "session/prompt").length, 1)
})

test("failed writer acquisition does not leave phantom ownership and can be retried", async () => {
  const acp = new FakeAcp()
  acp.failLoads = 1
  const service = new AcpService(acp, { historyLoader: journalLoader() })

  await service.messages("native-1")
  await assert.rejects(
    () => service.claimSession("native-1"),
    /active in another writer/
  )
  assert.equal(loadRequests(acp).length, 1)
  assert.equal((await service.listSessions())[0].external, true)
  assert.throws(() => service.abort("native-1"), /not active in the app/)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 2)
  assert.doesNotThrow(() => service.abort("native-1"))
  assert.deepEqual(acp.notifications.at(-1), ["session/cancel", { sessionId: "native-1" }])
})

test("compatibility adoption never substitutes for a real Session-first writer claim", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, { historyLoader: journalLoader() })

  assert.equal(await service.adoptTaskSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 0)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1, "an adopted Task session must still perform native session/load when explicitly claimed")
})

test("an ACP Session already opened successfully by this daemon can be claimed without a second load", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp)

  await service.messages("native-1")
  assert.equal(loadRequests(acp).length, 1)
  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1)
})

test("release preserves history and subsequent metadata reads do not reclaim the writer", async () => {
  const acp = new FakeAcp()
  const historyLoader = journalLoader()
  historyLoader.readOnlyExternalMetadata = true
  const service = new AcpService(acp, { historyLoader })
  await service.claimSession("native-1")
  assert.deepEqual(await service.releaseSession("native-1"), { released: true, sessionID: "native-1" })
  assert.deepEqual(acp.requests.at(-1), ["session/close", { sessionId: "native-1" }])
  assert.deepEqual(await service.releaseSession("native-1"), { released: true, sessionID: "native-1" })
  const loadsBeforeRead = loadRequests(acp).length
  assert.equal((await service.listSessions())[0].external, true)
  assert.deepEqual(await service.models("native-1"), [])
  assert.deepEqual(await service.commands("native-1"), [])
  assert.deepEqual(await service.actions("native-1"), [])
  assert.equal((await service.messages("native-1")).length, 1)
  assert.equal(loadRequests(acp).length, loadsBeforeRead, "read-only metadata must not reacquire the writer")
})

test("claim refuses a native Session that no longer exists", async () => {
  const acp = new FakeAcp()
  acp.listSessions = async () => []
  const service = new AcpService(acp)
  await assert.rejects(() => service.claimSession("missing"), /Harness session not found/)
  assert.equal(loadRequests(acp).length, 0)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("release fences all mutations and failed close leaves ownership available for retry", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, { historyLoader: journalLoader() })
  await service.claimSession("native-1")
  const close = deferred()
  const request = acp.request.bind(acp)
  acp.request = (method, params) => method === "session/close" ? close.promise : request(method, params)
  const releasing = service.releaseSession("native-1")
  for (const mutation of [
    () => service.claimSession("native-1"),
    () => service.prompt("native-1", "must not send"),
    () => service.setModel("native-1", "model-a"),
    () => service.renameSession("native-1", "must not rename"),
    () => service.deleteSession("native-1"),
    () => service.invokeAction("native-1", "undo")
  ]) await assert.rejects(mutation, /release is in progress/)
  close.reject(new Error("native child still shutting down"))
  await assert.rejects(releasing, /still shutting down/)
  assert.equal((await service.listSessions())[0].external, undefined)
  acp.request = request
  await service.releaseSession("native-1")
  assert.equal((await service.listSessions())[0].external, true)
})

test("release cannot report success while an external claim is still loading", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, { historyLoader: journalLoader() })
  const load = deferred(), entered = deferred()
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    if (method === "session/load") { entered.resolve(); await load.promise }
    return request(method, params)
  }
  const claiming = service.claimSession("native-1")
  await entered.promise
  await assert.rejects(service.releaseSession("native-1"), /busy/)
  load.resolve(); await claiming
  await service.releaseSession("native-1")
})

test("release rejects a prompt awaiting model selection before the turn becomes active", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, { historyLoader: journalLoader() })
  await service.claimSession("native-1")
  const model = deferred(), entered = deferred()
  const request = acp.request.bind(acp)
  acp.request = async (method, params) => {
    if (method === "session/set_config_option") { entered.resolve(); await model.promise }
    return request(method, params)
  }
  const prompting = service.prompt("native-1", "hello", "model-b")
  await entered.promise
  await assert.rejects(service.releaseSession("native-1"), /busy/)
  model.resolve(); await prompting
})
