import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createAgentRoutingServer } from "../src/agent-router.js"

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

class BridgeServer extends EventEmitter {}

function daemonWithAgents() {
  const hosts = {
    codex: { id: "codex", backend: "codex", state: "available" },
    omp: { id: "omp", backend: "omp", state: "configured" },
    pi: { id: "pi", backend: "pi", state: "configured" },
    opencode: { id: "opencode", backend: "opencode", state: "available" }
  }
  const entries = {
    omp: { id: "omp", kind: "acp" },
    pi: { id: "pi", kind: "acp" },
    opencode: { id: "opencode", kind: "http", host: {} }
  }
  return {
    registry: {
      host(id) { return hosts[id] }
    },
    hostEntry(id) { return entries[id] },
    snapshot() { return { agents: Object.values(hosts) } }
  }
}

test("legacy root request is routed by selected harness instead of primary", async () => {
  const primary = new BridgeServer()
  primary.on("request", (_request, response) => response.end("primary"))
  const pi = new BridgeServer()
  pi.on("request", (request, response) => response.end(`pi:${request.url}`))
  const server = createAgentRoutingServer({
    daemon: daemonWithAgents(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: primary,
    acpBridgeServer: (id) => id === "pi" ? pi : undefined
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/experimental/session`, {
      headers: { "X-Harness-Backend": "pi" }
    })
    assert.equal(await response.text(), "pi:/experimental/session")
  } finally {
    await close(server)
  }
})

test("stale scoped agent id is corrected by selected harness", async () => {
  const primary = new BridgeServer()
  primary.on("request", (_request, response) => response.end("wrong-codex"))
  const omp = new BridgeServer()
  omp.on("request", (request, response) => response.end(`omp:${request.url}`))
  const server = createAgentRoutingServer({
    daemon: daemonWithAgents(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: primary,
    acpBridgeServer: (id) => id === "omp" ? omp : undefined
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/codex/session`, {
      headers: { "X-Harness-Backend": "omp" }
    })
    assert.equal(await response.text(), "omp:/session")
  } finally {
    await close(server)
  }
})

test("correct explicit route is not changed by matching backend hint", async () => {
  const primary = new BridgeServer()
  primary.on("request", (_request, response) => response.end("primary"))
  const pi = new BridgeServer()
  pi.on("request", (request, response) => response.end(`pi:${request.url}`))
  const server = createAgentRoutingServer({
    daemon: daemonWithAgents(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: primary,
    acpBridgeServer: (id) => id === "pi" ? pi : undefined
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/pi/session`, {
      headers: { "X-Harness-Backend": "pi" }
    })
    assert.equal(await response.text(), "pi:/session")
  } finally {
    await close(server)
  }
})

test("explicit non-primary ACP route is not hijacked by an older client's fallback opencode header", async () => {
  const primary = new BridgeServer()
  primary.on("request", (_request, response) => response.end("primary"))
  const agy = new BridgeServer()
  agy.on("request", (request, response) => response.end(`agy:${request.url}`))
  const daemon = daemonWithAgents()
  const baseHost = daemon.registry.host.bind(daemon.registry)
  daemon.registry.host = (id) => id === "agy" ? { id: "agy", backend: "agy", state: "configured" } : baseHost(id)
  const baseEntry = daemon.hostEntry.bind(daemon)
  daemon.hostEntry = (id) => id === "agy" ? { id: "agy", kind: "acp" } : baseEntry(id)

  const server = createAgentRoutingServer({
    daemon,
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: primary,
    acpBridgeServer: (id) => id === "agy" ? agy : undefined
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/agy/experimental/session`, {
      headers: { "X-Harness-Backend": "opencode" }
    })
    assert.equal(await response.text(), "agy:/experimental/session")
  } finally {
    await close(server)
  }
})
