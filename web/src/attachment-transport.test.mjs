import assert from 'node:assert/strict'
import { api } from './api.ts'
import { attachmentPart } from './attachments.ts'

// Behavioral replacement for the old source-text guard in attachments.test.mjs: exercise the real
// lower-level prompt API and inspect the wire body that would be sent to the harness bridge.
const originalFetch = globalThis.fetch
const calls = []
const attachment = attachmentPart('image/jpeg', 'photo.jpg', 'data:image/jpeg;base64,AAAA')

try {
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return new Response('true', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const accepted = await api.sendPrompt(
    {
      backend: 'opencode',
      host: 'attachment-machine.invalid',
      port: 4096,
      username: 'harness',
      password: 'secret'
    },
    'ses_attachment',
    'Inspect this image',
    '/tmp/project with spaces',
    { providerID: 'openai', modelID: 'gpt-5', variant: 'high' },
    'reviewer',
    [attachment]
  )

  assert.equal(accepted, true)
  assert.equal(calls.length, 1, 'sendPrompt must issue exactly one transport request')

  const request = calls[0]
  const url = new URL(request.url)
  assert.equal(url.pathname, '/session/ses_attachment/prompt_async')
  assert.equal(url.searchParams.get('directory'), '/tmp/project with spaces')
  assert.equal(request.init.method, 'POST')

  const body = JSON.parse(request.init.body)
  assert.deepEqual(body.parts, [
    { type: 'text', text: 'Inspect this image' },
    attachment
  ], 'sendPrompt must preserve the supplied attachment part after the text part')
  assert.deepEqual(body.model, { providerID: 'openai', modelID: 'gpt-5' })
  assert.equal(body.variant, 'high')
  assert.equal(body.agent, 'reviewer')
} finally {
  globalThis.fetch = originalFetch
}

console.log('attachment transport behavioral tests passed')
