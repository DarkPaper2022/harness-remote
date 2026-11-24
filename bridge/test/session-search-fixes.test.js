import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createAgySessionIndex, parseAgyTimestampMs } from "../src/agy-session-history.js"
import { createCodexHistoryLoader } from "../src/codex-session-history.js"
import { createPiHistoryLoader } from "../src/pi-session-history.js"

test("Codex history loader searches title, first_user_message, escapes LIKE wildcards, and searches across model providers", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "hr-codex-search-"))
  t.after(() => rm(codexHome, { recursive: true, force: true }))

  await mkdir(path.join(codexHome, "sessions"), { recursive: true })
  await writeFile(path.join(codexHome, "config.toml"), 'model_provider = "openai"\n')

  const dbPath = path.join(codexHome, "state_5.sqlite")
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      cwd TEXT,
      source TEXT,
      title TEXT,
      name TEXT,
      preview TEXT,
      first_user_message TEXT,
      model_provider TEXT,
      archived INTEGER DEFAULT 0
    );
  `)
  const insert = db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at_ms, updated_at_ms, cwd, source, title, name, preview, first_user_message, model_provider, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `)
  insert.run(
    "thread-old-custom",
    "/tmp/r1.jsonl",
    1000,
    2000,
    "/work/app",
    "cli",
    "Deploy Agy Backend",
    null,
    "short",
    "please configure 100%_coverage auth",
    "custom-openai"
  )
  insert.run(
    "thread-other",
    "/tmp/r2.jsonl",
    1000,
    3000,
    "/work/app",
    "cli",
    "Unrelated",
    null,
    "short",
    "please configure 100Xcoverage auth",
    "openai"
  )
  db.close()

  const previousCodexHome = process.env.CODEX_HOME
  delete process.env.CODEX_HOME
  t.after(() => {
    if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome
  })

  const loader = createCodexHistoryLoader(path.join(codexHome, "sessions"))

  // Matches `title` AND crosses `model_provider` when `query` is non-empty!
  const byTitle = await loader.listSessions({ query: "Agy Backend" })
  assert.deepEqual(byTitle.sessions.map((s) => s.sessionId), ["thread-old-custom"])

  // Matches `first_user_message` AND escapes `_` so `100%_coverage` does NOT match `100Xcoverage`!
  const byExactUnderscore = await loader.listSessions({ query: "100%_coverage" })
  assert.deepEqual(byExactUnderscore.sessions.map((s) => s.sessionId), ["thread-old-custom"])
})

test("AgySessionIndex clamps zero-timestamps, paginates 0-ms cursors, and searches preview + multi-root workspaces", async (t) => {
  const geminiDir = await mkdtemp(path.join(os.tmpdir(), "hr-agy-search-"))
  t.after(() => rm(geminiDir, { recursive: true, force: true }))

  // Go zero-timestamp must clamp to 0 rather than negative -62135596800000
  assert.equal(parseAgyTimestampMs("0001-01-01T00:00:00Z"), 0)

  const appDir = path.join(geminiDir, "antigravity-cli")
  await mkdir(path.join(appDir, "conversations"), { recursive: true })
  await writeFile(path.join(appDir, "conversations", "conv-zero-1.db"), "")
  await writeFile(path.join(appDir, "conversations", "conv-zero-2.db"), "")

  const dbPath = path.join(appDir, "conversation_summaries.db")
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      workspace_uris TEXT,
      last_modified_time TEXT,
      killed INTEGER,
      parent_conversation_id TEXT,
      nesting_depth INTEGER
    );
  `)
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, last_modified_time, killed, parent_conversation_id, nesting_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run(
    "conv-zero-1",
    "",
    "Investigate Capacitor hot update",
    JSON.stringify(["file:///repo/primary", "file:///repo/secondary"]),
    "0001-01-01T00:00:00Z",
    null,
    null,
    null
  )
  insert.run(
    "conv-zero-2",
    "Older zero row",
    "Other topic",
    JSON.stringify(["file:///repo/primary"]),
    "0001-01-01T00:00:00Z",
    0,
    "",
    0
  )
  db.close()

  const index = createAgySessionIndex({ geminiDir, appDataDir: "antigravity-cli" })

  // Searches `preview` AND secondary workspace URI!
  const byPreview = await index.listSessions({ query: "Capacitor hot update" })
  assert.equal(byPreview.sessions.length, 1)
  assert.equal(byPreview.sessions[0].sessionId, "conv-zero-1")
  assert.equal(byPreview.sessions[0].updatedAt, "1970-01-01T00:00:00.000Z")

  const bySecondWorkspace = await index.listSessions({ query: "/repo/secondary" })
  assert.equal(bySecondWorkspace.sessions.length, 1)
  assert.equal(bySecondWorkspace.sessions[0].sessionId, "conv-zero-1")

  const dirs = await index.listSessionDirectories()
  assert.ok(dirs.includes("/repo/primary") && dirs.includes("/repo/secondary"))

  // Paginates cleanly across zero-timestamp rows (`agy-modified:0:...` cursor) without returning undefined!
  const page1 = await index.listSessions({ limit: 1 })
  assert.equal(page1.sessions.length, 1)
  assert.ok(page1.nextCursor?.startsWith("agy-modified:0:"))
  const page2 = await index.listSessions({ limit: 1, cursor: page1.nextCursor })
  assert.ok(page2)
  assert.equal(page2.sessions.length, 1)
  assert.notEqual(page2.sessions[0].sessionId, page1.sessions[0].sessionId)
})

test("PiHistoryLoader indexes and loads session IDs containing underscores", async (t) => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "hr-pi-underscore-"))
  t.after(() => rm(sessionRoot, { recursive: true, force: true }))

  const bucket = path.join(sessionRoot, "--work--")
  await mkdir(bucket, { recursive: true })
  const sessionID = "pi_session_with_underscores_01"
  const filePath = path.join(bucket, `2026-04-10T12-30-00.000Z_${sessionID}.jsonl`)
  await writeFile(
    filePath,
    [
      JSON.stringify({ type: "session", id: sessionID, cwd: "/work", timestamp: "2026-04-10T12:30:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-04-10T12:30:05.000Z",
        message: { role: "user", content: [{ type: "text", text: "Fix underscore session lookup" }] }
      })
    ].join("\n") + "\n"
  )

  const loadPiHistory = createPiHistoryLoader(sessionRoot)
  const updatedAt = await loadPiHistory.sessionUpdatedAt(sessionID)
  assert.ok(updatedAt, "sessionUpdatedAt must resolve for underscore sessionIDs")

  const messages = await loadPiHistory(sessionID)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].parts[0].text, "Fix underscore session lookup")
})
