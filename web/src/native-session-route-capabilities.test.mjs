import assert from "node:assert/strict"
import { routeCurrentNativeSessionAgents } from "./native-session-route-capabilities.ts"

const agent = (id, attachments, overrides = {}) => ({
  id,
  label: id,
  backend: id,
  transport: "acp",
  managed: true,
  state: "available",
  capabilities: { sessions: true, prompt: true, attachments, ...overrides }
})

const current = agent("omp", undefined)
const other = agent("claude", true)
const fallback = agent("omp", true)

const enabled = routeCurrentNativeSessionAgents([current, other], "omp", fallback, true)
assert.equal(enabled[0].capabilities.attachments, true)
assert.notEqual(enabled[0], current, "the live capability projection must not mutate the snapshot entry")
assert.equal(enabled[1], other, "unrelated agents must retain their snapshot identity")

const disabled = routeCurrentNativeSessionAgents([current], "omp", fallback, false)
assert.equal(disabled[0].capabilities.attachments, false, "the route must fail closed when the handshake lacks image support")

const missing = routeCurrentNativeSessionAgents([other], "omp", fallback, true)
assert.equal(missing[0], fallback, "a missing current agent must use the live fallback projection")
assert.equal(missing[0].capabilities.attachments, true)
assert.equal(missing[1], other)

console.log("native Session route capability tests passed")
