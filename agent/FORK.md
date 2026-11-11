# cast-agent

**cast-agent** is CAST's AI agent: the coding-agent CLI that CAST starts once per person as
`cast-agent --mode rpc-ui`. It is a permanent fork of **omp** ([oh-my-pi](https://github.com/can1357/oh-my-pi)),
kept in CAST's repository as this folder (`agent/`). There is no separate omp install and no separate repository:
CAST always runs the agent version it was tested with, and an upstream release can't change the RPC protocol,
frame shapes or model registry under it.

cast-agent is based on omp (oh-my-pi) by Mario Zechner, Can Bölük and Stencil Labs, MIT.

| | |
|---|---|
| License | MIT (see `LICENSE`, © Mario Zechner, Can Bölük, Stencil Labs, Inc.). Third-party notices: `THIRD-PARTY-NOTICES.txt` |
| Upstream | https://github.com/can1357/oh-my-pi |
| Base | omp **v18.13.2** (upstream tag `v18.13.2` = `e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e`). Upstream's git history is not kept here: this folder started as a copy of the files of that tag plus the patches below |
| Source patches | **two**, see [Patches](#patches) |
| Native addon | the prebuilt `@oh-my-pi/pi-natives-<platform>@18.13.2` from npm (no Rust toolchain needed), sha512-pinned in `cast/natives.lock.json` |

## What is renamed, and what is still omp

Only what people see is cast-agent: the program (`bin/cast-agent`, the standalone `cast-agent` executables, the
`bin` entry of `packages/coding-agent/package.json`), the launcher's messages and its environment variables.
Everything inside stays as upstream has it, so that upstream fixes still apply cleanly and existing sign-ins keep
working:

- package names `@oh-my-pi/*`, and `APP_NAME` (`omp`): `cast-agent --version` prints `omp/18.13.2`, and the agent's
  own help and messages say omp;
- the config folder `~/.omp` (sign-ins and sessions in `~/.omp/agent`, or `PI_CODING_AGENT_DIR`), and the `PI_*`
  environment variables;
- the native addon `@oh-my-pi/pi-natives-*`.

## Layout

```
agent/
├── FORK.md                    this file
├── bin/cast-agent             launcher: exec bun packages/coding-agent/dist/cli.js "$@"
├── manager.json               {"manager":"cast","name":"CAST"}: `cast-agent update` refuses to replace this install
├── cast/
│   ├── build.sh               full build without Rust (deps → natives → bundle [→ standalone binary])
│   ├── fetch-natives.ts       download, verify and install the prebuilt natives; --relock for a new version
│   ├── natives.lock.json      tarball URL + sha512 integrity of the natives, for every platform
│   └── parity/                compare two agent builds (version, models --json, rpc-ui session, LLM request)
│       ├── parity.sh  rpc-session.ts  mock-llm.ts  models.yml
├── vendor/npm/                cached natives tarballs (git-ignored; re-downloaded and verified on demand)
├── packages/natives/native/   pi_natives.<platform>[-modern|-baseline].node lands here (git-ignored *.node)
└── packages/coding-agent/dist/
    ├── cli.js + assets        the bundle that bin/cast-agent runs (same build step as upstream's npm package)
    ├── cast-agent[-<tag>]     optional standalone executables (cast/build.sh --binary [tag])
    └── CAST-BUILD.json        agent version, CAST commit (when CAST is a git checkout), natives version, bun, build time
```

Everything else is upstream's tree as of the base tag, with its own `.gitignore` files (they ignore `node_modules`,
the build output and the natives).

## Build (no Rust)

Requirements: **bun ≥ 1.3.14** (tested with 1.4.4), tar, and network access to registry.npmjs.org for the first
build. The build takes about 2 GB (`node_modules` and natives).

```bash
# in the CAST folder
bun run build                         # the web app, then the agent → agent/bin/cast-agent works
bun run build:agent                   # only the agent (= bash agent/cast/build.sh, ~20 s warm)
bash agent/cast/build.sh --binary     # + dist/cast-agent: one self-contained executable for this machine (~2 min)
bash agent/cast/build.sh --binary darwin-arm64   # cross-compile → dist/cast-agent-darwin-arm64
```

What `cast/build.sh` does, in upstream's own order:

1. `bun install --frozen-lockfile`. It uses upstream's `bun.lock` exactly, and the root `prepare` hook runs `gen:tool-views`.
2. `bun cast/fetch-natives.ts`. This is the **only build deviation** from upstream. Upstream builds `crates/` with
   Rust (`bun run build:native`). We download upstream's published addon for the same version instead, verify its
   sha512 against `cast/natives.lock.json`, and copy the `.node` files into `packages/natives/native/`. For a
   workspace checkout, the natives loader looks there (`docs/natives-addon-loader-runtime.md`).
3. `packages/coding-agent: bun scripts/bundle-dist.ts`. This is upstream's `gen:bundle`, the same step that
   produces the npm package's `dist/cli.js`.
4. Optionally `scripts/build-binary.ts` (upstream's `bun run build`), with `CROSS_TARGET=<tag>` for other
   platforms. It embeds the natives for that platform into the executable. It writes upstream's names
   (`dist/omp`, `dist/omp-<tag>`, which upstream's install tests, Nix package, Dockerfiles and metaharness read);
   `cast/build.sh` then renames the result to `dist/cast-agent`, or `dist/cast-agent-<tag>` whenever a tag was
   given (also when the tag is this machine's).

The build needs no git: when CAST is a git checkout, `CAST-BUILD.json` records CAST's commit and whether `agent/`
had uncommitted changes; otherwise those are `unknown` / `null`.

Rust is needed only to **patch the Rust code** in `crates/`. Prebuilt natives are upstream's bytes for exactly the
pinned version. To patch Rust, install the toolchain from `rust-toolchain.toml` and use upstream's
`bun run build:native`.

## Run

```bash
agent/bin/cast-agent --version                     # omp/18.13.2
CAST_AGENT_SOURCE=1 agent/bin/cast-agent ...       # run src/cli.ts directly (test TS changes without rebuilding)
CAST_AGENT_BUN=/path/to/bun agent/bin/cast-agent   # pick a specific bun (default: bun on PATH)
```

CAST runs `CAST_AGENT_BIN` when it is set; else a compiled CAST (the Mac kit, CAST.app) runs the `cast-agent` next to
its binary; else the server runs `agent/bin/cast-agent` of the CAST folder it was started from (and tells the
launcher which bun to use with `CAST_AGENT_BUN`). When that agent isn't built, CAST says so and asks for
`bun run build`.

The agent writes outside its agent dir too: `~/.omp/logs`, `~/.omp/run`, and for the standalone binary
`~/.omp/natives/<ver>`. Set `HOME`, `PI_CONFIG_DIR` or `PI_NATIVES_DIR` for full isolation.

## Checking a build

- CAST's compatibility suite checks every agent behaviour CAST relies on (164 checks, ~90 s, mock LLM, no keys;
  must all pass): `bun run compat:agent` in the CAST folder (runs `agent/bin/cast-agent`; `--omp <binary>` for
  another build).
- `cast/parity/parity.sh <agent-A> <agent-B> <work-dir>` runs two builds with the same fresh agent dir, HOME, cwd
  and a keyless mock LLM, then compares `--version`, `models --json`, an rpc-ui session (frame sequence, get_state,
  prompt_result, reply text) and the request each sends to the LLM. Before this fork moved into CAST, the bundle,
  the standalone binary and `src/cli.ts` were all identical to the npm release 18.13.2 there (2026-10-31), apart from
  1.5 KB of embedded `package.json` metadata in `cli.js` that upstream's publish script rewrites.
- The agent's own tests: `bun test` inside a package, e.g. `cd agent/packages/ai && bun test`.

## Porting an upstream fix

Upstream's git history isn't kept here, so fixes come over as patches from a clone of upstream:

```bash
git clone https://github.com/can1357/oh-my-pi /tmp/omp-upstream
cd /tmp/omp-upstream
git show <commit> > /tmp/fix.patch                      # one upstream commit, or:
git diff v18.13.2 v18.14.1 -- packages/ai/src/x.ts > /tmp/fix.patch   # what changed between two releases
cd <CAST folder>
git apply --check --directory=agent /tmp/fix.patch      # then without --check; -3 for a 3-way merge
bun run build:agent && bun run compat:agent
```

Rules:

- **TypeScript only.** A fix in `crates/` (Rust) can't be ported with prebuilt natives: the addon is upstream's
  build of exactly the pinned version.
- **Natives must be the release that matches the code.** `packages/natives/package.json`'s version selects which
  npm addon `fetch-natives.ts` installs, and `fetch-natives.ts` refuses to run when the lock and that version
  disagree. Never bump the natives version on its own: the standalone binary and installed packages check the
  addon's embedded version stamp. In a workspace build the loader skips that check, so mismatched JS and natives
  would run quietly.
- **Moving the whole base to a new release** is the same with the full diff between two release tags
  (`git diff v18.13.2 vX.Y.Z | git apply -3 --directory=agent`; resolve conflicts with the patches below), then
  `bun agent/cast/fetch-natives.ts --relock`, `bun run build:agent`, parity against the previous build, the compat
  suite, and CAST's pin (`OMP_TESTED_VERSION` in `shared/omp-version.ts`, CONTRIBUTING.md). Use release tags, not
  upstream `main`: a commit between releases has no matching npm addon.
- List every change below, with the reason and the upstream issue/PR if any. Keep patches small, so that porting
  stays cheap.

## Shipping

Users never install omp. CAST builds this folder, and a compiled CAST ships a standalone executable next to its
own binary (`scripts/mac/build-kit.sh` builds `cast/build.sh --binary darwin-arm64` for the Mac kit, and ships
`LICENSE` and `THIRD-PARTY-NOTICES.txt` beside it as `agent-LICENSE` and `agent-THIRD-PARTY-NOTICES.txt`; CAST.app
carries both in its Resources).

A standalone executable (`cast/build.sh --binary <tag>`) uses the same mechanism as upstream's GitHub release
binaries: Bun runtime, bundle and natives in one file, so users need neither bun nor `node_modules`. On first run it
unpacks the addon to `~/.omp/natives/<version>/`, or to `$PI_NATIVES_DIR/<version>`. Measured with 18.13.2:
linux-x64 287 MB (embeds the modern and baseline CPU variants), darwin-arm64 227 MB (cross-compiled from Linux:
Mach-O arm64 with an ad-hoc `LC_CODE_SIGNATURE`, **not notarized**; a copy downloaded through a browser is
quarantined).

Prebuilt natives that upstream publishes on npm for each release, all present for 18.13.2:

| platform | npm package | unpacked |
|---|---|---|
| linux-x64 | `@oh-my-pi/pi-natives-linux-x64` (modern + baseline) | 235 MB (94 MB .tgz) |
| linux-arm64 | `@oh-my-pi/pi-natives-linux-arm64` | 109 MB |
| darwin-x64 | `@oh-my-pi/pi-natives-darwin-x64` | 109 MB |
| darwin-arm64 | `@oh-my-pi/pi-natives-darwin-arm64` | 102 MB (42 MB .tgz) |
| win32-x64 | `@oh-my-pi/pi-natives-win32-x64` | 118 MB |
| win32-arm64 | `@oh-my-pi/pi-natives-win32-arm64` | 104 MB |

`bun agent/cast/fetch-natives.ts --all` caches every platform's tarball in `vendor/npm/`, verified against the lock.
Keep that folder (or a copy) with each CAST release, so a later npm unpublish can't break rebuilds.

License obligations (MIT):

- Include `LICENSE` (the copyright notices) and `THIRD-PARTY-NOTICES.txt` with every copy.
  `THIRD-PARTY-NOTICES.txt` covers the Rust crates inside the natives (including CDDL-1.0 `inferno` and WTFPL
  `terminfo`) and the JS packages bundled into `cli.js`.
- The LGPL sharp/libvips family is not part of the bundle or the binary. `@huggingface/transformers` stays external
  and is installed on demand, per upstream's notice.
- Say that this is a modified build: "cast-agent is based on omp (oh-my-pi) by Mario Zechner, Can Bölük and Stencil
  Labs, MIT". Don't present it as an official upstream release.

## Patches

Changes to upstream's files (files that only CAST has: this file, `bin/cast-agent`, `manager.json`, `cast/**`,
`vendor/.gitignore`):

| date | files | what and why | upstream status |
|---|---|---|---|
| 2026-11-02 | `packages/ai/src/providers/google-gemini-cli.ts`, `packages/ai/src/providers/google-shared.ts`, `packages/ai/src/error/flags.ts`, tests `packages/ai/test/google-empty-response-retry.test.ts`, `packages/coding-agent/test/agent-session-empty-stop-guard.test.ts` | A Google answer that finished (finish reason reached) with no text, tool call or thinking is classified as empty output: the session nudges with a reminder at most 3×, then says "try switching models", instead of replaying the identical request 10 times as a transient transport error. Re-apply on a new base if upstream hasn't fixed it | not reported |
| 2026-11-09 | `packages/coding-agent/package.json` (`bin`), `bun.lock` (the same entry), `scripts/install-tests/run-ci.sh`, `scripts/install-tests/source.dockerfile` and `scripts/install-tests/tarball.dockerfile` (the install smokes run the program the installed manifest names) | The program is called cast-agent: `bin` is `"cast-agent": "src/cli.ts"`. The npm publish override (`publishBin` in `scripts/ci-release-publish.ts`, used by `run-ci.sh`'s tarball smoke) still says `omp`: it is upstream's npm package, which CAST never publishes. `tarball.dockerfile` publishes the manifest as it is, so it runs `cast-agent` | CAST only |
| 2026-11-09 | `crates/pi-natives/tools/.gitignore` | No longer ignores `cache/`: upstream commits the tokenizer files there anyway, and CAST's repository must keep them | CAST only |
| 2026-11-10 | `packages/catalog/src/compat/rules/auth/anthropic.kdl` (+ regenerated `src/compat/rules.json`), `packages/ai/src/registry/oauth/callback-server.ts`, `docs/environment-variables.md`, tests `packages/ai/test/anthropic-oauth.test.ts`, `packages/ai/test/callback-server-manual-input.test.ts` | The Claude Pro/Max sign-in takes its redirect from `ANTHROPIC_OAUTH_REDIRECT_URI` (`redirect-uri-env`); CAST sets it to `https://platform.claude.com/oauth/code/callback`, Claude Code's manual redirect for the same client id, so the browser shows a `code#state` to paste instead of a localhost page that can't load. Unset (the CLI), it stays `http://localhost:54545/callback`. `PI_OAUTH_CALLBACK_TIMEOUT_MS` overrides the 5-min wait for the callback, so CAST's own (longer) sign-in deadline is the one that ends it | CAST only |
