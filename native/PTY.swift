import Foundation
import Darwin

/// 一个伪终端会话：本地 shell 或 ssh 子进程都跑在里面。
///
/// 线程约定：`buffer`、`flushScheduled`、`closed`、`source`、`askpass` 只在
/// `queue` 上读写。以前 `buffer` 在读取队列写、在主队列读，Data 的底层存储被
/// 两个线程同时改，会偶发 double-release（崩溃栈落在 flush 闭包里）。
final class PTYSession {
    let id: String
    private var master: Int32
    private var pid: pid_t = 0
    private var source: DispatchSourceRead?
    private var buffer = Data()
    private var flushScheduled = false
    private let queue = DispatchQueue(label: "betternotebook.pty", qos: .userInteractive)
    private var closed = false
    private var askpass: Askpass?

    init?(id: String, program: String, args: [String], cwd: String?, env: [String: String], cols: Int, rows: Int) {
        self.id = id
        var win = winsize(ws_row: UInt16(max(4, rows)), ws_col: UInt16(max(20, cols)), ws_xpixel: 0, ws_ypixel: 0)
        var merged = env
        if let secretId = env["__secretId"], !secretId.isEmpty, let pw = SSHSecrets.get(secretId),
           let ap = Askpass.make(password: pw) {
            self.askpass = ap
            for (k, v) in ap.env { merged[k] = v }
        }
        merged.removeValue(forKey: "__secretId")
        merged["TERM"] = merged["TERM"] ?? "xterm-256color"
        merged["LANG"] = merged["LANG"] ?? "en_US.UTF-8"
        if merged["HOME"] == nil { merged["HOME"] = NSHomeDirectory() }
        if merged["PATH"] == nil { merged["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" }

        // 必须用 forkpty：它会 setsid 并把 pty 设为控制终端，
        // 否则 ssh 打不开 /dev/tty，读密码时直接失败。
        var argv: [UnsafeMutablePointer<CChar>?] = ([program] + args).map { strdup($0) }
        argv.append(nil)
        var envp: [UnsafeMutablePointer<CChar>?] = merged.map { strdup("\($0.key)=\($0.value)") }
        envp.append(nil)
        let cwdC = cwd?.isEmpty == false ? strdup(cwd!) : nil
        let progC = strdup(program)

        var m: Int32 = 0
        let child = forkpty(&m, nil, nil, &win)

        if child == 0 {
            // 子进程：只做 async-signal-safe 的事，然后 exec
            if let cwdC { _ = chdir(cwdC) }
            execve(progC, argv, envp)
            _exit(127)
        }

        for p in argv { free(p) }
        for p in envp { free(p) }
        if let cwdC { free(cwdC) }
        free(progC)

        guard child > 0 else { return nil }
        self.master = m
        self.pid = child

        let src = DispatchSource.makeReadSource(fileDescriptor: m, queue: queue)
        src.setEventHandler { [weak self] in self?.drain() }
        // fd 只在这个 cancel handler 里关一次，避免和 close() 重复 close 导致 fd 被复用
        src.setCancelHandler { Darwin.close(m) }
        src.resume()
        self.source = src

        DispatchQueue.global(qos: .utility).async { [weak self] in
            var status: Int32 = 0
            waitpid(child, &status, 0)
            let code = Int((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
            guard let self else { return }
            self.queue.async {
                guard !self.closed else { return }
                self.closed = true
                self.source?.cancel()
                self.source = nil
                self.askpass?.cleanup()
                self.askpass = nil
                let id = self.id
                DispatchQueue.main.async {
                    API.shared.bridge?.emit("pty.exit", ["id": id, "code": code])
                }
            }
        }
    }

    deinit {
        source?.cancel()
    }

    /// 只在 queue 上调用
    private func drain() {
        guard !closed else { return }
        var buf = [UInt8](repeating: 0, count: 32 * 1024)
        let n = read(master, &buf, buf.count)
        if n <= 0 { return }
        buffer.append(contentsOf: buf[0..<n])
        scheduleFlush()
    }

    /// 只在 queue 上调用
    private func scheduleFlush() {
        if flushScheduled { return }
        flushScheduled = true
        queue.asyncAfter(deadline: .now() + 0.012) { [weak self] in
            guard let self, !self.closed else { return }
            self.flushScheduled = false
            guard !self.buffer.isEmpty else { return }
            // 在这里把数据取走（同一队列），主线程只负责发出去
            let chunk = self.buffer
            self.buffer.removeAll(keepingCapacity: true)
            let id = self.id
            DispatchQueue.main.async {
                API.shared.bridge?.emit("pty.data", ["id": id, "data": chunk.base64EncodedString()])
            }
        }
    }

    func write(_ data: Data) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            data.withUnsafeBytes { raw in
                guard let p = raw.baseAddress else { return }
                var off = 0
                while off < data.count {
                    let n = Darwin.write(self.master, p.advanced(by: off), data.count - off)
                    if n <= 0 { break }
                    off += n
                }
            }
        }
    }

    func resize(cols: Int, rows: Int) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            var win = winsize(ws_row: UInt16(max(4, rows)), ws_col: UInt16(max(20, cols)), ws_xpixel: 0, ws_ypixel: 0)
            _ = ioctl(self.master, TIOCSWINSZ, &win)
            if self.pid > 0 { kill(self.pid, SIGWINCH) }
        }
    }

    func close() {
        // 强引用到闭包执行完，保证 cancel（进而关 fd）一定发生
        queue.async {
            guard !self.closed else { return }
            self.closed = true
            self.source?.cancel()
            self.source = nil
            self.askpass?.cleanup()
            self.askpass = nil
            if self.pid > 0 { kill(self.pid, SIGHUP) }
        }
    }
}

enum PTYRegistry {
    private static var sessions: [String: PTYSession] = [:]
    private static let lock = NSLock()

    /// API 回调跑在并发队列上，这张表必须自己加锁
    static func session(_ id: String) -> PTYSession? {
        lock.lock(); defer { lock.unlock() }
        return sessions[id]
    }

    static func open(_ params: [String: Any]) -> [String: Any]? {
        let id = UUID().uuidString
        let program = params["program"] as? String ?? "/bin/zsh"
        let args = params["args"] as? [String] ?? []
        let cwd = params["cwd"] as? String
        let env = params["env"] as? [String: String] ?? [:]
        let cols = params["cols"] as? Int ?? 100
        let rows = params["rows"] as? Int ?? 30
        guard let s = PTYSession(id: id, program: program, args: args, cwd: cwd, env: env, cols: cols, rows: rows) else {
            return nil
        }
        lock.lock()
        sessions[id] = s
        lock.unlock()
        return ["id": id]
    }

    static func close(_ id: String) {
        lock.lock()
        let s = sessions.removeValue(forKey: id)
        lock.unlock()
        s?.close()
    }
}
