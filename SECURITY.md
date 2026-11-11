# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**
(GitHub private vulnerability reporting). If you can't use GitHub, e-mail
[jirapat.wov@gmail.com](mailto:jirapat.wov@gmail.com) with "CAST security" in the subject. Include:

- what an attacker can do, and what they need first (network position, a paired browser, a local account, …);
- steps to reproduce, ideally against a fresh install;
- the versions: in the app open **Help** (the `?` button in the top bar) → **Copy diagnostics**, or give the output of
  `git rev-parse --short HEAD` and `agent/bin/cast-agent --version` (it prints `omp/<version>`: the agent keeps omp's
  internal name).

The maintainers will acknowledge the report as soon as they can, agree on a fix and a disclosure date with you, and
credit you in the release notes unless you prefer otherwise.

Only the latest version on the default branch is supported. CAST is pre-1.0: fixes land there, not in old releases.

## What CAST is, security-wise

CAST is a web server that runs AI coding agents (cast-agent, based on [omp](https://github.com/can1357/oh-my-pi)) and
a real shell **with the rights of the operating-system user who started it**. Whoever can use a paired CAST page can
do anything that user can do on that machine: read and change files, run any command, open network connections, and
spend money on the AI accounts signed in there. Treat access to CAST like an SSH login to that account.

That shapes the defaults and the advice below.

### Defaults

- **Loopback only.** The server listens on `127.0.0.1:4860`. Nothing on your network can reach it until you choose a
  way in (see "Remote access").
- **Pairing link = password.** On first start CAST writes a random pairing token to `<data dir>/token` (mode 0600)
  and tells you where it is; it does not print the token itself. Opening `http://…/?token=<token>` once pairs that
  browser: the server swaps the token for a device session (an HttpOnly, SameSite=Lax cookie, Secure over HTTPS) and
  redirects to the clean address. Anyone who has the link can pair a browser, so don't paste it into chats, tickets,
  screenshots or shell history you share.
- **Wrong pairing tries.** After 10 wrong pairing tokens in 10 minutes from one device, CAST turns that device's
  wrong tries away for a while. Behind `tailscale serve` every request arrives from 127.0.0.1, so there CAST tells
  devices apart by the tailnet address serve forwards (`X-Forwarded-For`, believed only from 127.0.0.1). A correct
  pairing link or one-time code always works, even then: nobody can lock you out by failing on purpose, and the token
  (192 random bits) and the one-time codes (144) can't be guessed anyway. The short code typed by hand (12 characters,
  60 bits, shown beside each one-time code for the Home Screen app) is the exception: it is only looked at while that
  device may still try, so guessing one is capped at 10 tries per 10 minutes per device against at most 20 live codes,
  each good for 10 minutes and one use.
- **Revoking.** Paired devices can be signed out one by one, and the pairing token can be replaced (a new token also
  ends every file-viewer link made before it). To lock everyone
  out at once: stop CAST, delete `token` and `devices.json` in the data folder, and start CAST again; every browser
  must then pair with the new link.
- **Tailscale identity is off by default.** CAST trusts the `Tailscale-User-Login` header only when you list logins in
  `CAST_ALLOWED_USERS`, the request comes from `tailscale serve` on the same machine (loopback peer) and the `Host`
  is the tailnet name, an IP or localhost (a page that rebinds its own domain to your machine can't use it).
  **Once you set `CAST_ALLOWED_USERS`, every program on that machine can sign in as you.** CAST can't tell
  `tailscale serve` from any other local process: anything that can open a connection to 127.0.0.1 (another
  account on the machine, a container sharing its network, a script an agent started) can send that header with your
  login and gets full access. Set it only on a machine where you trust every local account and process. Otherwise
  leave it empty and pair each device with a link (pairing works through `tailscale serve` too).
- **WebSockets** from a browser must come from the page's own origin (cross-site WebSocket hijacking is refused).
  Add a reverse proxy's public origin with `CAST_ALLOWED_ORIGINS` only if you run one.
- **Secrets on disk.** CAST's own secrets (pairing token, device sessions, the session cookies of added cities, and a
  Gemini API key pasted under Models & providers, in `config.json`) live in its data folder with mode 0600 and are
  never written to logs or sent back to the browser. The data folder itself is 0700 (CAST closes one that other
  accounts can open, and says so at start), because it also holds your chats. Other AI sign-ins and API keys are
  stored by the agent itself (`~/.omp/agent`, or `PI_CODING_AGENT_DIR`). What you paste into a sign-in goes straight
  to the agent's standard input and is not logged.
- **The browser terminal** asks once per browser before the first shell and names the user it runs as (red when that
  is root). Turn it off entirely with `CAST_TERMINAL=0` or `"terminal": false` in `config.json`.

### Run it as a normal user, never as root

The agents and the browser terminal get exactly the rights of the user running CAST. Use your own unprivileged account
or, better, a dedicated one (for example `cast`) that owns only the folders you want agents to work in. Limit the
folder picker with `CAST_FS_ROOTS`. For code you don't trust, run CAST inside a container or VM.

### Remote access

- **Recommended:** [Tailscale](https://tailscale.com) `tailscale serve` (HTTPS, only your tailnet can reach it), then
  pair each device with the link. Never use `tailscale funnel` or any public tunnel for CAST.
- **SSH tunnel:** `ssh -L 4860:127.0.0.1:4860 you@server` and open `http://127.0.0.1:4860` on your computer.
- **Plain LAN (`CAST_HOST=0.0.0.0`)** sends the pairing link and the session cookie unencrypted over your network.
  Use it only on a network where you trust every device, and never on public Wi-Fi.
- Never put CAST on the public internet.

### AI agents are not a sandbox

- Agents read repositories, web pages and tool output, any of which can contain instructions written to mislead them
  ("prompt injection").
- The permission modes (**Ask first**, **Accept edits**, **Auto**) decide when CAST asks you before a step, and
  **Auto** uses rules to spot risky steps (steps it lets through are marked **Auto-approved** in the chat). They help
  you stay in control, but they are not a security boundary.
  **Bypass** never asks. Use it only in folders you could lose.
- Each agent is a cast-agent process running as your user, with all of that user's rights.

### Pages written by agents

The file viewer shows a house's `.html` files as live pages. CAST treats them as untrusted. They run sandboxed
(without your CAST session, without popups) under a Content-Security-Policy that only allows the house's own files
and a fixed list of CDNs (`server/files.ts`, extendable with `CAST_VIEWER_HOSTS`). The allowlist is **not airtight**
in Chromium: `<link rel=prerender>`, the DNS lookup and connection Chromium makes before `frame-src` refuses a
navigation, and WebRTC from a frame the page creates can each still send data to a host of the page's choosing.
Don't open pages you have reason to distrust.

### More than one machine (cities)

When you add another machine's CAST as a city, your main CAST (the hub) pairs with it and keeps that machine's session
cookie in `cities.json` (mode 0600). Anyone who can use the hub can then act on that machine too, through the hub.
It works the other way as well: a city's pages are served through the hub on the hub's own address, so a city running
changed code could act on the hub (and its machine) as you. Only add machines you control. AI accounts are never
copied between machines.

### The Mac app

CAST.app (the menu-bar app, see the README's "Mac app") is the same server with the same rules. The app runs as you,
reads the pairing token from the data folder like `bun run pair` does, and pairs itself once as a device named "CAST
menu bar (Mac)" (listed in Settings → Devices as "This Mac's menu bar"; its session cookie is kept in the data folder,
mode 0600, and never logged). With that session it reads `GET /api/status` (counts and the titles of what waits for you)
and asks `POST /api/login-link` for **Open CAST**: a one-time pairing code of the kind Settings → Pair a phone shows
(single use, 10 minutes, 144 random bits), in a link on this machine's own loopback address. The link may only land on
a path of the same server: a `next` naming another host (`https://…`, `//host`, a backslash) is refused, so it can't be
turned into a redirect elsewhere. Removing the app's device in Settings signs it out, but while it runs it pairs again
by itself (it can read the token file, like anything running as you); quit it to keep it out. The app is signed ad hoc,
not notarized: macOS asks you to confirm the first launch.

### The installed app and notifications

- **Pairing on the private page.** The page every unpaired browser gets (403) has a form that takes a pairing link or
  a short code: it is how the iPhone Home Screen app, which keeps its own cookies, pairs. The form is a plain POST to
  `/api/pair` from CAST's own origin (a post from another site is refused), follows the same wrong-try limit as the
  link, and lands only on a path of the same server.
- **The service worker** (`/sw.js`) never stores a page, an API answer, a file or a pairing link: only CAST's own
  code chunks (whose names change with their content). Page loads always go to the network; only when it can't be
  reached does a built-in offline page stand in. A city's pages, served through the hub, can't register a worker of
  their own (the hub refuses worker scripts under `/city/`). Settings → Notifications & app → **Reset the app's
  cache**, `?sw=off`, or `CAST_SERVICE_WORKER=off` (for every browser at once) removes it.
- **Web Push.** Notifications go from CAST to the push service of the device's browser (Apple, Google, Mozilla or
  Microsoft) and from there to the device. The payload is encrypted for that device (RFC 8291, aes128gcm), so the push
  service can't read it, but it sees that CAST sent something, when, how large, and the device's push address. It
  also sees CAST's contact (the VAPID `sub`, not encrypted): `CAST_PUSH_CONTACT` when set, else the https address the
  device subscribed from — usually your machine's tailnet name (`https://<machine>.<tailnet>.ts.net:…`). Set
  `CAST_PUSH_CONTACT` if that name should stay private. A notification says who needs you and where (a person, a house, a workflow name) and a count; never an approval's
  title or details, a command, a question, task text, a path or a token. CAST only sends to the known push services
  (https, default port, no IP addresses), so a subscription can't make it call into your network.
- **The VAPID key** (the key pair that proves notifications come from your CAST, RFC 8292) is made on first use and
  kept in `push.json` in the data folder (mode 0600) with the devices' push addresses and keys; it is never logged or
  sent anywhere but as a signature. Deleting `push.json` makes a new key; a device that still allows notifications subscribes again with it the next time it opens CAST.
  Signing a device out ends its notifications. `CAST_PUSH=off` turns them off entirely.

### Scripted test model

Only when a developer sets `CAST_MOCK_LLM=1` (tests and development, see [CONTRIBUTING.md](CONTRIBUTING.md)) does
CAST start a scripted model on `127.0.0.1:4871` (`CAST_MOCK_PORT`), without authentication. It only answers chat
requests with scripted text and holds no data, but other local users of the machine can reach it. It is off by
default and never needed for real use: without that setting nothing listens there, and people whose model has no AI
account don't run at all.

## Out of scope

- Anything that needs the pairing link, a paired browser, or the same operating-system account. Those already grant
  full access by design.
- Agents doing what a prompt or a repository told them to do (see "AI agents are not a sandbox"), unless CAST itself
  bypasses a permission mode it claims to enforce.
- Vulnerabilities in upstream omp, Bun, browsers or AI providers. Report those upstream. We are glad to hear about
  them if CAST makes them worse. Vulnerabilities in cast-agent itself (the agent in `agent/`) are in scope: report
  them here.
