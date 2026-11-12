# CAST ↔ Hermes Agent

Drive CAST from [Hermes Agent](https://hermes-agent.nousresearch.com/) — and so from LINE, Telegram, Slack or any
other chat Hermes runs in: give a job's lead work, ask how it is going, and answer the approval, question and plan
cards that wait for you. When a card starts waiting, CAST tells you in that chat.

```
you (LINE) ⇄ Hermes gateway ──MCP (stdio)──▶ cast-hermes mcp ──/ws──▶ CAST
                    ▲                                                   │
                    └──── webhook route "cast" ◀── cast-hermes notify ◀─┘
```

Two small programs, both clients of CAST like a paired browser:

- **`cast-hermes mcp`** — the MCP server Hermes starts. Five tools: `status`, `read`, `pending` (read only), `tell`
  (a message to a job's lead; waits a little for the reply) and `answer` (answers one waiting card).
- **`cast-hermes notify`** — a small service that watches CAST and POSTs every card that starts waiting to a Hermes
  webhook route, which delivers the message to your chat as is. Each card has a short code, e.g. `[a7k2q]`.

Hermes can also drive omp directly (an omp skill running `omp -p`). That works on a folder by itself: CAST doesn't
see it, its houses' people don't know about it, and nothing it does waits for your approval. Use this bridge to work
*through* CAST.

## 1. Pair the bridge with CAST

On the machine CAST runs on:

```bash
bun run hermes pair --data-dir <CAST's data folder>   # reads CAST's pairing token from there
```

Leave out `--data-dir` when CAST uses its default data folder. On another machine, pass the address and a one-time
code from **Settings → Pair a phone**: `bun run hermes pair --url https://<machine>.<tailnet>.ts.net:8443 --token <code>`.
The bridge shows up as **Hermes Agent** in **Settings → Devices**; revoke it there to sign it out (it never pairs again
on its own). Its session lives in `~/.config/cast-hermes/` (`CAST_HERMES_HOME` to move it).

Check: `bun run hermes status` prints the town.

## 2. The MCP server in Hermes

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  cast:
    command: bun
    args: ["run", "/path/to/cast/hermes/cast-hermes.ts", "mcp"]
    timeout: 360        # answer waits for your confirmation (Hermes asks for up to 300 s)
    elicitation:
      enabled: true     # the default; answer needs it (see "Answering for you")
      timeout: 300
```

Use the full path to `cast-hermes.ts`: Hermes starts the server from its own folder. Restart the gateway, or
`/reload-mcp` in a chat. The tools show up as `mcp_cast_status`, `mcp_cast_tell`, …

## 3. Notifications: a webhook route and the notifier

Set up the chat platform in Hermes first (for LINE: [LINE Setup](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/line)),
including its home channel — your own user id for LINE (`LINE_HOME_CHANNEL=U…` in `~/.hermes/.env`) — and send the bot
one message, so the chat has a session. Then add a route (`~/.hermes/config.yaml`; make the secret with
`openssl rand -hex 32`):

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        cast:
          secret: "<the secret>"
          signature: generic
          deliver_only: true        # the message goes out as is: no model run, no cost
          deliver: line             # or telegram, slack, …
          mirror_to_session: true   # so your reply in that chat knows what it answers
          prompt: "{text}"
```

Then run the notifier next to CAST and check the path end to end:

```bash
export HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/cast HERMES_WEBHOOK_SECRET=<the secret>
export CAST_HERMES_LANG=th                     # notifications in Thai (default: en)
export CAST_HERMES_OPEN_URL=https://<machine>.<tailnet>.ts.net:8443   # optional: an "Open in CAST" link
bun run hermes notify --test                   # one test message in your chat
bun run hermes notify                          # keep it running
```

To keep it running, a systemd user service (`~/.config/systemd/user/cast-hermes-notify.service`) does it:

```ini
[Unit]
Description=CAST → Hermes notifications
After=network-online.target

[Service]
WorkingDirectory=/path/to/cast
EnvironmentFile=%h/.config/cast-hermes/notify.env
ExecStart=/usr/bin/env bun run hermes/cast-hermes.ts notify
Restart=always

[Install]
WantedBy=default.target
```

(`notify.env` holds the `HERMES_WEBHOOK_*` and `CAST_HERMES_*` lines; keep it `chmod 600`.) Then
`systemctl --user enable --now cast-hermes-notify`.

Each card is told once (also across restarts), 2 s after it appears, so one you answer in CAST right away never
pings you; a delivery Hermes refuses is tried again later. Only cards notify: a house in **Bypass** (yolo) mode
never asks for approval, so set the house to **Ask**, **Accept edits** or **Auto** to get approvals on your phone.
Plan cards (work style *Ask*) and agents' questions notify in every mode.

## Using it

Talk to Hermes as usual, for example:

- “What is CAST doing?” → `status`
- “Tell the General job in terminal to add a /version route” → `tell`
- “How far is the Website job?” → `read`
- after a notification `[a7k2q]`: “approve a7k2q”, “deny a7k2q”, “run p4mx9”, “answer a3k9z blue”

## Answering for you

`answer` acts as you, so by default the bridge asks you itself before CAST gets anything: Hermes shows the card and
the answer as its own approval prompt in your chat (on LINE: reply `/approve` or `/deny`). Hermes' model can't answer
that prompt, and `/yolo` doesn't skip it, so text in a card, a chat or a file can't approve anything by talking Hermes
into it. A card answered in CAST meanwhile is left alone.

`CAST_HERMES_CONFIRM=off` (in the MCP server's `env:`) drops that prompt: then Hermes' word is enough, and one message
approves. Do that only when you trust everything that reaches Hermes' context.

For one more gate, `trust: untrusted` on the `cast` entry makes Hermes ask before every `tell` and `answer` (the read
tools are marked read-only and stay free); you can allow `tell` for the session or always.

## What travels where

The bridge can do what a paired browser can (it uses only the chat, cards and status here). Notifications carry what
a card asks — the command, the files and the start of the diff, the question — so you can decide from your phone; they
pass through Hermes and the chat service. CAST's own Web Push never does. Revoke **Hermes Agent** in Settings →
Devices to cut the bridge off at once.

## Troubleshooting

- `status` says *isn't paired* or *signed this bridge out*: run `bun run hermes pair` again (a running bridge picks
  the new session up by itself).
- `notify --test` says HTTP 401: the secret differs from the route's, or the route pins another signature scheme.
  HTTP 404: the route name in the URL, or the webhook platform isn't enabled. HTTP 502: Hermes took it but couldn't
  deliver (no home channel, the chat platform isn't connected).
- A notification arrives but “approve a7k2q” gets a blank look: send the bot a message first (the mirror needs a
  session in that chat), and check `mirror_to_session: true`.
- `answer` says the client cannot ask the user: elicitation is off for the `cast` entry in Hermes.
