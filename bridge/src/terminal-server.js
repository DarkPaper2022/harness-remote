import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"

const TERMINALS_ROUTE = "/v1/terminals"
const MAX_ACTIVE_TERMINALS = 16
const MAX_BUFFER_BYTES = 196_608
const MAX_BUFFER_CHUNKS = 1_500
const MAX_WRITE_CHARS = 262_144
const MAX_LONG_POLL_MS = 12_000
const OUTPUT_COALESCE_MS = 10

const PYTHON_PTY_SCRIPT = `
import base64, errno, fcntl, json, os, pty, signal, struct, sys, termios, threading

cols = max(20, min(400, int(sys.argv[1])))
rows = max(5, min(200, int(sys.argv[2])))
shell = sys.argv[3]

pid, master_fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = os.environ.get("TERM") or "xterm-256color"
    os.environ["COLORTERM"] = "truecolor"
    try:
        os.execvp(shell, [shell])
    except Exception:
        os.execvp("/bin/sh", ["/bin/sh"])

def set_winsize(c, r):
    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    except Exception:
        pass

set_winsize(cols, rows)

def stdin_reader():
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            try:
                os.kill(pid, signal.SIGHUP)
            except Exception:
                pass
            break
        try:
            msg = json.loads(line.decode("utf-8", "ignore"))
            kind = msg.get("type")
            if kind == "in":
                raw = base64.b64decode(msg.get("b64", ""))
                if raw:
                    os.write(master_fd, raw)
            elif kind == "resize":
                c = max(20, min(400, int(msg.get("cols", 80))))
                r = max(5, min(200, int(msg.get("rows", 24))))
                set_winsize(c, r)
            elif kind == "kill":
                os.kill(pid, signal.SIGTERM)
        except Exception:
            pass

t = threading.Thread(target=stdin_reader, daemon=True)
t.start()

try:
    while True:
        try:
            data = os.read(master_fd, 16384)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise
except Exception:
    pass

try:
    os.close(master_fd)
except Exception:
    pass

try:
    _, status = os.waitpid(pid, 0)
    if hasattr(os, "waitstatus_to_exitcode"):
        code = os.waitstatus_to_exitcode(status)
    else:
        code = (status >> 8) if os.WIFEXITED(status) else 1
except Exception:
    code = 0

os._exit(max(0, code) if code >= 0 else 128 + abs(code))
`.trim()

let cachedPythonBin
function detectPythonPtyBinary() {
  if (process.platform === "win32") return null
  if (cachedPythonBin !== undefined) return cachedPythonBin
  for (const bin of ["python3", "/usr/bin/python3"]) {
    try {
      const probe = spawnSync(bin, ["-c", "import pty, termios, fcntl; print('ok')"], {
        encoding: "utf8",
        timeout: 2_500
      })
      if (probe.status === 0 && probe.stdout.includes("ok")) {
        cachedPythonBin = bin
        return bin
      }
    } catch {
      // try next candidate
    }
  }
  cachedPythonBin = null
  return null
}

function resolveDefaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe"
  }
  const envShell = typeof process.env.SHELL === "string" ? process.env.SHELL.trim() : ""
  return envShell || "/bin/bash"
}

function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(num)))
}

async function readJsonBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_048_576) {
      const error = new Error("Terminal request body is too large")
      error.statusCode = 413
      throw error
    }
  }
  if (!body.trim()) return {}
  try {
    return JSON.parse(body)
  } catch {
    const error = new Error("Request body must be valid JSON")
    error.statusCode = 400
    throw error
  }
}

async function allowedDirectory(candidate, config, extraRoots) {
  const targetCandidate = typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : (config.roots?.[0] || process.cwd())
  let resolved
  try {
    resolved = await realpath(targetCandidate)
    const info = await stat(resolved)
    if (!info.isDirectory()) {
      const error = new Error("Target path is not a directory")
      error.statusCode = 400
      throw error
    }
  } catch (err) {
    if (err?.statusCode) throw err
    const error = new Error(`Directory does not exist: ${targetCandidate}`)
    error.statusCode = 400
    throw error
  }

  const configured = config.roots?.length ? config.roots : [process.cwd()]
  const learned = typeof extraRoots === "function" ? await extraRoots() : extraRoots
  const candidates = [...configured, ...(Array.isArray(learned) ? learned : [])]
  const roots = (await Promise.all(candidates.map((root) => realpath(root).catch(() => undefined)))).filter(Boolean)
  const inside = roots.some((root) => (
    resolved === root
    || (!path.relative(root, resolved).startsWith(`..${path.sep}`) && path.relative(root, resolved) !== "..")
  ))
  if (!inside) {
    const error = new Error("Directory is outside the configured --root boundary")
    error.statusCode = 403
    throw error
  }
  return resolved
}

