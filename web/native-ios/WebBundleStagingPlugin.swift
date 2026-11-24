import Foundation
import CryptoKit
import Capacitor

@objc(WebBundleStagingPlugin)
public class WebBundleStagingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebBundleStagingPlugin"
    public let jsName = "WebBundleStaging"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSnapshotsRoot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stageSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetToBuiltInBundle", returnType: CAPPluginReturnPromise)
    ]

    private func snapshotsDirectoryURL() throws -> URL {
        guard let libraryPath = NSSearchPathForDirectoriesInDomains(.libraryDirectory, .userDomainMask, true).first else {
            throw NSError(domain: "WebBundleStaging", code: 1, userInfo: [NSLocalizedDescriptionKey: "Library directory is unavailable"])
        }
        let dir = URL(fileURLWithPath: libraryPath, isDirectory: true)
            .appendingPathComponent("NoCloud", isDirectory: true)
            .appendingPathComponent("ionic_built_snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mutableDir = dir
        try? mutableDir.setResourceValues(resourceValues)
        return dir
    }

    private func safeBundleId(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 128 else { return nil }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        guard trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              !trimmed.hasPrefix("."),
              !trimmed.contains("..") else {
            return nil
        }
        return trimmed
    }

    private func safeRelativePath(_ raw: String) -> String? {
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
        guard !normalized.isEmpty, !normalized.hasPrefix("/") else { return nil }
        let segments = normalized.split(separator: "/", omittingEmptySubsequences: false)
        guard !segments.isEmpty else { return nil }
        for segment in segments {
            if segment.isEmpty || segment == "." || segment == ".." || segment.hasPrefix(".") {
                return nil
            }
        }
        return segments.joined(separator: "/")
    }

    private func sha256Hex(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    @objc func getSnapshotsRoot(_ call: CAPPluginCall) {
        do {
            let root = try snapshotsDirectoryURL()
            let persisted = KeyValueStore.standard["serverBasePath", as: String.self] ?? ""
            call.resolve([
                "snapshotsRoot": root.path,
                "persistedServerBasePath": persisted
            ])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func stageSnapshot(_ call: CAPPluginCall) {
        guard let rawBundleId = call.getString("bundleId"),
              let bundleId = safeBundleId(rawBundleId) else {
            call.reject("A valid bundleId is required")
            return
        }
        guard let files = call.getArray("files", JSObject.self), !files.isEmpty else {
            call.reject("Snapshot files are required")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            do {
                let snapshotsRoot = try self.snapshotsDirectoryURL()
                let stagingURL = snapshotsRoot.appendingPathComponent(".staging-\(bundleId)-\(UUID().uuidString)", isDirectory: true)
                let finalURL = snapshotsRoot.appendingPathComponent(bundleId, isDirectory: true)

                if fm.fileExists(atPath: stagingURL.path) {
                    try? fm.removeItem(at: stagingURL)
                }
                try fm.createDirectory(at: stagingURL, withIntermediateDirectories: true)

                var sawIndexHtml = false
                for item in files {
                    guard let rawPath = item["path"] as? String,
                          let relPath = self.safeRelativePath(rawPath),
                          let base64 = item["base64"] as? String,
                          let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
                        try? fm.removeItem(at: stagingURL)
                        DispatchQueue.main.async {
                            call.reject("Invalid file entry in snapshot payload")
                        }
                        return
                    }
                    if let expectedSha = item["sha256"] as? String, !expectedSha.isEmpty {
                        let actualSha = self.sha256Hex(data)
                        if actualSha.lowercased() != expectedSha.lowercased() {
                            try? fm.removeItem(at: stagingURL)
                            DispatchQueue.main.async {
                                call.reject("SHA-256 mismatch for \(relPath)")
                            }
                            return
                        }
                    }
                    if relPath == "index.html" {
                        sawIndexHtml = true
                    }
                    let destination = stagingURL.appendingPathComponent(relPath, isDirectory: false)
                    try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try data.write(to: destination, options: .atomic)
                }

                guard sawIndexHtml else {
                    try? fm.removeItem(at: stagingURL)
                    DispatchQueue.main.async {
                        call.reject("Snapshot is missing index.html")
                    }
                    return
                }

                if fm.fileExists(atPath: finalURL.path) {
                    try fm.removeItem(at: finalURL)
                }
                try fm.moveItem(at: stagingURL, to: finalURL)

                // Prune older snapshots to keep sandbox storage bounded.
                if let entries = try? fm.contentsOfDirectory(at: snapshotsRoot, includingPropertiesForKeys: nil) {
                    for entry in entries where entry.lastPathComponent != bundleId {
                        try? fm.removeItem(at: entry)
                    }
                }

                DispatchQueue.main.async {
                    call.resolve([
                        "path": finalURL.path,
                        "bundleId": bundleId
                    ])
                }
            } catch {
                DispatchQueue.main.async {
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    @objc func resetToBuiltInBundle(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            KeyValueStore.standard["serverBasePath"] = nil as String?
            if let builtInURL = Bundle.main.url(forResource: "public", withExtension: nil),
               let viewController = self.bridge?.viewController as? CAPBridgeViewController {
                viewController.setServerBasePath(path: builtInURL.path)
            }
            call.resolve([
                "reset": true
            ])
        }
    }
}
