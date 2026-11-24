import { EventEmitter } from "node:events"
import { AcpClient } from "./acp-client.js"

/** Codex keeps unsubscribed threads loaded for 30 minutes. Give each writable session its
 * own adapter/native process group so releasing one never interrupts another session. */
export class SessionAcpClient extends EventEmitter {
  #factory
  #catalog
  #sessions = new Map()
  #opening = new Map()
  #closing = new Map()
  #clients = new Set()
  #stopping = false

  constructor(options = {}, { createClient = (opts) => new AcpClient(opts) } = {}) {
    super()
    this.#factory = () => this.#connect(createClient({ ...options, processGroup: true }))
    this.#catalog = this.#factory()
    this.#catalog.on("exit", (error) => this.emit("exit", error))
  }

  #connect(client) {
    this.#clients.add(client)
    for (const event of ["notification", "stderr", "protocol-error", "permission", "agent-request"]) {
      client.on(event, (...args) => this.emit(event, ...args))
    }
    client.on("exit", () => {
      if (client === this.#catalog) return
      this.#clients.delete(client)
      for (const [sessionID, activeClient] of this.#sessions) {
        if (activeClient === client) this.#sessions.delete(sessionID)
      }
    })
    return client
  }

  #anyClientWith(select) {
    const fromCatalog = select(this.#catalog)
    if (fromCatalog !== undefined) return fromCatalog
    for (const client of this.#sessions.values()) {
      const candidate = select(client)
      if (candidate !== undefined) return candidate
    }
    return undefined
  }

  get agentInfo() { return this.#catalog.agentInfo ?? this.#anyClientWith((c) => c.agentInfo) }
  get promptCapabilities() {
    if (this.#catalog.promptCapabilities && Object.keys(this.#catalog.promptCapabilities).length > 0) {
      return this.#catalog.promptCapabilities
    }
    for (const client of this.#sessions.values()) {
      if (client.promptCapabilities && Object.keys(client.promptCapabilities).length > 0) {
        return client.promptCapabilities
      }
    }
    return this.#catalog.promptCapabilities
  }
  get sessionCapabilities() {
    if (this.#catalog.sessionCapabilities && Object.keys(this.#catalog.sessionCapabilities).length > 0) {
      return this.#catalog.sessionCapabilities
    }
    for (const client of this.#sessions.values()) {
      if (client.sessionCapabilities && Object.keys(client.sessionCapabilities).length > 0) {
        return client.sessionCapabilities
      }
    }
    return this.#catalog.sessionCapabilities
  }
  get steeringSupported() {
    if (this.#catalog.steeringSupported) return true
    for (const client of this.#sessions.values()) {
      if (client.steeringSupported) return true
    }
    return false
  }
  get processID() { return this.#catalog.processID }
  start(...args) { return this.#catalog.start(...args) }
  listSessions(...args) { return this.#catalog.listSessions(...args) }
  listSessionPage(...args) { return this.#catalog.listSessionPage(...args) }

  diagnostics() {
    const catalog = this.#catalog.diagnostics()
    const sessions = [...this.#sessions].map(([sessionID, client]) => ({ sessionID, ...client.diagnostics() }))
    const pendingRequests = [catalog, ...sessions].flatMap((item) => item.pendingRequests ?? [])
    return { ...catalog, sessions, pendingRequests, pendingRequestCount: pendingRequests.length }
  }

  async request(method, params = {}, ...rest) {
    if (this.#stopping) throw new Error("ACP session host is shutting down")
    const id = params.sessionId
    if (method === "session/close") return this.#release(id)
    if (id && this.#closing.has(id)) throw new Error("Session release is in progress")
    if (method === "session/new") {
      const client = this.#factory()
      try {
        await client.start()
        if (this.#stopping) throw new Error("ACP session host is shutting down")
        const result = await client.request(method, params, ...rest)
        this.#sessions.set(result.sessionId, client)
        return result
      } catch (error) {
        await client.closeAndWait()
        this.#clients.delete(client)
        throw error
      }
    }
    if (id && (method === "session/load" || method === "session/resume")) {
      if (this.#opening.has(id)) return this.#opening.get(id)
      const client = this.#sessions.get(id) ?? this.#factory()
      this.#sessions.set(id, client)
      const opening = (async () => {
        try {
          await client.start()
          if (this.#stopping) throw new Error("ACP session host is shutting down")
          return await client.request(method, params, ...rest)
        } catch (error) {
          await client.closeAndWait()
          this.#clients.delete(client)
          this.#sessions.delete(id)
          throw error
        }
      })()
      this.#opening.set(id, opening)
      try { return await opening } finally { this.#opening.delete(id) }
    }
    if (id) {
      const client = this.#sessions.get(id)
      if (!client) throw new Error("Session is not loaded; claim it before writing")
      return client.request(method, params, ...rest)
    }
    return this.#catalog.request(method, params, ...rest)
  }

  notify(method, params) {
    if (this.#closing.has(params?.sessionId)) throw new Error("Session release is in progress")
    const client = this.#sessions.get(params?.sessionId)
    if (!client) throw new Error("Session is not loaded")
    return client.notify(method, params)
  }

  async #release(id) {
    if (this.#closing.has(id)) return this.#closing.get(id)
    if (this.#opening.has(id)) throw new Error("Session is loading; retry release when idle")
    const client = this.#sessions.get(id)
    if (!client) return {}
    const closing = (async () => {
      await client.closeAndWait()
      this.#clients.delete(client)
      this.#sessions.delete(id)
      return {}
    })()
    this.#closing.set(id, closing)
    try { return await closing } finally { this.#closing.delete(id) }
  }

  async close() {
    this.#stopping = true
    const closing = [...this.#clients].map((client) => client.closeAndWait())
    this.#sessions.clear()
    await Promise.all(closing)
    this.#clients.clear()
  }
}

export function createHarnessAcpClient(backend, options) {
  return backend === "codex" && process.platform !== "win32" ? new SessionAcpClient(options) : new AcpClient(options)
}
