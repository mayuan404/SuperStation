import AppKit
import QuickLookThumbnailing

// PPT/Word/Excel 这类格式不自己解析版式，交给系统的 Quick Look：
// 缩略图用于内嵌预览，完整预览用 qlmanage 唤起系统面板。

enum Office {
    static let supported: Set<String> = [
        "ppt", "pptx", "pps", "ppsx", "key", "doc", "docx", "rtf", "odt",
        "xls", "xlsx", "numbers", "ods", "odp"
    ]

    static let cacheDir: String = {
        let d = NSTemporaryDirectory() + "betternotebook/office"
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }()

    static func isOffice(_ path: String) -> Bool {
        supported.contains((path as NSString).pathExtension.lowercased())
    }

    static func thumb(path: String, width: Int = 1600) -> [String: Any]? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else { return nil }
        guard let real = VaultIO.materialize(path) else {
            appLog("OFFICE thumb fail stage=materialize path=\(path)")
            return nil
        }
        let attrs = try? fm.attributesOfItem(atPath: path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(stableHash(path))-\(Int(mtime))-\(width)"
        let out = cacheDir + "/\(key).png"
        if fm.fileExists(atPath: out) { return ["file": out] }

        // 自己调 QLThumbnailGenerator 在部分 Office 文档上拿不到图，
        // 直接用系统的 qlmanage 生成，行为与访达一致。
        let tmpDir = NSTemporaryDirectory() + "betternotebook/ql-\(UUID().uuidString)"
        try? fm.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
        p.arguments = ["-t", "-s", String(width), "-o", tmpDir, real]
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        let sem = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in sem.signal() }
        do { try p.run() } catch {
            appLog("OFFICE thumb fail stage=run path=\(path) err=\(error.localizedDescription)")
            return nil
        }
        if sem.wait(timeout: .now() + 30) == .timedOut {
            p.terminate()
            try? fm.removeItem(atPath: tmpDir)
            appLog("OFFICE thumb fail stage=timeout path=\(path) size=\(((try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue ?? 0)")
            return nil
        }

        let produced = (try? fm.contentsOfDirectory(atPath: tmpDir))?.first { $0.hasSuffix(".png") }
        guard let produced else {
            try? fm.removeItem(atPath: tmpDir)
            appLog("OFFICE thumb fail stage=output path=\(path) real=\(real) status=\(p.terminationStatus)")
            return nil
        }
        let src = tmpDir + "/" + produced
        try? fm.moveItem(atPath: src, toPath: out)
        try? fm.removeItem(atPath: tmpDir)
        return fm.fileExists(atPath: out) ? ["file": out] : nil
    }

    static func quickLook(path: String) -> [String: Any] {
        guard FileManager.default.fileExists(atPath: path) else { return ["ok": false] }
        guard let real = VaultIO.materialize(path) else { return ["ok": false, "reason": "locked"] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
        p.arguments = ["-p", real]
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        do { try p.run() } catch { return ["ok": false] }
        return ["ok": true]
    }
}
