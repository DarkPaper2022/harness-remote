import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { normalizeAgyAuthConfig } from "./agy-auth.js"
import { harnessProfile, resolveAcpLaunch } from "./harness-profiles.js"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

function requireValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`)
  return value
}

function parsePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535")
  }
  return port
}

function parseArgumentList(value, fallback) {
  if (value === undefined) return [...fallback]
  if (Array.isArray(value)) {
    if (value.some((argument) => typeof argument !== "string")) {
      throw new Error("ACP arguments must be a JSON array of strings")
    }
    return [...value]
  }
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("ACP arguments must be a JSON array")
  }
  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== "string")) {
    throw new Error("ACP arguments must be a JSON array of strings")
  }
  return parsed
}

function parseBackend(value) {
  return harnessProfile(value).id
}

function parseSessionDays(value) {
  const days = Number(value)
  if (!Number.isFinite(days) || days < 0) throw new Error("--session-days must be a non-negative number")
  return days
}

function environmentValue(environment, name) {
  return environment[`HARNESS_REMOTE_${name}`] ?? environment[`OMP_BRIDGE_${name}`]
}

function resolveFromConfigDir(configDir, targetPath) {
  if (typeof targetPath !== "string" || !targetPath.trim()) return undefined
  const trimmed = targetPath.trim()
  return configDir && !path.isAbsolute(trimmed) ? path.resolve(configDir, trimmed) : trimmed
}

function stringListFromFileField(value, fieldName, mapItem = (item) => item) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value ? [mapItem(value)] : []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} in config file must be a string or an array of strings`)
  }
  return value.filter(Boolean).map(mapItem)
}

function extractAgyAuthFromFile(rawConfig, configDir) {
  const agySection = rawConfig.agy
  const topAgyAuth = rawConfig.agyAuth
  if (agySection === undefined && topAgyAuth === undefined) return {}
  if (agySection !== undefined && (!agySection || typeof agySection !== "object" || Array.isArray(agySection))) {
    throw new Error("agy section in config file must be an object")
  }

  const rawAuth = agySection?.auth ?? topAgyAuth
  let authFields = {}
  if (typeof rawAuth === "string") {
    authFields = { source: rawAuth }
  } else if (rawAuth !== undefined) {
    if (!rawAuth || typeof rawAuth !== "object" || Array.isArray(rawAuth)) {
      throw new Error("agy.auth in config file must be a string or an object")
    }
    authFields = { ...rawAuth }
  }

  const merged = {
    source: authFields.source ?? agySection?.authSource,
    apiKey: authFields.apiKey ?? agySection?.apiKey,
    apiKeyFile: resolveFromConfigDir(configDir, authFields.apiKeyFile ?? agySection?.apiKeyFile),
    apiKeyEnv: authFields.apiKeyEnv ?? agySection?.apiKeyEnv,
    baseUrl: authFields.baseUrl ?? agySection?.baseUrl,
    project: authFields.project ?? agySection?.project,
    location: authFields.location ?? agySection?.location,
    quotaProject: authFields.quotaProject ?? agySection?.quotaProject,
    credentialsFile: resolveFromConfigDir(configDir, authFields.credentialsFile ?? agySection?.credentialsFile),
    geminiDir: resolveFromConfigDir(configDir, authFields.geminiDir ?? agySection?.geminiDir),
    appDataDir: authFields.appDataDir ?? agySection?.appDataDir
  }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined))
}

export function loadServerConfigFile(configPath, readFileImpl = fs.readFileSync) {
  let text
  try {
    text = readFileImpl(configPath, "utf8")
  } catch (error) {
    throw new Error(`Cannot read config file '${configPath}': ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON in config file '${configPath}': ${error.message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file '${configPath}' must contain a JSON object`)
  }
  return parsed
}

export function findConfigFileOption(args, environment = process.env) {
  let configFile = environmentValue(environment, "CONFIG")
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--config") {
      configFile = requireValue(args, index, "--config")
      index += 1
    }
  }
  return configFile
}

