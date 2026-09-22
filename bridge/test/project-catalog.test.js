import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { discoverProjects } from "../src/project-catalog.js"

/**
 * The catalog reports canonical paths, because a project id has to stay the same however the root
 * was reached and the boundary check has to compare resolved paths. The temporary directory is not
 * canonical on two of the three platforms this repository builds for: macOS hands out
 * `/var/folders/...`, a symlink to `/private/var/folders/...`, and Windows hands out the 8.3 form
 * `C:\Users\RUNNER~1\...` of `C:\Users\runneradmin\...`. Comparing against the raw `mkdtemp` result
 * therefore asserted the platform's alias rather than the value under test, and passed only on Linux.
 */
async function tempRoot(prefix) {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
}

test("discovers configured roots and immediate Git projects without recursive scanning", async () => {
  const root = await tempRoot("harness-projects-")
  try {
    const gitProject = path.join(root, "alpha")
    const plainDirectory = path.join(root, "notes")
    const nestedGit = path.join(plainDirectory, "nested")
    await mkdir(path.join(gitProject, ".git"), { recursive: true })
    await mkdir(path.join(nestedGit, ".git"), { recursive: true })
    await writeFile(path.join(root, "README.txt"), "root")

    const projects = await discoverProjects({ machineID: "machine-1", roots: [root] })
    assert.deepEqual(projects.map((project) => ({ name: project.name, kind: project.kind, configured: project.configured })), [
      { name: "alpha", kind: "git", configured: false },
      { name: path.basename(root), kind: "directory", configured: true }
    ])
    assert.ok(projects.every((project) => project.machineId === "machine-1"))
    assert.ok(projects.every((project) => project.id.startsWith("machine-1:")))
    assert.equal(projects.some((project) => project.path === nestedGit), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("project ids remain stable for the same machine and canonical path", async () => {
  const root = await tempRoot("harness-project-id-")
  try {
    const first = await discoverProjects({ machineID: "machine-1", roots: [root] })
    const second = await discoverProjects({ machineID: "machine-1", roots: [root] })
    const otherMachine = await discoverProjects({ machineID: "machine-2", roots: [root] })
    assert.equal(first[0].id, second[0].id)
    assert.notEqual(first[0].id, otherMachine[0].id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an unreadable or missing configured root does not hide valid roots", async () => {
  const root = await tempRoot("harness-project-roots-")
  try {
    const projects = await discoverProjects({ machineID: "machine-1", roots: [path.join(root, "missing"), root] })
    assert.equal(projects.length, 1)
    assert.equal(projects[0].path, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("symlinked children cannot escape the configured root boundary", async () => {
  const root = await tempRoot("harness-project-boundary-")
  const outside = await tempRoot("harness-project-outside-")
  try {
    await mkdir(path.join(outside, ".git"), { recursive: true })
    await symlink(outside, path.join(root, "external"), "dir")
    const projects = await discoverProjects({ machineID: "machine-1", roots: [root] })
    assert.equal(projects.some((project) => project.path === outside), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("registers projects from Session working directories without any configured root", async () => {
  const root = await tempRoot("harness-project-sessions-")
  try {
    const gitRoot = path.join(root, "repo")
    const nested = path.join(gitRoot, "packages", "app")
    const plain = path.join(root, "pdf", "CS", "pdf_reader")
    await mkdir(path.join(gitRoot, ".git"), { recursive: true })
    await mkdir(nested, { recursive: true })
    await mkdir(plain, { recursive: true })

    const projects = await discoverProjects({
      machineID: "machine-1",
      roots: [],
      sessionDirectories: [nested, plain]
    })
    assert.deepEqual(projects.map((project) => ({ name: project.name, kind: project.kind, configured: project.configured })), [
      { name: "pdf_reader", kind: "directory", configured: false },
      { name: "repo", kind: "git", configured: false }
    ], "a Session inside a repository reports the repository, and a non-Git directory reports itself")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a configured container directory is not a project unless a Session ran in it", async () => {
  const root = await tempRoot("harness-project-container-")
  try {
    const project = path.join(root, "Documents", "work")
    await mkdir(project, { recursive: true })
    const container = path.join(root, "Documents")
    const withoutSession = await discoverProjects({ machineID: "machine-1", roots: [container] })
    assert.deepEqual(withoutSession.map((entry) => entry.name), ["Documents"], "an explicitly configured root stays visible")
    const fromSessions = await discoverProjects({ machineID: "machine-1", roots: [], sessionDirectories: [project] })
    assert.deepEqual(fromSessions.map((entry) => entry.name), ["work"], "only where work happened becomes a project")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
