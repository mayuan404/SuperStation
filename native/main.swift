// SuperWorkStation — 文件 / 笔记 / 终端 一体的本地工作台。
// Native shell: AppKit window + WKWebView, custom URL scheme, JS bridge, filesystem + vault.

import AppKit
import WebKit
import CommonCrypto
import CryptoKit

// MARK: - Small helpers

func jsonData(_ obj: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed])) ?? Data("null".utf8)
}

func jsonString(_ obj: Any) -> String {
    String(data: jsonData(obj), encoding: .utf8) ?? "null"
}

func b64(_ d: Data) -> String { d.base64EncodedString() }
func unb64(_ s: String) -> Data? { Data(base64Encoded: s) }

func ensureSamples() -> String {
    let base = Paths.support
    let dest = base + "/samples"
    if let src = Bundle.main.resourceURL?.appendingPathComponent("samples").path,
       FileManager.default.fileExists(atPath: src) {
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: dest) {
            try? FileManager.default.copyItem(atPath: src, toPath: dest)
        } else if let names = try? FileManager.default.contentsOfDirectory(atPath: src) {
            // 合并：只补缺失的，不覆盖用户改过的文件
            for n in names {
                let to = (dest as NSString).appendingPathComponent(n)
                if !FileManager.default.fileExists(atPath: to) {
                    try? FileManager.default.copyItem(atPath: (src as NSString).appendingPathComponent(n), toPath: to)
                }
            }
        }
    }
    return FileManager.default.fileExists(atPath: dest) ? dest : ""
}

func devConfig() -> [String: String] {
    let p = Paths.support + "/dev.json"
    guard let d = FileManager.default.contents(atPath: p),
          let obj = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return [:] }
    return obj
}

func devValue(_ key: String) -> String {
    return ProcessInfo.processInfo.environment[key] ?? devConfig()[key.lowercased()] ?? ""
}

let vaultMarker = ".bnbook-vault"
let vaultEncSuffix = ".bnenc"

// MARK: - File service

enum FSKind: String { case text, binary, none }

struct VaultHeader: Codable {
    var v: Int
    var kdf: String
    var iter: Int
    var salt: String
    var check: String
}

final class VaultStore {
    static let shared = VaultStore()
    private var keys: [String: SymmetricKey] = [:]
    private let lock = NSLock()

    func key(for root: String) -> SymmetricKey? {
        lock.lock(); defer { lock.unlock() }
        return keys[root]
    }
    func setKey(_ k: SymmetricKey?, for root: String) {
        lock.lock(); defer { lock.unlock() }
        if let k { keys[root] = k } else { keys.removeValue(forKey: root) }
    }
    func isUnlocked(_ root: String) -> Bool { key(for: root) != nil }
}

enum Crypto {
    static func deriveKey(password: String, salt: Data, iterations: Int) -> SymmetricKey {
        var derived = [UInt8](repeating: 0, count: 32)
        let pw = Array(password.utf8)
        _ = salt.withUnsafeBytes { saltPtr in
            pw.withUnsafeBufferPointer { pwPtr in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    pwPtr.baseAddress, pw.count,
                    saltPtr.bindMemory(to: UInt8.self).baseAddress, salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(iterations),
                    &derived, derived.count)
            }
        }
        return SymmetricKey(data: Data(derived))
    }

    static func seal(_ data: Data, key: SymmetricKey) throws -> Data {
        let nonce = AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(data, using: key, nonce: nonce)
        var out = Data("BNBK1".utf8)
        out.append(sealed.nonce.withUnsafeBytes { Data($0) })
        out.append(sealed.ciphertext)
        out.append(sealed.tag)
        return out
    }

    static func open(_ blob: Data, key: SymmetricKey) throws -> Data {
        guard blob.count > 5 + 12 + 16, blob.prefix(5) == Data("BNBK1".utf8) else {
            throw NSError(domain: "betternotebook", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "不是有效的加密文件"])
        }
        let nonceData = blob.subdata(in: 5..<17)
        let body = blob.subdata(in: 17..<blob.count)
        let ciphertext = body.prefix(body.count - 16)
        let tag = body.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonceData),
                                        ciphertext: ciphertext,
                                        tag: tag)
        return try AES.GCM.open(box, using: key)
    }
}

enum Paths {
    /// 应用支持目录。名字改过几次（BetterNoteBook → WorkStation → SuperStation → SuperWorkStation），
    /// 首次用新名字启动时把旧目录整体搬过来，SSH 密码 / AI Key / 草稿都还在。
    static let support: String = {
        let home = NSHomeDirectory()
        let newDir = home + "/Library/Application Support/SuperWorkStation"
        let fm = FileManager.default
        let newIsEmpty = (try? fm.contentsOfDirectory(atPath: newDir).isEmpty) ?? false
        if !fm.fileExists(atPath: newDir) || newIsEmpty {
            for old in ["SuperStation", "WorkStation", "BetterNoteBook"] {
                if adopt(home + "/Library/Application Support/" + old, into: newDir) { break }
            }
        }
        try? fm.createDirectory(atPath: newDir, withIntermediateDirectories: true)
        return newDir
    }()

    /// 把旧的支持目录搬成新的名字；新目录已经有内容时绝不覆盖。
    private static func adopt(_ oldDir: String, into newDir: String) -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: oldDir),
              !((try? fm.contentsOfDirectory(atPath: oldDir).isEmpty) ?? true) else { return false }
        if fm.fileExists(atPath: newDir) {
            guard (try? fm.contentsOfDirectory(atPath: newDir).isEmpty) ?? false else { return false }
            try? fm.removeItem(atPath: newDir)
        }
        return (try? fm.moveItem(atPath: oldDir, toPath: newDir)) != nil
    }

    static let logs: String = {
        let home = NSHomeDirectory()
        try? FileManager.default.createDirectory(atPath: home + "/Library/Logs", withIntermediateDirectories: true)
        return home + "/Library/Logs/SuperWorkStation.log"
    }()

    static let caches: String = {
        let base = NSHomeDirectory() + "/Library/Caches/SuperWorkStation"
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        return base
    }()
}

enum FS {
    static let fm = FileManager.default

    static func attributes(_ path: String) -> [FileAttributeKey: Any]? {
        try? fm.attributesOfItem(atPath: path)
    }

    static func isDirectory(_ path: String) -> Bool {
        var d: ObjCBool = false
        return fm.fileExists(atPath: path, isDirectory: &d) && d.boolValue
    }

    /// Nearest enclosing vault root (walking up), or nil.
    static func vaultRoot(for path: String) -> String? {
        var url = URL(fileURLWithPath: path).deletingLastPathComponent()
        var guardCount = 0
        while guardCount < 64 {
            guardCount += 1
            let marker = url.appendingPathComponent(vaultMarker).path
            if fm.fileExists(atPath: marker) { return url.path }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { break }
            url = parent
        }
        return nil
    }

