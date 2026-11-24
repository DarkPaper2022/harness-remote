import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const WEB_UPDATE_MANIFEST_ROUTE = "/v1/web-update/manifest"
const WEB_UPDATE_FILE_ROUTE = "/v1/web-update/file"

const CANDIDATE_WEB_DIST_DIRS = [
  path.join(ROOT_DIR, "deployment", "web-dist"),
  path.join(ROOT_DIR, "web", "dist")
]

async function readAppVersion() {
  for (const rel of ["package.json", "web/package.json"]) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(ROOT_DIR, rel), "utf8"))
      if (typeof raw?.version === "string" && raw.version.trim()) return raw.version.trim()
    } catch {
      // continue
    }
  }
  return "0.0.0"
}

export async function resolveWebBundleDirectory(overrideDir) {
  const candidates = [
    ...(typeof overrideDir === "string" && overrideDir.trim() ? [path.resolve(overrideDir.trim())] : []),
    ...(typeof process.env.HARNESS_REMOTE_WEB_DIST === "string" && process.env.HARNESS_REMOTE_WEB_DIST.trim()
      ? [path.resolve(process.env.HARNESS_REMOTE_WEB_DIST.trim())]
      : []),
    ...CANDIDATE_WEB_DIST_DIRS
  ]
  for (const dir of candidates) {
    try {
      const stat = await fs.stat(path.join(dir, "index.html"))
      if (stat.isFile()) return dir
    } catch {
      // try next candidate
    }
  }
  return null
}

async function walkBundleFiles(rootDir, currentDir = rootDir, acc = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      await walkBundleFiles(rootDir, fullPath, acc)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith(".map")) continue
    const relPath = path.relative(rootDir, fullPath).split(path.sep).join("/")
    const content = await fs.readFile(fullPath)
    const sha256 = crypto.createHash("sha256").update(content).digest("hex")
    acc.push({ path: relPath, size: content.byteLength, sha256 })
  }
  return acc
}

export async function buildWebUpdateManifest(overrideDir) {
  const dir = await resolveWebBundleDirectory(overrideDir)
  if (!dir) return null
  const files = (await walkBundleFiles(dir)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (!files.some((file) => file.path === "index.html")) return null
  const bundleHash = crypto
    .createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.size}:${file.sha256}`).join("\n"))
    .digest("hex")
    .slice(0, 16)
  const version = await readAppVersion()
  return {
    available: true,
    version,
    bundleId: `${version}-${bundleHash}`,
    bundleHash,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files
  }
}

function safeRelativeAssetPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null
  const normalized = path.posix.normalize(rawPath.trim().replace(/^\/+/, "").replace(/\\/g, "/"))
  if (
    !normalized
    || normalized === "."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.split("/").some((segment) => !segment || segment.startsWith("."))
  ) {
    return null
  }
  return normalized
}

export function createWebUpdateServer({ innerServer, config, webDistDir, createServer }) {
  let cachedManifest = null
  let cachedAt = 0

  async function currentManifest() {
    const now = Date.now()
    if (cachedManifest && now - cachedAt < 2_000) return cachedManifest
    cachedManifest = await buildWebUpdateManifest(webDistDir)
    cachedAt = Date.now()
    return cachedManifest
  }

  const server = createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (requestURL.pathname !== WEB_UPDATE_MANIFEST_ROUTE && requestURL.pathname !== WEB_UPDATE_FILE_ROUTE) {
      innerServer.emit("request", request, response)
      return
    }
    if (!authenticateDaemonRequest(request, response, config)) return
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET, OPTIONS" })
      response.end()
      return
    }

    try {
      if (requestURL.pathname === WEB_UPDATE_MANIFEST_ROUTE) {
        const manifest = await currentManifest()
        if (!manifest) {
          writeJSON(response, 200, { available: false })
          return
        }
        writeJSON(response, 200, manifest)
        return
      }

      const relPath = safeRelativeAssetPath(requestURL.searchParams.get("path"))
      if (!relPath) {
        writeJSON(response, 400, { error: "A valid relative asset path is required" })
        return
      }
      const dir = await resolveWebBundleDirectory(webDistDir)
      if (!dir) {
        writeJSON(response, 404, { error: "Web UI bundle is not installed on this server" })
        return
      }
      const resolvedRoot = await fs.realpath(dir)
      const candidatePath = path.resolve(resolvedRoot, relPath)
      const resolvedFile = await fs.realpath(candidatePath).catch(() => null)
      if (!resolvedFile || (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`))) {
        writeJSON(response, 404, { error: `Asset not found: ${relPath}` })
        return
      }
      const content = await fs.readFile(resolvedFile)
      const sha256 = crypto.createHash("sha256").update(content).digest("hex")
      writeJSON(response, 200, {
        path: relPath,
        size: content.byteLength,
        sha256,
        base64: content.toString("base64")
      })
    } catch (error) {
      writeJSON(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  server.on("close", () => {
    innerServer.emit("close")
  })

  return server
}
