# Before publishing CAST

Decisions only the project's owner can make. Each one is left as a placeholder on purpose; this page lists them all
in one place, with where each lives and how to find it (`git grep` the marker).

## Only the owner can do these

- [ ] **Turn on GitHub private vulnerability reporting**: the repository's Settings → Security. `SECURITY.md` and the
      Code of Conduct send reports there (and to the maintainer's e-mail).
- [ ] **Apple notarization** of CAST.app: needs an Apple Developer account (below).

## Done in the publication pass

- [x] Private notes (`NEXT.md`, `JOBS.md`, `GRAPHICS.md`) stay on disk but are ignored by `.gitignore`, and
      `tests/repo/hygiene.test.ts` checks the file list git would publish (also in a folder that is not a checkout).
- [x] `bun run release:snapshot -- <out-dir>` exports one fresh commit, no history (see "The first public push").
- [x] Every web build writes `web/dist/THIRD-PARTY-LICENSES.txt`: the full licence texts of the npm packages built
      into the app (`scripts/release/third-party-licenses.ts`, run by `bun run build:web`). The Mac kit and dmg carry it
      with `web/dist`. The build fails when a package ships no licence file.
- [x] Quaternius licence evidence recorded in `THIRD-PARTY-NOTICES.md`.
- [x] Repository: `https://github.com/JirapatWov/cast-town` in `package.json` (`repository`, `bugs`; `homepage`
      `https://casttown.dev`) and the README's clone command. Help links to it, and the Mac app's Check for Updates
      reads it.
- [x] Mac bundle identifier `dev.casttown.cast` (the project's domain casttown.dev).
- [x] Security and Code of Conduct contact: the maintainer's e-mail, in `SECURITY.md` and `CODE_OF_CONDUCT.md` only.
- [x] Push fallback contact `https://casttown.dev` (`server/push/vapid.ts`).

## Placeholders to fill

| What | Where | Marker to search for | Until it is filled |
|---|---|---|---|
| Copyright holder | [`LICENSE`](LICENSE) (MIT) | `CAST contributors` | The licence is valid as is; put a person or organisation here if you prefer |
| Repository URL | [`package.json`](package.json) → `repository.url` | `JirapatWov/cast-town` | Done. Help links to its docs, issues and private security reporting (`web/src/ui/help-info.ts`). CAST.app's **Check for Updates…** installs this repository's GitHub releases (`build-kit.sh` → `build-dmg.sh` → Info.plist `CASTUpdateRepository`). Each release: tag `v<version>`, `CAST-<version>-arm64.dmg` attached, repository public ([mac/README.md](mac/README.md#updates)) |
| Code of Conduct contact | [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), section "Enforcement" | `CAST Code of Conduct` | Done: the maintainer's e-mail, or GitHub private reporting titled "Code of Conduct" |
| Private vulnerability reporting | GitHub → the repository's Settings → Security | (a setting, not text) | The reporting route in [`SECURITY.md`](SECURITY.md) and the CoC does not work until it is turned on |
| Security response promise | [`SECURITY.md`](SECURITY.md), section "Reporting a vulnerability" | `as soon as they can` | No response time is promised |
| npm publishing | [`package.json`](package.json) | `"private": true` | `npm publish` is blocked; CAST is installed from a clone, so this only matters if you want it on npm |
| The agent (cast-agent) in `agent/` | [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) (last section), [`CONTRIBUTING.md`](CONTRIBUTING.md) (cast-agent), [`agent/FORK.md`](agent/FORK.md) | `cast-agent` | CAST ships its own agent, a fork of omp v18.13.2 with the patches listed in `agent/FORK.md`; `bun run build` builds it. Keep the credits and the fork notes up to date when you port upstream fixes |
| 3D assets in git | `web/public/assets/` (about 108 MB, 229 files, listed in `MANIFEST.json`) | (size, not text) | A clone downloads all of it. Alternatives: Git LFS, or a release download step |
| Quaternius animations and characters | [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), "Quaternius licence evidence" | `Quaternius licence evidence` | Done: the bundled licence files and the author pages of all three packs say CC0, checked 2026-11-10; the notices record the URLs and the sha256 of the files. Re-check the pages if you replace the packs |
| Supported platforms | [`README.md`](README.md), under the opening screenshot | `Windows is not supported` | Linux first, macOS less tested, Windows only through WSL 2 |
| Mac app bundle identifier | [`mac/Info.plist`](mac/Info.plist) → `CFBundleIdentifier` | `dev.casttown.cast` | Done. It names the app to macOS (Open at login, notifications, the settings it keeps); changing it makes Macs treat CAST as a new app, and Check for Updates refuses an app with another id |
| Mac app signing and notarization | [`README.md`](README.md), "Mac app" → "The first launch" | `not notarized` | CAST.app is signed ad hoc: everyone right-clicks → Open the first time (System Settings → Open Anyway on macOS 15). Notarizing needs an Apple Developer account (paid, yearly) and a Developer ID certificate; then `build-dmg.sh` would sign with it, `xcrun notarytool submit` and `xcrun stapler staple` the dmg, and the README paragraph goes |
| Fallback push contact | [`server/push/vapid.ts`](server/push/vapid.ts) → `FALLBACK_CONTACT` | `https://casttown.dev` | Done. Sent to push services only when `CAST_PUSH_CONTACT` is unset and the device subscribed over plain http (127.0.0.1) |
| The agent's licence and third-party notices in the Mac kit | `scripts/mac/build-kit.sh`, `mac/build-dmg.sh` | `agent-LICENSE`, `agent-THIRD-PARTY-NOTICES.txt` | Done: the kit always ships `agent/LICENSE` and `agent/THIRD-PARTY-NOTICES.txt` as `agent-LICENSE` and `agent-THIRD-PARTY-NOTICES.txt` (the kit build fails without them), and `build-dmg.sh` refuses a kit without them and copies both into CAST.app's Resources, as `agent/FORK.md` asks for every copy |

## The first public push

- Publish from a fresh clone of the repository, never from a folder CAST has run in: an install from before the
  per-user data folder kept its pairing token, chats and uploads in `<repo>/data`. (`.gitignore` covers it, but a
  fresh clone is the sure way.)
- Run the checks: `bun run typecheck`, `bun run test` (it includes `tests/repo/hygiene.test.ts`: no personal paths,
  host names or e-mail addresses in tracked files, and the asset manifest matches the folder) and `bun run build`.
- Scan the history for secrets before the first push (for example `gitleaks detect`), since a test cannot see what
  an older commit contained.
- **Don't push the development history.** Older commits still name the owner's e-mail address, the machine and
  tailnet names and local scratch paths: they were removed from the files, not from the history, and a secrets scanner
  does not flag them. Publish one fresh commit instead: `bun run release:snapshot -- <empty-dir>`
  (`scripts/release/snapshot.sh`) copies exactly what `.gitignore` allows into a new repository with a single commit
  and no history, and refuses to run if `data/`, a pairing token, the private notes (`NEXT.md`, `JOBS.md`,
  `GRAPHICS.md`) or build output would be in it. Push that branch only. Inside a checkout, `git checkout --orphan
  public`, then `git commit -m "CAST 0.1.0"`, does the same but trusts your index; the script does not.
- Fill the repository URL above, then check that Help → "Documentation and bug reports" shows its links.

## A fresh install

Start a built CAST with a new, empty data folder (`CAST_DATA_DIR`, `CAST_WORKSPACE`) and without `CAST_MOCK_LLM`:

- [ ] The town is empty: no houses, and the workspace folder exists with nothing in it.
- [ ] No workflows are listed anywhere (Workflow tab, the new-job dialog, the library).
- [ ] The top bar shows **Connect AI**, and the welcome asks to connect an AI account first.
- [ ] Place a project: its lead's chat box is locked and points to Models & providers. Connect an account: the lead
      answers.
- [ ] Nothing listens on port 4871, and the data folder has no `omp-demo-agent` folder.
- [ ] The README screenshot `docs/images/cast-town.webp` matches the app (houses of your own, the top bar with
      **N live**, no "Demo" button). Retake it when the town or the top bar changes.

## The installed app on a real iPhone

Headless Chrome can't install CAST, receive a real push or show the iOS status bar, so check these by hand on an
iPhone (iOS 16.4 or later) over the `tailscale serve` address, after `bun run build` and a restart:

- [ ] Safari: pair with the QR code; Settings → Pair a phone → Install CAST on this device shows the Share → Add to
      Home Screen steps. Add it; the icon and the name "CAST" look right on the Home Screen.
- [ ] Open it from the Home Screen: no Safari bars, the status bar's text is readable over the town (dark and light
      theme) and nothing sits under the notch or the home indicator (top bar, bottom sheet, Settings' Done).
- [ ] It shows the private page with the field and the Home Screen note. In Safari, Copy a link for the app, paste
      it in the app: it opens CAST. Repeat on another device with the typed short code (lower case, dashes).
      Settings → Devices lists "Safari on iPhone (Home Screen app)".
- [ ] Settings → Notifications & app → Turn on: iOS asks once; Send a test notification arrives (also with the phone
      locked); tapping it opens CAST.
- [ ] Start something that needs your OK, then lock the phone: one notification "… needs your OK" within a few
      seconds; the icon badge shows the count; answering on the computer clears the badge.
- [ ] Turn on Airplane mode and open the app: "CAST can't be reached"; turn it off: CAST opens by itself.
- [ ] Deploy a new build with the app open: "CAST was updated" with Reload; ⋯ → Reload CAST works.
- [ ] Reset the app's cache works and the device stays paired. `CAST_SERVICE_WORKER=off` (restart) then removes the
      worker on the next open; turn it back on.
- [ ] On the Mac: CAST.app's Open CAST → Safari → File → Add to Dock; the Dock app opens and pairs the same way.
