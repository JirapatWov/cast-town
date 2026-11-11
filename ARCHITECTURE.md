# CAST architecture

A map for contributors: what runs where, which module owns what, and the rules that keep the pieces apart. For
installing and using CAST see the [README](README.md); for workflow and style see [CONTRIBUTING.md](CONTRIBUTING.md).

CAST used to be called Real Life Terminal, so internal ids say `rlt` (`RLT_*` env, `rlt.*` storage keys, `.rlt/`,
`refs/rlt/*`, `window.__rlt`, the `[rlt-role:…]` marker). They stay for compatibility. Everything a person reads says
CAST.

## The big picture

```
 browser                                     server (Bun, one process)                       per person
┌──────────────────────────┐   /ws  JSON   ┌───────────────────────────────────────┐  stdio  ┌──────────────────┐
│ web/src/main.ts          │◀────────────▶│ server/index.ts  auth · static · hub  │◀──────▶│ cast-agent rpc-ui │
│  net/   store, socket    │   /term PTY   │ server/dispatch.ts → core services    │  JSONL  │  (cwd = project)  │
│  ui/    DOM panels       │◀────────────▶│ server/agents/   agent system         │         └──────────────────┘
│  engine/ city/ house/    │  /api/files   │ server/terminal.ts plain shells       │              │ HTTPS
│  people/ player/  three  │  /api/uploads │ git, files, uploads, jobs, city store │              ▼
└──────────────────────────┘               └───────────────────────────────────────┘   the model's provider (an AI account)
```

- **One WebSocket (`/ws`)** carries everything live: the server sends `hello`, then a `snapshot`, then deltas; the
  page sends commands, each with a `reqId` that gets exactly one `ack`. The contract is
  [`shared/protocol.ts`](shared/protocol.ts).
- **Terminals** use one WebSocket per tab at `/term` ([`shared/terminal-protocol.ts`](shared/terminal-protocol.ts)).
- **Files and images** go over plain HTTP: `/api/files/<key>/…` for the file viewer (the key is the capability) and
  `/api/uploads` for chat images.
