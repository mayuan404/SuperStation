import Foundation

/// SSH 密码只存在本机 0600 文件里，不进入设置、不经过网页层。
enum SSHSecrets {
    private static var file: String { Paths.support + "/ssh-secrets.json" }
    /// API 回调是并发队列，读-改-写必须串起来，否则并发保存会互相覆盖
    private static let lock = NSLock()

    private static func load() -> [String: String] {
        guard let d = FileManager.default.contents(atPath: file),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return [:] }
        return o
    }

    private static func save(_ map: [String: String]) {
        guard let d = try? JSONSerialization.data(withJSONObject: map) else { return }
        FileManager.default.createFile(atPath: file, contents: d, attributes: [.posixPermissions: 0o600])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file)
    }

    static func set(_ id: String, _ password: String?) {
        lock.lock(); defer { lock.unlock() }
        var map = load()
        if let password, !password.isEmpty { map[id] = password }
        else { map.removeValue(forKey: id) }
        save(map)
    }

    static func get(_ id: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return load()[id]
    }

    static func has(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (load()[id]?.isEmpty == false)
    }
}

/// 用 SSH_ASKPASS 把保存的密码喂给 ssh：密码写到 0600 临时文件，
/// askpass 脚本只负责把它打印出来，会话结束整个目录删除。
struct Askpass {
    let dir: String
    let env: [String: String]

    static func make(password: String) -> Askpass? {
        let fm = FileManager.default
        let base = Paths.support + "/askpass"
        try? fm.createDirectory(atPath: base, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
        let dir = base + "/" + UUID().uuidString
        guard (try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                       attributes: [.posixPermissions: 0o700])) != nil else { return nil }

        let pwFile = dir + "/pw"
        guard fm.createFile(atPath: pwFile, contents: Data(password.utf8),
                            attributes: [.posixPermissions: 0o600]) else { return nil }
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pwFile)

        let script = dir + "/askpass.sh"
        let body = "#!/bin/sh\ncat \"\(pwFile)\"\n"
        guard fm.createFile(atPath: script, contents: Data(body.utf8),
                            attributes: [.posixPermissions: 0o700]) else { return nil }
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script)

        return Askpass(dir: dir, env: [
            "SSH_ASKPASS": script,
            "SSH_ASKPASS_REQUIRE": "force",
            "DISPLAY": ":0"
        ])
    }

    func cleanup() { try? FileManager.default.removeItem(atPath: dir) }
}
