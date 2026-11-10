import Foundation
import PDFKit

// 给 AI 用的纯文本抽取：PDF 走 PDFKit，EPUB 走已解包的章节，其余按文本读。

enum TextExtract {
    static func text(path: String, limit: Int = 240_000) -> [String: Any] {
        var filePath = path
        if path.hasSuffix(vaultEncSuffix), let real = VaultIO.materialize(path) { filePath = real }
        let ext = (filePath as NSString).pathExtension.lowercased()
        var out = ""
        switch ext {
        case "pdf":
            out = pdfText(filePath)
        case "epub":
            out = epubText(filePath)
        case "html", "htm", "xhtml":
            out = stripTags((try? String(contentsOfFile: filePath, encoding: .utf8)) ?? "")
        default:
            if let d = FileManager.default.contents(atPath: filePath), FS.isProbablyText(d) {
                out = String(data: d, encoding: .utf8) ?? ""
            }
        }
        let truncated = out.count > limit
        if truncated { out = String(out.prefix(limit)) }
        return ["text": out, "truncated": truncated, "chars": out.count]
    }

    private static func pdfText(_ path: String) -> String {
        guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { return "" }
        var parts: [String] = []
        for i in 0..<min(doc.pageCount, 400) {
            if let s = doc.page(at: i)?.string, !s.isEmpty { parts.append(s) }
        }
        return parts.joined(separator: "\n\n")
    }

    private static func epubText(_ path: String) -> String {
        guard let info = try? EPUBService.info(path: path),
              let chapters = info["chapters"] as? [[String: Any]] else { return "" }
        var parts: [String] = []
        for ch in chapters.prefix(40) {
            guard let file = ch["file"] as? String,
                  let raw = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            let t = stripTags(raw)
            if !t.isEmpty { parts.append(t) }
            if parts.joined().count > 200_000 { break }
        }
        return parts.joined(separator: "\n\n")
    }

    private static func stripTags(_ html: String) -> String {
        var s = html
        s = s.replacingOccurrences(of: "(?is)<(script|style)[^>]*>.*?</\\1>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?is)<(br|/p|/div|/h[1-6]|/li)[^>]*>", with: "\n", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?is)<[^>]+>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "&nbsp;", with: " ")
        s = s.replacingOccurrences(of: "&amp;", with: "&")
        s = s.replacingOccurrences(of: "&lt;", with: "<")
        s = s.replacingOccurrences(of: "&gt;", with: ">")
        s = s.replacingOccurrences(of: "&quot;", with: "\"")
        s = s.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