- **Each person is an agent process** (`cast-agent --mode rpc-ui`), started on their first message, in the project
  folder (or their job's own copy), stopped after 10 idle minutes; at most 10 run at once. The agent is cast-agent in
  `agent/`, CAST's fork of omp (see [agent/FORK.md](agent/FORK.md)).
- **Without an AI account nobody works:** CAST starts no agent for a person whose model has no credentials and says
  which account to connect. Only for tests and development, `CAST_MOCK_LLM=1` points such a person's agent at a
  scripted OpenAI-compatible model served by the CAST server itself (the tools the agent calls are still real).

## Repository layout

| Path | What |
|---|---|
| `shared/` | Code used by both sides: `protocol.ts` (the wire contract), `terminal-protocol.ts`, `city-layout.ts` (roads, lots, landmarks), `house-plan.ts` (floors, rooms, stairs), `omp-version.ts` (the tested agent version and build hint), `omp-login-providers.ts` (every sign-in the agent's `login` offers, generated), `brand.ts` |
| `server/` | The Bun server (no framework). `index.ts` wires everything |
| `server/agents/` | The agent system: people, agent processes, chats, approvals, teams, models, and the scripted test model |
| `web/` | The web app (Vite + TypeScript + three.js, no UI framework). `index.html`, `src/`, `public/` (icons, `assets/`) |
| `web/public/assets/` | 3D models, animations, textures, skies. Every file is listed in `MANIFEST.json` |
| `web/dev/` | Harness pages for single modules (dev server only, not built, not type-checked) |
| `tests/` | `bun test` suites, see [tests/README.md](tests/README.md) |
| `agent/` | cast-agent, the agent CAST runs (a fork of omp; build with `bun run build:agent`, see [agent/FORK.md](agent/FORK.md)) |
| `scripts/omp-compat/` | Checks an agent build against everything CAST relies on (`bun run compat:agent`) |
| `scripts/gen-omp-login-providers.ts` | Writes `shared/omp-login-providers.ts` from the agent's source in `agent/` (`bun run gen:omp-logins`) |
| `tools/` | Offline asset pipelines: `characters/` (avatars), `city/` (tree textures), `splash/` (the iOS launch images: the boot screen's first frame per screen size) |

## Server

### Request flow (`server/index.ts`)

1. `/api/health` answers without auth.
2. `/api/files/…` is authorised by the key in its path (sandboxed pages load their CSS and images without a cookie).
3. Everything else goes through `auth.check` (`server/auth.ts`): a paired device session, the pairing link
   (`?token=` → redirect with a session cookie), or a Tailscale login when that is configured. WebSocket upgrades and
   uploads must also come from the page's own origin.
4. `/term` and `/ws` upgrade to WebSockets; `/api/uploads` stores or serves images; other `/api/*` is 404; the rest is
   the built web app (`server/static.ts`: SPA fallback, gzip, long cache for hashed files).

On `/ws` open the server sends `hello` (versions, agent status, and `demoMode`: true only with the scripted test model)
and `snapshot`; `server/hub.ts` keeps the connected pages and fans broadcasts out. Incoming messages are validated
(`server/validate.ts`) and routed (`server/dispatch.ts`): the core handles city, project, job, git and folder messages
itself and hands the rest to the agent system.

### Core modules

| Module | Owns |
|---|---|
| `config.ts` | Settings from the environment and `<data dir>/config.json` (README → Configuration) |
| `auth.ts` | Pairing token, device sessions, Tailscale identity, origin checks, the 403 page (`pages.ts`) |
| `devices.ts`, `device-sockets.ts` | Device sessions in `devices.json` (hashed secrets, one-time pairing codes, token rotation) and closing a revoked device's sockets |
| `startup.ts` | First-start folders, the startup banner (never the token), risky-setup warnings, `listen.json` for `bun run pair` |
| `data-routes.ts`, `data-wipe.ts` | Settings → Devices / Delete all data endpoints, and the wipe-and-restart itself |
| `city-store.ts` | `city.json`: projects and the lots they stand on |
| `projects.ts` | Place, create, move and remove projects (one project per lot, one house per folder, folder confinement) |
| `project-templates.ts` | Starter files for a new project (empty folder, Bun API, novel). The first start creates no projects |
| `job-store.ts`, `jobs.ts` | `jobs.json` and the rules for jobs, rooms and floors |
| `worktrees.ts` | A job's own copy of the files: a git worktree under `<data dir>/worktrees/<project>/<job>` |
| `git.ts`, `exec.ts` | Git summary and diff for the TV and Changes tab, checkpoints and reverts, job branches; a deleted own-copy job keeps its base as `refs/rlt/leftover/<branch>` so Changes can bring the branch in exactly; **Undo changes** in the house folder keeps what it removes under `refs/rlt/discarded/<ms>` (the last 20) for **Bring back** |
| `fs-browse.ts` | The folder picker (only below the allowed roots, realpath-checked) |
| `files.ts` | The file viewer: listings, file serving, the sandbox and CSP for `.html` pages |
| `uploads.ts` | Chat and tool images, content-addressed under `<data dir>/uploads/` |
| `terminal.ts` | Plain login shells in a PTY per place (not the agent), kept across reconnects with 1 MB of scrollback |
| `data-layout.ts` | Where each person's sessions and transcripts live under the data folder |
| `contracts.ts` | The seam between the core and the agent system |
| `pwa.ts` | The installed app's public files (manifest, icons, `/sw.js`; `CAST_SERVICE_WORKER=off` swaps in a worker that removes itself) |
| `push/` | Web Push: `ece.ts` (RFC 8291 aes128gcm) and `vapid.ts` (RFC 8292) on `node:crypto`, `store.ts` (`push.json`), `send.ts` (known push services only), `notifier.ts` (when to tell which device: debounce, presence, caps, generic text), `routes.ts` (`/api/push…`) |

**Git safety.** Checkpoints are written with a temporary index (`GIT_INDEX_FILE`) and `commit-tree`, and stored as
`refs/rlt/checkpoints/<runId>`. A revert restores that tree into the folder and removes files the checkpoint doesn't
have. Neither touches `HEAD`, branches or the user's index. **Undo changes** (Changes tab, a chat turn's card) first
commits what it removes onto a `refs/rlt/discarded/` ref, never acts through a symlink, and leaves ignored files,
`.git`, nested repositories and everything outside the house folder alone; it resets the index only for the paths it
puts back. `.rlt/` (team-run notes) is excluded through
`.git/info/exclude` and from every diff.

### More than one machine (cities)

The server the browser is paired with is the hub. It stores the other servers in `<data dir>/cities.json` (session
cookies, never pairing tokens) and reverse-proxies `/city/<id>/…` (HTTP and WebSocket) to them, stripping the
browser's cookies and auth headers on the way out and every `Set-Cookie` on the way back. `/api/version` says which
features a server has. The web app of a city is served through the proxy too, so each city runs the page that matches
its own server. In the page, `web/src/net/base.ts` turns paths into URLs under the right prefix (`apiUrl`, `wsUrl`,
`hubUrl`), and `storage` / `deviceStorage` in `web/src/ui/dom.ts` keep per-city and per-device settings apart.

The hub's own town is "Home" (named by `cityName` / `CAST_CITY_NAME`, default the host name). Other machines are added
from the top bar's `#city-switcher` → Add a city… (address + that machine's pairing link or token). Types and the hub
API: `shared/cities.ts`.

- **Pairing** (`server/cities.ts`): the hub checks `GET <url>/api/version` (`app: 'cast'`, feature `city-proxy-v1`, a
  different `instanceId` than its own), then pairs server-to-server with `POST /api/pair` (a device session; a server
  without it is refused, so a pairing token is never stored) and keeps only that cookie in `<dataDir>/cities.json`
  (0600, atomic). Status probes (`/api/version` with the cookie: `paired` says whether it still works, answered from
  that request's single auth decision) are cached ~10 s.
- **Proxy** (`server/city-proxy.ts`, routes in `server/city-routes.ts`): `/city/<id>/<rest>` → `<city>/<rest>`, HTTP
  (streamed, redirects not followed, gzip passed through) and WebSocket (the city's socket opens first, then the browser's
  is accepted and bridged frame by frame). Only signed-in requests, except `/city/<id>/api/files/<key>/…` (the key is the
  auth, like the hub's own files; forwarded without any cookie). Dropped on the way in: Cookie, Authorization, `Tailscale-*`,
  `X-Forwarded-*`, Origin, Referer, the hub's `?token=`; on the way out: every Set-Cookie (a session upgrade is adopted by
  the hub instead), HSTS/Clear-Site-Data/NEL/Service-Worker-Allowed; Location stays under `/city/<id>/`; files/uploads
  always end up CSP-sandboxed. Writes and WebSocket upgrades pass the hub's Origin check (the city can't see the Origin).
  An unreachable city answers page loads with an "is offline" page and everything else with 502 JSON.
- **Client**: the city's own server serves its own web app through the proxy (Vite `base: './'`), so each city runs the
  app of its version. Every request to *this* city's server goes through `apiUrl`/`wsUrl` (`web/src/net/base.ts`);
  the hub's list through `hubUrl` (`web/src/net/cities.ts`). Per-city browser state uses `storage`, device preferences
  `deviceStorage` (`web/src/ui/dom.ts`). AI accounts are never shared: each city's Models & providers is that machine's
  agent talking about its own sign-ins ("Accounts on <city>" when there is more than one city).

## Agent system (`server/agents/`)

`createAgentSystem` (`index.ts`) finds the agent (`resolveOmpBin`), checks its version (with `CAST_MOCK_LLM=1`, it also
starts the scripted test model) and builds `AgentSystemImpl` (`agent-system.ts`), which owns everything below.

| Module | Owns |
|---|---|
| `residents.ts` | Who lives in a house: per job, a lead plus one person per step of the job's team. Every person knows the other jobs and stays in scope |
| `agent-store.ts` | Server-side mirror of every person and transcript; throttles streaming (≤10 updates/s per person) |
| `agent-runtime.ts`, `empty-answer.ts` | One person's life: start, prompt, events → activity, errors, restarts; a model that keeps sending back empty answers gets one card with the way out (another model, a nudge) |
| `turn-changes.ts` | **Undo this turn's changes**: the house folder is snapshotted before and after a chat turn (`refs/rlt/turns/`, the newest 50 turns); a turn that changed files gets a card, undone only while none changed again since and nobody else worked there |
| `omp-process.ts`, `process-pool.ts` | Spawning the agent in its own process group, the RPC handshake, idle stop and the cap on live processes |
| `normalize.ts`, `tool-display.ts` | Agent frames → activities, transcript items and tool cards |
| `approvals.ts`, `auto-review.ts` | Approval cards, and the rules of **Auto** mode (what counts as risky) |
| `thread-store.ts`, `session-import.ts` | Chats per person (`threads.json` + one transcript per chat); old agent sessions imported as chats |
| `subagents.ts`, `helper-agents.ts` | The agent's task-tool helpers as people walking in; helper agent definitions per connected model |
| `lead-tools.ts`, `plan-gate.ts` | The lead's team tools (design and start teams from chat) and the plan card that waits for **Run** |
| `workflow-engine.ts`, `workflow-store.ts`, `templates.ts`, `verdict.ts` | Team runs: checkpoint, steps, hand-offs, review loops, verdict parsing, revert. Saved teams (`workflows.json`) belong to one house each: made there or imported there, only that house lists and runs them. CAST ships no teams: `templates.ts` only renders step instructions (`{{task}}`, `{{prev}}`, `{{runDir}}`, `{{feedback}}`) and holds the review verdict footer, and `legacy-examples.ts` keeps the two teams older versions shipped, read by the one-time move that gave them to the houses using them (and by the scripted test model). The shared library holds copies a house promoted; any house imports a copy (its own from then on). Every lookup is house + id (`shared/house-workflows.ts` gives the page the same view) |
| `models.ts`, `provider-accounts.ts`, `provider-login.ts`, `login-failure.ts`, `account-order.ts`, `credential-key.ts`, `credential-watch.ts` | Which models have credentials (`cast-agent models`, each extra naming the sign-in it runs through), sign-in from the browser and its failures in plain words, accounts and their limits; the model and account lists are kept while `credential-key.ts` (a hash of the agent's stored sign-in rows, never their secrets) and the extra environment are unchanged; `credential-watch.ts` notices sign-ins made outside CAST (stat, then a read-only look at the store) |
| `omp-env.ts`, `google-auth.ts` | Extra environment for every agent child from `config.json` `ompEnv` (Google Cloud project, Gemini API key; the server's env wins, an idle agent restarts on its next message), Google sign-in failures in plain words, the pasted-key check |
| `mock-llm.ts`, `demo/`, `demo-scripts.ts`, `demo-agent-dir.ts` | The scripted test model, only with `CAST_MOCK_LLM=1` (tests and development): scripted replies but real tool calls; its code changes are written for the two sample projects in `demo/fixtures/` |

**Process model.** One agent per (project, job, role): `cast-agent --mode rpc-ui --model <id> --approval-mode …
--resume <current chat's session> --append-system-prompt <persona + [rlt-role:<role>]>`, spawned `detached` so the
whole process group can be stopped. Changing a lead's brief, kind or model restarts that agent with the same session.

**Ids.** People are `${project}:${role}` for the Main job, `${project}:${job}:${role}` for other jobs and
`${project}:sub:${n}` for helpers. The page never parses ids; it reads `projectId`, `jobId` and `roleId`.

**Connected or not.** The agent lists only models it has credentials for. A person whose model has none can't work:
CAST starts no agent for them and refuses their messages, compacts, goals and team runs with a message that says which
account to connect (`#notConnected` in `agent-system.ts`, `#checkModels` in `workflow-engine.ts`). Each person's
`AgentInfo.notConnected` carries the same answer to the page, which locks the chat and marks the name tag on it (the
page's model list is capped, so it can't decide this itself; helpers are never locked). While the first check runs, a
message waits for it. CAST never silently swaps a model for another vendor's. Only with
`CAST_MOCK_LLM=1` (`ModelRegistry` `{ scripted: true }`, `demoActive()`) and nothing connected does such a person run
on the scripted model (`demo: true`, `PI_CODING_AGENT_DIR` pointed at a settings folder whose `models.yml` maps every
model id to the mock).

**Activities.** Agent events become what the person does in the house:

| Activity | From | Station | Animation |
|---|---|---|---|
| listening | a prompt arrived | middle of the room, facing you | Idle_Talking_Loop |
| thinking | first text delta, todo tools | pacing by the corkboard | Walk_Formal_Loop / Idle_FoldArms_Loop |
| reading | read, grep, find, ls, lsp, ast tools | bookshelf | Interact |
| writing | edit, write, apply_patch, notebook | desk, seated | Sitting_Talking_Loop + typing |
| running | bash, exec, eval, python | kitchen counter or workbench | Idle_Rail_Loop / Fixing_Kneeling |
| searching | web search, fetch, browser | window or sofa | Idle_TalkingPhone_Loop |
| delegating | task (helpers) | corkboard | Idle_Talking_Loop |
| waiting_approval | an approval is pending | steps out, amber ring | Idle_Rail_Call |
| error / done | failed / finished | stays | Idle_No_Loop / Yes |
| chore (helpers) | while a helper works | sink, vacuum path, plants, washer | various |

A person keeps a station for at least 1.2 s, so fast tool sequences don't make them run around.

## Jobs, rooms, floors and chats

A **job** is a separate line of work in one project folder: its own lead, team, chats and runs. One job is one
**room**: floor 0 has room 1A, each upper floor a corridor, a stairwell and rooms A–D (`shared/house-plan.ts`, up to 5
floors). `server/job-store.ts` enforces the rules (unique names, the room exists and is free, at least one job, ids
never reused). Every house has a `main` job, which keeps the original on-disk layout
(`sessions/<project>/<role>`); other jobs live under `…/<project>/jobs/<job>/<role>` (`server/data-layout.ts`).

A job can have its **own copy** of the files (a git worktree on branch `rlt/<project>/<job>`), chosen when it is
created. Everything that works "in the job's folder" asks `jobDir()` for the path, so people, the terminal, the file
viewer and git all follow the copy.

**Chats** (threads): per person, `threads.json` lists the chats and which is current, and each chat has its own
transcript. New and reopened chats drive the agent's `new_session` / `switch_session`; the agent always starts with
`--resume` on the current chat, so the model remembers it and it survives a restart.

## Web app (`web/src/`)

`main.ts` boots the app (loading screen in `boot.ts`), runs the view state machine (city ⇄ house ⇄ drive) and
connects the store to the 3D views. Modules code against the interfaces in `core/types.ts`. Everyone holds the engine
through a slot (`engine-slot.ts`): a flat stand-in until the WebGL engine is built, so a Board start (remembered per
device, or `?2d`; `ui/view-mode.ts`) and a browser without WebGL never build the 3D town, and switching to 3D builds
it then (the house view and the avatar come later still: "Loading order" below). A 3D start shows the 2D shell first:
the first chunk holds the UI and no three at all, the town builds in the background, and if it isn't ready about 3 s
after the page started (`STAND_IN_MS`) the splash lifts onto the Town board, which says how far the town is; the town
takes over when it is ready unless the person picked the board meanwhile (`threeD.wanted`).

| Folder | What |
|---|---|
| `net/` | `socket.ts` (reconnect with backoff), `store.ts` + `reducer.ts` (the client mirror of the server state), `requests.ts` (reqId → promise), `bus.ts` (UI ⇄ 3D events), `files.ts`, `uploads.ts`, `base.ts` (URLs per city) |
| `ui/` | Every DOM panel: `index.ts` creates them, `shell.ts` is what panels may ask of each other, `topbar.ts`, `sidepanel.ts`, the chat (`chat-tab.ts`, `composer.ts`, `transcript.ts`), jobs, workflows, approvals, palette, Help (`help.ts`, `help-info.ts`), Settings (`settings.ts`), terminal, file viewer, onboarding. Keyboard and screen-reader plumbing: `shortcuts.ts` (the one shortcut list, contract C5), `focus.ts` (focus never falls to `<body>`), `radios.ts` (option groups), `announce.ts` (live region), `a11y-prefs.ts`, `theme.ts` (System / Dark / Light: `<html data-theme>` swaps the colour tokens in `css/base.css`; `index.html` applies it before the first paint). Small pure copy and layout helpers sit beside their panels: `welcome-copy.ts` (the first-run cards), `wipe-text.ts` (Delete all data, worded for a city opened through a hub), `team-default.ts` (the Team heading, and its note for a job without a team), `path-line.ts` (a folder path cut from the start so the folder name stays). `dom.ts` has `h()`, storage helpers and other DOM utilities; `layers.ts` makes `Esc` close the top-most thing and `nav-history.ts` makes the browser's Back close it too (dialogs and the phone sheet first, then house → town); styles in `ui/css/` |
| `engine/` | Renderer, post-processing (N8AO, depth of field, bloom, AgX, grade, SMAA), lighting, skies and time of day, interior light-probe GI, asset loading, quality presets |
| `city/` | The town: ground, roads, lots, buildings (project houses grow a storey per floor), trees (an EZ-Tree port with 3 LODs and wind), grass, props, labels, camera rig, the drivable car; `decor-fade.ts` turns a decor building that hides a user's house see-through; `framing.ts` turns and steps the start view back until the user's houses fit a narrow (upright phone) screen |
| `house/` | The dollhouse interior: ground floor, upper floors with job rooms furnished by kind (`rooms/`), stairs, stations, navigation grid, the TV (live diff), corkboards |
| `people/` | Avatars (Microsoft Rocketbox, retargeted animation clips), activities → stations and clips, walking, name tags |
| `player/` | The homeowner ("You"): follows what you do, look picker. `character-api.ts` is its only door into `people/` |
| `pwa/` | The installed app, from the page: service worker registration and updates, the icon badge, Web Push for this device, launch routing (shortcuts, notification taps), install help |
| `../sw/` | The service worker (`web/sw/`, its own TypeScript program, built into `web/dist/sw.js`): network-first pages with an offline page, cache-first hashed chunks, push → notification |

**Rules of the web app**

- Every action must be possible without 3D: panels, the palette and the keyboard drive everything, and the Board
  pauses (or never starts) the renderer.
- Animations follow real agent state and never block work: clicking a person opens the chat at once while the avatar
  walks over.
- No UI framework. Plain DOM with `h()`, one module per panel, CSS per area in `ui/css/`.
- URLs to this city's server come from `apiUrl()` / `wsUrl()`; settings go through `storage` or `deviceStorage`.

**Graphics budgets.** Every effect has a per-quality setting (`QUALITY_PRESETS` in `engine/quality.ts`: shadow cadence
and range, GI probes and budget, depth of field, grass, LODs). Targets, counting shadow passes: Low ≤ 250 draw calls
and 0.8 M triangles, Medium ≤ 400 and 1.5 M, High ≤ 600 and 2.5 M. Interiors merge static meshes per material per room
and per floor (`house/batch.ts`) to stay inside them. `window.__rltEngine.debug.frame()` prints the last frame's
totals. Keep new assets small: textures ship as WebP with `512/` copies for phones (`node tools/assets/slim.mjs`;
`tests/perf/assets.test.ts` checks that every PBR set has them).

**Loading order and frame pacing.** The boot loads the city only (about 12 MB; a phone starts on the Board and loads none of it until it switches to 3D); the 2k sky and the parked car load after the town is on show (`core/town-shown.ts`); the house view and
avatar are a lazy chunk (`web/src/interior.ts`) whose furniture loads on intent (`building:hover`, a click, a deep
link); the indoor HDRI loads with the first house; only the sky on show loads (Auto prefetches the next one 10 min
ahead, desktop). `engine/frame-pacing.ts` renders at full rate while anything moves, 30 fps idle and 15 fps in the
background; consistently slow frames at 1× resolution → `onQualityAdvice` → `ui/auto-quality.ts` steps the preset down
once with an Undo toast. Vendor chunks: `three`, `postfx` (postprocessing + n8ao); the renderer and the city
(`engine/`, `city/`, imported by `build3D` in `main.ts`, so a Board start never downloads them), xterm, highlight.js,
diff2html and the interior are dynamic chunks. Nothing the first chunk imports may import `three` (that would make the
whole UI wait for it): the boot tracker gets three's loading manager from `engine/` when the town starts building, and
the models the name tags count as connected live in `people/tag-state.ts`. Text assets are served brotli-compressed with
long caching for `/assets` and `/fonts` (`server/static.ts`).

**Visual direction.** Frosted dark glass panels over the 3D view, warm off-white text, vendor colours as accents
(`VENDOR_COLORS` in `shared/protocol.ts`), amber for "needs you", Inter / IBM Plex Sans Thai / JetBrains Mono, motion
of 150–220 ms. Panels never cover the middle of the screen by default; on phones the side panel is a bottom sheet. UI
text is English; user content is often Thai, so fonts must render it well.

## Data on disk

| Where | What |
|---|---|
| `<data dir>/city.json`, `jobs.json`, `workflows.json` | The town, jobs, saved teams: per house plus the shared library (`{version: 3, houses, library}`) (atomic writes, only ever extended) |
| `<data dir>/workflow-bases.json` | Each house workflow's base for merging a lead's save with the user's hand edits, and when a person's model or effort was set by hand |
| `<data dir>/workflows.v1.json`, `workflow-bases.v1.json` | The files from before workflows belonged to houses, kept as they were when the first start moved each workflow to the houses that use it (or to the library) |
| `<data dir>/workflows.v2.json` | The file from before CAST stopped shipping example teams, kept once (never overwritten) when the first start of that version gave each house that used one (its team, a job's team or a run) its own copy, with the same ids |
| `<data dir>/token`, `devices.json`, `cities.json`, `config.json` | Pairing token, device sessions, added cities, settings (mode 0600) |
| `<data dir>/sessions/`, `transcripts/` | Agent session files and CAST's chat history, per project / job / person |
| `<data dir>/push.json` | The Web Push key pair and each device's push subscription (mode 0600) |
| `<data dir>/uploads/`, `worktrees/`, `omp-pids.json` | Images, jobs' own copies, live agent processes (to clean up after a crash) |
| `<project>/.rlt/runs/<runId>/` | Team-run notes and hand-offs (git-excluded) |
| `refs/rlt/checkpoints/*`, `refs/rlt/jobs/*`, branches `rlt/*` | Checkpoints for **Revert files**, job copy bases and branches |
| `refs/rlt/discarded/*`, `refs/rlt/turns/*` | What **Undo changes** removed (for **Bring back**, the last 20); chat turns' before/after snapshots |

## Extending CAST

- **A new message:** add it to `shared/protocol.ts` (additive only), validate it in `server/validate.ts`, route it in
  `server/dispatch.ts` or the agent system, apply its server answer in `web/src/net/reducer.ts`, and add a test.
- **A starter project template:** `server/project-templates.ts` (a `TemplateId` and its file map), plus its card in
  `TEMPLATES` of `web/src/ui/placement.ts`. Teams are not shipped: the lead or the user makes them per house.
- **A new keyboard shortcut:** bind it in `web/src/ui/keyboard.ts` (or the panel that owns it) and list it in
  `web/src/ui/shortcuts.ts` (Help and Settings read that list; a bare key is `single: true` and obeys the single-key
  setting); `tests/help/help-info.test.ts` checks the two agree.
- **A new asset:** `web/public/assets/` + `MANIFEST.json` + `THIRD-PARTY-NOTICES.md` (CONTRIBUTING.md → Assets).
- **A change to the agent, or a newer upstream omp:** change `agent/` (see [agent/FORK.md](agent/FORK.md)),
  `bun run build:agent`, `bun run compat:agent`, then move `OMP_TESTED_VERSION` if the version changed
  (CONTRIBUTING.md → cast-agent).
