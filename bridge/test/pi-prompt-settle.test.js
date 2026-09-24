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