function writeSSE(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function terminalSummary(session) {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    shell: session.shell,
    pty: session.isPty,
    pid: session.child?.pid ?? null,
    cols: session.cols,
    rows: session.rows,
    status: session.status,
    exitCode: session.exitCode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSeq: session.nextSeq - 1
  }
}

export function createTerminalServer({
  innerServer,
  config,
  dynamicRoots,
  createServer = http.createServer
}) {
  const sessions = new Map()
  let titleCounterByDir = new Map()

  function nextTitleForDirectory(directory) {
    const next = (titleCounterByDir.get(directory) ?? 0) + 1
    titleCounterByDir.set(directory, next)
    return `Terminal ${next}`
  }

  function snapshotSince(session, sinceSeq) {
    const requested = Number.isFinite(sinceSeq) ? Math.max(0, Math.trunc(sinceSeq)) : 0
    const earliestSeq = session.chunks.length > 0 ? session.chunks[0].seq : session.nextSeq
    const reset = requested > 0 && requested < earliestSeq
    const chunks = requested <= 0
      ? session.chunks.slice()
      : session.chunks.filter((chunk) => chunk.seq >= requested)
    return {
      terminal: terminalSummary(session),
      chunks,
      nextSeq: session.nextSeq,
      reset
    }
  }

  function notifyWaiters(session, immediate = false) {
    if (session.coalesceTimer && immediate) {
      clearTimeout(session.coalesceTimer)
      session.coalesceTimer = null
    }
    const flush = () => {
      session.coalesceTimer = null
      const waiters = [...session.waiters]
      session.waiters.clear()
      for (const waiter of waiters) waiter()
    }
    if (immediate || session.status !== "running") {
      flush()
      return
    }
    if (!session.coalesceTimer) {
      session.coalesceTimer = setTimeout(flush, OUTPUT_COALESCE_MS)
      session.coalesceTimer.unref?.()
    }
  }

  function appendOutput(session, text) {
    if (!text) return
    const now = Date.now()
    const chunk = {
      seq: session.nextSeq++,
      data: text,
      timestamp: now
    }
    const byteLength = Buffer.byteLength(text, "utf8")
    session.chunks.push(chunk)
    session.bufferBytes += byteLength
    session.updatedAt = now

    while (
      session.chunks.length > 1
      && (session.bufferBytes > MAX_BUFFER_BYTES || session.chunks.length > MAX_BUFFER_CHUNKS)
    ) {
      const removed = session.chunks.shift()
      session.bufferBytes -= Buffer.byteLength(removed.data, "utf8")
    }

    for (const stream of session.streams) {
      try {
        writeSSE(stream, "output", chunk)
      } catch {
        session.streams.delete(stream)
      }
    }
    notifyWaiters(session, false)
  }

  function terminateSession(session) {
    if (session.coalesceTimer) {
      clearTimeout(session.coalesceTimer)
      session.coalesceTimer = null
    }
    for (const stream of session.streams) {
      try { stream.end() } catch {}
    }
    session.streams.clear()
    notifyWaiters(session, true)

    const child = session.child
    if (!child || session.killed) return
    session.killed = true
    try {
      if (session.isPty && child.stdin && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ type: "kill" })}\n`)
        child.stdin.end()
      } else if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end()
      }
    } catch {}
    try {
      child.kill("SIGTERM")
    } catch {}
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch {}
    }, 1_500)
    killTimer.unref?.()
  }

  function cleanupAllTerminals() {
    for (const session of sessions.values()) {
      terminateSession(session)
    }
    sessions.clear()
  }

  function spawnTerminalSession({ directory, title, cols, rows, initialCommand }) {
    if (sessions.size >= MAX_ACTIVE_TERMINALS) {
      const exitedEntry = [...sessions.values()]
        .filter((candidate) => candidate.status !== "running")
        .sort((a, b) => a.updatedAt - b.updatedAt)[0]
      if (exitedEntry) {
        terminateSession(exitedEntry)
        sessions.delete(exitedEntry.id)
      }
    }
    if (sessions.size >= MAX_ACTIVE_TERMINALS) {
      const error = new Error(`Maximum active terminals (${MAX_ACTIVE_TERMINALS}) reached`)
      error.statusCode = 429
      throw error
    }

    const id = `term_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
    const shell = resolveDefaultShell()
    const pythonBin = detectPythonPtyBinary()
    const now = Date.now()
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }

    let child
    let isPty = false
    if (pythonBin) {
      child = spawn(pythonBin, ["-u", "-c", PYTHON_PTY_SCRIPT, String(cols), String(rows), shell], {
        cwd: directory,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      })
      isPty = true
    } else if (process.platform === "win32") {
      child = spawn(shell, [], {
        cwd: directory,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      })
    } else {
      child = spawn(shell, ["-i"], {
        cwd: directory,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      })
    }

    const session = {
      id,
      title: typeof title === "string" && title.trim() ? title.trim().slice(0, 64) : nextTitleForDirectory(directory),
      directory,
      shell: path.basename(shell),
      isPty,
      cols,
      rows,
      child,
      status: "running",
      exitCode: null,
      killed: false,
      createdAt: now,
      updatedAt: now,
      chunks: [],
      bufferBytes: 0,
      nextSeq: 1,
      waiters: new Set(),
      streams: new Set(),
      coalesceTimer: null
    }

    const stdoutDecoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")

    child.stdout?.on("data", (buf) => {
      appendOutput(session, stdoutDecoder.write(buf))
    })
    child.stderr?.on("data", (buf) => {
      // Only non-PTY fallback emits stderr separately; Python PTY helper merges slave stdout/stderr.
      if (!isPty) appendOutput(session, stderrDecoder.write(buf))
    })
    child.on("error", (err) => {
      appendOutput(session, `\r\n[terminal error: ${err.message}]\r\n`)
    })
    child.on("close", (code) => {
      const trailingOut = stdoutDecoder.end()
      const trailingErr = !isPty ? stderrDecoder.end() : ""
      if (trailingOut || trailingErr) appendOutput(session, `${trailingOut}${trailingErr}`)
      session.status = "exited"
      session.exitCode = typeof code === "number" ? code : 0
      session.updatedAt = Date.now()
      const summary = terminalSummary(session)
      for (const stream of session.streams) {
        try {
          writeSSE(stream, "exit", summary)
          stream.end()
        } catch {}
      }
      session.streams.clear()
      notifyWaiters(session, true)
    })

    sessions.set(id, session)

    if (typeof initialCommand === "string" && initialCommand.trim()) {
      writeToSession(session, `${initialCommand}\r`)
    }

    return session
  }

  function writeToSession(session, data) {
    if (session.status !== "running" || !session.child?.stdin || session.child.stdin.destroyed) {
      const error = new Error("Terminal has already exited")
      error.statusCode = 409
      throw error
    }
    const payload = Buffer.from(data, "utf8")
    if (session.isPty) {
      session.child.stdin.write(`${JSON.stringify({ type: "in", b64: payload.toString("base64") })}\n`)
    } else {
      session.child.stdin.write(payload)
    }
    session.updatedAt = Date.now()
  }

  function resizeSession(session, cols, rows) {
    session.cols = cols
    session.rows = rows
    session.updatedAt = Date.now()
    if (session.status === "running" && session.isPty && session.child?.stdin && !session.child.stdin.destroyed) {
      session.child.stdin.write(`${JSON.stringify({ type: "resize", cols, rows })}\n`)
    }
  }

  const server = createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const { pathname } = requestURL
    if (pathname !== TERMINALS_ROUTE && !pathname.startsWith(`${TERMINALS_ROUTE}/`)) {
      innerServer.emit("request", request, response)
      return
    }
    if (!authenticateDaemonRequest(request, response, config)) return

    try {
      if (pathname === TERMINALS_ROUTE && request.method === "GET") {
        const rawDir = requestURL.searchParams.get("directory")
        let filterDir = null
        if (rawDir && rawDir.trim()) {
          filterDir = await allowedDirectory(rawDir, config, dynamicRoots)
        }
        const list = [...sessions.values()]
          .filter((session) => !filterDir || session.directory === filterDir)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(terminalSummary)
        writeJSON(response, 200, { terminals: list })
        return
      }

      if (pathname === TERMINALS_ROUTE && request.method === "POST") {
        const body = await readJsonBody(request)
        const directory = await allowedDirectory(body.directory, config, dynamicRoots)
        const cols = clampInt(body.cols, 100, 20, 400)
        const rows = clampInt(body.rows, 28, 5, 200)
        const session = spawnTerminalSession({
          directory,
          title: body.title,
          cols,
          rows,
          initialCommand: body.command
        })
        writeJSON(response, 201, snapshotSince(session, 0))
        return
      }

      const subPath = pathname.slice(TERMINALS_ROUTE.length + 1)
      const segments = subPath.split("/").filter(Boolean)
      const terminalID = decodeURIComponent(segments[0] ?? "")
      const action = segments[1] ?? ""
      const session = sessions.get(terminalID)
      if (!session) {
        writeJSON(response, 404, { error: `Terminal not found: ${terminalID}` })
        return
      }

      if (!action && request.method === "GET") {
        const since = Number(requestURL.searchParams.get("since") ?? "0")
        const waitMs = clampInt(requestURL.searchParams.get("waitMs"), 0, 0, MAX_LONG_POLL_MS)
        const initial = snapshotSince(session, since)
        if (initial.chunks.length > 0 || session.status !== "running" || waitMs <= 0) {
          writeJSON(response, 200, initial)
          return
        }
        await new Promise((resolve) => {
          let settled = false
          const done = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            session.waiters.delete(done)
            request.off("close", done)
            resolve()
          }
          const timer = setTimeout(done, waitMs)
          timer.unref?.()
          session.waiters.add(done)
          request.on("close", done)
        })
        if (!response.writableEnded) {
          writeJSON(response, 200, snapshotSince(session, since))
        }
        return
      }

      if (action === "stream" && request.method === "GET") {
        const since = Number(requestURL.searchParams.get("since") ?? "0")
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        })
        const snapshot = snapshotSince(session, since)
        writeSSE(response, "snapshot", { terminal: snapshot.terminal, reset: snapshot.reset })
        for (const chunk of snapshot.chunks) {
          writeSSE(response, "output", chunk)
        }
        if (session.status !== "running") {
          writeSSE(response, "exit", snapshot.terminal)
          response.end()
          return
        }
        session.streams.add(response)
        const heartbeat = setInterval(() => {
          try { response.write(": ping\n\n") } catch {}
        }, 15_000)
        heartbeat.unref?.()
        request.on("close", () => {
          clearInterval(heartbeat)
          session.streams.delete(response)
        })
        return
      }

      if (action === "write" && request.method === "POST") {
        const body = await readJsonBody(request)
        if (typeof body.data !== "string") {
          writeJSON(response, 400, { error: "Field `data` must be a string" })
          return
        }
        if (body.data.length > MAX_WRITE_CHARS) {
          writeJSON(response, 413, { error: "Terminal write payload is too large" })
          return
        }
        if (body.data.length > 0) writeToSession(session, body.data)
        writeJSON(response, 200, { ok: true })
        return
      }

      if (action === "resize" && request.method === "POST") {
        const body = await readJsonBody(request)
        const cols = clampInt(body.cols, session.cols, 20, 400)
        const rows = clampInt(body.rows, session.rows, 5, 200)
        resizeSession(session, cols, rows)
        writeJSON(response, 200, { ok: true, terminal: terminalSummary(session) })
        return
      }

      if (!action && request.method === "DELETE") {
        terminateSession(session)
        sessions.delete(terminalID)
        writeJSON(response, 200, { ok: true })
        return
      }

      response.writeHead(405, { Allow: "GET, POST, DELETE, OPTIONS" })
      response.end()
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
      writeJSON(response, status, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  server.on("close", () => {
    cleanupAllTerminals()
    innerServer.emit("close")
  })

  return server
}
