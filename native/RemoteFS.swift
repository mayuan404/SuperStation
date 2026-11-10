import Foundation

/// 把 ssh://<sessionId>/<abs path> 形式的路径接进现有的 fs.* 接口，
/// 网页层完全不用区分本地还是远端。
final class RemoteSessions {
    static let shared = RemoteSessions()
    struct Conn { let host: String; let port: Int; let user: String; let secretId: String? }
    private var map: [String: Conn] = [:]
    private let lock = NSLock()

    func register(_ id: String, host: String, port: Int, user: String, secretId: String?) {
        lock.lock(); defer { lock.unlock() }
        map[id] = Conn(host: host, port: port, user: user, secretId: secretId)
    }

    func get(_ id: String) -> Conn? {
        lock.lock(); defer { lock.unlock() }
        return map[id]
    }

    func forget(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        map.removeValue(forKey: id)
    }
}

enum RemoteFS {
    static let prefix = "ssh://"

    /// 解析 ssh://id/repo/src/main.rs → (id, target, "/repo/src/main.rs")
    static func parse(_ path: String) -> (id: String, target: Remote.Target, abs: String)? {
        guard path.hasPrefix(prefix) else { return nil }
        let rest = String(path.dropFirst(prefix.count))
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let id = String(rest[..<slash])
        let abs = String(rest[slash...])
        guard let c = RemoteSessions.shared.get(id) else { return nil }
        var target = Remote.Target(host: c.host, port: c.port, user: c.user, secretId: c.secretId)
        if c.host == "mock" { target.mockLocal = true }
        return (id, target, abs)
    }

    static func isRemote(_ path: String) -> Bool { parse(path) != nil }

    static func join(_ id: String, _ abs: String) -> String {
        "\(prefix)\(id)\(abs.hasPrefix("/") ? abs : "/" + abs)"
    }

