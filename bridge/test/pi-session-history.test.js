import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { createPiHistoryLoader } from "../src/pi-session-history.js"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "harness-pi-history-"))
  const project = path.join(root, "project")
  await mkdir(project, { recursive: true })
  const sessionID = "01pi-session"
  const file = path.join(project, `2026-08-18T00-00-00-000Z_${sessionID}.jsonl`)
  const records = [
    { type: "session", version: 3, id: sessionID, timestamp: "2026-08-18T10:00:00.000Z", cwd: project },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-18T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-18T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Complete PI answer" }] } },
    { type: "session_info", id: "n1", parentId: "a1", timestamp: "2026-08-18T10:00:03.000Z", name: "PI native title" }
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  return { root, project, sessionID, file }
}

function visible(messages) {
  return messages.map((message) => ({ role: message.info.role, text: message.parts.map((part) => part.text ?? "").join("") }))
}

test("PI journal loader reads the authoritative current branch without opening ACP", async () => {
  const { root, sessionID } = await fixture()
  const loader = createPiHistoryLoader(root)
  assert.deepEqual(visible(await loader(sessionID)), [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Complete PI answer" }
  ])
})

test("PI journal loader follows the current leaf instead of replaying abandoned branches", async () => {
  const { root, sessionID, file } = await fixture()
  const records = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  records.splice(3, 0, {
    type: "message",
    id: "abandoned",
    parentId: "u1",
    timestamp: "2026-08-18T10:00:02.500Z",
    message: { role: "assistant", content: [{ type: "text", text: "Abandoned branch" }] }
  })
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  const loader = createPiHistoryLoader(root)
  assert.deepEqual(visible(await loader(sessionID)), [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Complete PI answer" }
  ])
})

test("PI journal pager follows only the active branch across cursor pages", async () => {
  const { root, sessionID, file, project } = await fixture()
  const records = [
    { type: "session", version: 3, id: sessionID, parentId: null, timestamp: "2026-08-18T10:00:00.000Z", cwd: project },
    { type: "message", id: "u0", parentId: sessionID, timestamp: "2026-08-18T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "u0" }] } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-08-18T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "a0" }] } },
    { type: "message", id: "abandoned-a", parentId: "u0", timestamp: "2026-08-18T10:00:02.500Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-08-18T10:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "u1" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-18T10:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } },
    { type: "session_info", id: "n1", parentId: "a1", timestamp: "2026-08-18T10:00:05.000Z", name: "PI native title" },
    { type: "message", id: "u2", parentId: "n1", timestamp: "2026-08-18T10:00:06.000Z", message: { role: "user", content: [{ type: "text", text: "u2" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-08-18T10:00:07.000Z", message: { role: "assistant", content: [{ type: "text", text: "a2" }] } },
    { type: "session_info", id: "n2", parentId: "a2", timestamp: "2026-08-18T10:00:08.000Z", name: "PI final title" }
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")

  const loader = createPiHistoryLoader(root)
  const full = visible(await loader(sessionID))
  assert.deepEqual(full.map((entry) => entry.text), ["u0", "a0", "u1", "a1", "u2", "a2"])

  const first = await loader.page(sessionID, { limit: 2 })
  assert.deepEqual(visible(first.messages).map((entry) => entry.text), ["u2", "a2"])
  assert.equal(first.hasMore, true)
  assert.ok(first.before)

  const second = await loader.page(sessionID, { limit: 2, before: first.before })
  assert.deepEqual(visible(second.messages).map((entry) => entry.text), ["u1", "a1"])
  assert.equal(second.hasMore, true)
  assert.ok(second.before)

  const third = await loader.page(sessionID, { limit: 2, before: second.before })
  assert.deepEqual(visible(third.messages).map((entry) => entry.text), ["u0", "a0"])
  assert.equal(third.hasMore, false)
  assert.equal(third.before, null)

  const ids = [...third.messages, ...second.messages, ...first.messages].map((message) => message.info.id)
  assert.equal(new Set(ids).size, 6, "cursor pages must not duplicate a PI message")
})

test("PI journal pager rejects invalid cursors instead of silently changing branches", async () => {
  const { root, sessionID } = await fixture()
  const loader = createPiHistoryLoader(root)
  await assert.rejects(() => loader.page(sessionID, { before: "not-a-valid-cursor", limit: 2 }), /Invalid PI history cursor/)
  const impossible = Buffer.from(JSON.stringify({ offset: 0, target: "missing-parent" }), "utf8").toString("base64url")
  await assert.rejects(() => loader.page(sessionID, { before: impossible, limit: 2 }), /Invalid PI history cursor/)
})

// Regression: a provider failure can leave ACP replay incomplete even though PI's journal is complete.
test("PI journal stays authoritative after an ACP load when a provider error was retried", async () => {
  const { root, sessionID, file } = await fixture()
  const records = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  records.splice(2, 2,
    {
      type: "message",
      id: "a-error",
      parentId: "u1",
      timestamp: "2026-08-18T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Partial reasoning before provider failure" }],
        stopReason: "error",
        errorMessage: "Streaming response failed: [502] Upstream error from NVidia: Internal server error"
      }
    },
    {
      type: "message",
      id: "a-retry",
      parentId: "a-error",
      timestamp: "2026-08-18T10:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }], stopReason: "stop" }
    },
    {
      type: "message",
      id: "u2",
      parentId: "a-retry",
      timestamp: "2026-08-18T10:00:04.000Z",
      message: { role: "user", content: [{ type: "text", text: "Follow-up" }] }
    },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "2026-08-18T10:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Follow-up answer" }], stopReason: "stop" }
    },
    { type: "session_info", id: "n2", parentId: "a2", timestamp: "2026-08-18T10:00:06.000Z", name: "PI native title" }
  )
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")

  const loader = createPiHistoryLoader(root)
  class PartialReplayPiAcp extends StrictPiAcp {
    async request(method, params) {
      if (method === "session/load") {
        if (this.open) throw new Error("Invalid params: session already open")
        this.open = true
        this.loads += 1
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "user_message_chunk", messageId: "replayed-user", content: { type: "text", text: "First prompt" } }
          }
        })
        return { configOptions: [{ id: "model", currentValue: "pi-model", options: [{ value: "pi-model", name: "PI model" }] }] }
      }
      return super.request(method, params)
    }
  }
  const session = { root, sessionID, file, project: path.dirname(file) }
  const acp = new PartialReplayPiAcp(loader, session)
  const service = new AcpService(acp, { historyLoader: loader, reloadOnHistoryRefresh: false, preferListedTitles: true })

  const expected = [
    { role: "user", text: "First prompt" },
    { role: "assistant", text: "Partial reasoning before provider failure" },
    { role: "assistant", text: "Recovered answer" },
    { role: "user", text: "Follow-up" },
    { role: "assistant", text: "Follow-up answer" }
  ]
  assert.deepEqual(visible(await service.messages(sessionID, true)), expected)
  await service.models(sessionID)
  assert.equal(acp.loads, 1)
  assert.deepEqual(visible(await service.messages(sessionID, true)), expected,
    "opening PI via ACP for models must not replace the journal with a partial replay")
})

