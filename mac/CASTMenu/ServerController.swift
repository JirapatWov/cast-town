// Finds, starts, watches and stops the CAST server (CAST.app/Contents/Resources/cast-server).
//
// Which server the app uses, in order:
//   1. The one <dataDir>/listen.json names, if it answers /api/version as CAST with this data folder's instance id
//      (a server this app started before it was force-quit is "adopted": Quit and Restart stop it again).
//   2. Ports 4860…4879: a CAST there that uses this data folder is attached to (never stopped by Quit); a port
//      that is busy with anything else is skipped; the first free one gets a server of our own.
// A server of our own runs with the environment of the app/server contract, its output in server.log (the previous
// run kept as server.1.log). If it crashes it is started again after 1 s, 5 s and 30 s; a fourth quick failure in a
// row leaves it stopped ("CAST stopped — Show logs / Restart"). Exit code 75 is the server asking to be started again
// ("Delete all CAST data" under this app: server/startup.ts RESTART_EXIT_CODE): that is done at once and is no
// failure. A server that exits cleanly by itself (exit code 0: an older server hands over to a fresh copy of itself)
// has that copy adopted. Stopping is SIGTERM, up to 10 s for a clean exit (the server stops its agent processes and
// shells), then SIGKILL.
import Foundation

@MainActor
final class ServerController {
    enum Phase: Equatable {
        case idle
        case starting
        case running
        case stopping
        /// Gave up after repeated quick failures.
        case crashed
        /// Could not start at all; the words are for the menu.
        case failed(String)
    }

    private enum Owner {
        case nobody
        case process(Process)
        case adopted(pid_t)
    }

    static let firstPort = 4860
    static let lastPort = 4879
    static let restartDelays: [UInt64] = [1, 5, 30]
    /// A run shorter than this counts as a quick failure.
    static let quickFailureSeconds: TimeInterval = 120
    static let startTimeoutSeconds: TimeInterval = 90
    /// The server's "start me again" exit code (EX_TEMPFAIL; server/startup.ts RESTART_EXIT_CODE).
    static let restartExitCode: Int32 = 75

    let paths: Paths
    let client: CastClient
    /// Menu-bar app (true): restarts after crashes and remembers the server's pid. The self-check (false) does neither.
    let appMode: Bool
    var onChange: (() -> Void)?

    private(set) var phase: Phase = .idle {
        didSet { if phase != oldValue { onChange?() } }
    }
    private(set) var port: Int?
    /// When the server in use became reachable: the status poll runs faster for 30 s after it.
    private(set) var readySince: Date?
    private var owner: Owner = .nobody
    private var launchedAt = Date()
    private var quickFailures = 0
    /// Bumped by every start and stop, so a start that was overtaken gives up quietly.
    private var generation = 0
    /// A restart waiting for its delay. It clears itself before it calls start(): start() cancels whatever is
    /// pending, and a start that runs in a cancelled task would see every request and sleep fail at once.
    private var pendingRestart: Task<Void, Never>?
    private var loginShellPath: String?
    /// The app is quitting: nothing starts or restarts any more.
    private var quitting = false

    init(paths: Paths, client: CastClient, appMode: Bool) {
        self.paths = paths
        self.client = client
        self.appMode = appMode
    }

    /// This app started the server in use (or adopted one it had started), so Quit and Restart stop it.
    var ownsServer: Bool {
        if case .nobody = owner { return false }
        return true
    }

    /// Restart makes sense unless the server in use was started by someone else and is running fine.
    var canRestart: Bool {
        phase != .stopping && (ownsServer || phase != .running)
    }

    var address: String? { port.map { "http://127.0.0.1:\($0)" } }

    // MARK: Starting

    /// Finds this data folder's server or starts one, and returns once it answers or has failed.
    func start(rotateLog: Bool = true) async {
        pendingRestart?.cancel()
        pendingRestart = nil
        guard !quitting else { return }
        if case .process(let proc) = owner, proc.isRunning { return }
        generation += 1
        let gen = generation
        owner = .nobody
        port = nil
        readySince = nil
        client.port = nil
        phase = .starting

        if let found = await serverFromListenFile(), gen == generation {
            if let pid = found.pid, pid == lastLaunchedPid, isAlive(pid) { owner = .adopted(pid) }
            becameReady(port: found.port)
            return
        }
        for candidate in Self.firstPort...Self.lastPort {
            guard gen == generation else { return }
            switch await client.probe(port: candidate) {
            case .cast(let info):
                guard gen == generation else { return }
                if usesOurData(info) {
                    becameReady(port: candidate)
                    return
                }
                paths.log("port \(candidate): a CAST with another data folder; trying the next port")
            case .busy:
                paths.log("port \(candidate) is in use; trying the next port")
            case .free:
                guard gen == generation else { return }
                await launch(port: candidate, rotateLog: rotateLog, gen: gen)
                return
            }
        }
        guard gen == generation else { return }
        phase = .failed("ports \(Self.firstPort)–\(Self.lastPort) are all in use")
    }

