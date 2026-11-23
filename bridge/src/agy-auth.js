import fs from "node:fs"
import path from "node:path"

const AUTH_SOURCE_ALIASES = new Map([
  ["cli", "cli"],
  ["auto", "cli"],
  ["cached", "cli"],
  ["default", "cli"],
  ["oauth-personal", "oauth-personal"],
  ["oauth", "oauth-personal"],
  ["google", "oauth-personal"],
  ["oauth-business", "oauth-business"],
  ["enterprise", "oauth-business"],
  ["workspace", "oauth-business"],
  ["gemini-api-key", "gemini-api-key"],
  ["api-key", "gemini-api-key"],
  ["gemini", "gemini-api-key"],
  ["agent-platform", "agent-platform"],
  ["adc", "agent-platform"],
  ["vertex", "agent-platform"],
  ["vertex-ai", "agent-platform"]
])

export const AGY_AUTH_SOURCES = [
  "cli",
  "oauth-personal",
  "oauth-business",
  "gemini-api-key",
  "agent-platform"
]

function optionalString(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`)
  const trimmed = value.trim()
  return trimmed || undefined
}

export function normalizeAgyAuthSource(value) {
  const raw = optionalString(value, "agy auth source")
  if (!raw) return undefined
  const normalized = AUTH_SOURCE_ALIASES.get(raw.toLowerCase())
  if (!normalized) {
    throw new Error(
      `Unsupported agy auth source '${raw}'. Expected one of: ${AGY_AUTH_SOURCES.join(", ")}`
    )
  }
  return normalized
}

export function validateAgyGeminiDir(value) {
  const dir = optionalString(value, "agy geminiDir")
  if (!dir) return undefined
  if (!path.isAbsolute(dir)) {
    throw new Error("agy geminiDir must be an absolute path")
  }
  return dir
}

export function validateAgyAppDataDir(value) {
  const dir = optionalString(value, "agy appDataDir")
  if (!dir) return undefined
  if (
    path.isAbsolute(dir)
    || dir.includes("/")
    || dir.includes("\\")
    || dir === "."
    || dir === ".."
  ) {
    throw new Error(
      "agy appDataDir must be a relative subdirectory name under geminiDir (for example 'antigravity-cli' or 'antigravity')"
    )
  }
  return dir
}

/**
 * Normalize raw `agy` auth/profile settings from JSON config, environment variables, or CLI flags.
 * Returns `undefined` when nothing was configured so default config objects stay clean.
 */
export function normalizeAgyAuthConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("agy auth configuration must be an object")
  }
  const source = normalizeAgyAuthSource(input.source)
  const apiKey = optionalString(input.apiKey, "agy.auth.apiKey")
  const apiKeyFile = optionalString(input.apiKeyFile, "agy.auth.apiKeyFile")
  const apiKeyEnv = optionalString(input.apiKeyEnv, "agy.auth.apiKeyEnv")
  const baseUrl = optionalString(input.baseUrl, "agy.auth.baseUrl")
  const project = optionalString(input.project, "agy.auth.project")
  const location = optionalString(input.location, "agy.auth.location")
  const quotaProject = optionalString(input.quotaProject, "agy.auth.quotaProject")
  const credentialsFile = optionalString(input.credentialsFile, "agy.auth.credentialsFile")
  const geminiDir = validateAgyGeminiDir(input.geminiDir)
  const appDataDir = validateAgyAppDataDir(input.appDataDir)

  const normalized = {
    ...(source ? { source } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyFile ? { apiKeyFile } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(project ? { project } : {}),
    ...(location ? { location } : {}),
    ...(quotaProject ? { quotaProject } : {}),
    ...(credentialsFile ? { credentialsFile } : {}),
    ...(geminiDir ? { geminiDir } : {}),
    ...(appDataDir ? { appDataDir } : {})
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function unquoteShellValue(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim()
  }
  const commentIndex = trimmed.search(/\s+#/)
  return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim()
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Read a Gemini API key from a plain-text key file, a JSON credential file, or a shell/dotenv
 * environment file (such as `~/.environment` containing `export GEMINI_API_KEY="..."`) without ever
 * echoing the file's contents into error messages or logs.
 */
export function readAgyApiKeyFile(filePath, readFileImpl = fs.readFileSync, envVarName = "GEMINI_API_KEY") {
  let raw
  try {
    raw = readFileImpl(filePath, "utf8")
  } catch {
    throw new Error(`Cannot read agy API key file: ${filePath}`)
  }
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (!trimmed) throw new Error(`agy API key file is empty: ${filePath}`)
  if (trimmed.startsWith("{")) {
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error(`agy API key file contains invalid JSON: ${filePath}`)
    }
    const candidate = [parsed?.[envVarName], parsed?.GEMINI_API_KEY, parsed?.apiKey, parsed?.api_key, parsed?.key]
      .find((value) => typeof value === "string" && value.trim())
    if (!candidate) {
      throw new Error(`agy API key JSON file must contain ${envVarName} or apiKey: ${filePath}`)
    }
    return candidate.trim()
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"))
  if (!lines.length) throw new Error(`agy API key file is empty: ${filePath}`)

  const assignmentPattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(envVarName)}\\s*=\\s*(.+)$`)
  let matchedAssignment
  for (const line of lines) {
    const match = assignmentPattern.exec(line)
    if (match) matchedAssignment = unquoteShellValue(match[1])
  }
  if (matchedAssignment !== undefined) {
    if (!matchedAssignment) throw new Error(`${envVarName} is empty in agy API key file: ${filePath}`)
    return matchedAssignment
  }

  const looksLikeShellOrEnvFile = lines.some((line) =>
    /^(?:export|alias|source|\.)\s+/.test(line) || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)
  )
  if (looksLikeShellOrEnvFile) {
    throw new Error(`agy API key file does not define ${envVarName}: ${filePath}`)
  }

  return lines[0]
}

