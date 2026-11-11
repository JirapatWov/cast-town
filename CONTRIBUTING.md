# Contributing to CAST

Thanks for helping. Bug reports, fixes, docs, assets and features are all welcome. By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through private reporting, not issues
([SECURITY.md](SECURITY.md)).

For anything bigger than a small fix, open an issue first and say what you want to change and why, so nobody spends a
weekend on something that can't be merged.

## Set up

You need what the [README](README.md#install) lists (Bun 1.3.14 or newer, git). Then:

```bash
git clone <your fork's URL> cast
cd cast
bun install
bun run build        # the web app and the agent (cast-agent); the first agent build needs about 2 GB and network
```

Give your development server its own data and workspace, so it never touches the CAST you use every day:

```bash
export CAST_DATA_DIR=$PWD/.dev/data CAST_WORKSPACE=$PWD/.dev/workspace CAST_FS_ROOTS=$PWD/.dev
export CAST_PORT=4870    # a free port, if your own CAST runs on 4860
bun run start
echo "http://127.0.0.1:$CAST_PORT/?token=$(cat .dev/data/token)"    # open once to pair
```

(`.dev/` is in `.gitignore`.)

Without an AI account nobody can work. To work on agents without one, start with `CAST_MOCK_LLM=1 bun run start`:
while no account is connected, people then run on a local scripted model (scripted replies, real tool calls). Its code
changes are written for the two sample projects in `server/agents/demo/fixtures/`; on other folders it reads the code
and answers, but changes only a note. It listens on `127.0.0.1:4871` (`CAST_MOCK_PORT`; pick another, such as 4881, if
your own CAST uses that port). `CAST_MOCK_SPEED` sets its pace (2 = twice as fast), and `CAST_MOCK_LOG=<file>` and
`CAST_MOCK_DUMP_DIR=<dir>` record what it was asked. These are read only with `CAST_MOCK_LLM=1`, which is never set
for real use and never mentioned in the app. For UI work that doesn't need agents at all, `CAST_STUB_AGENTS=1`
replaces the whole agent system with a stub.

## Dev mode (hot reload)

`bun run dev` serves the web app from source on `http://127.0.0.1:5173` with hot reload and forwards `/ws`, `/term`
and `/api` to the CAST server on this machine (on `CAST_PORT`, default 4860). Keep a server running as above, then:

1. pair the browser on the **server's** port first (`http://127.0.0.1:4870/?token=…`). Cookies are not tied to a
   port, so the session also works on `127.0.0.1:5173`. Use the same host name for both (`127.0.0.1`, not
   `localhost` for one and `127.0.0.1` for the other);
2. open `http://127.0.0.1:5173`.

Server code is not hot-reloaded: restart `bun run start` after changing `server/` or `shared/`.

`web/dev/*.html` are harness pages for single modules (`/dev/city.html`, `/dev/house.html`, `/dev/people.html`,
`/dev/ui.html`) with URL parameters documented at the top of each `.ts` file. They are not part of the build and are
not type-checked, so some have fallen behind the code. `ui.html` talks to `web/dev/ui-mock-server.ts`, whose fake data
predates jobs and threads. Fix what you need when you use one.

## Checks

Every pull request must pass the same checks CI runs (`.github/workflows/ci.yml`):

```bash
bun run typecheck    # tsc over shared/, server/ and web/src/
bun run test         # bun test tests (no agent build, no network, no AI account needed)
bun run build:web    # production build of the web app (and web/dist/THIRD-PARTY-LICENSES.txt)
```

CI also does the README's install on a clean machine: `bun install`, `bun run build` (the web app and the agent),
`agent/bin/cast-agent --version`, and a server start with a throwaway data folder that must answer `/api/health`.

[tests/README.md](tests/README.md) explains what is where, how to run one test, golden files, and how to write a new
test. Add a test for every bug fix and for new logic that has no DOM. Tests must not depend on your machine: no
absolute paths of your own, no `~/.omp`, no running CAST, no network.

The browser UI has no automated tests. For any change you can see, check it by hand at a desktop size (around
1440×900) **and** a phone size (around 390×844, for example a phone in your browser's device toolbar), with no errors
in the console. Describe what you checked in the pull request, with a screenshot if it changes the look.

`bun run typecheck` checks two programs: the app and server (`tsconfig.json`) and the service worker
(`web/sw/tsconfig.json`, with the worker's own types). `bun run build:web` builds the worker into `web/dist/sw.js` as one
classic script and stops if it is not one; `CAST_BUILD_ID` fixes the build id it carries (default: a fresh one per
build, so every build's worker differs and takes over).

Checking the installed app (manifest, service worker, offline page, notifications) in a browser you drive with
Playwright or Puppeteer:

- Service workers need a secure context: use `http://127.0.0.1:<port>` or https, not a LAN address. They don't run
  in the Vite dev server (`bun run dev`): check against a built `web/dist`.
- Give Chromium a short `TMPDIR` (for example `TMPDIR=/tmp/cast-pw`). Its sockets live there, and a long path makes
  it fail to start or lose its service worker process.
- Use a persistent profile (`launchPersistentContext`) to ask Chrome whether CAST is installable
  (`Page.getInstallabilityErrors` over CDP). `Emulation.setSafeAreaInsetsOverride` gives a page the iPhone's notch
  and home-indicator insets; `setEmulatedMedia` does not apply `display-mode: standalone` to CSS.
- Headless Chrome has no push service: stub `PushManager.prototype.subscribe` to return an endpoint on a local fake,
  start CAST with `CAST_PUSH_EXTRA_ENDPOINTS=http://127.0.0.1:<fake port>`, and hand a payload to the worker with
  CDP `ServiceWorker.deliverPushMessage`.

## cast-agent (the agent in agent/)

The agent CAST runs is cast-agent, a fork of omp kept in `agent/`. CAST talks to it over its RPC mode
(`cast-agent --mode rpc-ui`) and is tested with one exact version: `OMP_TESTED_VERSION` in
[`shared/omp-version.ts`](shared/omp-version.ts). The server warns when another version runs, and the app shows a
banner. The agent keeps omp's internal name, so `agent/bin/cast-agent --version` prints `omp/<version>`.

- Change the agent's files in `agent/` and list every change to upstream's files in
  [`agent/FORK.md`](agent/FORK.md) → Patches.
- Run its own tests in the package you changed: `cd agent/packages/<package> && bun test`.
- Rebuild it with `bun run build:agent`.
- `bun run compat:agent` runs `scripts/omp-compat/` against `$CAST_AGENT_BIN`, else `agent/bin/cast-agent`: about 95
  seconds against a scripted model, no keys needed. It checks every agent behaviour CAST relies on. Run it after every
  agent change and before you move the pin (`--omp <path>` tests another build).
- To move the pin: run the suite against the new version, fix what fails, then change `OMP_TESTED_VERSION` (every
  hint in the app and the docs uses it, and a test fails if a doc pins another version).
- Models & providers lists every sign-in the agent's `login` offers, from `shared/omp-login-providers.ts`. That file
  is made from the agent's source in `agent/`: run `bun run gen:omp-logins` when sign-ins change.
  `tests/providers/omp-login-providers.test.ts` compares it with the agent's real `login` menu when it can run one.
- `tests/auto/p3-helpers.test.ts` reads the agent's source in `agent/` (see tests/README.md). Without it, the test is
  skipped.
- To port a fix from upstream omp, follow [`agent/FORK.md`](agent/FORK.md).
- To run another build of the agent, point `CAST_AGENT_BIN` at it.

## Code style

- **TypeScript everywhere, no UI framework, no new dependencies** unless there is no reasonable alternative (talk about
  it in an issue first). The web app is plain DOM: build elements with `h()` and friends from
  [`web/src/ui/dom.ts`](web/src/ui/dom.ts), styles live in `web/src/ui/css/`.
- **Comments say why**, not what: the constraint, the bug it avoids, the trade-off. Every file starts with a comment
  saying what it is for. Keep them true when you change the code.
- **Contracts:** `shared/protocol.ts` is the WebSocket contract between server and web app. Changes must be additive
  (new optional fields, new message types) so an older page keeps working with a newer server, and the other way
  round. Validate every new client message in `server/validate.ts`.
- **Talking to the server from the page:** always build URLs with `apiUrl()` / `wsUrl()` from
  [`web/src/net/base.ts`](web/src/net/base.ts), never a bare `'/api/…'`. The same page also runs under `/city/<id>/`
  when it shows another machine's city.
- **Browser storage:** use `storage` (per city) or `deviceStorage` (per device: graphics, onboarding, accessibility)
  from `web/src/ui/dom.ts`, never `localStorage` directly.
- **Colours and sizes:** colours come from the tokens at the top of `web/src/ui/css/base.css`, which has a dark and a
  light set (`<html data-theme>`, set by `web/src/ui/theme.ts`); a colour that must not follow the theme carries a
  `/* theme: fixed — why */` note. Text sizes, and the spacing that grows with text, are in `rem` so the browser's
  font-size setting applies. `tests/a11y/theme.test.ts` checks both, and the contrast of every token (AA).
- **Data on disk:** only ever add fields. Old files must keep loading, and nothing is migrated destructively. Write
  files atomically (temporary file, then rename) and secrets with mode 0600. Never log tokens, cookies, keys or
  e-mail addresses.
- **UI text** is English, short and plain: say what happens, avoid jargon ("Sign in", not "Authenticate"). Every
  action must be reachable without the 3D view (2D panels, the palette, the keyboard) and must work on a phone.
  Keyboard shortcuts go into the list in `web/src/ui/help-info.ts` so Help shows them.
- **Internal names:** CAST used to be called Real Life Terminal, so internal ids say `rlt`: `RLT_*` environment
  variables (each also accepts `CAST_*`), `rlt.*` storage keys, `rlt_*` cookies, `.rlt/` folders, `refs/rlt/*`,
  `window.__rlt`. Keep them as they are: renaming them would break existing installs. User-facing text always says
  CAST.
- Format like the surrounding code (2 spaces, single quotes, semicolons, lines up to about 140 characters).

## Assets

Everything under `web/public/assets/` must have an entry in `web/public/assets/MANIFEST.json` (source URL, licence,
download date, the processing applied) and a line in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Only add
assets under CC0, CC BY, MIT or a similarly permissive licence that allows redistribution, and keep the author's
licence file next to them. A test checks that the manifest and the folder match. Keep files small (meshopt-compressed
GLB, WebP or KTX2 textures at the resolution actually needed): every megabyte is downloaded by every first visitor.
The offline pipelines are in `tools/` (avatars: `tools/characters/README.md`; tree textures:
`tools/city/build-tree-textures.mjs`; the iOS launch images in `web/public/splash/` and their `<link>` tags in
`web/index.html`: `bun tools/splash/launch-images.ts --dark-only`, rerun whenever the boot screen's first frame changes).

## Pull requests

- One topic per pull request, with a description of what changes for the user and why.
- Checklist:
  - [ ] `bun run typecheck`, `bun run test` and `bun run build` pass;
  - [ ] new logic and bug fixes come with tests;
  - [ ] UI changes checked at desktop and phone size, no console errors, screenshots attached;
  - [ ] user-facing changes are in the README (and Help, for new shortcuts);
  - [ ] new assets are in `MANIFEST.json` and `THIRD-PARTY-NOTICES.md`;
  - [ ] no secrets, personal paths, host names or e-mail addresses in code, tests, logs or screenshots.
- By sending a pull request you agree that your contribution is licensed under the project's [MIT licence](LICENSE).

## Maintainers: before the first public release

Everything the owner still has to decide (the Code of Conduct contact, private vulnerability reporting, Apple
notarization, the Mac bundle id, …) is listed in one place, with where each placeholder lives:
[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).

- **Publish a fresh tree, never the working folder's history.** `bun run release:snapshot -- <empty folder>` makes a
  new repository there with one commit of exactly what `.gitignore` lets through, and refuses when runtime state
  (`data/`, a `token`) or the maintainers' private notes (`NEXT.md`, `JOBS.md`, `GRAPHICS.md`, ignored by git) would
  go in. `tests/repo/hygiene.test.ts` checks the same file set.
- **Licences travel with the build.** `bun run build:web` also writes `web/dist/THIRD-PARTY-LICENSES.txt` (the full
  licence texts of every bundled dependency), so the Mac kit and the dmg carry it. It stops the build when a dependency
  has no licence information.
- **Releases:** bump `version` in `package.json` and push the tag `v<version>`; `.github/workflows/release.yml` builds
  the dmg on an Apple Silicon runner and attaches it to the GitHub release, which the Mac app's **Check for Updates…**
  installs ([mac/README.md](mac/README.md#updates)).
