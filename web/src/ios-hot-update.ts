import { Capacitor, WebView, registerPlugin } from "@capacitor/core"
import { api } from "./api"
import type { ServerConfig } from "./types"

export type WebUpdateManifestFile = {
  path: string
  size: number
  sha256: string
}

export type WebUpdateManifest = {
  available: boolean
  version?: string
  bundleId?: string
  bundleHash?: string
  totalBytes?: number
  files?: WebUpdateManifestFile[]
}

type WebBundleStagingPlugin = {
  getSnapshotsRoot(): Promise<{ snapshotsRoot: string; persistedServerBasePath: string }>
  stageSnapshot(options: {
    bundleId: string
    files: Array<{ path: string; sha256: string; base64: string }>
  }): Promise<{ path: string; bundleId: string }>
  resetToBuiltInBundle(): Promise<{ reset: boolean }>
}

const WebBundleStaging = registerPlugin<WebBundleStagingPlugin>("WebBundleStaging")

export const ACTIVE_WEB_BUNDLE_STORAGE_KEY = "harness-remote.ios-hot-bundle.v1"
export const BOOT_CONFIRM_KEY = "harness-remote.ios-hot-bundle-confirmed.v1"

export type PersistedHotBundleInfo = {
  bundleId: string
  version: string
  appliedAt: number
  machineName?: string
}

export function isIosNativeHotUpdateSupported(): boolean {
  return Capacitor.getPlatform() === "ios"
}

export function loadAppliedHotBundleInfo(): PersistedHotBundleInfo | null {
  try {
    const raw = localStorage.getItem(ACTIVE_WEB_BUNDLE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedHotBundleInfo>
    if (typeof parsed.bundleId !== "string" || !parsed.bundleId) return null
    return {
      bundleId: parsed.bundleId,
      version: typeof parsed.version === "string" ? parsed.version : "",
      appliedAt: typeof parsed.appliedAt === "number" ? parsed.appliedAt : 0,
      ...(typeof parsed.machineName === "string" ? { machineName: parsed.machineName } : {})
    }
  } catch {
    return null
  }
}

export async function inspectNativeWebViewPath(): Promise<{ currentPath: string; isHotSnapshot: boolean }> {
  if (!isIosNativeHotUpdateSupported()) return { currentPath: "", isHotSnapshot: false }
  try {
    const { path } = await WebView.getServerBasePath()
    return {
      currentPath: path || "",
      isHotSnapshot: Boolean(path && path.includes("ionic_built_snapshots"))
    }
  } catch {
    return { currentPath: "", isHotSnapshot: false }
  }
}

export async function checkServerWebUpdate(config: ServerConfig): Promise<WebUpdateManifest> {
  return api.checkWebUpdateManifest(config)
}

export async function applyIosHotUpdateFromServer(
  config: ServerConfig,
  machineName?: string,
  onProgress?: (completedFiles: number, totalFiles: number) => void
): Promise<{ bundleId: string; version: string }> {
  if (!isIosNativeHotUpdateSupported()) {
    throw new Error("Capacitor iOS WebView hot update is only used inside the iOS/iPadOS app.")
  }
  const manifest = await api.checkWebUpdateManifest(config)
  if (!manifest.available || !manifest.bundleId || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("This server does not currently expose a built Web UI bundle.")
  }

  const total = manifest.files.length
  const downloaded: Array<{ path: string; sha256: string; base64: string }> = []
  onProgress?.(0, total)

  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index]
    const payload = await api.downloadWebUpdateFile(config, entry.path)
    if (payload.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(`Asset digest mismatch while downloading ${entry.path}`)
    }
    downloaded.push({
      path: entry.path,
      sha256: entry.sha256,
      base64: payload.base64
    })
    onProgress?.(index + 1, total)
  }

  // Stage into `<Library>/NoCloud/ionic_built_snapshots/<bundleId>` where `CAPBridgeViewController`
  // natively resolves `KeyValueStore.standard["serverBasePath"]` across app launches.
  const staged = await WebBundleStaging.stageSnapshot({
    bundleId: manifest.bundleId,
    files: downloaded
  })

  const info: PersistedHotBundleInfo = {
    bundleId: manifest.bundleId,
    version: manifest.version || "",
    appliedAt: Date.now(),
    ...(machineName ? { machineName } : {})
  }
  try {
    localStorage.setItem(ACTIVE_WEB_BUNDLE_STORAGE_KEY, JSON.stringify(info))
    localStorage.removeItem(BOOT_CONFIRM_KEY)
  } catch {
    // ignore quota issues
  }

  // Official `@capacitor/core` `WebView` plugin calls:
  // 1. Switch `CAPBridgeViewController` asset base path and reload `capacitor://localhost`
  // 2. Persist `serverBasePath` in `KeyValueStore.standard` so future cold boots load this snapshot
  await WebView.setServerBasePath({ path: staged.path })
  await WebView.persistServerBasePath()
  return { bundleId: manifest.bundleId, version: manifest.version || "" }
}

export async function resetIosHotUpdateToBuiltIn(): Promise<void> {
  if (!isIosNativeHotUpdateSupported()) return
  try {
    localStorage.removeItem(ACTIVE_WEB_BUNDLE_STORAGE_KEY)
    localStorage.removeItem(BOOT_CONFIRM_KEY)
  } catch {
    // ignore
  }
  try {
    await WebBundleStaging.resetToBuiltInBundle()
  } catch {
    await WebView.setServerAssetPath({ path: "public" })
    await WebView.persistServerBasePath()
  }
}

export function markHotBundleBootHealthy(): void {
  if (!isIosNativeHotUpdateSupported()) return
  try {
    const active = loadAppliedHotBundleInfo()
    if (active) {
      localStorage.setItem(BOOT_CONFIRM_KEY, active.bundleId)
    }
  } catch {
    // ignore
  }
}
