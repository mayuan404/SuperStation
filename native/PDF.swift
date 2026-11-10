import AppKit
import PDFKit

// PDF rendering: page metadata + rasterisation to cached PNGs so the web layer
// can implement its own zoom / pan instead of relying on the system PDF plugin.

enum PDFService {
    static let cacheDir: String = {
        let d = NSTemporaryDirectory() + "betternotebook/pdf"
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }()

    static func info(path: String) -> [String: Any]? {
        guard let real = VaultIO.materialize(path),
              let doc = PDFDocument(url: URL(fileURLWithPath: real)) else { return nil }
        var pages: [[String: Any]] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let b = page.bounds(for: .mediaBox)
            pages.append(["width": Double(b.width), "height": Double(b.height)])
        }
        return ["count": doc.pageCount, "pages": pages]
    }

    static func render(path: String, page: Int, width: Double) -> [String: Any]? {
        guard let real = VaultIO.materialize(path),
              let doc = PDFDocument(url: URL(fileURLWithPath: real)),
              page >= 0, page < doc.pageCount,
              let p = doc.page(at: page) else { return nil }

        let bounds = p.bounds(for: .mediaBox)
        let w = max(80, min(3000, width))
        let scale = w / Double(bounds.width)
        let h = Double(bounds.height) * scale
        let size = NSSize(width: w, height: h)

        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(abs(path.hashValue))-\(Int(mtime))-\(page)-\(Int(w))"
        let out = cacheDir + "/\(key).png"

        if !FileManager.default.fileExists(atPath: out) {
            let image = p.thumbnail(of: size, for: .mediaBox)
            guard let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return nil }
            try? png.write(to: URL(fileURLWithPath: out))
        }
        return ["file": out, "width": w, "height": h]
    }
}