    /// The server listen.json names, when it is up and uses this data folder.
    private func serverFromListenFile() async -> (port: Int, pid: pid_t?)? {
        guard let data = try? Data(contentsOf: paths.listenFile),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let text = obj["url"] as? String, let url = URL(string: text), let found = url.port,
              (1...65535).contains(found),
              let info = await client.version(port: found), usesOurData(info) else { return nil }
        let pid = (obj["pid"] as? Int).flatMap { pid_t(exactly: $0) }
        return (port: found, pid: pid)
    }

    /// A CAST uses this app's data folder when its instance id is the one in <dataDir>/instance-id. A CAST from
    /// before instance ids is given the benefit of the doubt (pairing tells).
    private func usesOurData(_ info: VersionInfo) -> Bool {
        guard let theirs = info.instanceId else { return true }
        guard let ours = readTrimmed(paths.instanceFile) else { return false }
        return theirs == ours
    }

    private func launch(port newPort: Int, rotateLog: Bool, gen: Int) async {
        guard FileManager.default.isExecutableFile(atPath: paths.serverBinary.path) else {
            phase = .failed("cast-server is missing from the app")
            return
        }
        let env = await environment(port: newPort)
        guard gen == generation else { return }
        let log: FileHandle
        do {
            log = try openServerLog(rotate: rotateLog)
        } catch {
            phase = .failed("can't write to \(paths.logsDir.path)")
            return
        }
        let proc = Process()
        proc.executableURL = paths.serverBinary
        proc.arguments = []
        proc.environment = env
        proc.currentDirectoryURL = URL(fileURLWithPath: paths.home, isDirectory: true)
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = log
        proc.standardError = log
        proc.terminationHandler = { @Sendable ended in
            let pid = ended.processIdentifier
            let status = ended.terminationStatus
            let signaled = ended.terminationReason == .uncaughtSignal
            Task { @MainActor in self.exited(pid: pid, status: status, signaled: signaled) }
        }
        do {
            try proc.run()
        } catch {
            try? log.close()
            phase = .failed("cast-server could not be started (\(error.localizedDescription))")
            return
        }
        try? log.close() // the server has its own copy
        owner = .process(proc)
        port = newPort
        launchedAt = Date()
        if appMode { lastLaunchedPid = proc.processIdentifier }
        paths.log("started cast-server (pid \(proc.processIdentifier)) on port \(newPort)")

        // The first start creates the data folder; allow it time.
        let deadline = Date().addingTimeInterval(Self.startTimeoutSeconds)
        while Date() < deadline {
            guard gen == generation, case .process(let current) = owner, current === proc else { return }
            // Our server answers with this data folder's instance id (it writes instance-id before it listens). Another
            // CAST that took the port first would answer too, while ours fails to bind and exits.
            if let info = await client.version(port: newPort), usesOurData(info) {
                guard gen == generation, case .process(let still) = owner, still === proc else { return }
                becameReady(port: newPort)
                return
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        guard gen == generation else { return }
        paths.log("cast-server did not answer within \(Int(Self.startTimeoutSeconds)) s; stopping it")
        await stop()
        phase = .failed("CAST did not answer within \(Int(Self.startTimeoutSeconds)) seconds")
    }

    private func becameReady(port readyPort: Int) {
        port = readyPort
        client.port = readyPort
        readySince = Date()
        phase = .running
        let how: String
        switch owner {
        case .process: how = "started by this app"
        case .adopted: how = "started earlier by this app"
        case .nobody: how = "already running"
        }
        paths.log("CAST is running on port \(readyPort) (\(how))")
    }

    /// The environment of the app/server contract. Nothing else from the app's own environment is passed on, except
    /// CAST_DATA_DIR / CAST_WORKSPACE (set only for the self-check and tests) and macOS's per-user TMPDIR.
    private func environment(port newPort: Int) async -> [String: String] {
        if loginShellPath == nil {
            let shell = paths.shell
            loginShellPath = await Task.detached { LoginShell.path(shell: shell) }.value ?? ""
        }
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        for dir in (loginShellPath ?? "").split(separator: ":").map(String.init) where !dir.isEmpty && !dirs.contains(dir) {
            dirs.append(dir)
        }
        let own = ProcessInfo.processInfo.environment
        let lang = own["LANG"].flatMap { $0.isEmpty ? nil : $0 } ?? "en_US.UTF-8"
        var env: [String: String] = [
            "PATH": dirs.joined(separator: ":"),
            "HOME": paths.home,
            "USER": paths.user,
            "SHELL": paths.shell,
            "LANG": lang,
            "CAST_WEB_DIST": paths.webDist.path,
            "CAST_AGENT_BIN": paths.ompBinary.path,
            "CAST_PORT": String(newPort),
            "CAST_LAUNCHED_BY": "mac-app",
        ]
        if paths.customDataDir { env["CAST_DATA_DIR"] = paths.dataDir.path }
        for key in ["CAST_WORKSPACE", "TMPDIR"] {
            if let value = own[key], !value.isEmpty { env[key] = value }
        }
        return env
    }

    /// server.log for a new run. A fresh start keeps the previous run as server.1.log; a restart after a crash
    /// appends, so the crash stays readable.
    private func openServerLog(rotate: Bool) throws -> FileHandle {
        let fm = FileManager.default
        try fm.createDirectory(at: paths.logsDir, withIntermediateDirectories: true)
        let log = paths.serverLog
        if rotate, fm.fileExists(atPath: log.path) {
            try? fm.removeItem(at: paths.previousServerLog)
            try? fm.moveItem(at: log, to: paths.previousServerLog)
        }
        if !fm.fileExists(atPath: log.path) {
            _ = fm.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let handle = try FileHandle(forWritingTo: log)
        _ = try handle.seekToEnd()
        let stamp = ISO8601DateFormatter().string(from: Date())
        let note = rotate ? "" : " (restarted after it stopped unexpectedly)"
        try handle.write(contentsOf: Data("--- CAST started by the menu-bar app, \(stamp)\(note) ---\n".utf8))
        return handle
    }

    // MARK: Exits and restarts

    private func exited(pid: pid_t, status: Int32, signaled: Bool) {
        guard case .process(let proc) = owner, proc.processIdentifier == pid else { return }
        proc.terminationHandler = nil
        owner = .nobody
        let how = signaled ? "signal \(status)" : "exit code \(status)"
        if phase == .stopping || quitting {
            paths.log("cast-server stopped (\(how))")
            return
        }
        readySince = nil
        client.port = nil
        let ranFor = Date().timeIntervalSince(launchedAt)
        if appMode, !signaled, status == Self.restartExitCode, ranFor > 10 {
            // The server asks to be started again ("Delete all CAST data": it has emptied the data folder and exited
            // instead of starting a copy of itself). Start it now; this is no crash. (Asking within 10 s of its start,
            // over and over, would be a loop: that counts as a failure below.)
            paths.log("cast-server asked to be started again (exit code \(status)); starting it")
            phase = .starting
            generation += 1
            let gen = generation
            pendingRestart = Task {
                guard !Task.isCancelled, gen == self.generation else { return }
                self.pendingRestart = nil // (see pendingRestart: start() must not cancel the task it runs in)
                await self.start(rotateLog: false)
            }
            return
        }
        if appMode, !signaled, status == 0 {
            // A clean exit nobody asked for: stopped from outside the app (a SIGTERM of someone else's), or an older
            // server that hands over to a fresh copy of itself. Give such a copy a few seconds to appear (and treat it
            // as ours) before starting another one.
            paths.log("cast-server exited by itself; looking for a copy it may have started")
            phase = .starting
            generation += 1
            let gen = generation
            pendingRestart = Task {
                let deadline = Date().addingTimeInterval(10)
                while Date() < deadline {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    guard !Task.isCancelled, gen == self.generation else { return }
                    if let found = await self.serverFromListenFile(), let successor = found.pid, successor != pid,
                       self.isAlive(successor), gen == self.generation {
                        self.pendingRestart = nil
                        self.owner = .adopted(successor)
                        self.lastLaunchedPid = successor
                        self.becameReady(port: found.port)
                        return
                    }
                }
                guard !Task.isCancelled, gen == self.generation else { return }
                self.pendingRestart = nil
                await self.start(rotateLog: false)
            }
            return
        }
        paths.log("cast-server stopped unexpectedly (\(how))")
        guard appMode else {
            phase = .failed("the server stopped unexpectedly (\(how))")
            return
        }
        if ranFor > Self.quickFailureSeconds { quickFailures = 0 }
        quickFailures += 1
        guard quickFailures <= Self.restartDelays.count else {
            paths.log("cast-server failed \(quickFailures) times in a row; not restarting it")
            phase = .crashed
            return
        }
        let delay = Self.restartDelays[quickFailures - 1]
        phase = .starting
        generation += 1
        let gen = generation
        pendingRestart = Task {
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            guard !Task.isCancelled, gen == self.generation else { return }
            self.pendingRestart = nil // (see pendingRestart: start() must not cancel the task it runs in)
            await self.start(rotateLog: false)
        }
    }

    /// The status poll could not connect several times in a row. A server of someone else's that went away is
    /// replaced (by ours, or by another one that took its place); our own process reports its exit by itself.
    func lostConnection() async {
        guard phase == .running else { return }
        switch owner {
        case .process:
            return
        case .adopted(let pid):
            if isAlive(pid) { return }
            owner = .nobody
        case .nobody:
            break
        }
        paths.log("lost CAST on port \(port ?? 0); looking for it again")
        await start(rotateLog: true)
    }

    /// Restart CAST: stop ours (if any) and start again with a fresh log and a clean failure count.
    func restart() async {
        guard phase != .stopping, !quitting else { return }
        await stop()
        quickFailures = 0
        await start(rotateLog: true)
    }

    // MARK: Stopping

    /// Quit: stop our server (as stop() does) and never start one again, even if a Restart or a crash restart is
    /// still under way.
    @discardableResult
    func stopForQuit() async -> Bool {
        quitting = true
        return await stop()
    }

    /// SIGTERM, up to 10 s for a clean exit, then SIGKILL. A server this app did not start is left alone.
    /// Returns false when the server had to be killed.
    @discardableResult
    func stop() async -> Bool {
        pendingRestart?.cancel()
        pendingRestart = nil
        generation += 1
        let pid: pid_t
        let alive: () -> Bool
        switch owner {
        case .nobody:
            port = nil
            readySince = nil
            client.port = nil
            phase = .idle
            return true
        case .process(let proc):
            pid = proc.processIdentifier
            alive = { proc.isRunning }
        case .adopted(let adopted):
            pid = adopted
            alive = { kill(adopted, 0) == 0 }
        }
        var clean = true
        if alive() {
            phase = .stopping
            kill(pid, SIGTERM)
            clean = await waitUntil(seconds: 10) { !alive() }
            if !clean {
                paths.log("cast-server (pid \(pid)) did not stop within 10 s of SIGTERM; killing it")
                kill(pid, SIGKILL)
                _ = await waitUntil(seconds: 3) { !alive() }
            }
        }
        if case .process(let proc) = owner { proc.terminationHandler = nil }
        owner = .nobody
        port = nil
        readySince = nil
        client.port = nil
        phase = .idle
        return clean
    }

    private func waitUntil(seconds: TimeInterval, _ done: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if done() { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return done()
    }

    private func isAlive(_ pid: pid_t) -> Bool { pid > 0 && kill(pid, 0) == 0 }

    /// The pid of the last server this app started, to recognise it after the app was force-quit.
    private var lastLaunchedPid: pid_t {
        get { pid_t(truncatingIfNeeded: UserDefaults.standard.integer(forKey: "lastServerPid")) }
        set { UserDefaults.standard.set(Int(newValue), forKey: "lastServerPid") }
    }
}

/// The PATH the user's login shell sets up (Homebrew, nvm, …) if it can be read within 2 seconds.
enum LoginShell {
    static func path(shell: String) -> String? {
        let name = (shell as NSString).lastPathComponent
        guard ["zsh", "bash", "sh", "fish"].contains(name), FileManager.default.isExecutableFile(atPath: shell) else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: shell)
        proc.arguments = ["-l", "-c", "printf '\\n__CAST_PATH__%s__END__\\n' \"$PATH\""]
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        proc.terminationHandler = { @Sendable _ in done.signal() }
        do { try proc.run() } catch { return nil }
        guard done.wait(timeout: .now() + 2) == .success else {
            proc.terminate()
            return nil
        }
        guard proc.terminationStatus == 0 else { return nil }
        let text = String(decoding: out.fileHandleForReading.availableData, as: UTF8.self)
        guard let start = text.range(of: "__CAST_PATH__"),
              let end = text.range(of: "__END__", range: start.upperBound..<text.endIndex) else { return nil }
        return String(text[start.upperBound..<end.lowerBound])
    }
}
