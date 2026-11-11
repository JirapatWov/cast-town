// CAST.app's entry point: the menu-bar app, or `CAST --check`, the self-check build-dmg.sh runs (PASS/FAIL lines,
// exit status 0 or 1). Top-level code runs on the main thread; MainActor.assumeIsolated tells the compiler so.
import AppKit

MainActor.assumeIsolated {
    if CommandLine.arguments.contains("--check") {
        Task {
            let ok = await SelfCheck().run()
            exit(ok ? 0 : 1)
        }
        dispatchMain()
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory) // menu bar only, no Dock icon (Info.plist says LSUIElement too)
    withExtendedLifetime(delegate) { app.run() }
}
