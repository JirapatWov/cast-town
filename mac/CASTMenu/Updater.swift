// "Check for Updates…": CAST.app updates the way Mac apps from outside the App Store do. Every release of CAST is a
// GitHub release of the project's repository with the dmg attached (CAST-<version>-arm64.dmg, tag v<version>). The app
// asks GitHub for the newest release, downloads its dmg into Downloads, checks it (the SHA-256 GitHub lists for the
// file; then the app inside: the same bundle id, the version the release says, a valid signature), copies the new
// CAST.app next to this one and quits; cast-install-update.sh, copied out of the app first, swaps the two once this
// app has exited and opens the new one. Where that can't work (the folder isn't writable for this account, the app
// runs from the dmg or from a copy macOS moved aside), the dmg is opened in Finder: drag CAST onto Applications, as on
// the first install. The data folder, the logs and the settings are never touched.
//
// Where releases are: Info.plist CASTUpdateRepository (package.json's repository.url, written by build-dmg.sh), or the
// address the user gave when it wasn't set up (UserDefaults "updateRepository"). The CHANGE-ME placeholder counts as
// none. Only public GitHub repositories (the releases API without a token).
import AppKit
import Foundation

/// package.json's repository.url until the project has one: no updates then.
private let repositoryPlaceholder = "CHANGE-ME"

/// The newest release on GitHub, with its dmg.
struct Release: Sendable {
    let version: String
    let page: URL
    let notes: String
    let dmg: URL
    let dmgName: String
    let size: Int
    /// From the asset's "digest" ("sha256:<hex>"), when GitHub lists one.
    let sha256: String?
}

enum UpdateCheck: Sendable {
    case notConfigured
    case upToDate(newest: String)
    case available(Release)
    case failed(String)
}

/// Why an update stopped, in words for an alert. `byHand`: the download is fine but this app can't replace itself
/// here (where it runs, the folder's permissions), so the dmg is offered for the usual drag onto Applications; a
/// download that failed its checks is never offered.
struct UpdateFailure: Error {
    let reason: String
    var byHand = false
}

@MainActor
final class Updater {
    static let repositoryKey = "updateRepository"
    /// A quiet check runs this long after the app starts and then once a day: the menu offers what it found.
    static let firstCheckDelay: UInt64 = 60
    static let checkInterval: UInt64 = 24 * 60 * 60

    let paths: Paths
    private let session = URLSession(configuration: .ephemeral)
    /// A release newer than this app, from the last check (the menu offers it).
    private(set) var pending: Release?

    init(paths: Paths) {
        self.paths = paths
    }

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    private var userAgent: String { "CAST/\(currentVersion) (Mac menu bar)" }

    /// owner/name on GitHub: the address the user gave, else the one the app was built with; nil when neither is set.
    var repository: (owner: String, name: String)? {
        let saved = UserDefaults.standard.string(forKey: Self.repositoryKey) ?? ""
        let built = Bundle.main.object(forInfoDictionaryKey: "CASTUpdateRepository") as? String ?? ""
        return Self.gitHubRepository(saved) ?? Self.gitHubRepository(built)
    }