    static func isVaultRoot(_ path: String) -> Bool {
        fm.fileExists(atPath: (path as NSString).appendingPathComponent(vaultMarker))
    }

    static func readVaultHeader(_ root: String) -> VaultHeader? {
        let p = (root as NSString).appendingPathComponent(vaultMarker)
        guard let d = fm.contents(atPath: p) else { return nil }
        return try? JSONDecoder().decode(VaultHeader.self, from: d)
    }

    static func writeVaultHeader(_ root: String, _ h: VaultHeader) throws {
        let p = (root as NSString).appendingPathComponent(vaultMarker)
        try JSONEncoder().encode(h).write(to: URL(fileURLWithPath: p))
    }

    static func list(_ path: String) throws -> [[String: Any]] {
        if isVaultRoot(path) && !VaultStore.shared.isUnlocked(path) {
            throw NSError(domain: "betternotebook", code: 8,
                          userInfo: [NSLocalizedDescriptionKey: "目录已锁定，请先解锁"])
        }
        let containingVault = isVaultRoot(path) ? path : vaultRoot(for: path)
        let names = try fm.contentsOfDirectory(atPath: path)
        var out: [[String: Any]] = []
        for name in names {
            if name == vaultMarker { continue }
            if name == ".DS_Store" { continue }
            var displayName = name
            var encrypted = false
            if name.hasSuffix(vaultEncSuffix) {
                displayName = String(name.dropLast(vaultEncSuffix.count))
                encrypted = true
            }
            let full = (path as NSString).appendingPathComponent(name)
            let attrs = attributes(full)
            let isDir = (attrs?[.type] as? FileAttributeType) == .typeDirectory
            if isDir && name.hasSuffix(".app") { continue }
            let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
            let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            let display = isDir ? name : displayName
            out.append([
                "name": name,
                "displayName": display,
                "path": full,
                "isDir": isDir,
                "size": size,
                "mtime": mtime,
                "encrypted": encrypted,
                "ext": isDir ? "" : (display as NSString).pathExtension.lowercased(),
                "hidden": display.hasPrefix("."),
                "vault": isDir && isVaultRoot(full),
                "inVault": containingVault != nil,
                "vaultRoot": containingVault ?? ""
            ])
        }
        out.sort { a, b in
            let ad = a["isDir"] as? Bool ?? false
            let bd = b["isDir"] as? Bool ?? false
            if ad != bd { return ad }
            let an = (a["displayName"] as? String ?? "").lowercased()
            let bn = (b["displayName"] as? String ?? "").lowercased()
            return an < bn
        }
        return out
    }

    static func directorySize(_ path: String, limit: Int = 200_000) -> Int {
        var total = 0
        var count = 0
        if let en = FileManager.default.enumerator(atPath: path) {
            for case let rel as String in en {
                count += 1
                if count > limit { break }
                let full = (path as NSString).appendingPathComponent(rel)
                let attrs = try? FileManager.default.attributesOfItem(atPath: full)
                if (attrs?[.type] as? FileAttributeType) == .typeRegular {
                    total += (attrs?[.size] as? NSNumber)?.intValue ?? 0
                }
            }
        }
        return total
    }

    static func isProbablyText(_ data: Data) -> Bool {
        let head = data.prefix(8192)
        if head.contains(0) { return false }
        var utf8 = true
        if String(data: data, encoding: .utf8) == nil { utf8 = false }
        if !utf8 { return false }
        var control = 0
        for b in head {
            if b < 9 || (b > 13 && b < 32) { control += 1 }
        }
        return control * 100 / max(head.count, 1) < 2
    }

    static func read(path: String, maxBytes: Int = 24 * 1024 * 1024) throws -> [String: Any] {
        guard fm.fileExists(atPath: path) else {
            throw NSError(domain: "betternotebook", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "文件不存在"])
        }
        let attrs = attributes(path) ?? [:]
        let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
        let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0

