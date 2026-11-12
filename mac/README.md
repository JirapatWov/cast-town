# CAST for Mac

CAST.app puts CAST in your Mac's menu bar. It starts the CAST server for you, shows what your agents are doing in a
small icon at the top of the screen, and opens CAST in your browser already signed in. Everything CAST needs is
inside the app: the server, the agent program (cast-agent) and the web app. You don't need Bun, Node or a terminal to use it.

It runs on **Apple Silicon Macs (M1 or newer) with macOS 13 Ventura or newer**.

## What the menu shows

The icon is a small building. It is filled while someone is working, gets an orange number when people are waiting
for you (an approval or a question), and is dimmed while CAST starts or when it has stopped. Click it for the menu:

| Item | What it does |
|---|---|
| Status line | "Idle", "2 people working", "1 approval waiting — Open", "CAST stopped". Click it to open CAST |
| Waiting items | One line per approval or question that waits for you. Click one to open CAST at that house |
| Notes | "No AI account connected — open CAST to connect one" (nobody can work until one is; shown once a check of the accounts worked, else "Checking AI accounts…" or "Couldn't check AI accounts"), or that the agent program (cast-agent) is missing. Click one to open CAST |
| **Open CAST** (⌘O) | Opens CAST in your default browser, signed in with a one-time link |
| **Pair a phone…** | Opens Settings → Pair a phone in the browser |
| **Open at login** | Starts CAST.app when you log in to your Mac |
| **Notify me** | A notification when someone starts waiting for you (on by default) |
| **Restart CAST** | Stops the CAST server and starts it again |
| **Show logs** | Shows the server's log file in Finder |
| **About CAST** | Versions of the app, the server and the agent (cast-agent), where your data is, and where updates come from |
| **Check for Updates…** | Looks for a newer CAST and offers to install it ([Updates](#updates)). A newer CAST found by the daily check shows as "CAST 0.2.0 is available — Install…" near the top |
| **Quit CAST** (⌘Q) | Stops the server the app started, then quits |

The first time CAST.app starts, it opens CAST in your browser once, so you land on the welcome steps: connect an AI
account first, then place your first project.

If a CAST server is already running on port 4860 with the same data folder (for example one you started with
`bun run start`), the app uses that one and leaves it running when you quit. When port 4860 is busy with something
else, the app uses the next free port up to 4879. If the server stops unexpectedly, the app starts it again after 1,
5 and 30 seconds; after that it shows "CAST stopped — Show logs / Restart".

## Install from a dmg

1. Open `CAST-<version>-arm64.dmg` and drag **CAST** onto **Applications**.
2. Open CAST. Release downloads are signed with a Developer ID and notarized by Apple, so it opens like any app
   (macOS may ask once whether to open an app downloaded from the internet).
3. A dmg you built yourself (below) is signed ad hoc. On the Mac that built it, CAST opens like any app. On another
   Mac, macOS asks once:
   - **macOS 13 Ventura and 14 Sonoma:** in **Applications**, right-click **CAST** and choose **Open**, then
     **Open** again in the dialog (Control-click works like right-click). If macOS only offers to move it to the Bin,
     use **Open Anyway** as below.
   - **macOS 15 Sequoia and newer** (right-click → Open no longer skips the check there): double-click **CAST** once
     and close the message, then open **System Settings → Privacy & Security**, scroll down to the message about
     CAST, click **Open Anyway** and confirm with your password.

Look for the building icon at the top right of the screen.

## Updates

Choose **Check for Updates…** in the menu. When there is a newer CAST, the app shows its release notes and offers
**Install and Relaunch**, **Later** or **Release Notes**. Install and Relaunch:

1. downloads `CAST-<version>-arm64.dmg` into your Downloads folder and checks it (the SHA-256 GitHub lists for it, then
   the app inside: the same app, the version the release says, an intact signature). A download that fails a check is
   deleted and nothing changes;
2. copies the new CAST next to the one you use, quits (stopping the server, as Quit does), swaps the two apps and
   opens the new one. If a step fails, the CAST you had stays and opens again;
3. tells you on the next start that it was updated, and removes the dmg from Downloads.

Your town, chats, settings and logs are not touched: they live outside the app ([below](#where-your-data-and-logs-are)).
People who were working stop when CAST quits and carry on when you message them again.

The app also checks quietly a minute after it starts and then once a day; it never installs on its own.

**When CAST can't replace itself** (your account can't change the Applications folder, or CAST runs from the dmg or
from a copy macOS moved aside), it opens the downloaded dmg instead: quit CAST, drag **CAST** onto **Applications**,
choose **Replace**, and open it again, as on the first install. The same works any time without the menu: download
the newest dmg from the project's GitHub Releases page and drag it over the old app.

**Where updates come from:** the GitHub Releases of the repository in `package.json`'s `repository.url`, written
into the app when it is built. A CAST built before that address was set asks for it the first time you check (paste
the repository's GitHub address; it is remembered). The repository must be public.

## Publishing a release

Set `package.json`'s `repository.url` to this project's public GitHub repository so **Check for Updates** finds it.
Bump `version` in `package.json`, commit it, then push the matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The **Release Mac app** workflow checks the tag against the package version, builds the kit on Linux, and builds
and self-checks the app on an Apple Silicon Mac. It creates or updates the GitHub release with
`CAST-<version>-arm64.dmg` and `SHA256SUMS`. GitHub also computes the asset digest the app verifies. Edit the release
description for the notes shown in the app. Drafts and pre-releases are not offered as updates; versions containing
`-` are published as pre-releases. To rebuild a release, run the workflow manually with its existing `v<version>` tag.

Without signing secrets the workflow signs the app ad hoc and does **not notarize** it; downloaded copies then need
the opening steps above. Developer ID signing and notarization run when **all five** repository Actions secrets are
set:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12` | Base64-encoded Developer ID Application certificate and private key, exported as a `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | The `.p12` export password (use a nonempty password) |
| `APPLE_ID` | The Apple Developer account's email address |
| `APPLE_TEAM_ID` | The Apple Developer team ID |
| `APPLE_APP_PASSWORD` | An app-specific password for that Apple ID |

The workflow imports the certificate into a temporary keychain, signs inside out with hardened runtime and Bun's
JIT/native-loading entitlements, runs the self-check under that signature, then submits the dmg with
`xcrun notarytool submit --wait` and staples Apple's ticket before hashing and uploading it. Configured signing or
notarization failures stop publication. The temporary certificate and keychain are removed even if a build fails.

## Build the dmg on a Mac

The dmg is built on a Mac from a kit made on Linux or a Mac (`scripts/mac/build-kit.sh <out-dir>` packs the server
binary, the agent (`cast-agent`, with its licence as `agent-LICENSE` and its third-party notices as
`agent-THIRD-PARTY-NOTICES.txt`; both end up in CAST.app's Resources), the web app and these sources into
`cast-mac-kit-<version>.tar.gz`). By default build-kit.sh builds the agent itself (`bash agent/cast/build.sh --binary
darwin-arm64`); set `AGENT_DARWIN_BIN` to a prebuilt `cast-agent-darwin-arm64` to ship that one instead.

You need Apple's Command Line Tools for the Swift compiler. If you don't have them:

```bash
xcode-select --install
```

Then, in Terminal, in the folder where you copied the kit:

```bash
tar xzf cast-mac-kit-*.tar.gz
cd cast-mac-kit
./build-dmg.sh
```

The script checks the Mac and the kit, compiles the menu-bar app, assembles and signs `build/CAST.app`, runs the
app's self-check, and writes `CAST-<version>-arm64.dmg` next to itself.

Neither build script prompts. For local Developer ID builds, set `CAST_SIGN_IDENTITY` to an installed certificate's
name and `CAST_SIGN_ENTITLEMENTS` to the checkout's `agent/scripts/macos-entitlements.plist`; notarization is a
separate step. Without these settings the build remains ad hoc.

Options:

| Option | What it does |
|---|---|
| `--run` | Build the app and open it, without making a dmg |
| `--no-check` | Skip the self-check |

The self-check (`CAST.app/Contents/MacOS/CAST --check`) starts the bundled server in a throwaway folder, waits until
it answers, signs in, reads the status, asks for a sign-in link without opening it, stops the server and prints one
PASS or FAIL line per step. It never prints the pairing token, the session or the link.

## Where your data and logs are

| What | Where |
|---|---|
| CAST's data: the town, chats, the pairing token, paired devices | `~/Library/Application Support/CAST` |
| The menu-bar app's sign-in (a device session, readable only by you) | `~/Library/Application Support/CAST/menubar-session` |
| Projects you create in CAST | `~/CAST` |
| The server's log, and the previous run's | `~/Library/Logs/CAST/server.log`, `server.1.log` |
| The menu-bar app's own log | `~/Library/Logs/CAST/menubar.log` |
| What the last update did | `~/Library/Logs/CAST/update.log` |
| The app's settings (Notify me, first start, the updates address you gave) | `~/Library/Preferences/dev.casttown.cast.plist` |

The menu-bar app signs in like any other device, so it is listed in CAST under Settings → Devices as
"CAST menu bar (Mac)". Signing it out there is harmless: the app signs in again by itself.

CAST runs agents and a terminal with your user's rights. Read [SECURITY.md](../SECURITY.md) before you make it
reachable from other devices.

## Uninstall

1. Quit CAST from its menu (this stops the server).
2. If you turned on **Open at login**, turn it off first (or remove CAST in System Settings → General → Login Items).
3. Drag **CAST** from Applications to the Bin.
4. To remove your data too (this deletes your chats and paired devices, but not your projects):

```bash
rm -rf ~/Library/Application\ Support/CAST ~/Library/Logs/CAST
defaults delete dev.casttown.cast
```

Your projects in `~/CAST` stay where they are; delete that folder yourself if you no longer want them.

## Troubleshooting

- **"CAST stopped" right after it starts:** click **Show logs** and read the end of `server.log`.
- **The icon stays dimmed with "ports 4860–4879 are all in use":** something else holds all those ports; quit it, then
  choose **Restart CAST**.
- **No notifications:** allow them in System Settings → Notifications → CAST. An ad hoc signed app may not be allowed
  to post them on every Mac; the menu-bar icon shows the same information.
- **Open at login fails:** move CAST to the Applications folder and open it from there.
- **"CAST stopped" on a Mac that downloaded the dmg, and the log is empty:** macOS may have blocked the programs
  inside the app (`cast-server`, `cast-agent`) even after you allowed CAST itself. Quit CAST, run
  `xattr -dr com.apple.quarantine /Applications/CAST.app` in Terminal (it removes the "downloaded from the internet"
  mark from the app you already chose to trust), and open CAST again.
- **macOS offers to install the "command line developer tools":** CAST uses git for your projects, and on a Mac
  without Apple's Command Line Tools `git` is only a placeholder that offers to install them. Install them; if you
  decline, projects still open, without git.
- **Notifications or folder permissions are asked again after a rebuild:** macOS ties some permissions to the app's
  signature, and an ad hoc signature changes with every build. Allow them again.
- **Check for Updates says there is no published release:** the repository has no release yet, it is private, or
  its release has no dmg attached. Releases must be public and carry `CAST-<version>-arm64.dmg`.
- **"CAST couldn't be updated":** `~/Library/Logs/CAST/update.log` has the steps. The CAST you had still works;
  install the new one by hand from the dmg in Downloads.

## For developers

| File | What it is |
|---|---|
| `CASTMenu/main.swift` | Entry point: the menu-bar app, or `--check` |
| `CASTMenu/MenuBar.swift` | Status icon, menu, status poll, notifications, Open at login, About, the update dialogs |
| `CASTMenu/ServerController.swift` | Finds, starts (with the contract's environment), restarts and stops the server |
| `CASTMenu/CastClient.swift` | Loopback HTTP: `/api/version`, `/api/pair`, `/api/status`, `/api/login-link` |
| `CASTMenu/SelfCheck.swift` | `CAST --check` |
| `CASTMenu/Paths.swift` | Data and log folders, private file writes |
| `CASTMenu/Updater.swift` | Check for Updates: the newest GitHub release, download, checks, staging the new app |
| `cast-install-update.sh` | Swaps in the new CAST.app once the app has quit, and opens it (copied into the app) |
| `Info.plist` | Template; `build-dmg.sh` fills in the version and the updates repository (`CASTUpdateRepository`) |
| `build-dmg.sh` | Builds the app and the dmg on the Mac |

The app uses only AppKit, Foundation, ServiceManagement and UserNotifications, and is compiled with `swiftc` from the
Command Line Tools (no Xcode project). `tests/mac/` checks the script, the Info.plist template and the Swift imports
on any machine, since the Swift code itself can only be compiled on a Mac.

The server is started with exactly this environment: `CAST_WEB_DIST`, `CAST_AGENT_BIN` (the app's
`Contents/Resources/cast-agent`), `CAST_PORT`, `CAST_LAUNCHED_BY=mac-app`, `HOME`, `USER`, `SHELL` (from the user
database), `LANG` (default `en_US.UTF-8`), `PATH` (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
plus your login shell's `PATH`) and macOS's per-user `TMPDIR`. With `CAST_DATA_DIR` set, the app and its server use
that folder instead (logs go to `<that folder>/logs`); the self-check uses this, together with `CAST_WORKSPACE`.

When the server exits with code 75 (it does after **Delete all CAST data** when the app started it), the app starts
it again at once; any other unexpected exit counts as a crash. `tests/mac/` compares these numbers and names with the
server's own constants (`server/startup.ts`, `server/auth.ts`, `shared/app-status.ts`).
