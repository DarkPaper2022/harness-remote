import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const AGY_LIST_PAGE_LIMIT = 50
const AGY_LIST_CURSOR_PREFIX = "agy-modified:"
const CONVERSATION_FILES_TTL_MS = 2_000

let sqliteModulePromise
function loadSqliteModule() {
  sqliteModulePromise ??= import("node:sqlite").catch(() => null)
  return sqliteModulePromise
}

/**
 * Go's SQLite driver formats timestamps as `YYYY-MM-DD HH:MM:SS.nnnnnnnnn+00:00`. Trim sub-millisecond
 * digits and insert `T` so V8 parses an exact epoch millisecond across locales and Node versions.
 */
export function parseAgyTimestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return undefined
  const normalized = value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T")
    .replace(/(\.\d{3})\d+/, "$1")
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function firstWorkspaceDirectory(workspaceUris) {
  if (typeof workspaceUris !== "string" || !workspaceUris.trim()) return undefined
  let parsed
  try {
    parsed = JSON.parse(workspaceUris)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  for (const entry of parsed) {
    if (typeof entry !== "string" || !entry.trim()) continue
    if (entry.startsWith("file://")) {
      try {
        return fileURLToPath(entry)
      } catch {
        continue
      }
    }
    if (path.isAbsolute(entry)) return entry
  }
  return undefined
}

function decodeAgyListCursor(cursor) {
  if (typeof cursor !== "string" || !cursor.startsWith(AGY_LIST_CURSOR_PREFIX)) return undefined
  const match = /^(\d+):(.+)$/.exec(cursor.slice(AGY_LIST_CURSOR_PREFIX.length))
  if (!match) return undefined
  const updatedAtMs = Number(match[1])
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) return undefined
  try {
    const id = decodeURIComponent(match[2])
    return id ? { updatedAtMs, id } : undefined
  } catch {
    return undefined
  }
}

async function summaryTableColumns(file) {
  const sqlite = await loadSqliteModule()
  if (!sqlite?.DatabaseSync) return undefined
  let database
  try {
    database = new sqlite.DatabaseSync(file, { readOnly: true })
    const columns = new Set(
      database.prepare("PRAGMA table_info(conversation_summaries)").all().map((row) => row.name)
    )
    return columns.size > 0 ? columns : undefined
  } catch {
    return undefined
  } finally {
    database?.close()
  }
}

/**
 * Lightweight SQLite reader for Antigravity's `conversation_summaries.db`.
 *
 * Cold-starting `agy acp` just to answer `/v1/projects` or the first Session-rail page boots its Go
 * language server and refreshes remote model metadata (~3s), and `agy acp`'s own `session/list`
 * assigns its process `cwd` to standalone conversations that had `workspace_uris = []`. Reading the
 * summary table directly keeps discovery fast, paginated, and faithful to each conversation's real
 * workspace while falling back to ACP `session/list` whenever `node:sqlite` or the database is absent.
 */
