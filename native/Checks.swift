import Foundation

// Lightweight syntax checking that shells out to tools already on the system.
// No bundled parsers => no app bloat; cost is one short-lived process per check.

enum Checker {
    struct Issue {
        var line: Int
        var message: String
        var severity: String = "error"
    }

    static func check(path: String, text: String) -> [[String: Any]] {
        let ext = (path as NSString).pathExtension.lowercased()
        let tmpDir = NSTemporaryDirectory() + "betternotebook/check"
        try? FileManager.default.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
        let tmp = tmpDir + "/check-\(abs(path.hashValue))-\(UInt32.random(in: 0...UInt32.max)).\(ext.isEmpty ? "txt" : ext)"

        defer { try? FileManager.default.removeItem(atPath: tmp) }
        do { try text.write(toFile: tmp, atomically: true, encoding: .utf8) } catch { return [] }

        var issues: [Issue] = []
        switch ext {
        case "sh", "bash", "zsh":
            issues = run("/bin/bash", ["-n", tmp]).flatMap { parseBash($0.combined) } ?? []
        case "py":
            let script = "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read(),sys.argv[1])"
            issues = run("/usr/bin/env", ["python3", "-c", script, tmp]).flatMap { parsePython($0.combined) } ?? []
        case "js", "mjs", "cjs":
            issues = run("/usr/bin/env", ["node", "--check", tmp]).flatMap { parseNode($0.combined) } ?? []
        default:
            break
        }
        return issues.map { ["line": $0.line, "message": $0.message, "severity": $0.severity] }
    }

    private struct Result { let code: Int32; let out: String; let err: String
        var combined: String { err.isEmpty ? out : err } }

    private static func run(_ tool: String, _ args: [String]) -> Result? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let outPipe = Pipe(), errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        do { try p.run() } catch { return nil }

        let deadline = Date().addingTimeInterval(4)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate() }

        let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return Result(code: p.terminationStatus, out: out, err: err)
    }

    private static func firstMatch(_ pattern: String, _ text: String, group: Int = 1) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > group else { return nil }
        let r = m.range(at: group)
        return r.location == NSNotFound ? nil : ns.substring(with: r)
    }

    // bash: "check.sh: line 3: syntax error near unexpected token `fi'"
    private static func parseBash(_ out: String) -> [Issue]? {
        guard let lineStr = firstMatch(#"line (\d+):"#, out) ?? firstMatch(#": line (\d+)"#, out),
              let line = Int(lineStr) else { return nil }
        let msg = firstMatch(#"line \d+:\s*(.+)"#, out) ?? out.split(separator: "\n").last.map(String.init) ?? "语法错误"
        return [Issue(line: line, message: msg.trimmingCharacters(in: .whitespaces))]
    }

    // python: 'File "/tmp/x.py", line 3' + 'SyntaxError: invalid syntax'
    private static func parsePython(_ out: String) -> [Issue]? {
        guard let lineStr = firstMatch(#"line (\d+)"#, out), let line = Int(lineStr) else { return nil }
        let msg = firstMatch(#"(SyntaxError|IndentationError|TabError)[:\s]*(.*)"#, out, group: 2) ?? "语法错误"
        return [Issue(line: line, message: msg.trimmingCharacters(in: .whitespaces))]
    }

    // node --check: "check.js:3" then source line then caret then message
    private static func parseNode(_ out: String) -> [Issue]? {
        guard let lineStr = firstMatch(#":(\d+)\s*$"#, out, group: 1) ?? firstMatch(#"\.js:(\d+)"#, out),
              let line = Int(lineStr) else { return nil }
        var msg = "语法错误"
        if let e = firstMatch(#"(SyntaxError|ReferenceError)[:\s]*(.*)"#, out, group: 2), !e.isEmpty {
            msg = e
        } else if let u = firstMatch(#"(Unexpected[^\n]*|Invalid[^\n]*|missing[^\n]*)"#, out) {
            msg = u
        }
        return [Issue(line: line, message: msg.trimmingCharacters(in: .whitespaces))]
    }
}
