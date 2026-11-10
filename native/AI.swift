import Foundation

// 用户自备的 AI 配置：密钥只进 Keychain，不写配置文件、不进日志。
// 请求由原生发出（不受 CORS 限制），支持的接口格式与 OpenAI 一致。

final class AIStore {
    static let shared = AIStore()
    private let lock = NSLock()

    // 注意：不用 Keychain。应用是 ad-hoc 签名，每次重新构建签名都会变，
    // 读取旧 Keychain 条目会触发系统授权弹窗并阻塞调用。
    // 改为 0600 权限的本地文件：不在笔记目录里，不进配置、不进日志。
    private var path: String {
        let dir = Paths.support
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir + "/ai.key"
    }

    func apiKey() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let data = FileManager.default.contents(atPath: path),
              let s = String(data: data, encoding: .utf8) else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func setKey(_ key: String?) {
        lock.lock(); defer { lock.unlock() }
        let fm = FileManager.default
        guard let key, !key.trimmingCharacters(in: .whitespaces).isEmpty else {
            try? fm.removeItem(atPath: path)
            return
        }
        fm.createFile(atPath: path, contents: Data(key.trimmingCharacters(in: .whitespaces).utf8),
                      attributes: [.posixPermissions: 0o600])
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
}

enum AIService {
    private static var tasks: [String: Task<Void, Never>] = [:]
    private static let lock = NSLock()

    private static func endpoint(_ base: String) -> URL? {
        var s = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if s.isEmpty { s = "https://api.deepseek.com" }
        if s.hasSuffix("/chat/completions") { return URL(string: s) }
        return URL(string: s + "/chat/completions")
    }

    @discardableResult
    static func chat(params: [String: Any]) -> [String: Any] {
        let id = params["id"] as? String ?? UUID().uuidString
        let base = params["baseURL"] as? String ?? "https://api.deepseek.com"
        let model = params["model"] as? String ?? "deepseek-chat"
        let messages = params["messages"] as? [[String: Any]] ?? []
        let temperature = params["temperature"] as? Double ?? 0.7

        guard let key = AIStore.shared.apiKey(), !key.isEmpty else {
            return ["error": "还没有配置 API Key"]
        }
        guard let url = endpoint(base) else {
            return ["error": "API 地址无效"]
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "model": model,
            "messages": messages,
            "stream": true,
            "temperature": temperature
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else {
            return ["error": "请求构造失败"]
        }
        req.httpBody = data

        let task = Task.detached(priority: .userInitiated) {
            var full = ""
            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: req)
                guard let http = response as? HTTPURLResponse else {
                    emit("ai.error", ["id": id, "message": "无法连接到服务"])
                    return
                }
                if http.statusCode != 200 {
                    var msg = ""
                    for try await line in bytes.lines { msg += line; if msg.count > 400 { break } }
                    emit("ai.error", ["id": id, "message": "HTTP \(http.statusCode)：\(msg)"])
                    return
                }
                for try await line in bytes.lines {
                    guard line.hasPrefix("data:") else { continue }
                    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if payload == "[DONE]" { break }
                    guard let d = payload.data(using: .utf8),
                          let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                          let choices = obj["choices"] as? [[String: Any]],
                          let delta = choices.first?["delta"] as? [String: Any],
                          let piece = delta["content"] as? String else { continue }
                    full += piece
                    emit("ai.delta", ["id": id, "text": piece])
                }
                emit("ai.done", ["id": id, "text": full])
            } catch {
                if (error as NSError).code == NSURLErrorCancelled {
                    emit("ai.done", ["id": id, "text": full, "cancelled": true])
                } else {
                    emit("ai.error", ["id": id, "message": error.localizedDescription])
                }
            }
            lock.lock(); tasks.removeValue(forKey: id); lock.unlock()
        }

        lock.lock(); tasks[id] = task; lock.unlock()
        return ["id": id]
    }

    static func cancel(_ id: String) {
        lock.lock()
        let t = tasks[id]
        tasks.removeValue(forKey: id)
        lock.unlock()
        t?.cancel()
    }

    static func test(params: [String: Any]) -> [String: Any] {
        guard let key = AIStore.shared.apiKey(), !key.isEmpty else {
            return ["ok": false, "message": "还没有配置 API Key"]
        }
        guard let url = endpoint(params["baseURL"] as? String ?? "https://api.deepseek.com") else {
            return ["ok": false, "message": "API 地址无效"]
        }
        let model = params["model"] as? String ?? "deepseek-chat"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "model": model,
            "messages": [["role": "user", "content": "ping"]],
            "max_tokens": 1,
            "stream": false
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let sem = DispatchSemaphore(value: 0)
        var result: [String: Any] = ["ok": false, "message": "超时"]
        URLSession.shared.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            if let err { result = ["ok": false, "message": err.localizedDescription]; return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200 {
                result = ["ok": true, "message": "连接成功"]
            } else {
                let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                result = ["ok": false, "message": "HTTP \(code)：\(String(text.prefix(300)))"]
            }
        }.resume()
        _ = sem.wait(timeout: .now() + 25)
        return result
    }

    private static func emit(_ name: String, _ payload: [String: Any]) {
        API.shared.bridge?.emit(name, payload)
    }
}
