// `CAST.app/Contents/MacOS/CAST --check`: proves an assembled app works before build-dmg.sh makes the dmg.
// It starts the bundled server (or attaches to this data folder's running one), waits for /api/version, pairs,
// reads /api/status, asks for a one-time sign-in link (and does not open it), stops the server it started, and
// prints one PASS or FAIL line per step. Exit status 0 when every step passed. It never prints the pairing token,
// the session cookie or the sign-in link. build-dmg.sh runs it with CAST_DATA_DIR and CAST_WORKSPACE pointing at a
// throwaway folder, so the user's own CAST data is not touched.
import Foundation

@MainActor
final class SelfCheck {
    private let paths = Paths.current()
    private var passed = 0
    private var failed = 0

    func run() async -> Bool {
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        say("CAST self-check (app \(appVersion))")
        say("Data folder: \(paths.dataDir.path)")
        let fm = FileManager.default
        check(fm.isExecutableFile(atPath: paths.serverBinary.path), "the app contains cast-server",
              "cast-server is missing or not executable in \(paths.resources.path)")
        check(fm.isExecutableFile(atPath: paths.ompBinary.path), "the app contains cast-agent",
              "cast-agent is missing or not executable in \(paths.resources.path)")
        check(fm.fileExists(atPath: paths.webDist.appendingPathComponent("index.html").path), "the app contains the web app",
              "web/dist/index.html is missing in \(paths.resources.path)")
        guard failed == 0 else { return await finish(nil) }

        let client = CastClient(paths: paths)
        let server = ServerController(paths: paths, client: client, appMode: false)
        await server.start()
        guard server.phase == .running, let port = server.port else {
            var why = "it did not start"
            if case .failed(let reason) = server.phase { why = reason }
            check(false, "", "the server did not start: \(why)")
            return await finish(server)
        }
        check(true, server.ownsServer ? "started the bundled server on port \(port)"
                                      : "found this data folder's CAST already running on port \(port)", "")

        if let info = await client.version(port: port) {
            check(true, "GET /api/version answers as CAST \(info.version)", "")
            check(info.features.contains("mac-app-v1"), "the server supports the menu-bar app (mac-app-v1)",
                  "the server does not list the mac-app-v1 feature: it is older than this app")
        } else {
            check(false, "", "GET /api/version did not answer")
        }

        do {
            try await client.signIn()
            check(true, "signed in as \"\(CastClient.deviceName)\"", "")
            check(isPrivate(paths.sessionFile), "the saved session is readable only by you (0600)",
                  "\(paths.sessionFile.path) is missing or readable by others")
        } catch {
            check(false, "", "signing in: \(describe(error))")
        }

        do {
            let status = try await client.status()
            check(true, "GET /api/status: \(status.houses) houses, \(status.total) people, cast-agent \(status.ompState)", "")
        } catch {
            check(false, "", "GET /api/status: \(describe(error))")
        }

        do {
            let link = try await client.loginLink(next: "/?settings=pair")
            let host = link.host ?? ""
            check(["127.0.0.1", "localhost", "::1"].contains(host),
                  "POST /api/login-link gives a one-time sign-in link for this Mac (not opened)",
                  "the sign-in link does not point at this Mac")
        } catch {
            check(false, "", "POST /api/login-link: \(describe(error))")
        }

        return await finish(server)
    }

    /// Stops the server if this check started it, then prints the summary.
    private func finish(_ server: ServerController?) async -> Bool {
        if let server, server.ownsServer {
            let began = Date()
            let clean = await server.stop()
            let took = String(format: "%.1f", Date().timeIntervalSince(began))
            check(clean, "stopped the server it started (\(took) s after SIGTERM)",
                  "the server did not exit within 10 s of SIGTERM and had to be killed")
        } else if server?.phase == .running {
            say("INFO  left the CAST that was already running alone")
        }
        if failed > 0 {
            say("Server log: \(paths.serverLog.path)")
            say("\(failed) of \(passed + failed) checks failed.")
        } else {
            say("All \(passed) checks passed.")
        }
        return failed == 0
    }

    private func check(_ ok: Bool, _ passText: String, _ failText: String) {
        if ok {
            passed += 1
            say("PASS  \(passText)")
        } else {
            failed += 1
            say("FAIL  \(failText)")
        }
    }

    private func say(_ line: String) {
        try? FileHandle.standardOutput.write(contentsOf: Data((line + "\n").utf8))
    }

    private func describe(_ error: Error) -> String {
        (error as? ClientError)?.menuText ?? error.localizedDescription
    }

    private func isPrivate(_ url: URL) -> Bool {
        guard let mode = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? NSNumber
        else { return false }
        return mode.intValue & 0o077 == 0
    }
}
