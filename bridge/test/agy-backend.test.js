import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { AcpClient } from "../src/acp-client.js"
import { AcpService } from "../src/acp-service.js"
import { AcpAgentModelCatalog } from "../src/agent-model-catalog.js"
import { normalizeAgyAuthConfig, resolveAgyRuntime } from "../src/agy-auth.js"
import { createAgySessionIndex, firstWorkspaceDirectory, parseAgyTimestampMs } from "../src/agy-session-history.js"
import { parseConfig } from "../src/config.js"
import { parseDaemonOptions } from "../src/daemon-cli.js"
import { acpHarnessCapabilityContract } from "../src/harness-capability-contract.js"
import { HARNESS_PROFILES, harnessProfile, resolveAcpLaunch } from "../src/harness-profiles.js"
import { detectBackends, resolveLaunchPlan } from "../src/launcher.js"
import { createBridgeServer } from "../src/server.js"

const AGY_AUTH_METHODS = [
  { id: "oauth-personal", name: "Log in with Google" },
  { id: "oauth-business", name: "Log in with Gemini Enterprise" },
  { id: "gemini-api-key", name: "Gemini API key" },
  { id: "agent-platform", name: "Gemini Enterprise Agent Platform" }
]

test("Antigravity (agy) is registered as a first-class ACP backend profile", () => {
  const profile = harnessProfile("agy")
  assert.equal(profile, HARNESS_PROFILES.agy)
  assert.equal(profile.id, "agy")
  assert.equal(profile.label, "Antigravity")
  assert.equal(profile.command, "agy")
  assert.deepEqual(profile.args, ["acp"])
  assert.equal(profile.skipAuthenticate, true)
  assert.equal(profile.reportConfiguredModel, true)
  assert.ok(profile.modelVariantConfigIDs.includes("thought_level"))
  assert.equal(profile.capabilities.sessions, true)
  assert.equal(profile.capabilities.prompt, true)
  assert.equal(profile.capabilities.models, true)
  assert.equal(profile.capabilities.todos, true)
  assert.equal(profile.capabilities.commands, true)
  assert.equal(profile.capabilities.sessionRename, true)
  assert.equal(profile.capabilities.sessionDelete, true)
  assert.deepEqual(resolveAcpLaunch(profile), {
    command: "agy",
    args: ["acp"],
    source: "harness"
  })

  const contract = acpHarnessCapabilityContract(profile)
  assert.equal(contract.protocol, "acp")
  assert.equal(contract.sessions.transcript, "session-load")
  assert.ok(contract.models.variantConfigIDs.includes("thought_level"))
})

test("launcher detects agy on PATH and supports selecting it via --backend or --config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-agy-launch-"))
  const configFile = path.join(dir, "server.json")
  await writeFile(configFile, JSON.stringify({ backend: "agy" }), "utf8")

  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([path.join("/tools", "agy"), path.join("/tools", "codex")])
  const detected = detectBackends({
    pathValue,
    platform: "linux",
    exists: (candidate) => existing.has(candidate),
    access: () => {}
  })
  assert.deepEqual(detected, ["codex", "agy"])
  assert.deepEqual(resolveLaunchPlan(["--backend", "agy"], detected), {
    mode: "daemon",
    backend: "agy",
    detected,
    openCode: false
  })
  assert.deepEqual(resolveLaunchPlan(["--config", configFile], detected), {
    mode: "daemon",
    backend: "agy",
    detected,
    openCode: false
  })
})

