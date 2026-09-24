import assert from 'node:assert/strict'
import test from 'node:test'

class MemoryStorage {
  #values = new Map()
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
  clear() { this.#values.clear() }
}

const originalStorage = globalThis.localStorage
const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
const storage = new MemoryStorage()
globalThis.window ??= globalThis
globalThis.localStorage = storage

const { api } = await import('./api.ts')
const originalLoadMessagePage = api.loadMessagePage
const originalListStatuses = api.listStatuses
const { registerNativeSessionV3Adapter } = await import('./native-session-v3-adapter.ts')

const CONFIG = {
  backend: 'opencode',
  host: '127.0.0.1',
  port: 4097,
  username: 'harness',
  password: 'pw',
  agentId: 'opencode'
}
const MODEL = { providerID: 'opencode', modelID: 'mimo-v2.5-free' }
const SESSION_ID = 'reasoning-only-session'
const DIRECTORY = '/repo'
const PROMPT = 'What does this software do?'
const FINAL = 'This software controls native coding-agent sessions.'

function target() {
  return {
    key: `machine:opencode:${SESSION_ID}`,
    ref: { machineID: 'machine', agentID: 'opencode', sessionID: SESSION_ID, directory: DIRECTORY },
    machineID: 'machine',
    agentID: 'opencode',
    agentLabel: 'OpenCode',
    backend: 'opencode',
    transport: 'http',
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    title: 'Existing OpenCode Session',
    external: true,
    modelsSupported: true,
    model: MODEL,
    requiresExplicitClaim: false,
    canStop: true,
    config: CONFIG
  }
}

function userMessage() {
  return {
    info: {
      id: 'native-user-1',
      role: 'user',
      sessionID: SESSION_ID,
      time: { created: 1000 },
      model: MODEL
    },
    parts: [{ id: 'native-user-1:text', messageID: 'native-user-1', type: 'text', text: PROMPT }]
  }
}

function reasoningOnlyAssistant() {
  return {
    info: {
      id: 'native-assistant-1',
      role: 'assistant',
      sessionID: SESSION_ID,
      time: { created: 1001, completed: 1002 },
      finish: 'stop',
      providerID: MODEL.providerID,
      modelID: MODEL.modelID
    },
    parts: [{
      id: 'native-assistant-1:reasoning',
      messageID: 'native-assistant-1',
      type: 'reasoning',
      text: 'I should answer the user, but no final answer has been persisted.'
    }]
  }
}

function finalAssistant() {
  return {
    info: {
      id: 'native-assistant-1',
      role: 'assistant',
      sessionID: SESSION_ID,
      time: { created: 1001, completed: 1003 },
      finish: 'stop',
      providerID: MODEL.providerID,
      modelID: MODEL.modelID
    },
    parts: [
      {
        id: 'native-assistant-1:reasoning',
        messageID: 'native-assistant-1',
        type: 'reasoning',
        text: 'I should answer the user.'
      },
      {
        id: 'native-assistant-1:text',
        messageID: 'native-assistant-1',
        type: 'text',
        text: FINAL
      }
    ]
  }
}

test('OpenCode idle + finish=stop + reasoning-only never becomes successful Ready', async () => {
  storage.clear()
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [SESSION_ID]: { type: 'idle' } })
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'accepted', clientRequestId: 'request-1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

  const updates = []
  const registration = registerNativeSessionV3Adapter(target(), (conversation) => updates.push(conversation))
  try {
    // Normal mounted Sessions have already loaded their initial native tail before the user sends.
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)

    const accepted = await registration.controller.continueConversation(
      CONFIG,
      registration.conversation.id,
      { prompt: PROMPT, model: MODEL }
    )
    assert.equal(accepted.status, 'running', 'accepted OpenCode prompt starts optimistically running')

    // This is the real field failure: OpenCode persisted completed reasoning with finish=stop but no
    // user-visible text. It is activity, not proof that the requested turn produced an answer.
    page = { messages: [userMessage(), reasoningOnlyAssistant()], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY, undefined, 200, true)

    const firstIdle = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(firstIdle.status, 'running', 'one idle edge cannot turn reasoning-only activity into success')

    await new Promise((resolve) => setTimeout(resolve, 850))
    const stableIdle = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(
      stableIdle.status,
      'running',
      'even stable native idle cannot report Ready until the durable transcript contains final assistant text'
    )
    assert.equal(stableIdle.error, null, 'the bounded no-final recovery owns eventual failure presentation')

    // Once OpenCode really persists final text, the exact same turn settles normally and immediately.
    page = { messages: [userMessage(), finalAssistant()], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY, undefined, 200, true)
    const completed = updates.at(-1)
    assert.equal(completed.status, 'completed', 'durable final text is authoritative completion proof')
    assert.equal(completed.error, null)
  } finally {
    registration.dispose()
    api.loadMessagePage = originalLoadMessagePage
    api.listStatuses = originalListStatuses
    globalThis.fetch = originalFetch
    if (originalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = originalStorage
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