export function createAgySessionIndex({
  geminiDir = path.join(homedir(), ".gemini"),
  appDataDir = "antigravity-cli"
} = {}) {
  const appDataPath = path.join(geminiDir, appDataDir)
  const databaseFile = path.join(appDataPath, "conversation_summaries.db")
  const conversationsDir = path.join(appDataPath, "conversations")
  const standaloneScratchDir = path.join(appDataPath, "scratch")

  let storedIDsCache = null
  let storedIDsAt = 0
  let storedIDsPromise = null

  async function storedConversationIDs() {
    const now = Date.now()
    if (storedIDsCache && now - storedIDsAt < CONVERSATION_FILES_TTL_MS) return storedIDsCache
    if (!storedIDsPromise) {
      storedIDsPromise = readdir(conversationsDir)
        .then((entries) => {
          const ids = new Set()
          for (const name of entries) {
            if (name.endsWith(".db")) ids.add(name.slice(0, -3))
            else if (name.endsWith(".pb")) ids.add(name.slice(0, -3))
          }
          storedIDsCache = ids
          storedIDsAt = Date.now()
          return ids
        })
        .catch(() => null)
        .finally(() => {
          storedIDsPromise = null
        })
    }
    return storedIDsPromise
  }

  async function readSummaryRows() {
    const columns = await summaryTableColumns(databaseFile)
    if (!columns) return undefined
    for (const required of ["conversation_id", "title", "last_modified_time", "workspace_uris"]) {
      if (!columns.has(required)) return undefined
    }
    const sqlite = await loadSqliteModule()
    if (!sqlite?.DatabaseSync) return undefined
    let database
    try {
      database = new sqlite.DatabaseSync(databaseFile, { readOnly: true })
      const conditions = ["conversation_id IS NOT NULL", "conversation_id <> ''"]
      if (columns.has("killed")) conditions.push("killed = 0")
      if (columns.has("parent_conversation_id")) conditions.push("parent_conversation_id = ''")
      if (columns.has("nesting_depth")) conditions.push("nesting_depth = 0")
      const previewExpr = columns.has("preview") ? "COALESCE(NULLIF(title, ''), preview, '')" : "COALESCE(title, '')"
      return database
        .prepare(
          `SELECT conversation_id AS id, ${previewExpr} AS title, last_modified_time AS lastModified, workspace_uris AS workspaceUris
           FROM conversation_summaries
           WHERE ${conditions.join(" AND ")}
           ORDER BY last_modified_time DESC, conversation_id DESC`
        )
        .all()
    } catch {
      return undefined
    } finally {
      database?.close()
    }
  }

  return {
    async listSessions({ cursor, sinceMs, query, limit = AGY_LIST_PAGE_LIMIT } = {}) {
      const before = cursor === undefined ? undefined : decodeAgyListCursor(cursor)
      if (cursor !== undefined && before === undefined) return undefined
      const [rows, storedIDs] = await Promise.all([readSummaryRows(), storedConversationIDs()])
      if (!rows) return undefined

      const boundedLimit = Math.max(1, Math.min(200, Number(limit) || AGY_LIST_PAGE_LIMIT))
      const lowerQuery = typeof query === "string" ? query.trim().toLowerCase() : ""
      const cutoff = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0

      const matching = []
      for (const row of rows) {
        if (storedIDs && !storedIDs.has(row.id)) continue
        const updatedAtMs = parseAgyTimestampMs(row.lastModified) ?? 0
        if (cutoff && updatedAtMs < cutoff) continue
        const cwd = firstWorkspaceDirectory(row.workspaceUris) ?? standaloneScratchDir
        const title = typeof row.title === "string" ? row.title.trim() : ""
        if (lowerQuery) {
          const hit = title.toLowerCase().includes(lowerQuery)
            || cwd.toLowerCase().includes(lowerQuery)
            || String(row.id).toLowerCase().includes(lowerQuery)
          if (!hit) continue
        }
        matching.push({
          id: String(row.id),
          cwd,
          title: title || null,
          updatedAtMs,
          updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : undefined
        })
      }

      matching.sort((left, right) =>
        right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id)
      )

      const filtered = before
        ? matching.filter((item) =>
          item.updatedAtMs < before.updatedAtMs
          || (item.updatedAtMs === before.updatedAtMs && item.id < before.id)
        )
        : matching

      const hasMore = filtered.length > boundedLimit
      const page = hasMore ? filtered.slice(0, boundedLimit) : filtered
      const last = page.at(-1)
      return {
        sessions: page.map(({ id, cwd, title, updatedAt }) => ({
          sessionId: id,
          cwd,
          title,
          updatedAt
        })),
        ...(hasMore && last
          ? { nextCursor: `${AGY_LIST_CURSOR_PREFIX}${last.updatedAtMs}:${encodeURIComponent(last.id)}` }
          : {})
      }
    },

    async listSessionDirectories({ sinceMs } = {}) {
      const [rows, storedIDs] = await Promise.all([readSummaryRows(), storedConversationIDs()])
      if (!rows) return []
      const cutoff = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0
      const directories = new Set()
      for (const row of rows) {
        if (storedIDs && !storedIDs.has(row.id)) continue
        const updatedAtMs = parseAgyTimestampMs(row.lastModified) ?? 0
        if (cutoff && updatedAtMs < cutoff) continue
        const cwd = firstWorkspaceDirectory(row.workspaceUris)
        if (cwd) directories.add(cwd)
      }
      return [...directories]
    }
  }
}