test("server JSON config file configures agy auth and merges cleanly with env and CLI flags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-agy-config-"))
  const keyFile = path.join(dir, "gemini.key")
  await writeFile(keyFile, "# comment\nAIza-from-file\n", "utf8")
  const configFile = path.join(dir, "harness.config.json")
  await writeFile(configFile, JSON.stringify({
    backend: "agy",
    host: "127.0.0.1",
    port: 18080,
    sessionDays: 14,
    roots: ["./workspace"],
    stateDirectory: "./state",
    openCode: {
      enabled: false,
      port: 18081
    },
    agy: {
      geminiDir: "/srv/gemini",
      appDataDir: "antigravity-cli",
      auth: {
        source: "gemini-api-key",
        apiKeyFile: "./gemini.key",
        baseUrl: "http://127.0.0.1:8317"
      }
    }
  }), "utf8")

  const fromFile = parseConfig(["--config", configFile], {})
  assert.equal(fromFile.backend, "agy")
  assert.equal(fromFile.port, 18080)
  assert.equal(fromFile.sessionDays, 14)
  assert.deepEqual(fromFile.roots, [path.join(dir, "workspace")])
  assert.equal(fromFile.stateDirectory, path.join(dir, "state"))
  assert.deepEqual(fromFile.agyAuth, {
    source: "gemini-api-key",
    apiKeyFile: keyFile,
    baseUrl: "http://127.0.0.1:8317",
    geminiDir: "/srv/gemini",
    appDataDir: "antigravity-cli"
  })

  // Environment variables override config file values, and CLI flags override both.
  const overridden = parseConfig(
    ["--config", configFile, "--agy-auth", "oauth-personal"],
    {
      HARNESS_REMOTE_AGY_AUTH: "agent-platform",
      HARNESS_REMOTE_AGY_PROJECT: "my-gcp-project"
    }
  )
  assert.equal(overridden.agyAuth.source, "oauth-personal")
  assert.equal(overridden.agyAuth.project, "my-gcp-project")

  const daemonParsed = parseDaemonOptions([], { HARNESS_REMOTE_CONFIG: configFile })
  assert.equal(daemonParsed.config.backend, "agy")
  assert.equal(daemonParsed.openCode, false)
  assert.equal(daemonParsed.openCodePort, 18081)
})