    /// owner and name from https://github.com/o/r(.git), git+https://…, git@github.com:o/r.git or github.com/o/r;
    /// nil for anything else and for the placeholder.
    nonisolated static func gitHubRepository(_ text: String) -> (owner: String, name: String)? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, !s.contains(repositoryPlaceholder) else { return nil }
        for prefix in ["git+", "https://", "http://", "ssh://", "git@", "www."] where s.hasPrefix(prefix) {
            s.removeFirst(prefix.count)
        }
        guard s.lowercased().hasPrefix("github.com") else { return nil }
        s.removeFirst("github.com".count)
        guard let separator = s.first, separator == "/" || separator == ":" else { return nil }
        s.removeFirst()
        while s.hasSuffix("/") { s.removeLast() }
        if s.hasSuffix(".git") { s.removeLast(4) }
        let parts = s.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2, parts.allSatisfy(isName) else { return nil }
        return (owner: parts[0], name: parts[1])
    }

    private nonisolated static func isName(_ part: String) -> Bool {
        !part.isEmpty && part != "." && part != ".."
            && part.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "-_.".unicodeScalars.contains($0)) }
    }

    // MARK: Checking

    /// Asks GitHub for the newest release. A newer one is kept in `pending`.
    func check() async -> UpdateCheck {
        guard let repo = repository else { return .notConfigured }
        guard let url = URL(string: "https://api.github.com/repos/\(repo.owner)/\(repo.name)/releases/latest") else {
            return .notConfigured
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        let answer: (Data, URLResponse)
        do {
            answer = try await session.data(for: request)
        } catch {
            return .failed("CAST couldn't reach GitHub (\(error.localizedDescription)).")
        }
        let code = (answer.1 as? HTTPURLResponse)?.statusCode ?? 0
        switch code {
        case 200: break
        case 404: return .failed("\(repo.owner)/\(repo.name) on GitHub has no published release yet, or the repository is private.")
        case 403, 429: return .failed("GitHub asks CAST to wait (too many checks from this network). Try again in an hour.")
        default: return .failed("GitHub answered with an error (HTTP \(code)).")
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: answer.0)) as? [String: Any],
              let release = Self.release(from: obj) else {
            return .failed("The newest release of \(repo.owner)/\(repo.name) has no CAST dmg attached.")
        }
        paths.log("update check: newest release \(release.version), this app \(currentVersion)")
        if Self.compareVersions(release.version, currentVersion) > 0 {
            pending = release
            return .available(release)
        }
        pending = nil
        return .upToDate(newest: release.version)
    }

    /// The release in GitHub's answer, with its dmg (the arm64 one when there are several); nil without a dmg.
    nonisolated static func release(from obj: [String: Any]) -> Release? {
        guard let tag = obj["tag_name"] as? String, (obj["draft"] as? Bool) != true,
              let page = (obj["html_url"] as? String).flatMap({ URL(string: $0) }) else { return nil }
        let version = tag.hasPrefix("v") || tag.hasPrefix("V") ? String(tag.dropFirst()) : tag
        let assets = obj["assets"] as? [[String: Any]] ?? []
        let dmgs = assets.filter { (($0["name"] as? String) ?? "").lowercased().hasSuffix(".dmg") }
        guard let asset = dmgs.first(where: { (($0["name"] as? String) ?? "").contains("arm64") }) ?? dmgs.first,
              let name = asset["name"] as? String,
              let link = (asset["browser_download_url"] as? String).flatMap({ URL(string: $0) }), link.scheme == "https"
        else { return nil }
        let digest = (asset["digest"] as? String) ?? ""
        let sha = digest.hasPrefix("sha256:") ? String(digest.dropFirst("sha256:".count)).lowercased() : nil
        return Release(version: version, page: page, notes: (obj["body"] as? String) ?? "", dmg: link,
                       dmgName: URL(fileURLWithPath: name).lastPathComponent, size: (asset["size"] as? NSNumber)?.intValue ?? 0,
                       sha256: sha)
    }

    /// Semantic versions: 1 when a is newer, -1 when older, 0 when the same. "1.0.0" is newer than "1.0.0-beta.2";
    /// "+build" is ignored; a missing core part counts as 0. Pre-release parts compare one dot-separated identifier at
    /// a time: numbers by value and below words, words by ASCII order, and a shorter list first ("beta" < "beta.1").
    /// Numbers compare as digit strings, so any length works.
    nonisolated static func compareVersions(_ a: String, _ b: String) -> Int {
        func parts(_ v: String) -> (core: [String], pre: [String]) {
            let noBuild = String(v.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
            let halves = noBuild.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
            let core = (halves.first ?? "").split(separator: ".").map(String.init)
            let pre = halves.count > 1 ? halves[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init) : []
            return (core, pre)
        }
        func isNumber(_ id: String) -> Bool {
            !id.isEmpty && id.utf8.allSatisfy { $0 >= 48 && $0 <= 57 }
        }
        func compareNumbers(_ p: String, _ q: String) -> Int {
            let m = String(p.drop(while: { $0 == "0" }))
            let n = String(q.drop(while: { $0 == "0" }))
            if m.count != n.count { return m.count < n.count ? -1 : 1 }
            return m == n ? 0 : (m < n ? -1 : 1)
        }
        let x = parts(a)
        let y = parts(b)
        for i in 0..<max(x.core.count, y.core.count) {
            let p = i < x.core.count && isNumber(x.core[i]) ? x.core[i] : "0"
            let q = i < y.core.count && isNumber(y.core[i]) ? y.core[i] : "0"
            let order = compareNumbers(p, q)
            if order != 0 { return order }
        }
        if x.pre.isEmpty || y.pre.isEmpty {
            return x.pre.isEmpty == y.pre.isEmpty ? 0 : (x.pre.isEmpty ? 1 : -1)
        }
        for (p, q) in zip(x.pre, y.pre) where p != q {
            switch (isNumber(p), isNumber(q)) {
            case (true, true):
                let order = compareNumbers(p, q)
                if order != 0 { return order }
            case (true, false): return -1
            case (false, true): return 1
            case (false, false): return p < q ? -1 : 1
            }
        }
        return x.pre.count == y.pre.count ? 0 : (x.pre.count < y.pre.count ? -1 : 1)
    }

    // MARK: Installing

    /// Downloads the release's dmg into Downloads (it stays there: it is also the way to install by hand) and checks
    /// it against the SHA-256 GitHub lists.
    func download(_ release: Release) async throws -> URL {
        let fm = FileManager.default
        let downloads = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: paths.home, isDirectory: true).appendingPathComponent("Downloads", isDirectory: true)
        try? fm.createDirectory(at: downloads, withIntermediateDirectories: true)
        let target = downloads.appendingPathComponent(release.dmgName)
        var request = URLRequest(url: release.dmg, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        let answer: (URL, URLResponse)
        do {
            answer = try await session.download(for: request)
        } catch {
            throw UpdateFailure(reason: "The download stopped (\(error.localizedDescription)).")
        }
        let code = (answer.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            try? fm.removeItem(at: answer.0)
            throw UpdateFailure(reason: "GitHub refused the download (HTTP \(code)).")
        }
        if let want = release.sha256 {
            let sum = await runTool("/usr/bin/shasum", ["-a", "256", answer.0.path])
            let got = sum.output.split(separator: " ").first.map { String($0).lowercased() } ?? ""
            guard sum.status == 0, got == want else {
                try? fm.removeItem(at: answer.0)
                throw UpdateFailure(reason: "The downloaded file is damaged (its SHA-256 doesn't match the release). Try again.")
            }
        }
        try? fm.removeItem(at: target)
        do {
            try fm.moveItem(at: answer.0, to: target)
        } catch {
            throw UpdateFailure(reason: "The download couldn't be saved in \(downloads.path) (\(error.localizedDescription)).")
        }
        paths.log("update: downloaded \(release.dmgName)")
        return target
    }

    /// Copies the new CAST.app out of the dmg to a hidden name next to this app, after checking it. The returned app
    /// is what the helper swaps in. Throws `byHand` when the app in the dmg is fine but this app can't replace itself
    /// here; any other failure means the download is not to be installed at all.
    func stage(_ dmg: URL, _ release: Release) async throws -> URL {
        let fm = FileManager.default
        let app = Bundle.main.bundleURL
        let folder = app.deletingLastPathComponent()
        // Where this app runs is checked first but reported only after the dmg passed its checks.
        var limitation: String?
        if app.pathExtension != "app" {
            limitation = "This CAST isn't running as an app."
        } else if app.path.contains("/AppTranslocation/") || app.path.hasPrefix("/Volumes/") {
            limitation = "CAST is running from the dmg or from a copy macOS made, not from Applications."
        } else if !fm.isWritableFile(atPath: folder.path) {
            limitation = "Your account can't change the apps in \(folder.path)."
        }
        // A new folder each time: one an earlier attempt couldn't unmount is never reused or deleted.
        let mount = fm.temporaryDirectory.appendingPathComponent("cast-update-\(getpid())-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? fm.createDirectory(at: mount, withIntermediateDirectories: true)
        let attach = await runTool("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, dmg.path])
        guard attach.status == 0 else {
            paths.log("update: hdiutil attach failed (status \(attach.status))")
            _ = await runTool("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) // in case it got half way
            _ = rmdir(mount.path) // only when empty: never deletes what may still be mounted there
            throw UpdateFailure(reason: "macOS couldn't open the downloaded dmg; it may be damaged.")
        }
        var staged: URL?
        var problem = UpdateFailure(reason: "")
        let found = mount.appendingPathComponent("CAST.app", isDirectory: true)
        let bundle = Bundle(url: found)
        let foundVersion = bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        if bundle == nil {
            problem = UpdateFailure(reason: "The dmg has no CAST.app in it.")
        } else if bundle?.bundleIdentifier != Bundle.main.bundleIdentifier {
            problem = UpdateFailure(reason: "The app in the dmg isn't this CAST (its bundle id is different).")
        } else if foundVersion != release.version {
            problem = UpdateFailure(reason: "The app in the dmg is version \(foundVersion), not \(release.version).")
        } else if await runTool("/usr/bin/codesign", ["--verify", "--deep", "--strict", found.path]).status != 0 {
            problem = UpdateFailure(reason: "The app in the dmg isn't intact (its signature doesn't verify).")
        } else if let limitation {
            problem = UpdateFailure(reason: limitation, byHand: true)
        } else {
            let target = folder.appendingPathComponent(".CAST-\(release.version)-update.app", isDirectory: true)
            try? fm.removeItem(at: target)
            if await runTool("/usr/bin/ditto", [found.path, target.path]).status == 0 {
                staged = target
            } else {
                try? fm.removeItem(at: target)
                problem = UpdateFailure(reason: "The new CAST couldn't be copied to \(folder.path).", byHand: true)
            }
        }
        // A dmg that stays mounted (hidden, read-only, gone at the next restart) doesn't stop the update: the new
        // app is already copied out of it.
        if await runTool("/usr/bin/hdiutil", ["detach", mount.path, "-force"]).status == 0 {
            _ = rmdir(mount.path)
        } else {
            paths.log("update: the dmg could not be unmounted from \(mount.path)")
        }
        guard let staged else { throw problem }
        // It came from a download this app made, so macOS put no quarantine on it; make sure, as the README's
        // first-launch help does by hand.
        _ = await runTool("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged.path])
        paths.log("update: CAST \(release.version) is ready next to the app")
        return staged
    }

    /// Starts the helper that swaps `staged` in once this app has quit (it runs from a copy outside the app, which it
    /// replaces). Returns false when it couldn't be started.
    func startSwap(staged: URL, version: String) -> Bool {
        let fm = FileManager.default
        let helper = fm.temporaryDirectory.appendingPathComponent("cast-install-update-\(getpid()).sh")
        try? fm.removeItem(at: helper)
        do {
            try fm.copyItem(at: paths.installHelper, to: helper)
        } catch {
            paths.log("update: the helper couldn't be copied (\(error.localizedDescription))")
            return false
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [helper.path, String(getpid()), Bundle.main.bundleURL.path, staged.path, version, paths.updateResultFile.path]
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            paths.log("update: the helper couldn't be started (\(error.localizedDescription))")
            return false
        }
        paths.log("update: the helper (pid \(proc.processIdentifier)) swaps in CAST \(version) once this app has quit")
        return true
    }

    /// What the helper wrote about the last install ("installed <version>" / "failed <why>"), once: it is removed.
    func takeResult() -> String? {
        guard let line = readTrimmed(paths.updateResultFile) else { return nil }
        try? FileManager.default.removeItem(at: paths.updateResultFile)
        return line
    }
}

/// Runs a tool off the main thread; its exit status and what it printed (stdout and stderr together).
func runTool(_ tool: String, _ arguments: [String]) async -> (status: Int32, output: String) {
    await Task.detached { () -> (status: Int32, output: String) in
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: tool)
        proc.arguments = arguments
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        proc.standardInput = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return (status: Int32(-1), output: error.localizedDescription)
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return (status: proc.terminationStatus, output: String(decoding: data, as: UTF8.self))
    }.value
}
