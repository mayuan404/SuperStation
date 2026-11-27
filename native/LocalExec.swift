import Foundation

// 本地命令通道：给「不在 SSH 工作区里」的文件跑 git（blame、仓库根探测等）。
// 以前这类操作全走 remote.exec，非 ssh:// 路径直接返回「远端会话未注册」，
// 所以本地仓库永远没有行级 blame。这里补一条等价的本地实现。
enum LocalExec {
    private static let searchPath = [
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"
    ].joined(separator: ":")

    static func run(_ path: String, cmd: String, timeout: TimeInterval) -> [String: Any] {
        let dir = path.isEmpty ? NSHomeDirectory() : path
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", cmd]
        // 目录不存在时不要抛给上层，让 sh 自己报错（和远端行为一致）
        if FileManager.default.fileExists(atPath: dir) {
            process.currentDirectoryURL = URL(fileURLWithPath: dir, isDirectory: true)
        }
        var env = ProcessInfo.processInfo.environment
        // 从 Finder 启动的 app 只有最小 PATH，git 常常不在里面，补上常见位置
        let existing = env["PATH"] ?? ""
        env["PATH"] = existing.isEmpty ? searchPath : searchPath + ":" + existing
        env["GIT_PAGER"] = "cat"
        env["LC_ALL"] = "en_US.UTF-8"
        process.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return ["code": -1, "stdout": "", "stderr": "无法执行：\(error.localizedDescription)"]
        }

        // 两个管道并行读，避免「一边写满阻塞、另一边还在等 EOF」的死锁
        let group = DispatchGroup()
        var outData = Data()
        var errData = Data()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }

        // 超时就杀掉，避免调用方一直等
        let deadline = DispatchTime.now() + max(1, timeout)
        let watchdog = DispatchWorkItem {
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: deadline, execute: watchdog)

        process.waitUntilExit()
        watchdog.cancel()
        group.wait()

        if process.terminationReason == .uncaughtSignal {
            return ["code": -1, "stdout": "", "stderr": "命令超时或被杀掉（\(Int(timeout))s）"]
        }

        let stdout = String(data: outData, encoding: .utf8) ?? ""
        let stderr = String(data: errData, encoding: .utf8) ?? ""
        return [
            "code": Int(process.terminationStatus),
            "stdout": String(stdout.suffix(200_000)),
            "stderr": String(stderr.suffix(40_000)),
        ]
    }
}
