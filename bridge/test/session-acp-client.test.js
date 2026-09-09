import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SessionAcpClient } from '../src/session-acp-client.js'

function fixture() {
  const clients = []
  class Fake extends EventEmitter {
    calls = []
    closed = false
    async start() {}
    async request(method, params) {
      this.calls.push([method, params])
      return method === 'session/new' ? {sessionId: `s${clients.indexOf(this)}`} : {}
    }
    async closeAndWait() { this.closed = true }
    close() { this.closed = true }
    diagnostics() { return {pendingRequests: []} }
  }
  const router = new SessionAcpClient({}, {createClient(options) {
    assert.equal(options.processGroup, true)
    const client = new Fake(); clients.push(client); return client
  }})
  return {router, clients}
}

test('release stops only the selected session and permits a fresh resume', async () => {
  const {router, clients} = fixture()
  const a = await router.request('session/new', {})
  const b = await router.request('session/new', {})
  await router.request('session/close', {sessionId: a.sessionId})
  assert.equal(clients[1].closed, true)
  assert.equal(clients[0].closed, false)
  assert.equal(clients[2].closed, false)
  await router.request('session/prompt', {sessionId: b.sessionId})
  await assert.rejects(router.request('session/prompt', {sessionId: a.sessionId}), /not loaded/)
  await router.request('session/load', {sessionId: a.sessionId})
  assert.equal(clients.length, 4)
  assert.equal(clients[3].closed, false)
  router.close()
  assert.ok(clients.every(c => c.closed))
})

test('release is single flight and fences load and prompt until process exit', async () => {
  const {router, clients} = fixture()
  const {sessionId} = await router.request('session/new', {})
  let finish, count = 0
  clients[1].closeAndWait = () => {count++; return new Promise(resolve => {finish = resolve})}
  const first = router.request('session/close', {sessionId})
  const second = router.request('session/close', {sessionId})
  await assert.rejects(router.request('session/load', {sessionId}), /release is in progress/)
  await assert.rejects(router.request('session/prompt', {sessionId}), /release is in progress/)
  assert.equal(count, 1)
  finish(); await Promise.all([first, second])
  await router.request('session/close', {sessionId})
  assert.equal(count, 1)
})

test('failed close retains the session for retry', async () => {
  const {router, clients} = fixture()
  const {sessionId} = await router.request('session/new', {})
  clients[1].closeAndWait = async () => {throw Error('still shutting down')}
  await assert.rejects(router.request('session/close', {sessionId}), /shutting down/)
  let retried = false
  clients[1].closeAndWait = async () => {retried = true}
  await router.request('session/close', {sessionId})
  assert.equal(retried, true)
})

test('failed load closes its process and does not poison the next attempt', async () => {
  const {router, clients} = fixture()
  // Allocate a client, then force a subsequent reload to fail.
  await router.request('session/load', {sessionId: 'external'})
  clients[1].request = async () => {throw Error('writer locked')}
  await assert.rejects(router.request('session/load', {sessionId:'external'}), /writer locked/)
  assert.equal(clients[1].closed, true)
  await router.request('session/load', {sessionId:'external'})
  assert.equal(clients.length, 3)
})