        // Encrypted file inside an unlocked vault
        var data: Data
        if path.hasSuffix(vaultEncSuffix) {
            if let root = vaultRoot(for: path), let key = VaultStore.shared.key(for: root) {
                let raw = try Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe)
                data = try Crypto.open(raw, key: key)
            } else if FileVaultKeys.shared.key(for: path) != nil {
                data = try FileVault.decrypt(path: path)
            } else if FileVault.isFileVault(path) {
                throw NSError(domain: "betternotebook", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "该文件已加密，请先解锁"])
            } else {
                throw NSError(domain: "betternotebook", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "该文件已加密，请先解锁所在目录"])
            }
        } else {
            guard size <= maxBytes else {
                throw NSError(domain: "betternotebook", code: 4,
                              userInfo: [NSLocalizedDescriptionKey: "文件过大（\(size / 1024 / 1024) MB）"])
            }
            data = try Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe)
        }

        if isProbablyText(data) {
            let text = String(data: data, encoding: .utf8) ?? ""
            return [
                "kind": "text",
                "text": text,
                "size": data.count,
                "mtime": mtime,
                "truncated": data.count > maxBytes
            ]
        }
        return ["kind": "binary", "size": data.count, "mtime": mtime]
    }

    static func write(path: String, text: String) throws {
        if let old = FileManager.default.contents(atPath: path),
           let attrs = try? FileManager.default.attributesOfItem(atPath: path),
           let mtime = attrs[.modificationDate] as? Date {
            History.snapshot(path: path, previous: old, mtime: mtime)
        }
        var data = Data(text.utf8)
        if path.hasSuffix(vaultEncSuffix) {
            if let root = vaultRoot(for: path) {
                guard let key = VaultStore.shared.key(for: root) else {
                    throw NSError(domain: "betternotebook", code: 3,
                                  userInfo: [NSLocalizedDescriptionKey: "目录已锁定"])
                }
                data = try Crypto.seal(data, key: key)
            } else if FileVaultKeys.shared.key(for: path) != nil {
                data = try FileVault.sealForWrite(path: path, text: text)
            } else {
                throw NSError(domain: "betternotebook", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "该文件已加密，请先解锁"])
            }
        }
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    static func vaultPath(_ path: String) -> String {
        path.hasSuffix(vaultEncSuffix) ? path : path + vaultEncSuffix
    }

    static func createVault(at root: String, password: String, convert: Bool) throws {
        try fm.createDirectory(atPath: root, withIntermediateDirectories: true)
        if isVaultRoot(root) {
            throw NSError(domain: "betternotebook", code: 7,
                          userInfo: [NSLocalizedDescriptionKey: "该文件夹已是加密目录"])
        }
        let salt = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let iterations = 210_000
        let key = Crypto.deriveKey(password: password, salt: salt, iterations: iterations)
        let checkPlain = Data("betternotebook-vault-v1".utf8)
        let check = try Crypto.seal(checkPlain, key: key)
        let header = VaultHeader(v: 1, kdf: "pbkdf2-sha256", iter: iterations, salt: b64(salt), check: b64(check))
        try writeVaultHeader(root, header)
        VaultStore.shared.setKey(key, for: root)
        if convert {
            try encryptTree(root: root, key: key)
        }
    }

    static func encryptTree(root: String, key: SymmetricKey) throws {
        let sub = (try? fm.subpathsOfDirectory(atPath: root)) ?? []
        // Encrypt files depth-first so directories stay.
        for rel in sub {
            let full = (root as NSString).appendingPathComponent(rel)
            if isDirectory(full) { continue }
            let name = (rel as NSString).lastPathComponent
            if name == vaultMarker || name.hasSuffix(vaultEncSuffix) { continue }
            let data = try Data(contentsOf: URL(fileURLWithPath: full))
            let sealed = try Crypto.seal(data, key: key)
            let newPath = full + vaultEncSuffix
            try sealed.write(to: URL(fileURLWithPath: newPath), options: .atomic)
            try fm.removeItem(atPath: full)
        }
    }

    /// 解除整个目录的加密：逐个还原文件，然后删掉标记。
    static func removeVault(root: String, password: String) throws {
        try unlock(root: root, password: password)
        guard let key = VaultStore.shared.key(for: root) else {
            throw NSError(domain: "betternotebook", code: 9,
                          userInfo: [NSLocalizedDescriptionKey: "解锁失败"])
        }
        let fm = FileManager.default
        guard let en = fm.enumerator(atPath: root) else { return }
        var files: [String] = []
        for case let rel as String in en {
            if rel.hasSuffix(vaultEncSuffix) { files.append(rel) }
        }
        for rel in files {
            let full = (root as NSString).appendingPathComponent(rel)
            let raw = try Data(contentsOf: URL(fileURLWithPath: full))
            let plain = try Crypto.open(raw, key: key)
            let target = String(full.dropLast(vaultEncSuffix.count))
            try plain.write(to: URL(fileURLWithPath: target), options: .atomic)
            try fm.removeItem(atPath: full)
        }
        try? fm.removeItem(atPath: (root as NSString).appendingPathComponent(vaultMarker))
        VaultStore.shared.setKey(nil, for: root)
    }

    static func unlock(root: String, password: String) throws {
        guard let h = readVaultHeader(root), let salt = unb64(h.salt), let check = unb64(h.check) else {
            throw NSError(domain: "betternotebook", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "不是有效的加密目录"])
        }
        let key = Crypto.deriveKey(password: password, salt: salt, iterations: h.iter)
        let plain: Data
        do { plain = try Crypto.open(check, key: key) } catch {
            throw NSError(domain: "betternotebook", code: 6,
                          userInfo: [NSLocalizedDescriptionKey: "密码错误"])
        }
        guard plain == Data("betternotebook-vault-v1".utf8) else {
            throw NSError(domain: "betternotebook", code: 6,
                          userInfo: [NSLocalizedDescriptionKey: "密码错误"])
        }
        VaultStore.shared.setKey(key, for: root)
    }

    static func index(root: String, limit: Int = 40000) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let skipDirs: Set<String> = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", "target", ".idea"]
        var stack = [root]
        while let dir = stack.popLast() {
            guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for name in entries {
                if out.count >= limit { return out }
                if name == ".DS_Store" { continue }
                let full = (dir as NSString).appendingPathComponent(name)
                if isDirectory(full) {
                    if skipDirs.contains(name) || name.hasPrefix(".") { continue }
                    stack.append(full)
                } else {
                    if name == vaultMarker { continue }
                    var display = name
                    if name.hasSuffix(vaultEncSuffix) { display = String(name.dropLast(vaultEncSuffix.count)) }
                    if display.hasPrefix(".") { continue }
                    out.append([
                        "name": display,
                        "path": full,
                        "ext": (display as NSString).pathExtension.lowercased()
                    ])
                }
            }
        }
        return out
    }
}

// MARK: - File watcher

final class FileWatcher {
    private var stream: FSEventStreamRef?
    private var pending: Set<String> = []
    private var timer: DispatchSourceTimer?
    private let onChange: ([String]) -> Void
    /// FSEvents 回调只在这条串行队列上跑；释放前在同一队列上同步停流，
    /// 避免回调拿着已释放的 self（passUnretained）。
    private let queue = DispatchQueue(label: "betternotebook.fsevents")
    private let queueKey = DispatchSpecificKey<Bool>()
    private var stopped = false
    /// FSEvents 给的是解析过符号链接的路径（/tmp → /private/tmp），
    /// 这里把前缀换回用户当初打开的写法，树里的缓存键才能对上。
    private let rootPath: String
    private let resolvedRoot: String

    init(path: String, onChange: @escaping ([String]) -> Void) {
        self.onChange = onChange
        rootPath = path
        // Foundation 的 resolvingSymlinksInPath 不会把 /tmp、/var 这类 firmlink 解开，只有 realpath 会
        var resolved = path
        if let rp = realpath(path, nil) {
            resolved = String(cString: rp)
            free(rp)
        }
        resolvedRoot = resolved.hasSuffix("/") ? String(resolved.dropLast()) : resolved
        queue.setSpecific(key: queueKey, value: true)
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                       retain: nil, release: nil, copyDescription: nil)
        let paths = [path] as CFArray
        let cb: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<FileWatcher>.fromOpaque(info).takeUnretainedValue()
            let raw = UnsafeRawPointer(eventPaths)
            guard let arr = Unmanaged<CFArray>.fromOpaque(raw).takeUnretainedValue() as? [String] else { return }
            watcher.enqueue(paths: arr)
        }
        stream = FSEventStreamCreate(nil, cb, &ctx, paths,
                                     FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                                     0.25,
                                     UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer))
        guard let stream else { return }
        FSEventStreamSetDispatchQueue(stream, queue)
        FSEventStreamStart(stream)
    }

    /// 显式停止（在事件队列上同步执行）；重复调用安全
    func stop() {
        if DispatchQueue.getSpecific(key: queueKey) == true {
            performStop()
        } else {
            queue.sync { performStop() }
        }
    }

    private func performStop() {
        guard !stopped else { return }
        stopped = true
        timer?.cancel()
        timer = nil
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        stream = nil
    }

    private func enqueue(paths: [String]) {
        let mapped = paths.map { p -> String in
            guard resolvedRoot != rootPath, p.hasPrefix(resolvedRoot) else { return p }
            return rootPath + p.dropFirst(resolvedRoot.count)
        }
        DispatchQueue.main.async {
            self.pending.formUnion(mapped)
            self.timer?.cancel()
            let t = DispatchSource.makeTimerSource(queue: .main)
            t.schedule(deadline: .now() + 0.12)
            t.setEventHandler { [weak self] in
                guard let self else { return }
                let batch = Array(self.pending)
                self.pending.removeAll()
                if !batch.isEmpty { self.onChange(batch) }
            }
            t.resume()
            self.timer = t
        }
    }

    deinit {
        stop()
    }
}

