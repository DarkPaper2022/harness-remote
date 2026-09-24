import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { ManagedOpenCodeHost, stopPosixProcessTree } from "../src/opencode-host.js"

class FakeChild extends EventEmitter {
  pid = 7331
  exitCode = null
  signalCode = null
  killSignals = []

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal)
    return true
  }
}

test("POSIX managed OpenCode isolates and force-terminates its exact process tree", async () => {
  const child = new FakeChild()
  const treeStops = []
  let spawnOptions
  const host = new ManagedOpenCodeHost({
    username: "harness",
    password: "secret",
    platform: "linux",
    isolatePosixProcessTree: true,
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options
      return child
    },
    stopPosixTree: (pid, signal) => {
      treeStops.push([pid, signal])
      return true
    },
    waitUntilReady: async () => {}
  })

  await host.start()

  assert.equal(spawnOptions.detached, true, "managed POSIX OpenCode must be isolated from the daemon process group")
  assert.equal(host.stop("SIGTERM"), true)
  assert.deepEqual(treeStops, [[7331, "SIGTERM"]], "shutdown must target only the managed OpenCode tree")
  assert.deepEqual(child.killSignals, [], "tree shutdown must not fall back to killing only the launcher")
  await assert.rejects(
    host.start(),
    /Managed OpenCode host is closed/,
    "traffic draining after daemon shutdown must never resurrect a replacement OpenCode process"
  )
})

test("POSIX tree shutdown falls back to the launcher if process enumeration itself fails", async () => {
  const child = new FakeChild()
  const host = new ManagedOpenCodeHost({
    username: "harness",
    password: "secret",
    platform: "linux",
    isolatePosixProcessTree: true,
    spawnProcess: () => child,
    stopPosixTree: () => { throw new Error("ps unavailable") },
    waitUntilReady: async () => {}
  })

  await host.start()
  assert.equal(host.stop("SIGTERM"), true)
  assert.deepEqual(child.killSignals, ["SIGTERM"])
})

test("POSIX tree terminator snapshots descendants before force-killing them child-first", () => {
  const killed = []
  const processTable = [
    " 7331  7000",
    " 7442  7331",
    " 7553  7442",
    " 7664  7331",
    " 9000     1"
  ].join("\n")

  const stopped = stopPosixProcessTree(7331, "SIGTERM", {
    listProcesses: (command, args) => {
      assert.equal(command, "ps")
      assert.deepEqual(args, ["-eo", "pid=,ppid="])
      return { status: 0, stdout: processTable }
    },
    killProcess: (pid, signal) => killed.push([pid, signal])
  })

  assert.equal(stopped, true)
  assert.deepEqual(killed, [
    [7553, "SIGKILL"],
    [7442, "SIGKILL"],
    [7664, "SIGKILL"],
    [7331, "SIGKILL"]
  ])
  assert.equal(killed.some(([pid]) => pid === 9000), false, "an unrelated process must never be targeted")
})

test("POSIX tree terminator still kills the managed root if ps cannot provide a process table", () => {
  const killed = []
  const stopped = stopPosixProcessTree(7331, "SIGTERM", {
    listProcesses: () => ({ status: 1, stdout: "" }),
    killProcess: (pid, signal) => killed.push([pid, signal])
  })
  assert.equal(stopped, true)
  assert.deepEqual(killed, [[7331, "SIGKILL"]])
})
