import Foundation

// EPUB = zip + container.xml -> OPF (manifest/spine/metadata) + TOC(nav or ncx).
// We unzip into a cache dir once, then hand the web layer absolute file paths so it
// can render chapters with the app's own typography.

enum EPUBService {
    static let cacheRoot: String = {
        let base = Paths.caches + "/epub"
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        return base
    }()

    private static func nodesAll(_ node: XMLNode, _ xpath: String) -> [XMLNode] {
        (try? node.nodes(forXPath: xpath)) ?? []
    }

    private static func err(_ m: String) -> NSError {
        NSError(domain: "betternotebook", code: 400, userInfo: [NSLocalizedDescriptionKey: m])
    }

    private static func extract(_ path: String, to root: String) throws {
        let fm = FileManager.default
        try? fm.removeItem(atPath: root)
        try fm.createDirectory(atPath: root, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", path, root]
        let errPipe = Pipe()
        p.standardError = errPipe
        p.standardOutput = Pipe()
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw err("无法解压 EPUB：\(msg.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    static func info(path: String) throws -> [String: Any] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else { throw err("文件不存在") }
        let attrs = try? fm.attributesOfItem(atPath: path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(abs(path.hashValue))-\(Int(mtime))"
        let root = cacheRoot + "/" + key

        if !fm.fileExists(atPath: root + "/META-INF/container.xml") {
            try extract(path, to: root)
        }

        // container.xml -> OPF path
        let containerURL = URL(fileURLWithPath: root + "/META-INF/container.xml")
        let cdoc = try XMLDocument(contentsOf: containerURL, options: [])
        guard let rf = nodesAll(cdoc, "//*[local-name()='rootfile']").first as? XMLElement,
              let opfRel = rf.attribute(forName: "full-path")?.stringValue, !opfRel.isEmpty else {
            throw err("EPUB 缺少 OPF 清单")
        }
        let opfPath = root + "/" + opfRel
        let opfDir = (opfPath as NSString).deletingLastPathComponent
        let odoc = try XMLDocument(contentsOf: URL(fileURLWithPath: opfPath), options: [])

        func text(_ xpath: String) -> String {
            (nodesAll(odoc, xpath).first as? XMLElement)?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        let title = text("//*[local-name()='metadata']/*[local-name()='title']")
        let author = text("//*[local-name()='metadata']/*[local-name()='creator']")
        let language = text("//*[local-name()='metadata']/*[local-name()='language']")

        // manifest: id -> (href, mediaType, properties)
        struct Item { var href: String; var mediaType: String; var properties: String }
        var manifest: [String: Item] = [:]
        for node in nodesAll(odoc, "//*[local-name()='manifest']/*[local-name()='item']") {
            guard let e = node as? XMLElement,
                  let id = e.attribute(forName: "id")?.stringValue,
                  let href = e.attribute(forName: "href")?.stringValue else { continue }
            manifest[id] = Item(href: href,
                                mediaType: e.attribute(forName: "media-type")?.stringValue ?? "",
                                properties: e.attribute(forName: "properties")?.stringValue ?? "")
        }

        func absPath(_ href: String) -> String {
            let clean = href.removingPercentEncoding ?? href
            if clean.hasPrefix("/") { return root + clean }
            let p = (opfDir as NSString).appendingPathComponent(clean)
            return (p as NSString).standardizingPath
        }

        // spine
        var chapters: [[String: Any]] = []
        let spineNodes = nodesAll(odoc, "//*[local-name()='spine']/*[local-name()='itemref']")
        for node in spineNodes {
            guard let e = node as? XMLElement,
                  let idref = e.attribute(forName: "idref")?.stringValue,
                  let item = manifest[idref] else { continue }
            if item.mediaType.contains("xhtml") || item.mediaType.contains("html") || item.mediaType.isEmpty {
                chapters.append(["href": item.href, "file": absPath(item.href), "label": ""])
            }
        }

        // TOC: EPUB3 nav first, then NCX
        var toc: [[String: Any]] = []
        if let navItem = manifest.values.first(where: { $0.properties.split(separator: " ").contains("nav") }) {
            let navPath = absPath(navItem.href)
            if let ndoc = try? XMLDocument(contentsOf: URL(fileURLWithPath: navPath), options: []) {
                let navNodes = nodesAll(ndoc, "//*[local-name()='nav']") 
                let target = navNodes.first(where: { n in
                    guard let e = n as? XMLElement else { return false }
                    let t = e.attribute(forLocalName: "type", uri: "http://www.idpf.org/2007/ops")?.stringValue
                        ?? e.attribute(forName: "type")?.stringValue ?? ""
                    return t.contains("toc")
                }) ?? navNodes.first
                if let t = target {
                    for a in (nodesAll(t, ".//*[local-name()='a']") ) {
                        guard let e = a as? XMLElement,
                              let href = e.attribute(forName: "href")?.stringValue else { continue }
                        let label = e.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        toc.append(["href": href, "label": label, "file": absPath(href.split(separator: "#").first.map(String.init) ?? href)])
                    }
                }
            }
        }
        if toc.isEmpty, let ncxItem = manifest.values.first(where: { $0.mediaType.contains("dtbncx") || $0.mediaType.contains("ncx") }) {
            if let ndoc = try? XMLDocument(contentsOf: URL(fileURLWithPath: absPath(ncxItem.href)), options: []) {
                func walk(_ nodes: [XMLNode], _ level: Int) {
                    for n in nodes {
                        guard let e = n as? XMLElement else { continue }
                        let label = (nodesAll(e, "./*[local-name()='navLabel']/*[local-name()='text']").first as? XMLElement)?.stringValue ?? ""
                        let src = (nodesAll(e, "./*[local-name()='content']").first as? XMLElement)?.attribute(forName: "src")?.stringValue ?? ""
                        if !src.isEmpty {
                            toc.append(["href": src, "label": label, "file": absPath(src.split(separator: "#").first.map(String.init) ?? src)])
                        }
                        walk(nodesAll(e, "./*[local-name()='navPoint']"), level + 1)
                    }
                }
                walk(nodesAll(ndoc, "//*[local-name()='navMap']/*[local-name()='navPoint']") , 0)
            }
        }

        // cover
        var cover = ""
        if let ci = manifest.values.first(where: { $0.properties.split(separator: " ").contains("cover-image") }) {
            cover = absPath(ci.href)
        } else if let metaCover = nodesAll(odoc, "//*[local-name()='metadata']/*[local-name()='meta'][@name='cover']").first as? XMLElement,
                  let cid = metaCover.attribute(forName: "content")?.stringValue, let item = manifest[cid] {
            cover = absPath(item.href)
        }

        // label chapters from toc
        var labels: [String: String] = [:]
        for t in toc {
            let f = (t["file"] as? String) ?? ""
            if labels[f] == nil, !(t["label"] as? String ?? "").isEmpty { labels[f] = t["label"] as? String }
        }
        for i in 0..<chapters.count {
            let f = chapters[i]["file"] as? String ?? ""
            if let l = labels[f] { chapters[i]["label"] = l } else { chapters[i]["label"] = "第 \(i + 1) 节" }
        }

        return [
            "title": title.isEmpty ? ((path as NSString).lastPathComponent) : title,
            "author": author,
            "language": language,
            "root": root,
            "cover": cover,
            "chapters": chapters,
            "toc": toc
        ]
    }
}