// MARK: - Bridge

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    var watcher: FileWatcher?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let method = body["method"] as? String else { return }
        let params = body["params"] as? [String: Any] ?? [:]
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var result: Any = NSNull()
            var errMsg: String? = nil
            do {
                result = try API.shared.handle(method: method, params: params)
            } catch let e {
                errMsg = (e as NSError).localizedDescription
            }
            let payload: [String: Any] = ["id": id, "ok": errMsg == nil, "result": result,
                                          "error": errMsg ?? NSNull()]
            let js = "window.__betternotebookReply(\(jsonString(payload)))"
            DispatchQueue.main.async { self?.webView?.evaluateJavaScript(js, completionHandler: nil) }
        }
    }

    func emit(_ name: String, _ payload: Any) {
        let js = "window.__betternotebookEvent(\(jsonString(["name": name, "payload": payload])))"
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(js, completionHandler: nil) }
    }

    func watch(root: String) {
        // watcher 是可变的引用，统一在主线程换，避免和回调/deinit 抢
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.watch(root: root) }
            return
        }
        watcher?.stop()
        watcher = nil
        guard !root.isEmpty else { return }
        watcher = FileWatcher(path: root) { [weak self] paths in
            self?.emit("fs.change", ["paths": paths])
        }
    }
}

// MARK: - API

final class API {
    static let shared = API()
    static let logQueue = DispatchQueue(label: "app.betternotebook.log")
    private var dragMonitor: Any?