test("PI journal rename appends the same session_info record PI list/resume uses", async () => {
  const { root, sessionID, file } = await fixture()
  const loader = createPiHistoryLoader(root)
  await loader.renameSession(sessionID, "Renamed from Harness Remote")
  const records = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  const renamed = records.at(-1)
  assert.equal(renamed.type, "session_info")
  assert.equal(renamed.name, "Renamed from Harness Remote")
  assert.equal(renamed.parentId, "n1")
})

class StrictPiAcp extends EventEmitter {
  constructor(loader, session) {
    super()
    this.loader = loader
    this.session = session
    this.open = false
    this.loads = 0
    this.closes = 0
    this.prompts = 0
    this.promptCapabilities = {}
  }
  async listSessions() {
    const records = (await readFile(this.session.file, "utf8")).trim().split("\n").map(JSON.parse)
    const title = [...records].reverse().find((record) => record.type === "session_info")?.name
    return [{ sessionId: this.session.sessionID, cwd: this.session.project, title, updatedAt: new Date().toISOString() }]
  }
  async request(method, params) {
    if (method === "session/load") {
      if (this.open) throw new Error("Invalid params: session already open")
      this.open = true
      this.loads += 1
      return { configOptions: [{ id: "model", currentValue: "pi-model", options: [{ value: "pi-model", name: "PI model" }] }] }
    }
    if (method === "session/close") {
      this.open = false
      this.closes += 1
      return {}
    }
    if (method === "session/prompt") {
      if (!this.open) throw new Error("Invalid params: unknown session")
      this.prompts += 1
      return { stopReason: "end_turn" }
    }
    throw new Error(`Unexpected request: ${method}`)
  }
  notify() {}
}

test("PI open, model load, refresh, rename and prompt never double-open the ACP session", async () => {
  const session = await fixture()
  const loader = createPiHistoryLoader(session.root)
  const acp = new StrictPiAcp(loader, session)
  const service = new AcpService(acp, {
    historyLoader: loader,
    reloadOnHistoryRefresh: false,
    preferListedTitles: true
  })

  assert.equal((await service.messages(session.sessionID, true)).length, 2)
  assert.equal(acp.loads, 0, "reading PI history must not open the ACP session")

  assert.equal((await service.models(session.sessionID)).length, 1)
  assert.equal(acp.loads, 1, "model discovery may open PI once")
  assert.equal((await service.messages(session.sessionID, true)).length, 2)
  assert.equal(acp.loads, 1, "history refresh must not session/load an already open PI session")

  const renamed = await service.renameSession(session.sessionID, "Renamed from app")
  assert.equal(renamed.title, "Renamed from app")
  assert.equal(acp.closes, 1, "rename closes a live PI session before touching its journal")
  assert.equal(acp.open, false)

  await service.prompt(session.sessionID, "Next prompt")
  assert.equal(acp.loads, 2, "the next prompt reopens PI exactly once")
  assert.equal(acp.prompts, 1)
})

test("PI recovers a Session's activity time from its journal because the adapter omits updatedAt", async () => {
  const { root, sessionID, file } = await fixture()
  const loader = createPiHistoryLoader(root)
  assert.equal(await loader.sessionUpdatedAt("not a session id"), undefined)
  assert.equal(await loader.sessionUpdatedAt("01missing"), undefined)

  const activity = new Date("2026-09-20T08:30:00.000Z")
  await utimes(file, activity, activity)
  // A new loader so the assertion observes the on-disk time rather than the previous index.
  assert.equal(await createPiHistoryLoader(root).sessionUpdatedAt(sessionID), activity.toISOString())
})

test("PI lists the working directories its journals recorded so projects need no configured root", async () => {
  const { root, sessionID, project } = await fixture()
  const second = path.join(root, "other-project")
  await mkdir(second, { recursive: true })
  await writeFile(
    path.join(second, `2026-08-19T00-00-00-000Z_01pi-second.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: "01pi-second", timestamp: "2026-08-19T10:00:00.000Z", cwd: second })}\n`
  )
  const loader = createPiHistoryLoader(root)
  assert.deepEqual((await loader.listSessionDirectories()).sort(), [project, second].sort())
})
