import Foundation

/// 远端文件浏览：不依赖 SFTP 协议栈，直接复用 ssh 执行远端命令。
/// 这样密码/密钥认证与终端完全一致，macOS 自带的 curl 不支持 sftp 也不影响。
enum Remote {
    struct Target {
        let host: String
        let port: Int
        let user: String
        let secretId: String?
        var mockLocal: Bool = false
    }

    struct Result {
        let out: Data
        let err: Data
        let code: Int32
    }

    static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// 同一个目标复用一条底层连接：ControlMaster 让后续 ssh 直接走已有 socket，
    /// 避免每次列目录都付一次握手 + 认证的代价。
    static func controlOptions(_ t: Target) -> [String] {
        let key = stableHash("\(t.user)@\(t.host):\(t.port)")
        let sock = "/tmp/ws-ssh-\(key)"
        return ["-o", "ControlMaster=auto", "-o", "ControlPath=\(sock)", "-o", "ControlPersist=180"]
    }

    static func warm(_ t: Target) -> [String: Any] {
        let start = Date()
        let res = run(t, command: "true", timeout: 20)
        return ["ok": res.code == 0, "ms": Int(Date().timeIntervalSince(start) * 1000)]
    }

    static func run(_ t: Target, command: String, stdin: Data? = nil, timeout: TimeInterval = 45) -> Result {
        if t.mockLocal {
            return exec("/bin/sh", ["-c", command], env: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"],
                        stdin: stdin, timeout: timeout)
        }
        var args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12", "-o", "BatchMode=no"]
        args += controlOptions(t)
        if t.port > 0 && t.port != 22 { args += ["-p", String(t.port)] }
        args += ["\(t.user.isEmpty ? "root" : t.user)@\(t.host)", command]

        var env: [String: String] = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        if let sid = t.secretId, let pw = SSHSecrets.get(sid), let ap = Askpass.make(password: pw) {
            for (k, v) in ap.env { env[k] = v }
            defer { ap.cleanup() }
            return exec("/usr/bin/ssh", args, env: env, stdin: stdin, timeout: timeout)
        }
        return exec("/usr/bin/ssh", args, env: env, stdin: stdin, timeout: timeout)
    }