    /// 处理 fs.* 调用；不是远端路径时返回 nil，交回本地实现。
    static func handle(_ method: String, _ params: [String: Any]) -> Any? {
        let rawPath = (params["path"] as? String) ?? (params["from"] as? String) ?? ""
        guard rawPath.hasPrefix(prefix) else { return nil }
        guard let (id, target, abs) = parse(rawPath) else {
            return ["error": "远端会话未注册"]
        }

        switch method {
        case "fs.list":
            let res = Remote.list(target, path: abs)
            if let err = res["error"] as? String { return ["error": err] }
            let raw = (res["entries"] as? [[String: Any]]) ?? []
            let entries: [[String: Any]] = raw.map { e in
                let name = e["name"] as? String ?? ""
                let isDir = e["isDir"] as? Bool ?? false
                let ext = (name as NSString).pathExtension.lowercased()
                let childAbs = abs.hasSuffix("/") ? abs + name : abs + "/" + name
                return [
                    "name": name,
                    "displayName": name,
                    "path": join(id, childAbs),
                    "isDir": isDir,
                    "size": e["size"] as? Int ?? 0,
                    "mtime": 0,
                    "ext": ext,
                    "hidden": name.hasPrefix("."),
                    "encrypted": false,
                    "vault": false
                ]
            }
            return entries

        case "fs.read":
            let res = Remote.download(target, path: abs, to: NSTemporaryDirectory() + "ws-remote-read-\(UUID().uuidString)")
            if let err = res["error"] as? String { return ["error": err] }
            guard let local = res["path"] as? String,
                  let data = FileManager.default.contents(atPath: local) else {
                return ["error": "读取失败"]
            }
            try? FileManager.default.removeItem(atPath: local)
            let text = String(data: data, encoding: .utf8) ?? ""
            return [
                "kind": "text",
                "text": text,
                "size": data.count,
                "mtime": 0,
                "binary": String(data: data, encoding: .utf8) == nil
            ]

        case "fs.write":
            let tmp = NSTemporaryDirectory() + "ws-remote-write-\(UUID().uuidString)"
            let text = params["text"] as? String ?? ""
            guard (try? Data(text.utf8).write(to: URL(fileURLWithPath: tmp))) != nil else {
                return ["error": "本地暂存失败"]
            }
            let res = Remote.upload(target, localPath: tmp, to: abs)
            try? FileManager.default.removeItem(atPath: tmp)
            if let err = res["error"] as? String { return ["error": err] }
            return ["mtime": 0]

        case "fs.mkdir":
            let res = Remote.mkdir(target, path: abs)
            if let err = res["error"] as? String { return ["error": err] }
            return NSNull()

        case "fs.remove":
            let res = Remote.remove(target, path: abs)
            if let err = res["error"] as? String { return ["error": err] }
            return NSNull()

        case "fs.rename":
            guard let toRaw = params["to"] as? String, let (_, toTarget, toAbs) = parse(toRaw),
                  toTarget.host == target.host else { return ["error": "不能跨会话重命名"] }
            let res = Remote.rename(target, from: abs, to: toAbs)
            if let err = res["error"] as? String { return ["error": err] }
            return NSNull()

        case "fs.stat":
            let res = Remote.run(target, command: "stat -c '%s %Y %F' \(Remote.quote(abs)) 2>/dev/null || stat -f '%z %m %HT' \(Remote.quote(abs))")
            let out = (String(data: res.out, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let parts = out.split(separator: " ")
            let size = Int(parts.first ?? "0") ?? 0
            let mtime = parts.count > 1 ? (Double(parts[1]) ?? 0) : 0
            let isDir = out.contains("directory")
            return ["size": size, "mtime": mtime, "isDir": isDir]

        case "fs.exists":
            let res = Remote.run(target, command: "test -e \(Remote.quote(abs)) && echo yes || echo no")
            let out = String(data: res.out, encoding: .utf8) ?? ""
            return out.contains("yes")

        case "fs.size":
            let res = Remote.run(target, command: "du -sk \(Remote.quote(abs)) 2>/dev/null | cut -f1")
            let kb = Int((String(data: res.out, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            return ["size": kb * 1024, "isDir": true]

        default:
            return nil
        }
    }

    static func git(_ id: String, path: String, action: String, message: String) -> [String: Any] {
        guard let (_, target, abs) = parse(path) else { return ["error": "会话未注册"] }
        let cmd: String
        switch action {
        case "pull": cmd = "git -C \(Remote.quote(abs)) pull --ff-only 2>&1"
        case "push": cmd = "git -C \(Remote.quote(abs)) push 2>&1"
        case "fetch": cmd = "git -C \(Remote.quote(abs)) fetch --all 2>&1"
        case "commit": cmd = "git -C \(Remote.quote(abs)) add -A && git -C \(Remote.quote(abs)) commit -m \(Remote.quote(message)) 2>&1"
        default: cmd = "git -C \(Remote.quote(abs)) status -sb 2>&1 | head -5"
        }
        let res = Remote.run(target, command: cmd, timeout: 90)
        let out = String(data: res.out, encoding: .utf8) ?? ""
        return ["ok": res.code == 0, "output": String(out.suffix(800))]
    }

    /// 远端仓库的 git 状态，用于树里的修改标记
    static func gitStatus(_ id: String, path: String) -> [String: Any] {
        guard let (_, target, abs) = parse(path) else { return ["entries": [], "branch": ""] }
        let res = Remote.run(target, command: "cd \(Remote.quote(abs)) 2>/dev/null && git status --porcelain -z 2>/dev/null")
        let text = String(data: res.out, encoding: .utf8) ?? ""
        var out: [[String: Any]] = []
        for item in text.split(separator: "\0") {
            let s = String(item)
            guard s.count > 3 else { continue }
            let code = String(s.prefix(2)).trimmingCharacters(in: .whitespaces)
            var rel = String(s.dropFirst(3))
            if let arrow = rel.range(of: " -> ") { rel = String(rel[arrow.upperBound...]) }
            out.append(["path": rel, "code": code.isEmpty ? "M" : code])
        }
        // 当前分支
        let br = Remote.run(target, command: "git -C \(Remote.quote(abs)) rev-parse --abbrev-ref HEAD 2>/dev/null")
        let branch = (String(data: br.out, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return ["entries": out, "branch": branch]
    }
}
