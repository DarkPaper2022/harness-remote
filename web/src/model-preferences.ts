const FAVORITE_MODELS_STORAGE_KEY = "harness-remote.favoriteModels.v1"
const PROJECT_DEFAULTS_STORAGE_KEY = "harness-remote.projectDefaults.v1"
const MAX_FAVORITE_MODELS = 16
const MAX_PROJECT_ENTRIES = 100

export const FAVORITE_MODELS_CHANGED_EVENT = "hr:favorite-models-changed"

type ProjectDefaultEntry = {
  agentID?: string
  modelsByAgent?: Record<string, string>
  updatedAt: number
}

type ProjectDefaultsMap = Record<string, ProjectDefaultEntry>

export function normalizeProjectDirectoryKey(directory?: string): string {
  if (!directory) return ""
  const trimmed = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (!trimmed) return ""
  return /^[A-Za-z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

export function loadFavoriteModelKeys(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === "string" && item.includes("|"))
      .slice(0, MAX_FAVORITE_MODELS)
  } catch {
    return []
  }
}

export function toggleFavoriteModelKey(key: string): string[] {
  const trimmed = key.trim()
  if (!trimmed) return loadFavoriteModelKeys()
  const current = loadFavoriteModelKeys()
  const exists = current.includes(trimmed)
  const next = exists
    ? current.filter((item) => item !== trimmed)
    : [trimmed, ...current].slice(0, MAX_FAVORITE_MODELS)
  try {
    localStorage.setItem(FAVORITE_MODELS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode keeps UI responsive even if storage is unavailable.
  }
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(FAVORITE_MODELS_CHANGED_EVENT))
    }
  } catch {}
  return next
}

function readProjectDefaultsMap(): ProjectDefaultsMap {
  try {
    const raw = localStorage.getItem(PROJECT_DEFAULTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as ProjectDefaultsMap
  } catch {
    return {}
  }
}

function writeProjectDefaultsMap(map: ProjectDefaultsMap): void {
  try {
    const entries = Object.entries(map)
      .filter(([key, val]) => key && val && typeof val === "object")
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, MAX_PROJECT_ENTRIES)
    localStorage.setItem(PROJECT_DEFAULTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {}
}

function machineProjectScopeKey(machineID: string, normalizedDir: string): string {
  return machineID ? `${machineID}::${normalizedDir}` : normalizedDir
}

export function loadProjectDefaultAgent(machineID: string, directory?: string): string | undefined {
  const normalizedDir = normalizeProjectDirectoryKey(directory)
  if (!normalizedDir) return undefined
  const map = readProjectDefaultsMap()
  const scoped = map[machineProjectScopeKey(machineID, normalizedDir)]?.agentID
  if (typeof scoped === "string" && scoped.trim()) return scoped.trim()
  const byDir = map[normalizedDir]?.agentID
  return typeof byDir === "string" && byDir.trim() ? byDir.trim() : undefined
}

export function saveProjectDefaultAgent(machineID: string, directory: string | undefined, agentID: string): void {
  const normalizedDir = normalizeProjectDirectoryKey(directory)
  const trimmedAgent = agentID.trim()
  if (!normalizedDir || !trimmedAgent) return
  const map = readProjectDefaultsMap()
  const now = Date.now()
  for (const key of [machineProjectScopeKey(machineID, normalizedDir), normalizedDir]) {
    const prev = map[key] ?? { updatedAt: now }
    map[key] = { ...prev, agentID: trimmedAgent, updatedAt: now }
  }
  writeProjectDefaultsMap(map)
}

export function loadProjectDefaultModelKey(directory: string | undefined, agentID: string): string | undefined {
  const normalizedDir = normalizeProjectDirectoryKey(directory)
  const trimmedAgent = agentID.trim()
  if (!normalizedDir || !trimmedAgent) return undefined
  const map = readProjectDefaultsMap()
  const value = map[normalizedDir]?.modelsByAgent?.[trimmedAgent]
  return typeof value === "string" && value.includes("|") ? value : undefined
}

export function saveProjectDefaultModelKey(directory: string | undefined, agentID: string, modelKey: string): void {
  const normalizedDir = normalizeProjectDirectoryKey(directory)
  const trimmedAgent = agentID.trim()
  const trimmedModel = modelKey.trim()
  if (!normalizedDir || !trimmedAgent || !trimmedModel.includes("|")) return
  const map = readProjectDefaultsMap()
  const now = Date.now()
  const prev = map[normalizedDir] ?? { updatedAt: now }
  map[normalizedDir] = {
    ...prev,
    modelsByAgent: { ...(prev.modelsByAgent ?? {}), [trimmedAgent]: trimmedModel },
    updatedAt: now
  }
  writeProjectDefaultsMap(map)
}