function hasFlag(args, names) {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)))
}

/**
 * Resolve the ACP launch arguments, child environment, and ACP handshake policy for `agy`.
 *
 * `agy acp` reuses cached CLI credentials when no `authenticate` RPC is sent, while calling
 * `authenticate({ methodId: "oauth-personal" })` without cached credentials opens a browser window
 * and blocks. Defaulting `cli` mode to `skipAuthenticate: true` keeps headless daemons browser-free
 * while allowing explicit `gemini-api-key`, `agent-platform`, `oauth-personal`, or `oauth-business`
 * selection from the server configuration.
 */
export function resolveAgyRuntime({
  baseArgs = ["acp"],
  agyAuth,
  environment = process.env,
  platform = process.platform,
  getuid = process.getuid,
  existsSync = fs.existsSync,
  readFileImpl = fs.readFileSync
} = {}) {
  const normalized = agyAuth ? normalizeAgyAuthConfig(agyAuth) : undefined
  const source = normalized?.source ?? "cli"
  const args = [...baseArgs]

  if (normalized?.geminiDir && !hasFlag(args, ["--gemini-dir", "--gemini_dir"])) {
    args.push("--gemini-dir", normalized.geminiDir)
  }
  if (normalized?.appDataDir && !hasFlag(args, ["--app-data-dir", "--app_data_dir"])) {
    args.push("--app-data-dir", normalized.appDataDir)
  }

  const childEnv = {
    ...environment,
    NO_BROWSER: environment.NO_BROWSER ?? "1",
    BROWSER: environment.BROWSER ?? (platform === "win32" ? "cmd /c exit 1" : "/bin/false")
  }

  // systemd user services and SSH sessions on Linux sometimes omit DBUS_SESSION_BUS_ADDRESS even
  // though the user's Secret Service bus socket is live under XDG_RUNTIME_DIR. Supplying it lets
  // keyring-backed `cli` / `oauth-*` auth succeed without interactive re-login.
  if (platform === "linux" && !childEnv.DBUS_SESSION_BUS_ADDRESS && typeof getuid === "function") {
    const runtimeDir = childEnv.XDG_RUNTIME_DIR || `/run/user/${getuid.call(process)}`
    const busSocket = path.join(runtimeDir, "bus")
    try {
      if (existsSync(busSocket)) childEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busSocket}`
    } catch {
      // Best-effort probe only.
    }
  }

  if (normalized?.baseUrl) childEnv.GOOGLE_GEMINI_BASE_URL = normalized.baseUrl
  if (normalized?.project) childEnv.GOOGLE_CLOUD_PROJECT = normalized.project
  if (normalized?.location) childEnv.GOOGLE_CLOUD_LOCATION = normalized.location
  if (normalized?.quotaProject) childEnv.GOOGLE_CLOUD_QUOTA_PROJECT = normalized.quotaProject
  if (normalized?.credentialsFile) childEnv.GOOGLE_APPLICATION_CREDENTIALS = normalized.credentialsFile

  let resolvedApiKey = normalized?.apiKey
  const targetEnvVar = normalized?.apiKeyEnv || "GEMINI_API_KEY"
  if (!resolvedApiKey && normalized?.apiKeyFile) {
    resolvedApiKey = readAgyApiKeyFile(normalized.apiKeyFile, readFileImpl, targetEnvVar)
  }
  if (!resolvedApiKey && normalized?.apiKeyEnv) {
    const fromNamedEnv = environment[normalized.apiKeyEnv]
    if (typeof fromNamedEnv === "string" && fromNamedEnv.trim()) resolvedApiKey = fromNamedEnv.trim()
  }
  if (!resolvedApiKey && source === "gemini-api-key") {
    const ambient = environment.GEMINI_API_KEY
    if (typeof ambient === "string" && ambient.trim()) resolvedApiKey = ambient.trim()
  }
  if (resolvedApiKey) childEnv.GEMINI_API_KEY = resolvedApiKey

  if (source === "gemini-api-key" && !childEnv.GEMINI_API_KEY) {
    throw new Error(
      "agy auth source 'gemini-api-key' requires an API key (set agy.auth.apiKey, agy.auth.apiKeyFile, HARNESS_REMOTE_AGY_API_KEY, HARNESS_REMOTE_AGY_API_KEY_FILE, or GEMINI_API_KEY)"
    )
  }

  if (source === "agent-platform") {
    childEnv.AGY_ADC_AUTH = "true"
  }

  const skipAuthenticate = source === "cli"
  const requiredAuthMethod = source === "cli" ? undefined : source

  return {
    authSource: source,
    args,
    env: childEnv,
    skipAuthenticate,
    requiredAuthMethod,
    geminiDir: normalized?.geminiDir,
    appDataDir: normalized?.appDataDir
  }
}
