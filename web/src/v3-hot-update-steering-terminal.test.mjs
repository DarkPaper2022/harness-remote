import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8")

test("NativeSessionHome renders effectiveRecords (including historical searchResults) and pins opened search sessions", () => {
  const home = read("./components/native-session-home-base.tsx")
  assert.match(home, /const baseRecords = useMemo\(/)
  assert.match(home, /projectGroups\(effectiveRecords\)/, "groups must be built from effectiveRecords so >7d searchResults appear in the rail")
  assert.match(home, /pinnedRecords/, "clicking a historical search result must pin it across search clear")
})

test("Capacitor iOS hot update uses official WebView serverBasePath primitives and NoCloud snapshot directory", () => {
  const hotTs = read("./ios-hot-update.ts")
  const swiftPlugin = read("../native-ios/WebBundleStagingPlugin.swift")
  assert.match(hotTs, /WebView\.setServerBasePath/)
  assert.match(hotTs, /WebView\.persistServerBasePath/)
  assert.match(swiftPlugin, /NoCloud/)
  assert.match(swiftPlugin, /ionic_built_snapshots/)
})

test("T3-inspired live steering, /btw side chat, workspace terminal, and iPad 16px touch guards are wired", () => {
  const conversation = read("./components/taskdesk-conversation.tsx")
  const observer = read("./components/native-session-observer.tsx")
  const workspace = read("./components/standalone-universal-workspace.tsx")
  const polishCss = read("./t3-modern-polish.css")

  assert.match(conversation, /uw-composer-mode-pill/)
  assert.match(conversation, /\/btw/)
  assert.match(conversation, /Terminal/)
  assert.match(observer, /<SideChatDrawer/)
  assert.match(workspace, /<TerminalDrawer/)
  assert.match(polishCss, /@media \(pointer: coarse\)[\s\S]*?font-size:\s*16px;/)
})

test("Floating live/completed tail pill (#3) and pinned favorite models + per-project default memory (#6) work cleanly", async () => {
  const conversation = read("./components/taskdesk-conversation.tsx")
  const picker = read("./components/model-picker.tsx")
  const workThread = read("./components/work-thread-conversation.tsx")
  const home = read("./components/native-session-home-base.tsx")

  // #3 Floating live tail pill
  assert.match(conversation, /uw-live-tail-pill/)
  assert.match(conversation, /unreadCompleted/)

  // #6 Pinned favorite models & per-project defaults
  assert.match(picker, /tdw-model-favorites/)
  assert.match(picker, /tdw-model-star/)
  assert.match(workThread, /loadProjectDefaultModelKey/)
  assert.match(workThread, /saveProjectDefaultModelKey/)
  assert.match(home, /loadProjectDefaultAgent/)
  assert.match(home, /saveProjectDefaultAgent/)

  // Behavioral check on model-preferences storage helpers
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  }
  const prefs = await import("./model-preferences.ts")
  assert.deepEqual(prefs.loadFavoriteModelKeys(), [])
  assert.deepEqual(prefs.toggleFavoriteModelKey("openai|gpt-5.4|high"), ["openai|gpt-5.4|high"])
  assert.deepEqual(prefs.toggleFavoriteModelKey("agy|claude-opus-4-6-thinking|max"), [
    "agy|claude-opus-4-6-thinking|max",
    "openai|gpt-5.4|high"
  ])
  assert.deepEqual(prefs.toggleFavoriteModelKey("openai|gpt-5.4|high"), ["agy|claude-opus-4-6-thinking|max"])

  prefs.saveProjectDefaultAgent("m1", "/repo/demo/", "agy")
  assert.equal(prefs.loadProjectDefaultAgent("m1", "/repo/demo"), "agy")
  prefs.saveProjectDefaultModelKey("/repo/demo/", "agy", "agy|claude-opus-4-6-thinking|max")
  assert.equal(prefs.loadProjectDefaultModelKey("/repo/demo", "agy"), "agy|claude-opus-4-6-thinking|max")
})
