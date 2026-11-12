# Tests

```bash
bun run test                     # = bun test tests   (everything, ~95 s)
bun test tests/auto              # one folder
bun test tests/web/plans.test.ts # one file
bun test -t "plan card"          # tests whose name matches
```

The tests are [`bun:test`](https://bun.sh/docs/cli/test) files (`*.test.ts`). They need Bun and git, nothing else:
no agent build, no AI account, no network, no running CAST server. Every test makes its own temporary folders under
`$TMPDIR` and removes them afterwards. Set `TMPDIR` to keep them away from `/tmp`.

Where people must answer without an AI account, a test opts into the scripted test model: `ModelRegistry` with
`{ scripted: true }` (the default of `rv-server/sys-world.ts`), or `CAST_MOCK_LLM=1` for a whole server. It is off
by default, so a test that builds its own registry, or a server without the flag, gets the production behaviour:
nothing connected means nobody works.

CI (`.github/workflows/ci.yml`) runs `bun run typecheck`, `bun run test` and `bun run build:web` on every push and
pull request (the agent is not built there).

## What is where

| Folder | What it covers | How |
|---|---|---|
| `auto/` | The server's agent side: team runs (`WorkflowEngine`), plan cards (`PlanGate`), the lead's team tools, the scripted test model's lead, effort levels, parallel steps, helper agents per model | `world.ts` / `p3-world.ts`: real city, job and workflow stores in temporary folders, with fake people, git and models |
| `continue/` | Continuing a finished team run from a step, review loops, reverts of stopped runs, what the lead reads about a run | `cworld.ts`, plus golden files in `continue/golden/` (see below) |
| `rv-server/` | A real `AgentSystemImpl` whose agent processes are scripted fakes: crashes, Stop while an agent boots, remembered model choices, no AI account connected, the one-time move of the old example teams | `sys-world.ts` (`scripted: false` for the production default) |
| `web/` | Client logic that has no DOM: the store reducer, run and plan helpers, effort labels | imports from `web/src` directly |
| `repo/` | The repository itself: no owner paths in shipped docs, every bundled asset listed in the manifest with a licence, the test helpers | plain file checks |
| `mac/` | CAST for Mac (`mac/`): `build-dmg.sh` linted for BSD tools and bash 3.2 and run against stub macOS tools in a fake kit, the Info.plist template, the Swift sources' imports, brackets and contract names | stub `swiftc`, `codesign`, `hdiutil`, … on `PATH`; no Mac needed |
| `providers/` | Models & providers: the extra agent environment in config.json (`ompEnv`: Google Cloud project, pasted Gemini / Anthropic / OpenAI API keys), Sign in with Google failures in plain words, the key checks, idle agent restarts after a change, model servers on the network in the agent's `models.yml` (the merge, what Test connection says), every sign-in of the agent's `login` menu (the list, its flows, other providers' accounts), usage shown as used | fake `login` / `models` scripts, fake fetch and a local Bun.serve model server, a fake rpc-ui agent for the real `ProcessPool`, `rv-server/sys-world.ts` |
| `help/` | In-app help: the shortcut list, the diagnostics text (nothing secret in it), project links, the agent build hint | pure functions from `web/src/ui/help-info.ts` and `shared/omp-version.ts` |
| `hermes/` | The Hermes Agent bridge (`hermes/`): answers typed in a chat mapped to a card's options (never a guess), the user's confirmation before an answer reaches CAST, the notifier's debounce, once-only and retries, Hermes' webhook signature, and pair → MCP status / tell / read against a server | pure functions, a fake town and clock, a real server process with dev stub agents |
| `helpers/` | Shared helpers, no tests | |

Files named after a review finding (`FINDING: …` at the top) describe a bug first and then pin the fix.

## Tests that need the agent's source

`auto/p3-helpers.test.ts` checks the helper-agent files CAST writes with **the agent's own parser** (cast-agent's
`src/task/agents.ts`). `helpers/omp-source.ts` looks for that source in this order:

1. `CAST_OMP_SRC`: another omp coding-agent package folder (the one with `src/task/agents.ts`), or an omp checkout root;
2. `agent/packages/coding-agent` of this repository.

The source loads only once `agent/` is built (`bun run build:agent`). Before that, that one test is reported as
skipped, and the run still passes.

## Golden files

`continue/golden/*.json` hold the exact prompts and the scripted test model's replies from before a refactor.
`golden.test.ts` and `describe-run.test.ts` require byte-identical output, so a change that alters prompts on purpose
must regenerate them: `bun run tests/continue/gen-golden.ts` and `bun run tests/continue/gen-golden-lead.ts`. Review
the diff of the JSON like code.

## Writing a test

- Put it next to the tests of the same area (or start a folder), name it `<topic>.test.ts`, and start the file with a
  comment saying what it covers and why.
- Test behaviour through the module's public functions. The worlds in `auto/`, `continue/` and `rv-server/` give you
  real stores and an engine without the agent. Use them rather than mocking internals.
- A new house has no workflows. A test that needs the two teams older versions shipped (ids `decode-implement-review`
  and `novel`, from `server/agents/legacy-examples.ts`) gives them to a house with `giveExamples(store, projectId)`
  from `tests/legacy-examples.ts`; `world.ts`, `cworld.ts` and `sys-world.ts` already do.
- Never depend on a path of your own machine, on `~/.omp`, on a running CAST server or on the network.
- The browser UI has no automated tests in this folder. For a UI change, check it by hand in a desktop and a phone-sized
  window, and describe what you checked in the pull request (see CONTRIBUTING.md).

## Not in this folder

- `scripts/omp-compat/` is a separate suite that checks **the agent** (cast-agent in `agent/`, or another omp build)
  against everything CAST relies on (about 95 s, scripted model, no keys): `bun run compat:agent` (`--omp <path>` for
  another build). Run it after changing `agent/`.