test("resolves all supported agy auth sources and rejects missing or unsafe settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-agy-auth-"))
  const jsonKeyFile = path.join(dir, "auth.json")
  await writeFile(jsonKeyFile, JSON.stringify({ GEMINI_API_KEY: "json-secret-key" }), "utf8")
  const shellEnvFile = path.join(dir, ".environment")
  await writeFile(
    shellEnvFile,
    "alias ls='ls --color=auto'\nexport GEMINI_API_KEY=\"shell-cpa-secret\"\nexport GOOGLE_GEMINI_BASE_URL=\"http://127.0.0.1:9999\"\n",
    "utf8"
  )
  const busDir = path.join(dir, "run")
  await mkdir(busDir, { recursive: true })
  await writeFile(path.join(busDir, "bus"), "", "utf8")

  // 1. Default `cli` mode skips upfront ACP `authenticate` and wires Linux D-Bus + NO_BROWSER.
  const cliRuntime = resolveAgyRuntime({
    baseArgs: ["acp"],
    environment: { PATH: "/usr/bin", XDG_RUNTIME_DIR: busDir },
    platform: "linux",
    getuid: () => 1000
  })
  assert.equal(cliRuntime.authSource, "cli")
  assert.equal(cliRuntime.skipAuthenticate, true)
  assert.equal(cliRuntime.requiredAuthMethod, undefined)
  assert.equal(cliRuntime.env.NO_BROWSER, "1")
  assert.equal(cliRuntime.env.BROWSER, "/bin/false")
  assert.equal(cliRuntime.env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${path.join(busDir, "bus")}`)

  // 2. `gemini-api-key` reads JSON or plain-text key files and custom base URLs without leaking keys into argv.
  const apiKeyRuntime = resolveAgyRuntime({
    baseArgs: ["acp"],
    agyAuth: {
      source: "api-key",
      apiKeyFile: jsonKeyFile,
      baseUrl: "http://127.0.0.1:8317",
      geminiDir: "/home/user/.gemini",
      appDataDir: "antigravity"
    },
    environment: { PATH: "/usr/bin" }
  })
  assert.equal(apiKeyRuntime.authSource, "gemini-api-key")
  assert.equal(apiKeyRuntime.skipAuthenticate, false)
  assert.equal(apiKeyRuntime.requiredAuthMethod, "gemini-api-key")
  assert.equal(apiKeyRuntime.env.GEMINI_API_KEY, "json-secret-key")
  assert.equal(apiKeyRuntime.env.GOOGLE_GEMINI_BASE_URL, "http://127.0.0.1:8317")
  assert.deepEqual(apiKeyRuntime.args, [
    "acp",
    "--gemini-dir",
    "/home/user/.gemini",
    "--app-data-dir",
    "antigravity"
  ])
  assert.equal(apiKeyRuntime.args.join(" ").includes("json-secret-key"), false)

  // 2b. `gemini-api-key` also extracts `export GEMINI_API_KEY="..."` from a shell `.environment` file.
  const shellRuntime = resolveAgyRuntime({
    baseArgs: ["acp"],
    agyAuth: {
      source: "gemini-api-key",
      apiKeyFile: shellEnvFile,
      baseUrl: "http://127.0.0.1:8318"
    },
    environment: { PATH: "/usr/bin" }
  })
  assert.equal(shellRuntime.env.GEMINI_API_KEY, "shell-cpa-secret")
  assert.equal(shellRuntime.env.GOOGLE_GEMINI_BASE_URL, "http://127.0.0.1:8318")

  // 3. `agent-platform` (Vertex AI / ADC) enables AGY_ADC_AUTH and forwards project/location/credentials.
  const adcRuntime = resolveAgyRuntime({
    baseArgs: ["acp"],
    agyAuth: {
      source: "vertex",
      project: "corp-proj",
      location: "us-central1",
      quotaProject: "corp-quota",
      credentialsFile: "/etc/gcp/adc.json"
    },
    environment: {}
  })
  assert.equal(adcRuntime.authSource, "agent-platform")
  assert.equal(adcRuntime.requiredAuthMethod, "agent-platform")
  assert.equal(adcRuntime.env.AGY_ADC_AUTH, "true")
  assert.equal(adcRuntime.env.GOOGLE_CLOUD_PROJECT, "corp-proj")
  assert.equal(adcRuntime.env.GOOGLE_CLOUD_LOCATION, "us-central1")
  assert.equal(adcRuntime.env.GOOGLE_CLOUD_QUOTA_PROJECT, "corp-quota")
  assert.equal(adcRuntime.env.GOOGLE_APPLICATION_CREDENTIALS, "/etc/gcp/adc.json")

  // 4. `oauth-personal` / `oauth-business` require their exact ACP method.
  const oauthRuntime = resolveAgyRuntime({
    baseArgs: ["acp"],
    agyAuth: { source: "google" },
    environment: {}
  })
  assert.equal(oauthRuntime.authSource, "oauth-personal")
  assert.equal(oauthRuntime.skipAuthenticate, false)
  assert.equal(oauthRuntime.requiredAuthMethod, "oauth-personal")

  // 5. Validation errors stay actionable and never leak file contents.
  assert.throws(
    () => resolveAgyRuntime({ baseArgs: ["acp"], agyAuth: { source: "gemini-api-key" }, environment: {} }),
    /requires an API key/
  )
  assert.throws(() => normalizeAgyAuthConfig({ source: "magic-token" }), /Unsupported agy auth source/)
  assert.throws(() => normalizeAgyAuthConfig({ geminiDir: "relative/.gemini" }), /must be an absolute path/)
  assert.throws(() => normalizeAgyAuthConfig({ appDataDir: "/abs/antigravity-cli" }), /relative subdirectory name/)
})

test("AcpClient honors skipAuthenticate, requiredAuthMethod, and isolated child env", async () => {
  class FakeChild extends EventEmitter {
    killed = false
    pid = 5150
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    writes = []
    constructor(onRequest) {
      super()
      this.stdout.setEncoding = () => undefined
      this.stderr.setEncoding = () => undefined
      this.stdin = {
        writable: true,
        write: (line, cb) => {
          const msg = JSON.parse(line)
          this.writes.push(msg)
          onRequest(this, msg)
          cb?.()
          return true
        }
      }
    }
    respond(msg) {
      this.stdout.emit("data", `${JSON.stringify(msg)}\n`)
    }
    kill() {
      this.killed = true
      this.stdin.writable = false
      return true
    }
  }

  const originalGeminiKey = process.env.GEMINI_API_KEY
  let capturedOptions
  const skipped = new AcpClient({
    command: "agy",
    args: ["acp"],
    skipAuthenticate: true,
    env: { GEMINI_API_KEY: "isolated-key" },
    spawnProcess: (_cmd, _args, options) => {
      capturedOptions = options
      return new FakeChild((child, req) => {
        if (req.method === "initialize") {
          child.respond({ jsonrpc: "2.0", id: req.id, result: { agentInfo: { name: "agy", version: "1.5.15" }, authMethods: AGY_AUTH_METHODS } })
        }
      })
    }
  })
  await skipped.start()
  assert.equal(capturedOptions.env.GEMINI_API_KEY, "isolated-key")
  assert.equal(process.env.GEMINI_API_KEY, originalGeminiKey)
  skipped.close()

  let authedWith
  const explicit = new AcpClient({
    command: "agy",
    args: ["acp"],
    requiredAuthMethod: "gemini-api-key",
    spawnProcess: () => new FakeChild((child, req) => {
      if (req.method === "initialize") {
        child.respond({ jsonrpc: "2.0", id: req.id, result: { agentInfo: { name: "agy", version: "1.5.15" }, authMethods: AGY_AUTH_METHODS } })
      }
      if (req.method === "authenticate") {
        authedWith = req.params.methodId
        child.respond({ jsonrpc: "2.0", id: req.id, result: {} })
      }
    })
  })
  await explicit.start()
  assert.equal(authedWith, "gemini-api-key")
  explicit.close()

  const unadvertised = new AcpClient({
    command: "agy",
    args: ["acp"],
    requiredAuthMethod: "agent-platform",
    spawnProcess: () => new FakeChild((child, req) => {
      if (req.method === "initialize") {
        child.respond({ jsonrpc: "2.0", id: req.id, result: { agentInfo: { name: "agy", version: "1.5.15" }, authMethods: [{ id: "oauth-personal" }] } })
      }
    })
  })
  await assert.rejects(unadvertised.start(), /does not advertise configured auth method 'agent-platform'/)
})

test("Agy SQLite session index parses Go nanosecond timestamps, workspaces, pagination, and search", async (t) => {
  const sqlite = await import("node:sqlite").catch(() => null)
  if (!sqlite?.DatabaseSync) {
    t.skip("node:sqlite is unavailable in this Node runtime")
    return
  }

  assert.equal(
    parseAgyTimestampMs("2026-11-23 21:04:21.504988648+00:00"),
    Date.parse("2026-11-23T21:04:21.504Z")
  )
  const repoDir = path.resolve(tmpdir(), "agy-repo-alpha")
  assert.equal(firstWorkspaceDirectory(JSON.stringify([pathToFileURL(repoDir).href])), repoDir)

  const root = await mkdtemp(path.join(tmpdir(), "harness-agy-sqlite-"))
  const appDir = path.join(root, "antigravity-cli")
  await mkdir(path.join(appDir, "conversations"), { recursive: true })
  const db = new sqlite.DatabaseSync(path.join(appDir, "conversation_summaries.db"))
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL,
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      killed NUMERIC NOT NULL DEFAULT 0
    );
  `)
  const insert = db.prepare(`
    INSERT INTO conversation_summaries
    (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth, killed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run("s-newest", "Implement agy backend", "", 6, "2026-11-23 21:04:21.504988648+00:00", JSON.stringify([pathToFileURL(repoDir).href]), "", 0, 0)
  insert.run("s-scratch", "", "Standalone note", 2, "2026-11-22 10:00:00.123456789+00:00", "[]", "", 0, 0)
  insert.run("s-subagent", "Subagent worker", "", 4, "2026-11-23 21:05:00+00:00", JSON.stringify([pathToFileURL(repoDir).href]), "s-newest", 1, 0)
  insert.run("s-killed", "Killed session", "", 3, "2026-11-23 21:06:00+00:00", JSON.stringify([pathToFileURL(repoDir).href]), "", 0, 1)
  insert.run("s-orphan", "Missing db file", "", 3, "2026-11-23 21:07:00+00:00", JSON.stringify([pathToFileURL(repoDir).href]), "", 0, 0)
  db.close()

  for (const id of ["s-newest", "s-scratch", "s-subagent", "s-killed"]) {
    await writeFile(path.join(appDir, "conversations", `${id}.db`), "", "utf8")
  }

  const index = createAgySessionIndex({ geminiDir: root, appDataDir: "antigravity-cli" })
  const directories = await index.listSessionDirectories()
  assert.deepEqual(directories, [repoDir], "standalone scratch conversations must not pollute Project discovery")

  const page1 = await index.listSessions({ limit: 1 })
  assert.equal(page1.sessions.length, 1)
  assert.equal(page1.sessions[0].sessionId, "s-newest")
  assert.equal(page1.sessions[0].cwd, repoDir)
  assert.ok(page1.nextCursor)

  const page2 = await index.listSessions({ cursor: page1.nextCursor, limit: 5 })
  assert.equal(page2.sessions.length, 1)
  assert.equal(page2.sessions[0].sessionId, "s-scratch")
  assert.equal(page2.sessions[0].title, "Standalone note")
  assert.equal(page2.sessions[0].cwd, path.join(appDir, "scratch"))
  assert.equal(page2.nextCursor, undefined)

  const searched = await index.listSessions({ query: "standalone" })
  assert.deepEqual(searched.sessions.map((s) => s.sessionId), ["s-scratch"])
})

test("Agy ACP model variants, session_info_update, and multi-turn tool replays work end-to-end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-agy-service-"))

  class FakeAgyAcp extends EventEmitter {
    promptCapabilities = { image: true }
    sessionCapabilities = { resume: {}, load: {}, list: {}, close: {} }
    agentInfo = { name: "Antigravity ACP Server", version: "1.5.15" }
    calls = []
    currentTitle = "Initial title"

    async start() {}
    async listSessions() {
      return [{
        sessionId: "agy-s1",
        cwd: dir,
        title: this.currentTitle,
        updatedAt: "2026-11-23T21:00:00Z"
      }]
    }
    async listSessionPage() {
      return { sessions: await this.listSessions() }
    }
    async request(method, params) {
      this.calls.push({ method, params })
      const configOptionsFor = (model = "gemini-4-neon", thought = "high") => ([
        {
          id: "model",
          currentValue: model,
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }
          ]
        },
        ...(model.startsWith("gemini-") ? [{
          id: "thought_level",
          currentValue: thought,
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra" }
          ]
        }] : [])
      ])

      if (method === "session/new") {
        return { sessionId: "agy-catalog", configOptions: configOptionsFor() }
      }
      if (method === "session/set_config_option") {
        if (params.configId === "model") {
          return { configOptions: configOptionsFor(params.value, "high") }
        }
        return { configOptions: configOptionsFor("gemini-4-neon", params.value) }
      }
      if (method === "session/load") {
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First prompt" } }
          }
        })
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call_1",
              name: "run_command",
              title: "git status",
              args: { CommandLine: "git status" },
              rawOutput: "clean",
              status: "completed"
            }
          }
        })
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Second prompt" } }
          }
        })
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All set." } }
          }
        })
        return { sessionId: params.sessionId, configOptions: configOptionsFor("gemini-4-neon", "xhigh") }
      }
      throw new Error(`Unexpected ACP request: ${method}`)
    }
  }

  const acp = new FakeAgyAcp()
  const catalog = new AcpAgentModelCatalog({
    agent: acp,
    agentID: "agy",
    directory: dir,
    stateDirectory: dir,
    variantConfigIDs: HARNESS_PROFILES.agy.modelVariantConfigIDs
  })
  const discovered = await catalog.list()
  assert.ok(discovered.models.some((m) => m.providerID === "agy" && m.modelID === "gemini-4-neon" && m.variant === "xhigh"))
  assert.ok(discovered.models.some((m) => m.providerID === "agy" && m.modelID === "claude-sonnet-5-5" && !m.variant))
  assert.equal(discovered.models.some((m) => m.modelID === "claude-sonnet-5-5" && m.variant), false)

  const bridgeServer = createBridgeServer({
    config: {
      backend: "agy",
      host: "127.0.0.1",
      port: 0,
      username: "",
      password: "",
      roots: [dir],
      corsOrigins: [],
      sessionDays: 0,
      stateDirectory: dir
    },
    acp,
    serviceOptions: { snapshotDirectory: path.join(dir, "agy") }
  })

  const page = await bridgeServer.acpService.messagePage("agy-s1", { limit: 20 })
  assert.deepEqual(page.model, {
    providerID: "agy",
    modelID: "gemini-4-neon",
    variant: "xhigh"
  })
  assert.equal(page.messages.length, 4, "tool-only assistant turn must separate two consecutive user turns")
  assert.equal(page.messages[0].info.role, "user")
  assert.equal(page.messages[0].parts[0].text, "First prompt")
  assert.equal(page.messages[1].info.role, "assistant")
  assert.equal(page.messages[1].parts[0].tool, "run_command")
  assert.equal(page.messages[1].parts[0].state.output, "clean")
  assert.equal(page.messages[2].info.role, "user")
  assert.equal(page.messages[2].parts[0].text, "Second prompt")
  assert.equal(page.messages[3].info.role, "assistant")
  assert.equal(page.messages[3].parts[0].text, "All set.")

  acp.currentTitle = "Updated Agy Title"
  acp.emit("notification", {
    method: "session/update",
    params: {
      sessionId: "agy-s1",
      update: { sessionUpdate: "session_info_update", title: "Updated Agy Title" }
    }
  })
  const sessions = await bridgeServer.acpService.listSessions(dir)
  assert.equal(sessions[0].title, "Updated Agy Title")
  bridgeServer.close()
})
