import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkThreadTimeline } from "./work-thread-timeline.ts"
import { openCodeAssistantHasActivity, openCodeAssistantProvesTurnCompleted } from "./native-session-opencode-reconciliation.ts"

function message(id, role, text, error) {
  return {
    info: {
      id,
      sessionID: "session-opencode",
      role,
      time: { created: Number(id.replace(/\D/g, "")) || 1 },
      ...(error ? { error: { name: "ResponseInterrupted", message: error } } : {})
    },
    parts: text ? [{ id: `${id}:text`, messageID: id, type: "text", text }] : []
  }
}

function task(status = "completed") {
  const run = {
    id: "run-1",
    sequence: 1,
    agentId: "opencode",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    sessionId: "session-opencode",
    status,
    transport: "http",
    directory: "/repo",
    prompt: "Explain the change",
    startedAt: "2026-08-25T16:00:00.000Z",
    finishedAt: status === "completed" ? "2026-08-25T16:01:00.000Z" : undefined
  }
  return {
    id: "task-opencode",
    machineId: "machine-1",
    projectId: "project-1",
    project: { name: "Harness Remote", path: "/repo", kind: "git" },
    agentId: "opencode",
    prompt: run.prompt,
    model: run.model,
    status,
    workspace: { mode: "inplace", path: "/repo" },
    run,
    runs: [run],
    createdAt: run.startedAt,
    updatedAt: run.finishedAt || run.startedAt
  }
}

const agents = { opencode: { label: "OpenCode", backend: "opencode" } }

function assistantEnvelope({ role = "assistant", finish, completed, error, parts = [] } = {}) {
  return {
    info: {
      id: "assistant-envelope",
      sessionID: "session-opencode",
      role,
      time: { created: 1, ...(completed ? { completed: 2 } : {}) },
      ...(finish === undefined ? {} : { finish }),
      ...(error ? { error: { name: "ProviderError", message: error } } : {})
    },
    parts
  }
}

test("OpenCode turn completion requires final text even when the envelope says stop", () => {
  for (const finish of ["tool", "tool-call", "tool-calls", "tool_calls", "  TOOL-CALLS  "]) {
    assert.equal(
      openCodeAssistantProvesTurnCompleted(assistantEnvelope({ finish })),
      false,
      `${finish} is only an intermediate tool step`
    )
  }

  for (const parts of [
    [],
    [{ id: "reasoning", type: "reasoning", text: "I should answer the user now" }],
    [{ id: "step", type: "step-finish" }]
  ]) {
    assert.equal(
      openCodeAssistantProvesTurnCompleted(assistantEnvelope({ finish: "stop", parts })),
      false,
      "a real OpenCode stop marker without user-visible final text must not turn the Session Ready"
    )
  }

  assert.equal(
    openCodeAssistantProvesTurnCompleted(assistantEnvelope({ finish: "stop", parts: [{ id: "text", type: "text", text: "Final answer" }] })),
    true
  )
  assert.equal(
    openCodeAssistantProvesTurnCompleted(assistantEnvelope({ finish: "end_turn", parts: [{ id: "text", type: "text", text: "Final answer" }] })),
    true
  )
  assert.equal(
    openCodeAssistantProvesTurnCompleted(assistantEnvelope({ finish: "stop", error: "provider retry", parts: [{ id: "text", type: "text", text: "partial" }] })),
    false,
    "a provider error may still be followed by an automatic retry"
  )
  assert.equal(
    openCodeAssistantProvesTurnCompleted(assistantEnvelope({ role: "user", finish: "stop", parts: [{ id: "text", type: "text", text: "prompt" }] })),
    false,
    "only assistant envelopes can prove assistant completion"
  )
})

test("OpenCode completed timestamps require terminal assistant text", () => {
  assert.equal(
    openCodeAssistantProvesTurnCompleted(assistantEnvelope({
      completed: true,
      parts: [
        { id: "text", type: "text", text: "Final answer" },
        { id: "step", type: "step-finish" }
      ]
    })),
    true,
    "structural tail parts must not hide terminal assistant text"
  )

  for (const parts of [
    [],
    [{ id: "text", type: "text", text: "   " }],
    [{ id: "reasoning", type: "reasoning", text: "still thinking" }],
    [{ id: "tool", type: "tool", callID: "call-1" }]
  ]) {
    assert.equal(
      openCodeAssistantProvesTurnCompleted(assistantEnvelope({ completed: true, parts })),
      false,
      "completed metadata without terminal text must stay non-terminal"
    )
  }
})

test("OpenCode activity keeps empty assistant envelopes in the silent phase", () => {
  assert.equal(openCodeAssistantHasActivity(assistantEnvelope()), false)
  assert.equal(openCodeAssistantHasActivity(assistantEnvelope({ parts: [{ id: "step", type: "step-start" }] })), true)
  assert.equal(openCodeAssistantHasActivity(assistantEnvelope({ finish: "tool-calls" })), true)
  assert.equal(openCodeAssistantHasActivity(assistantEnvelope({ finish: "stop", parts: [{ id: "reasoning", type: "reasoning", text: "thinking" }] })), true)
  assert.equal(openCodeAssistantHasActivity(assistantEnvelope({ error: "provider error" })), true)
  assert.equal(
    openCodeAssistantHasActivity(assistantEnvelope({ role: "user", parts: [{ id: "text", type: "text", text: "prompt" }] })),
    false
  )
})

test("a later successful OpenCode assistant envelope clears an earlier interrupted attempt", () => {
  const timeline = buildWorkThreadTimeline(task(), {
    "session-opencode": [
      message("u1", "user", "Explain the change"),
      message("a2", "assistant", undefined, "response interrupted"),
      message("a3", "assistant", "The response recovered and completed normally.")
    ]
  }, agents)
  const assistant = timeline.find((entry) => entry.info.role === "assistant")
  assert.equal(assistant.info.error, undefined)
  assert.equal(assistant.parts.some((part) => part.type === "text" && part.text.includes("recovered")), true)
})

test("a genuinely terminal OpenCode interruption remains visible", () => {
  const timeline = buildWorkThreadTimeline(task("failed"), {
    "session-opencode": [
      message("u1", "user", "Explain the change"),
      message("a2", "assistant", undefined, "response interrupted")
    ]
  }, agents)
  const assistant = timeline.find((entry) => entry.info.role === "assistant")
  assert.equal(assistant.info.error?.message, "response interrupted")
})