    private func beginDrag() {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first else { return }
        if let m = dragMonitor { NSEvent.removeMonitor(m); dragMonitor = nil }
        let start = NSEvent.mouseLocation
        let origin = window.frame.origin
        dragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseUp]) { [weak self] ev in
            guard let self else { return ev }
            if ev.type == .leftMouseUp {
                if let m = self.dragMonitor { NSEvent.removeMonitor(m) }
                self.dragMonitor = nil
                return nil
            }
            let now = NSEvent.mouseLocation
            window.setFrameOrigin(NSPoint(x: origin.x + (now.x - start.x),
                                          y: origin.y + (now.y - start.y)))
            return nil
        }
    }
    weak var bridge: Bridge?

    func handle(method: String, params: [String: Any]) throws -> Any {
        // 远端路径（ssh://…）走另一套实现，网页层无感
        if method.hasPrefix("fs."), let r = RemoteFS.handle(method, params) {
            if let e = r as? [String: Any], let msg = e["error"] as? String {
                throw err(msg)
            }
            return r
        }
        switch method {
        case "dev.snapshot":
            let path = params["path"] as? String ?? "/tmp/betternotebook-snap.png"
            DispatchQueue.main.async {
                guard let wv = self.bridge?.webView else { return }
                let cfg = WKSnapshotConfiguration()
                wv.takeSnapshot(with: cfg) { image, _ in
                    guard let image,
                          let tiff = image.tiffRepresentation,
                          let rep = NSBitmapImageRep(data: tiff),
                          let png = rep.representation(using: .png, properties: [:]) else { return }
                    try? png.write(to: URL(fileURLWithPath: path))
                }
            }
            return NSNull()

        case "app.log":
            let line = params["line"] as? String ?? ""
            API.logQueue.async {
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
            return NSNull()

        case "app.info":
            return ["version": "0.1.0", "home": NSHomeDirectory(),
                    "os": ProcessInfo.processInfo.operatingSystemVersionString,
                    "initial": devValue("BNB_OPEN"),
                    "initialFile": devValue("BNB_FILE"),
                    "samples": ensureSamples()]

        case "ui.openFolder":
            return onMain { self.openFolderPanel() ?? NSNull() }
        case "ui.savePanel":
            return onMain { self.savePanel(name: params["name"] as? String ?? "untitled.txt") ?? NSNull() }
        case "ui.confirm":
            return onMain { self.confirm(title: params["title"] as? String ?? "确认",
                                             message: params["message"] as? String ?? "") }
        case "ui.openExternal":
            let u = params["url"] as? String ?? ""
            if let url = URL(string: u) { DispatchQueue.main.async { NSWorkspace.shared.open(url) } }
            return NSNull()
        case "ui.zoomWindow":
            return onMain {
                guard let w = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first else { return NSNull() }
                let global = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain) as? [String: Any]
                let action = (global?["AppleActionOnDoubleClick"] as? String) ?? "Maximize"
                switch action {
                case "Minimize": w.performMiniaturize(nil)
                case "None": break
                default: w.zoom(nil)
                }
                return NSNull()
            }

        case "ui.beginDrag":
            DispatchQueue.main.async { self.beginDrag() }
            return NSNull()
        case "ui.reveal":
            // activateFileViewerSelecting 在 macOS 26/27 上不再把 Finder 拉到前台（实测
            // 调用后 frontmost 仍是本应用）。`open -R` 走 LaunchServices，能稳定调起
            // 并在 Finder 里选中；路径不存在时退回它的父目录。
            let p = params["path"] as? String ?? ""
            DispatchQueue.main.async {
                guard !p.isEmpty else { return }
                var target = p
                if !FileManager.default.fileExists(atPath: target) {
                    target = (p as NSString).deletingLastPathComponent
                }
                guard FileManager.default.fileExists(atPath: target) else { return }
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                proc.arguments = ["-R", target]
                try? proc.run()
            }
            return NSNull()
        case "ui.setTitle":
            let t = params["title"] as? String ?? ""
            DispatchQueue.main.async { NSApp.mainWindow?.title = t }
            return NSNull()
        case "ui.cursor":
            // 网页侧把 getComputedStyle(el).cursor 回传过来，由 AppKit 直接设，
            // 绕开 WKWebView 在某些系统版本上不按 CSS 刷新光标的问题。
            let shape = params["shape"] as? String ?? "default"
            if !devValue("BNB_CURSOR_DEBUG").isEmpty { appLog("CURSOR \(shape)") }
            DispatchQueue.main.async {
                let cursor: NSCursor
                switch shape {
                case "pointer": cursor = .pointingHand
                case "text": cursor = .iBeam
                case "vertical-text": cursor = .iBeamCursorForVerticalLayout
                case "col-resize": cursor = .resizeLeftRight
                case "row-resize": cursor = .resizeUpDown
                case "grab": cursor = .openHand
                case "grabbing": cursor = .closedHand
                case "crosshair": cursor = .crosshair
                case "not-allowed", "no-drop": cursor = .operationNotAllowed
                case "context-menu": cursor = .contextualMenu
                default: cursor = .arrow
                }
                (self.bridge?.webView as? CursorWebView)?.applyCursor(cursor)
            }
            return NSNull()

        case "fs.list":
            let p = params["path"] as? String ?? ""
            guard FS.isDirectory(p) else { throw err("目录不存在") }
            return try FS.list(p)
        case "fs.read":
            return try FS.read(path: params["path"] as? String ?? "")
        case "fs.write":
            try AllowedRoots.guardWrite(params["path"] as? String ?? (params["to"] as? String ?? ""))
            try FS.write(path: params["path"] as? String ?? "", text: params["text"] as? String ?? "")
            let attrs = FS.attributes(params["path"] as? String ?? "")
            return ["mtime": (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0]
        case "fs.mkdir":
            let p = params["path"] as? String ?? ""
            try AllowedRoots.guardWrite(p)
            try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
            return NSNull()
        case "fs.create":
            let p = params["path"] as? String ?? ""
            try AllowedRoots.guardWrite(p)
            let content = params["text"] as? String ?? ""
            let dir = (p as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            if FS.isDirVault(dir) {
                return try makeEncrypted(p, content: content)
            }
            try Data(content.utf8).write(to: URL(fileURLWithPath: p), options: .atomic)
            return NSNull()
        case "fs.rename":
            let from = params["from"] as? String ?? ""
            let to = params["to"] as? String ?? ""
            try AllowedRoots.guardWrite(from)
            try AllowedRoots.guardWrite(to)
            try FileManager.default.moveItem(atPath: from, toPath: to)
            return NSNull()
        case "fs.trash":
            let p = params["path"] as? String ?? ""
            try AllowedRoots.guardWrite(p)
            var resulting: NSURL?
            try FileManager.default.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: &resulting)
            return NSNull()
        case "fs.exists":
            return FileManager.default.fileExists(atPath: params["path"] as? String ?? "")
        case "fs.search":
            return try search(root: params["root"] as? String ?? "",
                              query: params["query"] as? String ?? "",
                              limit: params["limit"] as? Int ?? 200,
                              caseSensitive: params["caseSensitive"] as? Bool ?? false,
                              wholeWord: params["wholeWord"] as? Bool ?? false,
                              namesOnly: params["namesOnly"] as? Bool ?? false,
                              budget: params["budget"] as? Double ?? 8)

        case "history.list":
            return History.list(path: params["path"] as? String ?? "")
        case "history.read":
            return History.read(path: params["path"] as? String ?? "",
                                id: params["id"] as? String ?? "") ?? NSNull()

        case "drafts.put":
            Drafts.put(path: params["path"] as? String ?? "",
                       name: params["name"] as? String ?? "",
                       text: params["text"] as? String ?? "")
            return NSNull()
        case "drafts.drop":
            Drafts.drop(path: params["path"] as? String ?? "")
            return NSNull()
        case "drafts.list":
            return Drafts.list()
        case "drafts.read":
            return Drafts.read(path: params["path"] as? String ?? "") ?? NSNull()

        case "app.allowRoot":
            AllowedRoots.allow(params["path"] as? String ?? "")
            return NSNull()

        case "remote.register":
            RemoteSessions.shared.register(
                params["id"] as? String ?? "",
                host: params["host"] as? String ?? "",
                port: params["port"] as? Int ?? 22,
                user: params["user"] as? String ?? "root",
                secretId: params["secretId"] as? String)
            return ["ok": true]

        case "remote.git":
            return (try? JSONSerialization.jsonObject(with: Data(), options: [])) == nil
                ? RemoteFS.git(params["id"] as? String ?? "", path: params["path"] as? String ?? "",
                               action: params["action"] as? String ?? "status",
                               message: params["message"] as? String ?? "update")
                : [:]

        case "remote.gitStatus":
            return RemoteFS.gitStatus(params["id"] as? String ?? "", path: params["path"] as? String ?? "")

        case "remote.warm":
            let t0 = Remote.Target(
                host: params["host"] as? String ?? "",
                port: params["port"] as? Int ?? 22,
                user: params["user"] as? String ?? "root",
                secretId: params["secretId"] as? String,
                mockLocal: (params["mockLocal"] as? Bool) ?? ((params["host"] as? String) == "mock"))
            return Remote.warm(t0)

        case "remote.search":
            let st = Remote.Target(
                host: params["host"] as? String ?? "",
                port: params["port"] as? Int ?? 22,
                user: params["user"] as? String ?? "root",
                secretId: params["secretId"] as? String,
                mockLocal: (params["mockLocal"] as? Bool) ?? ((params["host"] as? String) == "mock"))
            return Remote.search(st,
                root: params["path"] as? String ?? ".",
                query: params["query"] as? String ?? "",
                limit: params["limit"] as? Int ?? 60,
                caseSensitive: params["caseSensitive"] as? Bool ?? false)

        case "remote.list", "remote.download", "remote.upload", "remote.mkdir",
             "remote.remove", "remote.rename":
            let t = Remote.Target(
                host: params["host"] as? String ?? "",
                port: params["port"] as? Int ?? 22,
                user: params["user"] as? String ?? "root",
                secretId: params["secretId"] as? String,
                mockLocal: (params["mockLocal"] as? Bool) ?? ((params["host"] as? String) == "mock"))
            switch method {
            case "remote.list":
                return Remote.list(t, path: params["path"] as? String ?? ".")
            case "remote.download":
                return Remote.download(t, path: params["path"] as? String ?? "",
                                       to: params["to"] as? String ?? "")
            case "remote.upload":
                return Remote.upload(t, localPath: params["local"] as? String ?? "",
                                     to: params["to"] as? String ?? "")
            case "remote.mkdir":
                return Remote.mkdir(t, path: params["path"] as? String ?? "")
            case "remote.remove":
                return Remote.remove(t, path: params["path"] as? String ?? "")
            default:
                return Remote.rename(t, from: params["from"] as? String ?? "",
                                     to: params["to"] as? String ?? "")
            }

        case "ssh.setSecret":
            SSHSecrets.set(params["id"] as? String ?? "", params["password"] as? String)
            return ["ok": true]
        case "ssh.hasSecret":
            return ["has": SSHSecrets.has(params["id"] as? String ?? "")]

        case "pty.open":
            guard let r = PTYRegistry.open(params) else {
                throw err("无法创建终端会话")
            }
            return r
        case "pty.write":
            let id = params["id"] as? String ?? ""
            let b64 = params["data"] as? String ?? ""
            if let s = PTYRegistry.session(id), let d = Data(base64Encoded: b64) { s.write(d) }
            return NSNull()
        case "pty.resize":
            let id = params["id"] as? String ?? ""
            PTYRegistry.session(id)?.resize(cols: params["cols"] as? Int ?? 100, rows: params["rows"] as? Int ?? 30)
            return NSNull()
        case "pty.close":
            PTYRegistry.close(params["id"] as? String ?? "")
            return NSNull()

        case "ui.pickFiles":
            // AppKit 的面板必须在主线程创建，否则 NSWindow 会直接抛异常 abort
            return onMain { () -> [String] in
                let panel = NSOpenPanel()
                panel.canChooseFiles = true
                panel.canChooseDirectories = false
                panel.allowsMultipleSelection = true
                panel.prompt = "选择"
                if panel.runModal() == .OK {
                    return panel.urls.map { $0.path }
                }
                return [String]()
            }

        case "ui.isFullscreen":
            // 用 onMain：万一以后从主线程调用，DispatchQueue.main.sync 会死锁
            return onMain {
                (NSApp.keyWindow ?? NSApp.mainWindow)?.styleMask.contains(.fullScreen) ?? false
            }

        case "ui.copy":
            let text = params["text"] as? String ?? ""
            DispatchQueue.main.async {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
            return NSNull()

        case "office.thumb":
            return Office.thumb(path: params["path"] as? String ?? "") ?? NSNull()
        case "office.quickLook":
            return Office.quickLook(path: params["path"] as? String ?? "")

        case "fs.textOf":
            return TextExtract.text(path: params["path"] as? String ?? "")

        case "ai.setKey":
            AIStore.shared.setKey(params["key"] as? String)
            return NSNull()
        case "ai.hasKey":
            return !(AIStore.shared.apiKey() ?? "").isEmpty
        case "ai.chat":
            return AIService.chat(params: params)
        case "ai.cancel":
            AIService.cancel(params["id"] as? String ?? "")
            return NSNull()
        case "ai.test":
            return AIService.test(params: params)

        case "epub.info":
            return try EPUBService.info(path: params["path"] as? String ?? "")

        case "fs.size":
            let p = params["path"] as? String ?? ""
            if FS.isDirectory(p) {
                return ["size": FS.directorySize(p), "isDir": true]
            }
            let attrs = FS.attributes(p) ?? [:]
            return ["size": (attrs[.size] as? NSNumber)?.intValue ?? 0, "isDir": false]

        case "fs.writeBytes":
            try AllowedRoots.guardWrite(params["path"] as? String ?? (params["to"] as? String ?? ""))
            let p = params["path"] as? String ?? ""
            guard let b64 = params["base64"] as? String, let data = Data(base64Encoded: b64) else {
                throw err("数据无效")
            }
            try data.write(to: URL(fileURLWithPath: p), options: .atomic)
            return NSNull()

        case "fs.check":
            return Checker.check(path: params["path"] as? String ?? "",
                                 text: params["text"] as? String ?? "")
        case "fs.copy":
            let from = params["from"] as? String ?? ""
            let to = params["to"] as? String ?? ""
            try AllowedRoots.guardWrite(to)
            try FileManager.default.copyItem(atPath: from, toPath: to)
            return NSNull()
        case "fs.move":
            try AllowedRoots.guardWrite(params["path"] as? String ?? (params["to"] as? String ?? ""))
            let from = params["from"] as? String ?? ""
            let to = params["to"] as? String ?? ""
            try FileManager.default.moveItem(atPath: from, toPath: to)
            return NSNull()
        case "fs.unzip":
            try AllowedRoots.guardWrite(params["path"] as? String ?? (params["to"] as? String ?? ""))
            return try Archive.extract(path: params["path"] as? String ?? "")
        case "pdf.info":
            return PDFService.info(path: params["path"] as? String ?? "") ?? NSNull()
        case "pdf.render":
            return PDFService.render(path: params["path"] as? String ?? "",
                                     page: params["page"] as? Int ?? 0,
                                     width: params["width"] as? Double ?? 1000) ?? NSNull()

        case "vault.encryptFile":
            let p = params["path"] as? String ?? ""
            let pw = params["password"] as? String ?? ""
            let out = try FileVault.encrypt(path: p, password: pw)
            return ["path": out]
        case "vault.unlockFile":
            try FileVault.unlock(path: params["path"] as? String ?? "",
                                 password: params["password"] as? String ?? "")
            return ["ok": true]
        case "vault.lockFile":
            FileVaultKeys.shared.set(nil, for: params["path"] as? String ?? "")
            return NSNull()

        case "vault.isFileVault":
            return FileVault.isFileVault(params["path"] as? String ?? "")

        case "fs.index":
            return FS.index(root: params["path"] as? String ?? "")
        case "fs.watch":
            let root = params["root"] as? String ?? ""
            DispatchQueue.main.async { self.bridge?.watch(root: root) }
            return NSNull()
        case "fs.stat":
            let p = params["path"] as? String ?? ""
            let a = FS.attributes(p) ?? [:]
            return ["size": (a[.size] as? NSNumber)?.intValue ?? 0,
                    "mtime": (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0,
                    "isDir": FS.isDirectory(p)]

        case "vault.status":
            let p = params["path"] as? String ?? ""
            guard FS.isVaultRoot(p) else { return ["isVault": false] }
            return ["isVault": true, "unlocked": VaultStore.shared.isUnlocked(p)]
        case "vault.findRoot":
            let p = params["path"] as? String ?? ""
            return FS.vaultRoot(for: p) ?? NSNull()

        case "vault.create":
            let p = params["path"] as? String ?? ""
            let pw = params["password"] as? String ?? ""
            guard pw.count >= 4 else { throw err("密码至少 4 位") }
            try FS.createVault(at: p, password: pw, convert: params["convert"] as? Bool ?? false)
            VaultStore.shared.setKey(nil, for: p)   // 加密完成即上锁
            return ["ok": true]
        case "vault.unlock":
            let p = params["path"] as? String ?? ""
            try FS.unlock(root: p, password: params["password"] as? String ?? "")
            return ["ok": true]
        case "vault.remove":
            try FS.removeVault(root: params["path"] as? String ?? "",
                               password: params["password"] as? String ?? "")
            return ["ok": true]
        case "vault.decryptFile":
            let p = params["path"] as? String ?? ""
            let pw = params["password"] as? String ?? ""
            try FileVault.unlock(path: p, password: pw)
            let plain = try FileVault.decrypt(path: p)
            let target = String(p.dropLast(vaultEncSuffix.count))
            try plain.write(to: URL(fileURLWithPath: target), options: .atomic)
            try FileManager.default.removeItem(atPath: p)
            FileVaultKeys.shared.set(nil, for: p)
            return ["path": target]
        case "vault.lock":
            let p = params["path"] as? String ?? ""
            VaultStore.shared.setKey(nil, for: p)
            return ["ok": true]

        default:
            throw err("未知方法: \(method)")
        }
    }

    private func search(root: String, query: String, limit: Int,
                        caseSensitive: Bool, wholeWord: Bool,
                        namesOnly: Bool, budget: Double) throws -> [[String: Any]] {
        let started = Date()
        guard !query.isEmpty, FS.isDirectory(root) else { return [] }
        var pattern = NSRegularExpression.escapedPattern(for: query)
        if wholeWord {
            pattern = "(?<![\\p{L}\\p{N}_])" + pattern + "(?![\\p{L}\\p{N}_])"
        }
        var opts: NSRegularExpression.Options = []
        if !caseSensitive { opts.insert(.caseInsensitive) }
        guard let re = try? NSRegularExpression(pattern: pattern, options: opts) else { return [] }
        func hits(_ s: String) -> Bool {
            re.firstMatch(in: s, options: [], range: NSRange(s.startIndex..., in: s)) != nil
        }

        let skip: Set<String> = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", "target", ".idea", "Pods", "package-lock.json"]
        var nameHits: [[String: Any]] = []
        var contentHits: [[String: Any]] = []
        let nameCap = 60

        if let en = FileManager.default.enumerator(atPath: root) {
            for case let rel as String in en {
                if nameHits.count >= nameCap && contentHits.count >= limit { break }
                let name = (rel as NSString).lastPathComponent
                if name.hasPrefix(".") { continue }
                let comps = rel.split(separator: "/").map(String.init)
                if comps.contains(where: { skip.contains($0) }) { continue }
                let full = (root as NSString).appendingPathComponent(rel)
                var isDir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: full, isDirectory: &isDir), !isDir.boolValue else { continue }

                var display = name
                if display.hasSuffix(vaultEncSuffix) { display = String(display.dropLast(vaultEncSuffix.count)) }

                // 文件名命中：单独收集，最后排在内容命中之前
                if hits(display), nameHits.count < nameCap {
                    nameHits.append(["path": full, "name": display, "line": 0,
                                     "preview": "文件名匹配", "kind": "name",
                                     "encrypted": name.hasSuffix(vaultEncSuffix)])
                }
                if contentHits.count >= limit { continue }
                if namesOnly { continue }
                if Date().timeIntervalSince(started) > budget { break }

                var data: Data?
                if name.hasSuffix(vaultEncSuffix) {
                    if let vr = FS.vaultRoot(for: full), let key = VaultStore.shared.key(for: vr),
                       let raw = try? Data(contentsOf: URL(fileURLWithPath: full)) {
                        data = try? Crypto.open(raw, key: key)
                    }
                } else {
                    let attrs = try? FileManager.default.attributesOfItem(atPath: full)
                    let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
                    if size > 2_000_000 { continue }
                    data = try? Data(contentsOf: URL(fileURLWithPath: full))
                }
                guard let d = data, FS.isProbablyText(d), let text = String(data: d, encoding: .utf8) else { continue }
                var found = 0
                for (i, line) in text.components(separatedBy: .newlines).enumerated() {
                    if found >= 3 || contentHits.count >= limit { break }
                    if hits(line) {
                        var preview = line.trimmingCharacters(in: .whitespaces)
                        if preview.count > 180 { preview = String(preview.prefix(180)) }
                        contentHits.append(["path": full, "name": display, "line": i + 1,
                                            "preview": preview, "kind": "content",
                                            "encrypted": name.hasSuffix(vaultEncSuffix)])
                        found += 1
                    }
                }
            }
        }
        return nameHits + contentHits
    }

    private func makeEncrypted(_ path: String, content: String) throws -> Any {
        let root = FS.vaultRoot(for: path) ?? ""
        guard let key = VaultStore.shared.key(for: root) else { throw err("目录已锁定") }
        let sealed = try Crypto.seal(Data(content.utf8), key: key)
        try sealed.write(to: URL(fileURLWithPath: FS.vaultPath(path)), options: .atomic)
        return NSNull()
    }

    private func err(_ msg: String) -> NSError {
        NSError(domain: "betternotebook", code: 100, userInfo: [NSLocalizedDescriptionKey: msg])
    }

    private func onMain<T>(_ block: () -> T) -> T {
        if Thread.isMainThread { return block() }
        return DispatchQueue.main.sync { block() }
    }

    private func openFolderPanel() -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "打开"
        panel.message = "选择一个文件夹作为工作区"
        return panel.runModal() == .OK ? panel.url?.path : nil
    }

    private func savePanel(name: String) -> String? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url?.path : nil
    }

    private func confirm(title: String, message: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

extension FS {
    static func isDirVault(_ dir: String) -> Bool {
        FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent(vaultMarker))
    }
}

