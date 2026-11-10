import Foundation
import CryptoKit

// Single-file encryption: the key material lives inside the encrypted file itself,
// so a loose file can be locked without turning its whole folder into a vault.
//
// Layout: magic(5) | iterations(4, BE) | salt(16) | verifier(42) | payload(nonce12+ct+tag16)

final class FileVaultKeys {
    static let shared = FileVaultKeys()
    private var keys: [String: SymmetricKey] = [:]
    private let lock = NSLock()

    func key(for path: String) -> SymmetricKey? {
        lock.lock(); defer { lock.unlock() }
        return keys[path]
    }
    func set(_ k: SymmetricKey?, for path: String) {
        lock.lock(); defer { lock.unlock() }
        if let k { keys[path] = k } else { keys.removeValue(forKey: path) }
    }
}

enum FileVault {
    static let magic = Data("BNBF1".utf8)
    static let verifierPlain = Data("bnbook-file-v1".utf8)
    static let iterations: UInt32 = 210_000
    static let headerFixed = 5 + 4 + 16

    private static func err(_ m: String) -> NSError {
        NSError(domain: "betternotebook", code: 200, userInfo: [NSLocalizedDescriptionKey: m])
    }

    private static func sealBox(_ plain: Data, key: SymmetricKey) throws -> Data {
        let nonce = AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(plain, using: key, nonce: nonce)
        var out = Data(sealed.nonce.withUnsafeBytes { Data($0) })
        out.append(sealed.ciphertext)
        out.append(sealed.tag)
        return out
    }

    private static func openBox(_ blob: Data, key: SymmetricKey) throws -> Data {
        guard blob.count >= 28 else { throw err("加密数据已损坏") }
        let nonceData = blob.subdata(in: 0..<12)
        let body = blob.subdata(in: 12..<blob.count)
        let ct = body.subdata(in: 0..<(body.count - 16))
        let tag = body.subdata(in: (body.count - 16)..<body.count)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonceData), ciphertext: ct, tag: tag)
        return try AES.GCM.open(box, using: key)
    }

    static func isFileVault(_ path: String) -> Bool {
        guard let h = FileHandle(forReadingAtPath: path) else { return false }
        defer { h.closeFile() }
        let head = h.readData(ofLength: 5)
        return head == magic
    }

    static func encrypt(path: String, password: String) throws -> String {
        guard !path.hasSuffix(vaultEncSuffix) else { throw err("该文件已加密") }
        guard password.count >= 4 else { throw err("密码至少 4 位") }

        let plain = try Data(contentsOf: URL(fileURLWithPath: path))
        let salt = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let key = Crypto.deriveKey(password: password, salt: salt, iterations: Int(iterations))

        var blob = magic
        var iter = iterations.bigEndian
        withUnsafeBytes(of: &iter) { blob.append(contentsOf: $0) }
        blob.append(salt)
        blob.append(try sealBox(verifierPlain, key: key))
        blob.append(try sealBox(plain, key: key))

        let out = path + vaultEncSuffix
        try blob.write(to: URL(fileURLWithPath: out), options: .atomic)
        try FileManager.default.removeItem(atPath: path)
        FileVaultKeys.shared.set(key, for: out)
        return out
    }

    static func unlock(path: String, password: String) throws {
        let blob = try Data(contentsOf: URL(fileURLWithPath: path))
        guard blob.count > headerFixed + 42, blob.prefix(5) == magic else { throw err("不是有效的加密文件") }
        let iter = blob.subdata(in: 5..<9).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
        let salt = blob.subdata(in: 9..<25)
        let key = Crypto.deriveKey(password: password, salt: salt, iterations: Int(iter))
        let verifier = blob.subdata(in: 25..<(25 + 42))
        let plain: Data
        do { plain = try openBox(verifier, key: key) } catch { throw err("密码错误") }
        guard plain == verifierPlain else { throw err("密码错误") }
        FileVaultKeys.shared.set(key, for: path)
    }

    /// Re-seal new content while keeping the original salt / iterations header.
    static func sealForWrite(path: String, text: String) throws -> Data {
        guard let key = FileVaultKeys.shared.key(for: path) else { throw err("该文件已加密，请先解锁") }
        let blob = try Data(contentsOf: URL(fileURLWithPath: path))
        guard blob.count > headerFixed + 42 else { throw err("加密数据已损坏") }
        var out = blob.subdata(in: 0..<(headerFixed + 42))
        out.append(try sealBox(Data(text.utf8), key: key))
        return out
    }

    static func decrypt(path: String) throws -> Data {
        guard let key = FileVaultKeys.shared.key(for: path) else { throw err("该文件已加密，请先解锁") }
        let blob = try Data(contentsOf: URL(fileURLWithPath: path))
        guard blob.count > headerFixed + 42 else { throw err("加密数据已损坏") }
        let payload = blob.subdata(in: (headerFixed + 42)..<blob.count)
        return try openBox(payload, key: key)
    }
}


/// 加密文件对系统工具（Quick Look、PDFKit）不可见，
/// 这里按需解密出一份临时明文副本给它们用。
enum VaultIO {
    static let dir: String = {
        let d = NSTemporaryDirectory() + "betternotebook/plain"
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }()

    static func materialize(_ path: String) -> String? {
        guard path.hasSuffix(vaultEncSuffix) else { return path }
        guard let data = SchemeHandler.decrypt(path) else { return nil }
        let base = String(path.dropLast(vaultEncSuffix.count))
        var ext = (base as NSString).pathExtension.lowercased()
        if ext.isEmpty { ext = "bin" }
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let out = dir + "/" + stableHash(path) + "-" + String(Int(mtime)) + "." + ext
        if !FileManager.default.fileExists(atPath: out) {
            try? data.write(to: URL(fileURLWithPath: out))
        }
        return out
    }
}
