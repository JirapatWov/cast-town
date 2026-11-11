# Agent compatibility suite

CAST drives its agent, cast-agent (CAST's fork of the omp coding agent, oh-my-pi, in `agent/`), as a child process:
one `cast-agent --mode rpc-ui` per person, plus a few one-shot commands (`--version`, `models --json`, `login`,
`usage`). Any omp release can change a frame, a command or a file layout that CAST reads. This suite starts a given
agent build **exactly the way CAST does** and checks each of those behaviours, so you know whether a build (a change
to `agent/`, an upstream fix ported into it, or another omp) is safe for CAST before you ship it.

```sh
# from the CAST repository root
bun run compat:agent                                   # agent/bin/cast-agent (build it first: bun run build:agent)
bun run compat:agent --omp /path/to/another/cast-agent # any other build
```

| Option | Meaning |
|---|---|
| `--omp <path>` | The agent to test. Default: `$CAST_AGENT_BIN`, then `agent/bin/cast-agent` of this repository (what CAST runs). |
| `--only <groups>` | Comma-separated: `cli,accounts,lead,resume,advisor,compaction`. `resume` also runs `lead`. |
| `--work <dir>` | Scratch dir. Default: a fresh `$TMPDIR/omp-compat-*`. The dir must be empty or come from an earlier run (it is wiped). |
| `--keep` | Keep the scratch dir after a passing run. After a failing run it is always kept. |
| `--verbose` | Also print the expected shape of every passing check. |

The exit code is 0 when everything passed, 1 when any check failed, and 2 for a usage error. A full run takes about
95 s: each of the 6 omp processes needs 4–8 s to boot, and the lead group runs about 35 s of scenarios.

## Output

Every check prints one line: `PASS  <group> · <behaviour (CAST code that relies on it)>`. A failure also shows what
CAST expects, what omp sent (trimmed), and the exact mismatching paths:

```
FAIL  lead · queue_update {steering[], followUp[], liveSteered} (normalize.ts queue)
        expected: {type: "queue_update", steering: ["STEER-ONE now"], followUp: [], liveSteered: number}
        seen:     {type: "queue_update", steering: ["STEER-ONE now"], followUp: []}
        mismatch: liveSteered: expected number, got undefined
```

After a failing run, `<scratch>/logs/<process>.frames.jsonl` holds every frame each omp process sent. Only
`message_update` frames are left out, and very long lines are cut.

A step that times out is reported as a FAIL, and the group continues. CAST's Stop runs first: open dialogs are
cancelled, then `abort_and_restore_queue` is sent. If omp no longer answers the abort, the group's remaining steps
are reported as skipped.

## Isolation

- **No real model.** `mock-llm.ts` is a small OpenAI-compatible SSE server on a random 127.0.0.1 port.
  - Its replies are scripted. Who is asking is read from the request: the main agent, a helper (model `mock-b`), the
    advisor (it is offered the `advise` tool), or a summary request (no tools). What to do is read from directives in
    the user's text, such as `BASH:<cmd>`, `SLOW`, `SPAWN`, `HOST`, `ASK`, `WORDS:<n>`, `TOKENS:<n>`,
    `FAIL500x<n>:<key>` and `FAIL400`. The header of `mock-llm.ts` lists them all.
  - omp reaches the mock through a keyless provider in the scratch `models.yml`. It has the same shape as the provider
    of CAST's scripted test model (`server/agents/demo-agent-dir.ts`, used only with `CAST_MOCK_LLM=1`).
- **No real credentials or config.** Every omp process runs with `HOME` and `PI_CODING_AGENT_DIR` set to scratch
  dirs. Only `PATH`, `LANG`, `TMPDIR` and CAST's `BUN_OPTIONS` are passed through, so no provider keys reach omp.
  `~/.omp` is never read or written, and the suite never runs `login`, `logout`, `update` or `usage` beyond `--help`.
- **The same spawn as CAST.** `omp-rpc.ts` builds `process-pool.ts`'s argument list in the same order:
  `--model`, `--approval-mode`, `--append-system-prompt`, `--session-dir`, `--no-title`, `--thinking`, `--extension`,
  `--config`, `--resume`.
  - omp runs in its own process group and speaks JSONL with protocol-v2 chunk reassembly.
  - The boot is CAST's: `negotiate_protocol` v2, `set_event_filter` delta, `set_subagent_subscription` progress,
    `set_ask_dialog`, `set_interrupt_mode` wait, `set_host_tools`, then the strict `get_state` model check.
- **CAST's real definitions.** Inside the CAST tree, the suite imports the real `LEAD_TOOLS` (`lead-tools.ts`) for
  `set_host_tools` and writes the helper agent file with the real `renderHelperAgent()` (`helper-agents.ts`).
  Copied elsewhere, it falls back to a built-in copy and says so in its header.
- Every process it starts is stopped when the run ends, including on Ctrl-C. Nothing else is touched.

## What it checks

| Group | omp process | Behaviours (CAST file that relies on them) |
|---|---|---|
| `cli` | one-shot commands | `--version` has N.N.N (`models.ts` detectOmpVersion); `--help` lists every flag CAST passes plus `rpc-ui` and the approval modes; `models --json` shape incl. `input` and the `thinking` ladder (`models.ts`); `login --help` / `usage --help` shape (`provider-login.ts`, `provider-accounts.ts`) |
| `accounts` | `--no-session --no-tools --no-title`, no negotiation | `get_logout_accounts` → `data.accounts[]`; a store without credentials exits before `ready` with the message CAST treats as "no accounts" (`provider-accounts.ts`) |
| `lead` | a lead: write mode, host tools, `--thinking`, `--extension`, `--config` goal overlay | boot answers; chat event shapes (user/assistant `message_start`, delta `message_update`, `message_end` content/usage/stopReason/provider/model, `prompt_result`, `session_settled`, ordering); persona and thinking level reach the model; images on `prompt`; `get_last_assistant_text`; `get_session_stats.contextUsage`; approvals (`select` "Allow tool: …" with Approve/Deny, tool start before the ask, approve / deny / Stop with an approval open); `ask` dialog and its withdrawal (`method:"cancel"`); host tools (essential in the tool list, `host_tool_call` → `host_tool_result`, `host_tool_cancel`); queue (`streamingBehavior` steer/followUp, `queue_update` incl. `liveSteered`, delivery with `steering:true`, `promote_queued_message`, `remove_queued_message`, unknown text → false, `abort_and_restore_queue` restores both queues, aborted `stopReason`/`prompt_result`); interrupt mode `wait`; helpers (`subagent_lifecycle`/`subagent_progress` with `sessionFile`, `parentToolCallId`, `resolvedModel`, `currentTool`, tokens/cost, helper session file on disk at `<lead session>/<id>.jsonl`, `get_subagents`, `steer_subagent`, `cancel_subagent`, `async-result` wake); goal mode (`goal` create with `token_budget` / pause / resume / drop, `goal_updated`, continuation turns from the `--config` overlay, `get_state.goal`); session files (header `cwd`, message/toolCall/toolResult entries, timestamps); `new_session`, `switch_session` with provider/model, `compact` on an empty chat; graceful exit on stdin close |
| `resume` | the lead again with `--resume <its session file>` | the same file, the goal comes back, the history reaches the model; a frame over 1 MiB arrives as `rpc_chunk` and reassembles |
| `advisor` | a lead with the advisor overlay (`advisor.enabled`, `modelRoles.advisor`) | advisor card `custom/advisor` with `details.notes[{note, severity}]`; `advisor_yielded`; reviews on the advisor model; `<session>/__advisor.jsonl` with `usage.cost.total`; a builtin slash command answers `agentInvoked:false` |
| `compaction` | a team member: `always-ask`, text-only model with a 100k window | always-ask approvals; `compact` → `tokensBefore`, context shrinks, a repeat compact gives "Already compacted"; `auto_compaction_start`/`_end` shapes; repeated HTTP 500 → `auto_retry_start`; HTTP 400 → `message_end` with `stopReason:"error"` and `errorMessage` |

## Not covered

These need a real provider, a real account or a person, so the suite leaves them out:

- Real provider transports: Anthropic, OpenAI Responses and remote compaction.
- The interactive `omp login` flow.
- `logout`.
- The output of `omp usage --json`.
- Image descriptions for text-only models.
- The `notice` frames that compaction and providers send.

When CAST starts relying on a new omp behaviour, add a check here:

1. Add a step to the group whose process fits, in `groups.ts`.
2. If the mock needs to answer differently, add a directive to `mock-llm.ts`.
3. Name the CAST file that relies on the behaviour in the check's title.
