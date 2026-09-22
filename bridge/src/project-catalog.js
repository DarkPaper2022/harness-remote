import { createHash } from "node:crypto"
import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"

function projectID(machineID, projectPath) {
  const digest = createHash("sha256").update(`${machineID}\0${projectPath}`).digest("hex").slice(0, 16)
  return `${machineID}:${digest}`
}

async function isGitProject(directory) {
  try {
    await stat(path.join(directory, ".git"))
    return true
  } catch {
    return false
  }
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * A Session runs in a working directory that may be nested inside a repository. Project identity has
 * to be the repository root, otherwise one project would appear once per subdirectory a user ever
 * happened to launch a Session from.
 */
async function gitProjectRoot(directory) {
  let current = directory
  for (;;) {
    if (await isGitProject(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * The catalog is derived from where Sessions actually ran, not only from configured roots. A root
 * such as `~/Documents` is usually a container for many projects and must not be reported as a
 * project itself just because it was configured.
 */
export async function discoverProjects({ machineID, roots = [], sessionDirectories = [] }) {
  const projects = new Map()
  const addProject = async (resolved, configured) => {
    if (projects.has(resolved)) return
    const git = await isGitProject(resolved)
    projects.set(resolved, {
      id: projectID(machineID, resolved),
      machineId: machineID,
      name: path.basename(resolved) || resolved,
      path: resolved,
      kind: git ? "git" : "directory",
      configured
    })
  }

  for (const sessionDirectory of sessionDirectories) {
    let resolved
    try {
      resolved = await realpath(sessionDirectory)
    } catch {
      continue
    }
    await addProject((await gitProjectRoot(resolved)) ?? resolved, false)
  }

  for (const configuredRoot of roots) {
    let root
    try {
      root = await realpath(configuredRoot)
    } catch {
      continue
    }

    const add = async (candidate, configured = false) => {
      const resolved = await realpath(candidate)
      if (!configured && !insideRoot(root, resolved)) return
      if (projects.has(resolved)) return
      const git = await isGitProject(resolved)
      if (!configured && !git) return
      await addProject(resolved, configured)
    }

    await add(root, true)
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        await add(path.join(root, entry.name), false)
      } catch {
        // A disappearing or unreadable child should not make the catalog unavailable.
      }
    }
  }
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
}