export function parseConfig(args, environment = process.env, { readFileImpl = fs.readFileSync } = {}) {
  const configFile = findConfigFileOption(args, environment)
  const fileData = configFile ? loadServerConfigFile(configFile, readFileImpl) : {}
  const configDir = configFile ? path.dirname(path.resolve(configFile)) : undefined

  const backend = parseBackend(environmentValue(environment, "BACKEND") ?? fileData.backend ?? "omp")
  const profile = harnessProfile(backend)
  const launch = resolveAcpLaunch(profile)
  const envAcpCommand = environmentValue(environment, "ACP_COMMAND")
  const envAcpArgs = environmentValue(environment, "ACP_ARGS")
  const fileAcpCommand = typeof fileData.acpCommand === "string" && fileData.acpCommand.trim()
    ? fileData.acpCommand.trim()
    : undefined
  const fileAcpArgs = fileData.acpArgs !== undefined ? parseArgumentList(fileData.acpArgs, []) : undefined

  const envRoot = environmentValue(environment, "ROOT")
  const fileRoots = stringListFromFileField(
    fileData.roots ?? fileData.root,
    "roots",
    (item) => resolveFromConfigDir(configDir, item)
  )
  const envCors = environmentValue(environment, "CORS")
  const fileCors = stringListFromFileField(fileData.corsOrigins ?? fileData.cors, "corsOrigins")

  const envStateDir = environmentValue(environment, "STATE_DIR")
  const fileStateDir = resolveFromConfigDir(configDir, fileData.stateDirectory ?? fileData.stateDir)

  const envLogRequests = environmentValue(environment, "LOG_REQUESTS")
  const logRequests = envLogRequests !== undefined
    ? envLogRequests === "1"
    : Boolean(fileData.logRequests)

  const agyAuthDraft = {
    ...extractAgyAuthFromFile(fileData, configDir),
    ...(environmentValue(environment, "AGY_AUTH") ?? environmentValue(environment, "AGY_AUTH_SOURCE")
      ? { source: environmentValue(environment, "AGY_AUTH") ?? environmentValue(environment, "AGY_AUTH_SOURCE") }
      : {}),
    ...(environmentValue(environment, "AGY_API_KEY") ? { apiKey: environmentValue(environment, "AGY_API_KEY") } : {}),
    ...(environmentValue(environment, "AGY_API_KEY_FILE") ? { apiKeyFile: environmentValue(environment, "AGY_API_KEY_FILE") } : {}),
    ...(environmentValue(environment, "AGY_API_KEY_ENV") ? { apiKeyEnv: environmentValue(environment, "AGY_API_KEY_ENV") } : {}),
    ...(environmentValue(environment, "AGY_BASE_URL") ? { baseUrl: environmentValue(environment, "AGY_BASE_URL") } : {}),
    ...(environmentValue(environment, "AGY_PROJECT") ? { project: environmentValue(environment, "AGY_PROJECT") } : {}),
    ...(environmentValue(environment, "AGY_LOCATION") ? { location: environmentValue(environment, "AGY_LOCATION") } : {}),
    ...(environmentValue(environment, "AGY_QUOTA_PROJECT") ? { quotaProject: environmentValue(environment, "AGY_QUOTA_PROJECT") } : {}),
    ...(environmentValue(environment, "AGY_CREDENTIALS_FILE") ? { credentialsFile: environmentValue(environment, "AGY_CREDENTIALS_FILE") } : {}),
    ...(environmentValue(environment, "AGY_GEMINI_DIR") ? { geminiDir: environmentValue(environment, "AGY_GEMINI_DIR") } : {}),
    ...(environmentValue(environment, "AGY_APP_DATA_DIR") ? { appDataDir: environmentValue(environment, "AGY_APP_DATA_DIR") } : {})
  }

  const config = {
    backend,
    host: environmentValue(environment, "HOST") ?? fileData.host ?? "127.0.0.1",
    port: parsePort(environmentValue(environment, "PORT") ?? fileData.port ?? "4097"),
    username: environmentValue(environment, "USERNAME") ?? fileData.username ?? "",
    password: environmentValue(environment, "PASSWORD") ?? fileData.password ?? "",
    acpCommand: envAcpCommand ?? fileAcpCommand ?? launch.command,
    acpArgs: envAcpArgs !== undefined ? parseArgumentList(envAcpArgs, launch.args) : (fileAcpArgs ?? [...launch.args]),
    roots: envRoot ? [envRoot] : (fileRoots ?? []),
    corsOrigins: envCors ? [envCors] : (fileCors ?? []),
    sessionDays: parseSessionDays(environmentValue(environment, "SESSION_DAYS") ?? fileData.sessionDays ?? "7"),
    logRequests,
    stateDirectory: envStateDir ?? fileStateDir ?? path.join(homedir(), ".harness-remote")
  }
  let acpCommandOverridden = envAcpCommand !== undefined || fileAcpCommand !== undefined
  let acpArgsOverridden = envAcpArgs !== undefined || fileAcpArgs !== undefined

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    switch (option) {
      case "--config":
        requireValue(args, index, option)
        index += 1
        break
      case "--backend":
        config.backend = parseBackend(requireValue(args, index, option))
        {
          const selected = resolveAcpLaunch(harnessProfile(config.backend))
          if (!acpCommandOverridden) config.acpCommand = selected.command
          if (!acpArgsOverridden) config.acpArgs = [...selected.args]
        }
        index += 1
        break
      case "--host":
        config.host = requireValue(args, index, option)
        index += 1
        break
      case "--port":
        config.port = parsePort(requireValue(args, index, option))
        index += 1
        break
      case "--username":
        config.username = requireValue(args, index, option)
        index += 1
        break
      case "--password":
        config.password = requireValue(args, index, option)
        index += 1
        break
      case "--acp-command":
        config.acpCommand = requireValue(args, index, option)
        acpCommandOverridden = true
        index += 1
        break
      case "--acp-arg":
        if (!acpArgsOverridden) {
          config.acpArgs = []
          acpArgsOverridden = true
        }
        config.acpArgs.push(requireValue(args, index, option))
        index += 1
        break
      case "--root":
        config.roots.push(requireValue(args, index, option))
        index += 1
        break
      case "--session-days":
        config.sessionDays = parseSessionDays(requireValue(args, index, option))
        index += 1
        break
      case "--cors":
        config.corsOrigins.push(requireValue(args, index, option))
        index += 1
        break
      case "--log-requests":
        config.logRequests = true
        break
      case "--state-dir":
        config.stateDirectory = requireValue(args, index, option)
        index += 1
        break
      case "--agy-auth":
      case "--agy-auth-source":
        agyAuthDraft.source = requireValue(args, index, option)
        index += 1
        break
      case "--agy-api-key-file":
        agyAuthDraft.apiKeyFile = requireValue(args, index, option)
        index += 1
        break
      case "--agy-api-key-env":
        agyAuthDraft.apiKeyEnv = requireValue(args, index, option)
        index += 1
        break
      case "--agy-base-url":
        agyAuthDraft.baseUrl = requireValue(args, index, option)
        index += 1
        break
      case "--agy-project":
        agyAuthDraft.project = requireValue(args, index, option)
        index += 1
        break
      case "--agy-location":
        agyAuthDraft.location = requireValue(args, index, option)
        index += 1
        break
      case "--agy-quota-project":
        agyAuthDraft.quotaProject = requireValue(args, index, option)
        index += 1
        break
      case "--agy-credentials-file":
        agyAuthDraft.credentialsFile = requireValue(args, index, option)
        index += 1
        break
      case "--agy-gemini-dir":
        agyAuthDraft.geminiDir = requireValue(args, index, option)
        index += 1
        break
      case "--agy-app-data-dir":
        agyAuthDraft.appDataDir = requireValue(args, index, option)
        index += 1
        break
      case "--help":
        config.help = true
        break
      default:
        throw new Error(`Unknown option: ${option}`)
    }
  }

  const normalizedAgyAuth = normalizeAgyAuthConfig(agyAuthDraft)
  if (normalizedAgyAuth) config.agyAuth = normalizedAgyAuth

  if (Boolean(config.username) !== Boolean(config.password)) {
    throw new Error("--username and --password must be supplied together")
  }
  if (!LOOPBACK_HOSTS.has(config.host) && !config.username) {
    throw new Error("A username and password are required when binding beyond loopback")
  }
  return config
}

