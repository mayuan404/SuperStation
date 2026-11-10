import Foundation

// 崩溃草稿 + 保存历史：都放在 Application Support 下，按路径的稳定哈希分目录。

func stableHash(_ s: String) -> String {
    var h: UInt64 = 0xcbf29ce484222325
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
    return String(h, radix: 16)
}

enum AppPaths {
    static let support: String = {
        let p = Paths.support
        try? FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
        return p
    }()
}

func appLog(_ line: String) {
    let dir = NSHomeDirectory() + "/Library/Logs"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let file = Paths.logs
    let stamp = ISO8601DateFormatter().string(from: Date())
    let text = "[\(stamp)] \(line)\n"
    if let h = FileHandle(forWritingAtPath: file) {
        h.seekToEndOfFile(); h.write(Data(text.utf8)); h.closeFile()
    } else {
        try? Data(text.utf8).write(to: URL(fileURLWithPath: file))
    }
}

enum History {
    static let root = AppPaths.support + "/history"
    static let keep = 20
    static let minInterval: TimeInterval = 45

    private static func dir(for path: String) -> String {
        let d = root + "/" + stableHash(path)
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }

    /// 覆盖写之前调用：把旧内容存一份（同一文件 45 秒内只存一次）
    static func snapshot(path: String, previous: Data, mtime: Date) {
        guard previous.count < 8 * 1024 * 1024 else { return }
        let d = dir(for: path)
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: d)) ?? [])
            .filter { $0.hasSuffix(".bak") }.sorted()
        if let last = files.last {
            let stamp = TimeInterval(last.replacingOccurrences(of: ".bak", with: "")) ?? 0
            if Date().timeIntervalSince1970 - stamp < minInterval { return }
        }
        let ts = String(format: "%.0f", Date().timeIntervalSince1970)
        try? previous.write(to: URL(fileURLWithPath: d + "/" + ts + ".bak"))
        let all = ((try? FileManager.default.contentsOfDirectory(atPath: d)) ?? [])
            .filter { $0.hasSuffix(".bak") }.sorted()
        for old in all.dropLast(keep) { try? FileManager.default.removeItem(atPath: d + "/" + old) }
    }

    static func list(path: String) -> [[String: Any]] {
        let d = dir(for: path)
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: d)) ?? [])
            .filter { $0.hasSuffix(".bak") }.sorted(by: >)
        return files.map { f in
            let full = d + "/" + f
            let size = (try? FileManager.default.attributesOfItem(atPath: full)[.size] as? NSNumber)?.intValue ?? 0
            let ts = Double(f.replacingOccurrences(of: ".bak", with: "")) ?? 0
            return ["id": f, "ts": ts, "size": size]
        }
    }

    static func read(path: String, id: String) -> String? {
        guard id.hasSuffix(".bak"), !id.contains("/") else { return nil }
        let full = dir(for: path) + "/" + id
        guard let data = FileManager.default.contents(atPath: full) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

enum Drafts {
    static let root = AppPaths.support + "/drafts"

    private static func file(for path: String) -> String {
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        return root + "/" + stableHash(path) + ".json"
    }

    static func put(path: String, name: String, text: String) {
        let payload: [String: Any] = ["path": path, "name": name, "text": text,
                                      "at": Date().timeIntervalSince1970]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: URL(fileURLWithPath: file(for: path)), options: .atomic)
    }

    static func drop(path: String) {
        try? FileManager.default.removeItem(atPath: file(for: path))
    }

    static func list() -> [[String: Any]] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
        var out: [[String: Any]] = []
        for n in names where n.hasSuffix(".json") {
            let full = root + "/" + n
            guard let d = FileManager.default.contents(atPath: full),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            let text = obj["text"] as? String ?? ""
            out.append([
                "path": obj["path"] as? String ?? "",
                "name": obj["name"] as? String ?? "",
                "at": obj["at"] as? Double ?? 0,
                "size": text.count,
                "preview": String(text.prefix(120))
            ])
        }
        return out.sorted { ($0["at"] as? Double ?? 0) > ($1["at"] as? Double ?? 0) }
    }

    static func read(path: String) -> String? {
        guard let d = FileManager.default.contents(atPath: file(for: path)),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return obj["text"] as? String
    }
}
