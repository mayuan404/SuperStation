import Foundation

enum Archive {
    static let supported: Set<String> = ["zip", "tar", "gz", "tgz", "bz2", "xz", "zst"]

    static func isArchive(_ path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return supported.contains(ext)
    }

    /// Extract next to the archive into "<name>/" and return the created folder.
    static func extract(path: String) throws -> [String: Any] {
        let fm = FileManager.default
        guard isArchive(path), fm.fileExists(atPath: path) else {
            throw NSError(domain: "betternotebook", code: 300,
                          userInfo: [NSLocalizedDescriptionKey: "不支持的压缩格式"])
        }
        let ext = (path as NSString).pathExtension.lowercased()
        var base = (path as NSString).deletingPathExtension
        if ["gz", "bz2", "xz", "tgz", "zst"].contains(ext) {
            let inner = (base as NSString).pathExtension.lowercased()
            if ["tar", ""].contains(inner) { base = (base as NSString).deletingPathExtension }
        }
        var dir = base
        var n = 2
        while fm.fileExists(atPath: dir) { dir = base + " \(n)"; n += 1 }
        try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)

        let p = Process()
        if ext == "zip" {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
            p.arguments = ["-x", "-k", path, dir]
        } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            p.arguments = ["-xf", path, "-C", dir]
        }
        let errPipe = Pipe()
        p.standardError = errPipe
        p.standardOutput = Pipe()
        do { try p.run() } catch {
            try? fm.removeItem(atPath: dir)
            throw error
        }
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            try? fm.removeItem(atPath: dir)
            throw NSError(domain: "betternotebook", code: 301,
                          userInfo: [NSLocalizedDescriptionKey: "解压失败：\(msg.trimmingCharacters(in: .whitespacesAndNewlines))"])
        }
        return ["dir": dir]
    }
}