    private static func exec(_ program: String, _ args: [String], env: [String: String],
                             stdin: Data?, timeout: TimeInterval) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: program)
        p.arguments = args
        var e = ProcessInfo.processInfo.environment
        for (k, v) in env { e[k] = v }
        p.environment = e

        let outPipe = Pipe(), errPipe = Pipe(), inPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        p.standardInput = inPipe

        do { try p.run() } catch {
            return Result(out: Data(), err: Data(error.localizedDescription.utf8), code: -1)
        }

        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if let stdin {
            inPipe.fileHandleForWriting.write(stdin)
        }
        inPipe.fileHandleForWriting.closeFile()

        // 超时兜底：以前 timeout 参数没有真正生效，远端 grep/find 卡住会永远等
        let softKill = DispatchWorkItem {
            if p.isRunning { p.terminate() }
        }
        let hardKill = DispatchWorkItem {
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: softKill)
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout + 1.0, execute: hardKill)
        p.waitUntilExit()
        softKill.cancel()
        hardKill.cancel()
        group.wait()
        return Result(out: outData, err: errData, code: p.terminationStatus)
    }

    // MARK: - 解析 ls -la

    struct Entry {
        let name: String
        let isDir: Bool
        let size: Int
        let mtime: Double
        let mode: String
    }

    static func parseListing(_ text: String, dir: String) -> [Entry] {
        var out: [Entry] = []
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            let first = line.first!
            guard first == "-" || first == "d" || first == "l" else { continue }
            let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard parts.count >= 9 else { continue }
            guard parts[0].count >= 10 else { continue }
            let perms = parts[0]
            let size = Int(parts[4]) ?? 0
            var name = parts[8...].joined(separator: " ")
            if perms.hasPrefix("l") {
                // 软链接：name -> target
                if let r = name.range(of: " -> ") { name = String(name[..<r.lowerBound]) }
            }
            if name == "." || name == ".." { continue }
            let isDir = perms.hasPrefix("d")
            out.append(Entry(name: name, isDir: isDir, size: size, mtime: 0, mode: perms))
        }
        out.sort { a, b in
            if a.isDir != b.isDir { return a.isDir }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
        return out
    }

    static func list(_ t: Target, path: String) -> [String: Any] {
        let res = run(t, command: "LC_ALL=C ls -la \(quote(path)) 2>&1")
        let text = String(data: res.out, encoding: .utf8) ?? ""
        if res.code != 0 {
            return ["error": text.isEmpty ? "无法列目录（退出码 \(res.code)）" : text.trimmingCharacters(in: .whitespacesAndNewlines)]
        }
        let entries = parseListing(text, dir: path).map { e -> [String: Any] in
            ["name": e.name, "isDir": e.isDir, "size": e.size, "mode": e.mode]
        }
        return ["entries": entries]
    }

    /// 远程文件名搜索：只跑 find，不扫内容，避免大仓库 grep 慢到不可用。
    static func search(_ t: Target, root: String, query: String, limit: Int, caseSensitive: Bool) -> [String: Any] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return ["hits": []] }
        var escaped = ""
        for ch in q {
            if "*?[]\\".contains(ch) { escaped.append("\\") }
            escaped.append(ch)
        }
        let pattern = "*\(escaped)*"
        let opt = caseSensitive ? "-name" : "-iname"
        let n = max(1, min(200, limit))
        let cmd = "cd \(quote(root)) 2>/dev/null || exit 7; LC_ALL=C find . -type f -not -path './.git/*' \(opt) \(quote(pattern)) -print 2>/dev/null | head -n \(n)"
        let res = run(t, command: cmd, timeout: 12)
        let text = String(data: res.out, encoding: .utf8) ?? ""
        if res.code != 0 && text.isEmpty {
            let err = String(data: res.err, encoding: .utf8) ?? ""
            return ["error": err.isEmpty ? "远端搜索失败（退出码 \(res.code)）" : err.trimmingCharacters(in: .whitespacesAndNewlines), "hits": []]
        }
        var hits: [[String: Any]] = []
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            let rel = line.hasPrefix("./") ? String(line.dropFirst(2)) : line
            if rel.isEmpty { continue }
            let name = (rel as NSString).lastPathComponent
            hits.append(["rel": rel, "name": name])
            if hits.count >= n { break }
        }
        return ["hits": hits]
    }

    static func download(_ t: Target, path: String, to: String) -> [String: Any] {
        let res = run(t, command: "LC_ALL=C cat -- \(quote(path))", timeout: 300)
        if res.code != 0 {
            return ["error": String(data: res.err, encoding: .utf8) ?? "下载失败"]
        }
        do {
            try FileManager.default.createDirectory(
                atPath: (to as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true)
            try res.out.write(to: URL(fileURLWithPath: to))
            return ["path": to, "bytes": res.out.count]
        } catch {
            return ["error": "写入失败：\(error.localizedDescription)"]
        }
    }

    static func upload(_ t: Target, localPath: String, to remotePath: String) -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: localPath) else {
            return ["error": "本地文件不存在"]
        }
        let res = run(t, command: "cat > \(quote(remotePath))", stdin: data, timeout: 300)
        if res.code != 0 {
            return ["error": String(data: res.err, encoding: .utf8) ?? "上传失败"]
        }
        return ["ok": true, "bytes": data.count]
    }

    static func mkdir(_ t: Target, path: String) -> [String: Any] {
        let res = run(t, command: "mkdir -p \(quote(path)) 2>&1")
        return res.code == 0 ? ["ok": true] : ["error": String(data: res.out, encoding: .utf8) ?? "创建失败"]
    }

    static func remove(_ t: Target, path: String) -> [String: Any] {
        let res = run(t, command: "rm -rf \(quote(path)) 2>&1")
        return res.code == 0 ? ["ok": true] : ["error": String(data: res.out, encoding: .utf8) ?? "删除失败"]
    }

    static func rename(_ t: Target, from: String, to: String) -> [String: Any] {
        let res = run(t, command: "mv \(quote(from)) \(quote(to)) 2>&1")
        return res.code == 0 ? ["ok": true] : ["error": String(data: res.out, encoding: .utf8) ?? "重命名失败"]
    }
}
