// The menu-bar half of CAST.app: the status icon and its menu, the status poll, notifications, Open at login.
//
// Icon: a template SF Symbol (follows light and dark menu bars). Idle: building.2. Working: building.2.fill.
// Someone waiting on you: building.2.fill and an orange count. Starting, stopped or unreachable: dimmed.
// The tooltip and the VoiceOver label carry the status line.
import AppKit
import ServiceManagement
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: MenuBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = MenuBarController(paths: Paths.current())
        self.controller = controller
        controller.start()
    }

    /// Quit (menu, ⌘Q, log out): a server this app started gets SIGTERM, up to 10 s, then SIGKILL.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let controller, controller.server.ownsServer else { return .terminateNow }
        Task {
            await controller.server.stopForQuit()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@MainActor
final class MenuBarController: NSObject, NSMenuDelegate, UNUserNotificationCenterDelegate {
    let paths: Paths
    let client: CastClient
    let server: ServerController
    let updater: Updater
    private let statusItem: NSStatusItem
    private let menu: NSMenu
    private let defaults = UserDefaults.standard
    /// UNUserNotificationCenter needs a real app bundle (it crashes in a bare binary).
    private let canNotify: Bool
    private var status: CastStatus?
    /// Why the last poll failed, for the status line.
    private var problem: String?
    /// Keys of the waiting items already seen; nil until the first answer after a start (nothing is announced
    /// for what was already waiting then).
    private var announced: Set<String>?
    private var pollTask: Task<Void, Never>?
    /// Keeps App Nap away while the app runs: a napping menu-bar app gets its timers deferred (the status poll and
    /// the crash restarts would lag by many seconds). Idle system sleep stays allowed.
    private var activity: NSObjectProtocol?
    /// What an update is doing now ("Downloading CAST 0.2.0…"): the status line and the menu show it.
    private var updatePhase: String?
    private var updateTask: Task<Void, Never>?

    init(paths: Paths) {
        let client = CastClient(paths: paths)
        self.paths = paths
        self.client = client
        server = ServerController(paths: paths, client: client, appMode: true)
        updater = Updater(paths: paths)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu = NSMenu()
        canNotify = Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
        super.init()
    }

    func start() {
        defaults.register(defaults: ["notify": true])
        menu.delegate = self
        menu.autoenablesItems = true
        statusItem.menu = menu
        server.onChange = { [weak self] in self?.refresh() }
        if canNotify { UNUserNotificationCenter.current().delegate = self }
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep],
                                                         reason: "CAST watches its server and its people")
        refresh()
        Task { await self.server.start() }
        pollTask = Task { await self.pollLoop() }
        updateTask = Task { await self.updateLoop() }
        Task { self.reportUpdate() }
    }

    // MARK: Status

    /// /api/status every 3 s (every second for the first 30 s after the server came up), slower after errors.
    private func pollLoop() async {
        var failures = 0
        while !Task.isCancelled {
            var delay: Double = 1
            if server.phase == .running {
                do {
                    let fresh = try await client.status()
                    failures = 0
                    problem = nil
                    received(fresh)
                    let young = server.readySince.map { Date().timeIntervalSince($0) < 30 } ?? false
                    delay = young ? 1 : 3
                } catch {
                    failures += 1
                    let clientError = error as? ClientError
                    problem = clientError?.menuText ?? "Can't reach CAST"
                    if failures >= 2 { status = nil }
                    if clientError == ClientError.unreachable, failures >= 3 { await server.lostConnection() }
                    delay = min(3 * pow(2, Double(min(failures, 5) - 1)), 30)
                }
            } else {
                failures = 0
                status = nil
                problem = nil
                announced = nil
            }
            refresh()
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    private func received(_ fresh: CastStatus) {
        if let seen = announced, defaults.bool(forKey: "notify") {
            for item in fresh.attention.filter({ !seen.contains($0.key) }).prefix(3) { notify(item) }
        }
        announced = Set(fresh.attention.map { $0.key })
        status = fresh
        // The very first time CAST answers (signed in: this status came through the app's session), CAST opens once
        // in the browser, so a new user lands on its onboarding. Here rather than right after the start, so that a
        // first start that needed a crash restart still gets it, and the sign-in link works at once.
        if !defaults.bool(forKey: "openedOnce") {
            defaults.set(true, forKey: "openedOnce")
            openCAST(next: nil)
        }
    }

    private func statusLine() -> String {
        if let updatePhase { return updatePhase }
        switch server.phase {
        case .idle, .starting: return "Starting CAST…"
        case .stopping: return "Stopping CAST…"
        case .crashed: return "CAST stopped — Show logs / Restart"
        case .failed(let why): return "CAST stopped: \(why)"
        case .running: break
        }
        if let problem { return problem }
        guard let s = status else { return "Connecting to CAST…" }
        if s.approvalsWaiting > 0 { return plural(s.approvalsWaiting, "approval", "approvals") + " waiting — Open" }
        if s.needsYou > 0 { return (s.needsYou == 1 ? "1 person needs" : "\(s.needsYou) people need") + " you — Open" }
        if s.working > 0 { return plural(s.working, "person", "people") + " working" }
        return "Idle"
    }

    private func plural(_ n: Int, _ one: String, _ many: String) -> String {
        n == 1 ? "1 \(one)" : "\(n) \(many)"
    }

    private func refresh() {
        guard let button = statusItem.button else { return }
        let line = statusLine()
        var symbol = "building.2"
        var dimmed = true
        var badge = 0
        if server.phase == .running, problem == nil {
            dimmed = false
            if let s = status {
                badge = s.waitingCount
                if badge > 0 || s.working > 0 { symbol = "building.2.fill" }
            }
        }
        let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "CAST")?.withSymbolConfiguration(config)
        image?.isTemplate = true
        button.image = image
        if badge > 0 {
            button.attributedTitle = NSAttributedString(string: " \(badge)", attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .bold),
                .foregroundColor: NSColor.systemOrange,
            ])
            button.imagePosition = .imageLeft
        } else if image == nil {
            button.title = "CAST"
            button.imagePosition = .noImage
        } else {
            button.title = ""
            button.imagePosition = .imageOnly
        }
        button.appearsDisabled = dimmed
        button.toolTip = line
        button.setAccessibilityLabel("CAST: \(line)")
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let running = server.phase == .running
        add(statusLine(), running ? #selector(openHome) : nil)
        if running, problem == nil, let s = status {
            for item in s.attention {
                let entry = add(item.menuTitle, #selector(openAttention(_:)))
                entry.representedObject = link(for: item)
                entry.indentationLevel = 1
            }
            if let note = ompNote(s) { add(note, #selector(openHome)).indentationLevel = 1 }
            if let note = accountNote(s) { add(note, #selector(openHome)).indentationLevel = 1 }
        }
        if updatePhase == nil, let release = updater.pending {
            add("CAST \(release.version) is available — Install…", #selector(installPending)).indentationLevel = 1
        }
        menu.addItem(.separator())
        add("Open CAST", running ? #selector(openHome) : nil, key: "o")
        add("Pair a phone…", running ? #selector(pairPhone) : nil)
        add("Open at login", #selector(toggleOpenAtLogin)).state = loginState()
        add("Notify me", #selector(toggleNotify)).state = defaults.bool(forKey: "notify") ? .on : .off
        let restart = add("Restart CAST", server.canRestart ? #selector(restartServer) : nil)
        if !server.canRestart, server.phase == .running {
            restart.toolTip = "This CAST was started outside the app. Restart it where it runs."
        }
        add("Show logs", #selector(showLogs))
        add("About CAST", #selector(showAbout))
        add("Check for Updates…", updatePhase == nil ? #selector(checkForUpdates) : nil)
        menu.addItem(.separator())
        add("Quit CAST", #selector(NSApplication.terminate(_:)), key: "q").target = NSApp
    }

    @discardableResult
    private func add(_ title: String, _ action: Selector?, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
        return item
    }

    /// What the menu says about AI accounts once the agent (cast-agent) is fine: "none connected" only after a check worked.
    private func accountNote(_ s: CastStatus) -> String? {
        guard s.ompState == "ok" else { return nil }
        switch s.modelsState {
        case "checking": return "Checking AI accounts…"
        case "failed": return "Couldn't check AI accounts — Open CAST"
        default: return s.modelsConnected == 0 ? "No AI account connected — open CAST to connect one" : nil
        }
    }

    private func ompNote(_ s: CastStatus) -> String? {
        switch s.ompState {
        case "missing": return "The agent program (cast-agent) is missing — Open CAST"
        case "too-old": return "The agent program (cast-agent) is too old — Open CAST"
        case "error": return "The agent program (cast-agent) has a problem — Open CAST"
        default: return nil
        }
    }

    private func loginState() -> NSControl.StateValue {
        switch SMAppService.mainApp.status {
        case .enabled: return .on
        case .requiresApproval: return .mixed
        default: return .off
        }
    }

    // MARK: Actions

    @objc private func openHome() { openCAST(next: nil) }

    @objc private func pairPhone() { openCAST(next: "/?settings=pair") }

    @objc private func openAttention(_ sender: NSMenuItem) {
        openCAST(next: sender.representedObject as? String)
    }

    /// Where a waiting item opens CAST: the path the server gives for it (that house, and the job when there is
    /// one), else #/house/<id>, else the town.
    private func link(for item: CastStatus.Attention) -> String? {
        item.next ?? housePath(item.houseId)
    }

    /// Opens CAST in the default browser through a one-time sign-in link, so the browser gets a session of its own.
    func openCAST(next: String?) {
        Task {
            if let url = await self.signInLink(next: next) {
                _ = NSWorkspace.shared.open(url)
            } else if let address = self.server.address, let url = URL(string: address + "/") {
                // A server without one-time links: its plain address (a browser paired before still gets in).
                _ = NSWorkspace.shared.open(url)
            }
        }
    }

    private func signInLink(next: String?) async -> URL? {
        if let url = try? await client.loginLink(next: next) { return url }
        if next != nil, let url = try? await client.loginLink(next: nil) { return url } // deep link refused
        return nil
    }

    private func housePath(_ id: String?) -> String? {
        guard let id, !id.isEmpty else { return nil }
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return "/#/house/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id)
    }

    @objc private func toggleOpenAtLogin() {
        let service = SMAppService.mainApp
        do {
            switch service.status {
            case .enabled:
                try service.unregister()
            case .requiresApproval:
                SMAppService.openSystemSettingsLoginItems()
            default:
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            }
        } catch {
            alert("Couldn't change Open at login",
                  "\(error.localizedDescription)\n\nMove CAST to the Applications folder, open it from there and try again.")
        }
    }

    @objc private func toggleNotify() {
        defaults.set(!defaults.bool(forKey: "notify"), forKey: "notify")
    }

    @objc private func restartServer() {
        announced = nil
        Task { await self.server.restart() }
    }

    @objc private func showLogs() {
        let fm = FileManager.default
        try? fm.createDirectory(at: paths.logsDir, withIntermediateDirectories: true)
        if fm.fileExists(atPath: paths.serverLog.path) {
            NSWorkspace.shared.activateFileViewerSelecting([paths.serverLog])
        } else {
            _ = NSWorkspace.shared.open(paths.logsDir)
        }
    }

    @objc private func showAbout() {
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let serverText = status.map { "CAST server \($0.version)" } ?? "CAST server: not running"
        let ompText = status.map { "cast-agent " + ($0.ompVersion ?? $0.ompState) } ?? "cast-agent: not checked yet"
        let lines = [
            serverText + (server.address.map { " at \($0)" } ?? ""),
            ompText,
            "Data folder: " + (paths.dataDir.path as NSString).abbreviatingWithTildeInPath,
            "Logs: " + (paths.logsDir.path as NSString).abbreviatingWithTildeInPath,
            updater.repository.map { "Updates from github.com/\($0.owner)/\($0.name)" } ?? "Updates: not set up",
            "Free software under the MIT licence.",
        ]
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        let credits = NSAttributedString(string: lines.joined(separator: "\n"), attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: style,
        ])
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "CAST",
            .applicationVersion: appVersion,
            .version: "",
            .credits: credits,
        ])
    }

    private func alert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        _ = alert.runModal()
    }

    // MARK: Updates (Updater.swift)

    /// A quiet check a minute after the start, then once a day: a newer release shows in the menu as "Install…".
    private func updateLoop() async {
        try? await Task.sleep(nanoseconds: Updater.firstCheckDelay * 1_000_000_000)
        while !Task.isCancelled {
            if updatePhase == nil, updater.repository != nil {
                let result = await updater.check()
                if case .available = result { refresh() }
            }
            try? await Task.sleep(nanoseconds: Updater.checkInterval * 1_000_000_000)
        }
    }

    @objc private func checkForUpdates() {
        Task { await self.checkNow() }
    }

    @objc private func installPending() {
        guard let release = updater.pending else { return }
        Task { await self.offer(release) }
    }

    private func checkNow() async {
        guard updatePhase == nil else { return }
        updatePhase = "Checking for updates…"
        refresh()
        let result = await updater.check()
        updatePhase = nil
        refresh()
        switch result {
        case .notConfigured:
            askForRepository()
        case .upToDate(let newest):
            alert("CAST is up to date", "You have CAST \(updater.currentVersion); the newest release is \(newest).")
        case .failed(let why):
            alert("Couldn't check for updates", why)
        case .available(let release):
            await offer(release)
        }
    }

    /// "A new version of CAST is available": Install and Relaunch, Later, or the release's page on GitHub.
    private func offer(_ release: Release) async {
        var text = "CAST \(release.version) is out; you have \(updater.currentVersion)."
        let notes = release.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if !notes.isEmpty { text += "\n\n" + clip(notes, 600) }
        let size = release.size > 0 ? " (\(ByteCountFormatter.string(fromByteCount: Int64(release.size), countStyle: .file)))" : ""
        text += "\n\nCAST downloads it\(size), puts it in place of this one and opens again. Your town, chats and settings stay."
        if let s = status, s.working > 0 {
            text += "\n\n" + plural(s.working, "person is", "people are") + " working now: they stop, and carry on when you message them again."
        }
        let ask = NSAlert()
        ask.messageText = "A new version of CAST is available"
        ask.informativeText = text
        ask.addButton(withTitle: "Install and Relaunch")
        ask.addButton(withTitle: "Later")
        ask.addButton(withTitle: "Release Notes")
        NSApp.activate(ignoringOtherApps: true)
        switch ask.runModal() {
        case .alertFirstButtonReturn: await install(release)
        case .alertThirdButtonReturn: _ = NSWorkspace.shared.open(release.page)
        default: break
        }
    }

    /// Download and check the release, put its app next to this one, then quit: the helper swaps the two and opens
    /// the new one. Where this app can't replace itself, the dmg opens for the usual drag onto Applications.
    private func install(_ release: Release) async {
        guard updatePhase == nil else { return }
        updatePhase = "Downloading CAST \(release.version)…"
        refresh()
        let dmg: URL
        do {
            dmg = try await updater.download(release)
        } catch {
            updatePhase = nil
            refresh()
            alert("CAST couldn't be updated", (error as? UpdateFailure)?.reason ?? error.localizedDescription)
            return
        }
        updatePhase = "Installing CAST \(release.version)…"
        refresh()
        let staged: URL
        do {
            staged = try await updater.stage(dmg, release)
        } catch let failure as UpdateFailure where failure.byHand {
            updatePhase = nil
            refresh()
            installByHand(dmg, failure.reason)
            return
        } catch {
            // It failed its checks: removed, so that nobody installs it by hand either.
            try? FileManager.default.removeItem(at: dmg)
            updatePhase = nil
            refresh()
            alert("CAST couldn't be updated",
                  ((error as? UpdateFailure)?.reason ?? error.localizedDescription) + "\n\nNothing was changed; the download was removed. Try again later.")
            return
        }
        guard updater.startSwap(staged: staged, version: release.version) else {
            try? FileManager.default.removeItem(at: staged)
            updatePhase = nil
            refresh()
            installByHand(dmg, "The installer couldn't be started.")
            return
        }
        defaults.set(dmg.path, forKey: "updateDownload") // removed once the new app reports it is in place
        updatePhase = "Restarting CAST…"
        refresh()
        NSApp.terminate(nil) // the server stops first (AppDelegate); then the helper swaps the apps and opens the new one
    }

    private func installByHand(_ dmg: URL, _ why: String) {
        paths.log("update: to be installed by hand (\(why))")
        alert("Install the new CAST by hand",
              "\(why)\n\nThe new CAST is in Downloads (\(dmg.lastPathComponent)) and opens now. Quit CAST from its menu, drag CAST onto Applications, choose Replace, then open CAST again. Your town, chats and settings stay.")
        _ = NSWorkspace.shared.open(dmg)
    }

    /// No repository yet (a dmg built before the project had its address): ask for it and remember it.
    private func askForRepository() {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "https://github.com/owner/cast"
        let ask = NSAlert()
        ask.messageText = "Updates aren't set up yet"
        ask.informativeText = "This copy of CAST doesn't know where its releases are published. Paste the address of CAST's GitHub repository to check there."
        ask.accessoryView = field
        ask.addButton(withTitle: "Check for Updates")
        ask.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        ask.window.initialFirstResponder = field
        guard ask.runModal() == .alertFirstButtonReturn else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Updater.gitHubRepository(text) != nil else {
            alert("That isn't a GitHub repository", "Use the address of its page on GitHub, like https://github.com/owner/cast.")
            return
        }
        defaults.set(text, forKey: Updater.repositoryKey)
        Task { await self.checkNow() }
    }

    /// What the helper said about the last install, once, when the app starts after it.
    private func reportUpdate() {
        guard let line = updater.takeResult() else { return }
        paths.log("update result: \(line)")
        let download = defaults.string(forKey: "updateDownload")
        defaults.removeObject(forKey: "updateDownload")
        if line.hasPrefix("installed ") {
            if let download, download.hasSuffix(".dmg") { try? FileManager.default.removeItem(atPath: download) }
            alert("CAST was updated", "This is CAST \(line.dropFirst("installed ".count)). Your town, chats and settings are as you left them.")
        } else if line.hasPrefix("failed ") {
            alert("CAST couldn't be updated",
                  "The installer said: \(line.dropFirst("failed ".count)).\n\nThis is still the CAST you had. The new one is in Downloads: open its dmg, drag CAST onto Applications and choose Replace.")
        }
    }

    // MARK: Notifications

    /// "CAST needs you — <person> in <house>: <title>". Permission is asked the first time; an ad-hoc signed app
    /// that may not post notifications fails quietly.
    private func notify(_ item: CastStatus.Attention) {
        guard canNotify else { return }
        let who = [item.person, item.house].filter { !$0.isEmpty }.joined(separator: " in ")
        let body = item.title.isEmpty ? who : "\(who): \(item.title)"
        let next = link(for: item) ?? ""
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { @Sendable (granted: Bool, _: Error?) in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "CAST needs you"
            content.body = body
            content.sound = .default
            content.userInfo = ["next": next]
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        }
    }

    /// A click on a notification opens CAST at that house.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let next = response.notification.request.content.userInfo["next"] as? String
        Task { @MainActor in self.openCAST(next: next.flatMap { CastStatus.isLocalPath($0) ? $0 : nil }) }
        completionHandler()
    }

    /// Show the banner even while the menu is open (the app counts as active then).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
