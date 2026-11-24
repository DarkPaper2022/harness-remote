import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const pluginSource = resolve(root, "native-ios/WebBundleStagingPlugin.swift")
const iosAppDir = resolve(root, "ios/App/App")
const pluginTarget = resolve(iosAppDir, "WebBundleStagingPlugin.swift")
const capConfigPath = resolve(iosAppDir, "capacitor.config.json")
const pbxprojPath = resolve(root, "ios/App/App.xcodeproj/project.pbxproj")

if (!existsSync(iosAppDir)) throw new Error("iOS project not found; run npx cap sync ios first")

cpSync(pluginSource, pluginTarget)

// 1. Register `WebBundleStagingPlugin` in `capacitor.config.json` `packageClassList` so Capacitor's
//    official `CapacitorBridge.registerPlugins()` auto-loads it alongside `CAPWebViewPlugin`.
const capConfig = JSON.parse(readFileSync(capConfigPath, "utf8"))
const classes = Array.isArray(capConfig.packageClassList) ? [...capConfig.packageClassList] : []
if (!classes.includes("WebBundleStagingPlugin")) classes.push("WebBundleStagingPlugin")
capConfig.packageClassList = classes
writeFileSync(capConfigPath, `${JSON.stringify(capConfig, null, "\t")}\n`, "utf8")

// 2. Ensure `WebBundleStagingPlugin.swift` is compiled in Xcode's `App` Sources build phase.
let pbx = readFileSync(pbxprojPath, "utf8")
const buildFileId = "A1B2C3D42F0000010016851F"
const fileRefId = "A1B2C3D42F0000020016851F"

if (!pbx.includes("WebBundleStagingPlugin.swift")) {
  pbx = pbx.replace(
    "/* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 504EC3071FED79650016851F /* AppDelegate.swift */; };",
    `/* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 504EC3071FED79650016851F /* AppDelegate.swift */; };\n\t\t${buildFileId} /* WebBundleStagingPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* WebBundleStagingPlugin.swift */; };`
  )
  pbx = pbx.replace(
    "504EC3071FED79650016851F /* AppDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = \"<group>\"; };",
    `504EC3071FED79650016851F /* AppDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>"; };\n\t\t${fileRefId} /* WebBundleStagingPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = WebBundleStagingPlugin.swift; sourceTree = "<group>"; };`
  )
  pbx = pbx.replace(
    "504EC3071FED79650016851F /* AppDelegate.swift */,",
    `504EC3071FED79650016851F /* AppDelegate.swift */,\n\t\t\t\t${fileRefId} /* WebBundleStagingPlugin.swift */,`
  )
  pbx = pbx.replace(
    "504EC3081FED79650016851F /* AppDelegate.swift in Sources */,",
    `504EC3081FED79650016851F /* AppDelegate.swift in Sources */,\n\t\t\t\t${buildFileId} /* WebBundleStagingPlugin.swift in Sources */,`
  )
  writeFileSync(pbxprojPath, pbx, "utf8")
}

console.log("Synced iOS WebBundleStagingPlugin for Capacitor WebView hot updates")
