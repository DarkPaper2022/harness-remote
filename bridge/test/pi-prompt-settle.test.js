import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { AcpService } from "../src/acp-service.js"

const SESSION = "pi-prompt-settle"

class PiPromptTailAcp extends EventEmitter {
  async start() {}

  async listSessions() {
    return [{ sessionId: SESSION, cwd: process.cwd(), title: "PI prompt tail", updatedAt: new Date().toISOString() }]
  }

  async request(method, params) {
    if (method === "session/load") return { configOptions: [] }
    if (method !== "session/prompt") throw new Error(`Unexpected request: ${method}`)

    // PI can resolve the RPC before its final notifications have crossed stdout.
    setTimeout(() => {
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", messageId: "pi-answer", content: { type: "text", text: "Thinking" } }
        }
      })
      this.emit("notification", {
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: "pi-answer", content: { type: "text", text: "Done" } }
        }
      })
    }, 10)
    return {}
  }
}

test("PI prompt drain closes late reasoning after session/prompt resolves", async () => {
  const service = new AcpService(new PiPromptTailAcp(), { promptSettleMs: 40 })
  await service.prompt(SESSION, "answer")
  await new Promise((resolve) => setTimeout(resolve, 80))

  const assistant = (await service.messages(SESSION)).find((message) => message.info.role === "assistant")
  const reasoning = assistant?.parts.find((part) => part.type === "reasoning")
  assert.ok(reasoning?.time?.start, "late PI reasoning was retained")
  assert.ok(reasoning?.time?.end, "late PI reasoning was closed after the prompt drain")
  assert.deepEqual(service.status(SESSION), { type: "idle" })
})

test("PI with authoritative journal and resume capability resumes instead of replaying", async () => {
  const calls = []
  class PiResumeAcp extends EventEmitter {
    sessionCapabilities = { resume: {} }
    async start() {}
    async listSessions() {
      return [{ sessionId: "pi-resume-session", cwd: process.cwd(), title: "PI resume", updatedAt: new Date().toISOString() }]
    }
    async request(method, params) {
      calls.push({ method, params })
      if (method === "session/resume") return { configOptions: [{ id: "model", currentValue: "zjupl/deepseek-v4-pro" }] }
      if (method === "session/prompt") return {}
      throw new Error(`Unexpected request: ${method}`)
    }
  }

  const historyLoader = async () => [
    { info: { id: "m1", role: "user", sessionID: "pi-resume-session", time: { created: 1000 } }, parts: [{ type: "text", text: "Hello" }] }
  ]
  historyLoader.authoritativeHistory = true
  historyLoader.claimOnLoad = true

  const service = new AcpService(new PiResumeAcp(), { historyLoader })
  await service.prompt("pi-resume-session", "Next prompt")

  assert.ok(calls.some((c) => c.method === "session/resume"), "must call session/resume")
  assert.ok(!calls.some((c) => c.method === "session/load"), "must NOT call session/load")
  const messages = await service.messages("pi-resume-session")
  assert.equal(messages[0].parts[0].text, "Hello", "preserves history from authoritative loader")
})

test("PI open session does not double-resume when commands or prompts run", async () => {
  const calls = []
  class PiActiveAcp extends EventEmitter {
    processID = 1234
    sessionCapabilities = { resume: true }
    promptCapabilities = {}
    async start() {}
    async request(method, params) {
      calls.push({ method, params })
      if (method === "session/new") return { sessionId: "new-pi-session", configOptions: [] }
      if (method === "session/resume") return { configOptions: [] }
      if (method === "session/prompt") return {}
      throw new Error(`Unexpected request: ${method}`)
    }
  }

  const historyLoader = async () => []
  historyLoader.authoritativeHistory = true
  historyLoader.claimOnLoad = true

  const service = new AcpService(new PiActiveAcp(), { historyLoader })
  const created = await service.createSession({ directory: "/test", title: "New" })
  assert.equal(created.id, "new-pi-session")

  const cmds = await service.commands("new-pi-session")
  assert.deepEqual(cmds, [])

  // session/new already opened the session, so commands must not call session/resume
  assert.equal(calls.filter((c) => c.method === "session/resume").length, 0)
  assert.equal(calls.filter((c) => c.method === "session/load").length, 0)

  // Subsequent prompt runs directly
  await service.prompt("new-pi-session", "Test prompt")
  assert.equal(calls.filter((c) => c.method === "session/resume").length, 0)
  assert.equal(calls.filter((c) => c.method === "session/prompt").length, 1)
})

