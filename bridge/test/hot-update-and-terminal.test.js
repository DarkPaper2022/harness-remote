import assert from "node:assert/strict"
import crypto from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { allowedOrigin, applyCorsHeaders } from "../src/http-policy.js"
import { createTerminalServer } from "../src/terminal-server.js"
import { createWebUpdateServer } from "../src/web-update-server.js"

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  return `http://127.0.0.1:${addr.port}`
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()))
}

test("Capacitor native WebView origins are allowed by CORS while untrusted origins stay blocked", () => {
  const config = { corsOrigins: ["https://trusted.example"] }
  assert.equal(
    allowedOrigin({ headers: { origin: "capacitor://localhost" } }, config),
    "capacitor://localhost"
  )
  assert.equal(
    allowedOrigin({ headers: { origin: "ionic://localhost" } }, config),
    "ionic://localhost"
  )
  assert.equal(
    allowedOrigin({ headers: { origin: "https://evil.example" } }, config),
    undefined
  )

  const headers = new Map()
  const mockRes = { setHeader: (k, v) => headers.set(k.toLowerCase(), v) }
  applyCorsHeaders({ headers: { origin: "capacitor://localhost" } }, mockRes, { corsOrigins: [] })
  assert.equal(headers.get("access-control-allow-origin"), "capacitor://localhost")
})

test("Web UI hot-update server serves SHA-256 verified manifest/files and blocks traversal & unauthenticated access", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hr-web-update-"))
  t.after(() => rm(tmpDir, { recursive: true, force: true }))

  await mkdir(path.join(tmpDir, "assets"), { recursive: true })
  const indexHtml = "<!doctype html><html><body>Harness Hot UI</body></html>"
  const appJs = "console.log('hot-bundle-v1');"
  await writeFile(path.join(tmpDir, "index.html"), indexHtml)
  await writeFile(path.join(tmpDir, "assets", "app.js"), appJs)
  await writeFile(path.join(tmpDir, "assets", "app.js.map"), "{}")

  const config = { username: "admin", password: "secret", corsOrigins: [] }
  const fallback = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end("inner-404")
  })
  const server = createWebUpdateServer({
    innerServer: fallback,
    config,
    webDistDir: tmpDir,
    createServer: http.createServer
  })
  const base = await listen(server)
  t.after(() => closeServer(server))

  // Unauthenticated -> 401
  const unauth = await fetch(`${base}/v1/web-update/manifest`)
  assert.equal(unauth.status, 401)

  const headers = { Authorization: basicAuth("admin", "secret") }
  const manifestRes = await fetch(`${base}/v1/web-update/manifest`, { headers })
  assert.equal(manifestRes.status, 200)
  const manifest = await manifestRes.json()
  assert.equal(manifest.available, true)
  assert.ok(manifest.bundleId)
  // .map files are excluded from hot-update bundles
  assert.deepEqual(manifest.files.map((f) => f.path), ["assets/app.js", "index.html"])

  const fileRes = await fetch(`${base}/v1/web-update/file?path=${encodeURIComponent("assets/app.js")}`, { headers })
  assert.equal(fileRes.status, 200)
  const filePayload = await fileRes.json()
  const expectedSha = crypto.createHash("sha256").update(appJs).digest("hex")
  assert.equal(filePayload.sha256, expectedSha)
  assert.equal(Buffer.from(filePayload.base64, "base64").toString("utf8"), appJs)

  // Path traversal attempts must be rejected
  for (const malicious of ["../etc/passwd", "assets/../../etc/passwd", ".hidden", "/../../secret"]) {
    const res = await fetch(`${base}/v1/web-update/file?path=${encodeURIComponent(malicious)}`, { headers })
    assert.ok(res.status === 400 || res.status === 404, `Expected 400/404 for ${malicious}, got ${res.status}`)
  }
})

test("Workspace terminal server spawns interactive shell inside allowed root, streams output, and blocks outside directories", async (t) => {
  const allowedRoot = await mkdtemp(path.join(os.tmpdir(), "hr-term-root-"))
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "hr-term-outside-"))
  t.after(async () => {
    await rm(allowedRoot, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  const config = { username: "dev", password: "pw", roots: [allowedRoot], corsOrigins: [] }
  const fallback = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  const server = createTerminalServer({
    innerServer: fallback,
    config,
    dynamicRoots: async () => [],
    createServer: http.createServer
  })
  const base = await listen(server)
  t.after(() => closeServer(server))

  const headers = {
    Authorization: basicAuth("dev", "pw"),
    "Content-Type": "application/json"
  }

  // Directory outside --root must be rejected with 403
  const forbidden = await fetch(`${base}/v1/terminals`, {
    method: "POST",
    headers,
    body: JSON.stringify({ directory: outsideRoot })
  })
  assert.equal(forbidden.status, 403)

  // Allowed directory spawns interactive shell
  const createdRes = await fetch(`${base}/v1/terminals`, {
    method: "POST",
    headers,
    body: JSON.stringify({ directory: allowedRoot, cols: 90, rows: 24 })
  })
  assert.equal(createdRes.status, 201)
  const created = await createdRes.json()
  const termId = created.terminal.id
  assert.ok(termId.startsWith("term_"))
  assert.equal(created.terminal.status, "running")

  // Resize works
  const resizeRes = await fetch(`${base}/v1/terminals/${termId}/resize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cols: 120, rows: 32 })
  })
  assert.equal(resizeRes.status, 200)
  const resized = await resizeRes.json()
  assert.equal(resized.terminal.cols, 120)
  assert.equal(resized.terminal.rows, 32)

  // Write command and poll until marker appears
  const marker = `HR_PTY_OK_${Date.now()}`
  const writeRes = await fetch(`${base}/v1/terminals/${termId}/write`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data: `echo ${marker}\r` })
  })
  assert.equal(writeRes.status, 200)

  let combined = created.chunks.map((c) => c.data).join("")
  let since = created.nextSeq
  const deadline = Date.now() + 6_000
  while (!combined.includes(marker) && Date.now() < deadline) {
    const pollRes = await fetch(`${base}/v1/terminals/${termId}?since=${since}&waitMs=1500`, { headers })
    assert.equal(pollRes.status, 200)
    const snap = await pollRes.json()
    combined += snap.chunks.map((c) => c.data).join("")
    since = snap.nextSeq
  }
  assert.ok(combined.includes(marker), `Expected terminal output to include ${marker}, got: ${combined}`)

  // Delete cleans up terminal
  const delRes = await fetch(`${base}/v1/terminals/${termId}`, { method: "DELETE", headers })
  assert.equal(delRes.status, 200)

  const listRes = await fetch(`${base}/v1/terminals?directory=${encodeURIComponent(allowedRoot)}`, { headers })
  const listed = await listRes.json()
  assert.equal(listed.terminals.length, 0)
})