// MARK: - URL scheme handler

/// 网页能通过 betternotebook://file 读到的目录白名单，避免被笔记内容当成任意文件读取通道。
enum AllowedRoots {
    private static var roots: [String] = ["/tmp", NSHomeDirectory() + "/Library/Caches/SuperWorkStation"]
    private static let lock = NSLock()

    static func allow(_ path: String) {
        let p = path.hasSuffix("/") ? String(path.dropLast()) : path
        lock.lock(); defer { lock.unlock() }
        if !roots.contains(p) { roots.append(p) }
    }

    static func guardWrite(_ path: String) throws {
        let p = (path as NSString).standardizingPath
        guard allows(p) else {
            throw NSError(domain: "betternotebook", code: 403,
                          userInfo: [NSLocalizedDescriptionKey: "该位置未授权写入：在「打开」对话框里选择过这个目录后才能修改"])
        }
    }

    static func allows(_ path: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let p = (path as NSString).standardizingPath
        return roots.contains { p == $0 || p.hasPrefix($0 + "/") }
    }
}

// 光标托管：WKWebView 在某些系统版本上不按 CSS 刷新光标，
// 这里接管 cursor rect —— 永远只用 JS 经桥接推下来的形状，
// 不让 AppKit 在指针掠过行间缝隙时把光标复位成箭头（表现为手/箭头抖动）。
final class CursorWebView: WKWebView {
    private var desired: NSCursor = .arrow

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: desired)
    }

    func applyCursor(_ cursor: NSCursor) {
        if cursor !== desired {
            desired = cursor
            window?.invalidateCursorRects(for: self)
        }
        cursor.set()
    }
}

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    var webRoot: URL

    init(webRoot: URL) { self.webRoot = webRoot }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let host = url.host ?? ""
        var fileURL: URL?
        var logicalExt = ""
        if host == "local" {
            var rel = url.path
            if rel == "/" || rel.isEmpty { rel = "/index.html" }
            fileURL = webRoot.appendingPathComponent(String(rel.dropFirst()))
            logicalExt = fileURL?.pathExtension ?? ""
        } else if host == "file" {
            var p = url.path
            guard AllowedRoots.allows(p) else {
                // 白屏最常见的原因就是这里被拒；留一行日志方便定位
                appLog("SCHEME 403 \(p)")
                let resp = HTTPURLResponse(url: url, statusCode: 403, httpVersion: "HTTP/1.1", headerFields: nil)!
                urlSchemeTask.didReceive(resp)
                urlSchemeTask.didFinish()
                return
            }
            // 加密目录里的相对引用（如 style.css）实际落盘为 style.css.bnenc
            if !FileManager.default.fileExists(atPath: p),
               FileManager.default.fileExists(atPath: p + vaultEncSuffix) {
                p += vaultEncSuffix
            }
            fileURL = URL(fileURLWithPath: p)
            logicalExt = (p.hasSuffix(vaultEncSuffix)
                ? String(p.dropLast(vaultEncSuffix.count))
                : p) as NSString as String
            logicalExt = (logicalExt as NSString).pathExtension
        }
        guard let fileURL else {
            let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didFinish()
            return
        }
        var data: Data
        if fileURL.path.hasSuffix(vaultEncSuffix) {
            guard let plain = SchemeHandler.decrypt(fileURL.path) else {
                let resp = HTTPURLResponse(url: url, statusCode: 403, httpVersion: "HTTP/1.1", headerFields: nil)!
                urlSchemeTask.didReceive(resp)
                urlSchemeTask.didFinish()
                return
            }
            data = plain
        } else {
            guard let raw = try? Data(contentsOf: fileURL) else {
                let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
                urlSchemeTask.didReceive(resp)
                urlSchemeTask.didFinish()
                return
            }
            data = raw
        }
        let mime = SchemeHandler.mime(for: logicalExt.isEmpty ? fileURL.pathExtension : logicalExt)
        var status = 200
        var headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Accept-Ranges": "bytes",
            "Cache-Control": host == "local" ? "no-cache" : "max-age=60",
            "Access-Control-Allow-Origin": "*"
        ]
        var body = data

        if let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range"),
           rangeHeader.hasPrefix("bytes=") {
            let spec = rangeHeader.dropFirst("bytes=".count)
            let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
            if parts.count == 2 {
                let start = Int(parts[0]) ?? 0
                let end = parts[1].isEmpty ? data.count - 1 : (Int(parts[1]) ?? (data.count - 1))
                if start >= 0, end >= start, start < data.count {
                    let clampedEnd = min(end, data.count - 1)
                    body = data.subdata(in: start..<(clampedEnd + 1))
                    status = 206
                    headers["Content-Range"] = "bytes \(start)-\(clampedEnd)/\(data.count)"
                    headers["Content-Length"] = String(body.count)
                }
            }
        }

        let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(resp)
        urlSchemeTask.didReceive(body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    /// 预览用：加密文件在内存里解密后返回，未解锁则失败。
    static func decrypt(_ path: String) -> Data? {
        if let root = FS.vaultRoot(for: path), let key = VaultStore.shared.key(for: root) {
            guard let raw = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
            return try? Crypto.open(raw, key: key)
        }
        return try? FileVault.decrypt(path: path)
    }

    static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "ico": return "image/x-icon"
        case "pdf": return "application/pdf"
        case "mp4": return "video/mp4"
        case "webm": return "video/webm"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var bridge = Bridge()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web")
            ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("web")

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(webRoot: webRoot), forURLScheme: "betternotebook")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "betternotebook")
        config.userContentController = ucc

        let rect = NSRect(x: 0, y: 0, width: 1180, height: 780)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "SuperWorkStation"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        // 关掉「拖背景移动窗口」：AppKit 会把窗口背景当拖拽区，鼠标停在树行上时
        // 它把 WebKit 设好的 pointer 光标重置回箭头，表现为手形只闪一下。
        // 窗口拖动已由 JS 侧 ui.beginDrag（标题栏 mousedown）接管，不依赖这个开关。
        window.isMovableByWindowBackground = false
        // 让 AppKit 持续投递 mouseMoved，WebKit 才能稳定刷新光标形状
        window.acceptsMouseMovedEvents = true
        window.minSize = NSSize(width: 640, height: 420)
        window.delegate = self
        window.collectionBehavior = [.fullScreenPrimary]

        NotificationCenter.default.addObserver(
            forName: NSWindow.didEnterFullScreenNotification, object: window, queue: .main
        ) { _ in API.shared.bridge?.emit("ui.fullscreen", ["value": true]) }
        NotificationCenter.default.addObserver(
            forName: NSWindow.didExitFullScreenNotification, object: window, queue: .main
        ) { _ in API.shared.bridge?.emit("ui.fullscreen", ["value": false]) }

        webView = CursorWebView(frame: rect, configuration: config)
        webView.allowsMagnification = false
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        webView.navigationDelegate = self
        window.contentView = webView
        bridge.webView = webView
        bridge.emit("ready", ["": ""])
        API.shared.bridge = bridge

        let base = ProcessInfo.processInfo.environment["BNB_DEV_URL"] ?? "betternotebook://local/index.html"
        if let url = URL(string: base) { webView.load(URLRequest(url: url)) }

        let restored = window.setFrameUsingName("SuperWorkStationMainWindow")
        window.setFrameAutosaveName("SuperWorkStationMainWindow")
        let onScreen = NSScreen.screens.contains { $0.visibleFrame.intersects(window.frame) }
        if !restored || !onScreen { window.center() }
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let iconImage = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = iconImage
        }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        buildMenu()

        // 未捕获的 ObjC 异常会直接 abort，留一份到日志方便事后定位
        NSSetUncaughtExceptionHandler { ex in
            let head = "UNCAUGHT \(ex.name.rawValue): \(ex.reason ?? "-")"
            let stack = ex.callStackSymbols.prefix(24).joined(separator: "\n")
            appLog(head + "\n" + stack)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let scriptPath = devValue("BNB_SCRIPT")
        guard !scriptPath.isEmpty, let code = try? String(contentsOfFile: scriptPath, encoding: .utf8) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            webView.evaluateJavaScript(code) { _, err in
                if let err { NSLog("BNB_SCRIPT error: %@", String(describing: err)) }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 SuperWorkStation", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 SuperWorkStation", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 SuperWorkStation", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "显示")
        // 全屏用系统的 ⌃⌘F，把 ⌘F 留给文档内搜索
        let fs = view.addItem(withTitle: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "窗口")
        win.addItem(withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        let closeItem = win.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        closeItem.keyEquivalentModifierMask = [.command, .shift]
        winItem.submenu = win

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
