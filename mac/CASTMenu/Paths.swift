// Where CAST.app finds its bundled programs and where it keeps its files, plus small file helpers.
//
// Data folder: $CAST_DATA_DIR when set (the self-check and tests use it), else ~/Library/Application Support/CAST,
// which is the server's own default on macOS. Logs: ~/Library/Logs/CAST (or <data folder>/logs with CAST_DATA_DIR).
// Nothing here reads out, prints or logs a secret: the pairing token and the session cookie only pass through.
import Foundation

struct Paths {
    /// The user's real home folder, login name and login shell, from the user database: an app started by Finder or
    /// at login gets a minimal environment.
    let home: String
    let user: String
    let shell: String
    let dataDir: URL
    let logsDir: URL
    /// CAST.app/Contents/Resources
    let resources: URL
    /// CAST_DATA_DIR was set: the server must be given the same folder.
    let customDataDir: Bool

    var serverBinary: URL { resources.appendingPathComponent("cast-server") }
    var ompBinary: URL { resources.appendingPathComponent("cast-agent") }
    var webDist: URL { resources.appendingPathComponent("web/dist", isDirectory: true) }
    var tokenFile: URL { dataDir.appendingPathComponent("token") }
    var sessionFile: URL { dataDir.appendingPathComponent("menubar-session") }
    var listenFile: URL { dataDir.appendingPathComponent("listen.json") }
    var instanceFile: URL { dataDir.appendingPathComponent("instance-id") }
    var serverLog: URL { logsDir.appendingPathComponent("server.log") }
    var previousServerLog: URL { logsDir.appendingPathComponent("server.1.log") }
    var appLog: URL { logsDir.appendingPathComponent("menubar.log") }
    /// The helper that swaps in an update once the app has quit (Updater.swift copies it out of the app first).
    var installHelper: URL { resources.appendingPathComponent("cast-install-update.sh") }
    /// One line from that helper ("installed <version>" / "failed <why>"), shown on the app's next start.
    var updateResultFile: URL { logsDir.appendingPathComponent("update-result") }

    static func current() -> Paths {
        var home = NSHomeDirectory()
        var user = NSUserName()
        var shell = "/bin/zsh"
        if let pw = getpwuid(getuid()) {
            home = String(cString: pw.pointee.pw_dir)
            user = String(cString: pw.pointee.pw_name)
            let loginShell = String(cString: pw.pointee.pw_shell)
            if loginShell.hasPrefix("/") { shell = loginShell }
        }
        let homeURL = URL(fileURLWithPath: home, isDirectory: true)
        let custom = (ProcessInfo.processInfo.environment["CAST_DATA_DIR"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let dataDir: URL
        let logsDir: URL
        if custom.isEmpty {
            dataDir = homeURL.appendingPathComponent("Library/Application Support/CAST", isDirectory: true)
            logsDir = homeURL.appendingPathComponent("Library/Logs/CAST", isDirectory: true)
        } else {
            var expanded = custom
            if custom == "~" {
                expanded = home
            } else if custom.hasPrefix("~/") {
                expanded = home + String(custom.dropFirst(1))
            }
            dataDir = URL(fileURLWithPath: expanded, isDirectory: true).standardizedFileURL
            logsDir = dataDir.appendingPathComponent("logs", isDirectory: true)
        }
        let resources = Bundle.main.resourceURL
            ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        return Paths(home: home, user: user, shell: shell, dataDir: dataDir, logsDir: logsDir,
                     resources: resources, customDataDir: !custom.isEmpty)
    }

    /// One line in menubar.log: events only, never tokens, cookies or sign-in links. Started afresh above 1 MB.
    func log(_ message: String) {
        let fm = FileManager.default
        try? fm.createDirectory(at: logsDir, withIntermediateDirectories: true)
        if let size = (try? fm.attributesOfItem(atPath: appLog.path))?[.size] as? NSNumber, size.intValue > 1_000_000 {
            try? fm.removeItem(at: appLog)
        }
        let line = Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: appLog) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: line)
            try? handle.close()
        } else {
            try? line.write(to: appLog)
        }
    }
}

/// The trimmed text of a small file, or nil when it is missing or empty.
func readTrimmed(_ url: URL) -> String? {
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

/// Writes a file only this user can read (0600) without it ever existing with wider permissions: a new file
/// created 0600 next to it, then renamed over it.
func writePrivateFile(_ url: URL, _ text: String) throws {
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
    unlink(tmp.path)
    let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard fd >= 0 else { throw CocoaError(.fileWriteNoPermission) }
    let bytes = Array(text.utf8)
    let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    close(fd)
    guard written == bytes.count, rename(tmp.path, url.path) == 0 else {
        unlink(tmp.path)
        throw CocoaError(.fileWriteUnknown)
    }
}

/// Whether 127.0.0.1:<port> can be bound right now, the way the server binds it (SO_REUSEADDR, so a port that only
/// has connections closing in TIME_WAIT counts as free).
func canBindLoopback(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr = in_addr(s_addr: in_addr_t(0x7f00_0001).bigEndian)
    let result = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return result == 0
}

/// Shortens a line for the menu.
func clip(_ text: String, _ max: Int) -> String {
    text.count <= max ? text : String(text.prefix(max - 1)) + "…"
}
