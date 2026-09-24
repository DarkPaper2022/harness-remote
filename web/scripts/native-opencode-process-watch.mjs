import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const gate = path.join(here, "native-opencode-live-zen-release-gate.mjs")
const DAEMON_ORIGIN = "http://127.0.0.1:4497"
const AUTHORIZATION = `Basic ${Buffer.from("harness:live-zen-release-gate").toString("base64")}`

function snapshot() {
  if (process.platform === "win32") return "process topology watch is POSIX-only"
  try {
    const output = execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,sid=,stat=,comm=,args="], { encoding: "utf8" })
    return output
      .split(/\r?\n/)
      .filter((line) => /(?:opencode|daemon-cli\.js)/i.test(line) && !/native-opencode-process-watch/i.test(line))
      .join("\n")
      .trim() || "<no managed OpenCode/daemon process>"
  } catch (error) {
    return `<ps failed: ${error instanceof Error ? error.message : String(error)}>`
  }
}

async function daemonSnapshot() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 750)
  try {
    const response = await fetch(`${DAEMON_ORIGIN}/v1/diagnostics`, {
      headers: { Authorization: AUTHORIZATION, Accept: "application/json" },
      signal: controller.signal
    })
    if (!response.ok) return `<diagnostics HTTP ${response.status}>`
    const payload = await response.json()
    const agents = Array.isArray(payload?.agents)
      ? payload.agents.map((agent) => `${agent.id}:${agent.state}:pid=${agent.process?.processID ?? "-"}`).join(",")
      : ""
    const requests = Array.isArray(payload?.router?.inFlightRequests)
      ? payload.router.inFlightRequests.map((request) => `${request.method}:${request.path}:${request.durationMs}ms`).sort().join(",")
      : ""
    return `agents=[${agents}] requests=[${requests}]`
  } catch (error) {
    if (error?.name === "AbortError") return "<diagnostics timeout>"
    return "<daemon unavailable>"
  } finally {
    clearTimeout(timer)
  }
}

let prior = ""
function report(label = "change") {
  const current = snapshot()
  if (label !== "change" || current !== prior) {
    console.log(`process-watch ${label}:\n${current}`)
    prior = current
  }
}

let priorDaemon = ""
async function reportDaemon(label = "change") {
  const current = await daemonSnapshot()
  if (label !== "change" || current !== priorDaemon) {
    console.log(`request-watch ${label}: ${current}`)
    priorDaemon = current
  }
}

report("initial")
void reportDaemon("initial")
const child = spawn(process.execPath, [gate], {
  cwd: path.join(here, ".."),
  env: process.env,
  stdio: "inherit"
})
let polling = false
const timer = setInterval(() => {
  report()
  if (polling) return
  polling = true
  void reportDaemon().finally(() => { polling = false })
}, 1_000)
timer.unref()

child.once("exit", (code, signal) => {
  clearInterval(timer)
  report("final")
  void reportDaemon("final")
  if (signal) {
    console.error(`process-watch: release gate exited by ${signal}`)
    process.exitCode = 1
  } else {
    process.exitCode = code ?? 1
  }
})