export function usage() {
  return `Usage: harness-remote-bridge [options]

Options:
  --config <path>                Load JSON server configuration file
  --backend <name>               ACP backend: omp, pi, claude, codex, or agy (default: omp)
  --host <host>                  Bind host (default: 127.0.0.1)
  --port <port>                  Bind port (default: 4097)
  --username <username>          Enable HTTP Basic Auth
  --password <password>          Enable HTTP Basic Auth
  --acp-command <path>           ACP adapter command (default depends on backend)
  --acp-arg <arg>                ACP adapter argument; repeatable
  --root <path>                  Allowed worktree root; repeatable
  --session-days <n>             Only list Sessions active within n days; 0 disables (default: 7)
  --cors <origin>                Allow browser requests from this exact origin; repeatable
  --state-dir <path>             Persist bridge session snapshots
  --agy-auth <source>            Antigravity auth source: cli, oauth-personal, oauth-business, gemini-api-key, or agent-platform
  --agy-api-key-file <path>      Read GEMINI_API_KEY for agy from a plain-text or JSON file
  --agy-base-url <url>           Override GOOGLE_GEMINI_BASE_URL for agy
  --agy-project <id>             Override GOOGLE_CLOUD_PROJECT for agy
  --agy-location <region>        Override GOOGLE_CLOUD_LOCATION for agy
  --agy-credentials-file <path>  Override GOOGLE_APPLICATION_CREDENTIALS for agy
  --log-requests                 Log request method, path, and query
  --help                         Show this help`
}
