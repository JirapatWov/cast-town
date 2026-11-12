// cast-hermes: lets Hermes Agent drive CAST — give a job's lead work, see how it goes, answer what waits for the user —
// and tells the user through Hermes (LINE, Telegram, …) when something waits. Setup: hermes/README.md.
//
//   bun run hermes pair [--url <CAST address>] [--token <token, link or code>] [--data-dir <CAST data folder>]
//   bun run hermes/cast-hermes.ts mcp       the MCP server (stdio) Hermes starts
//   bun run hermes notify [--test]          watch CAST, POST what waits to a Hermes webhook route
//   bun run hermes status                   what the status tool answers (checks the bridge reaches CAST)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEnvAliases, resolveDataDir } from '../server/config';
import { readListenInfo } from '../server/startup';
import { errorMessage } from '../server/util';
import { CastLink, DEVICE_NAME, ensureStateDir, loadSession, pair, stateDir, stderrLog } from './client';
import { McpServer, serveStdio } from './mcp';
import { Notifier, payloadFor, postWebhook, ToldStore, type NotifyPayload, type WebhookTarget } from './notify';
import { renderStatus, type Lang } from './view';

const USAGE = `Usage: bun run hermes <command>

  pair [--url <address>] [--token <token | pairing link | one-time code>] [--data-dir <dir>]
           Pair the bridge with CAST once; it shows up as "${DEVICE_NAME}" in Settings → Devices.
           On the CAST machine, without --token, it reads CAST's pairing token from its data folder
           (--data-dir or CAST_DATA_DIR, as for bun run pair). For another machine, use a one-time code
           from Settings → Pair a phone.
  mcp      The MCP server Hermes starts (stdio). Not for a terminal.
  notify   Watch CAST and POST every request waiting for the user to a Hermes webhook route
           (HERMES_WEBHOOK_URL, HERMES_WEBHOOK_SECRET). --test sends one test message and exits.
  status   Print what the status tool would answer.

Environment:
  CAST_HERMES_HOME     the bridge's folder (default ~/.config/cast-hermes)
  CAST_HERMES_LANG     en (default) or th: the language of notifications
  CAST_HERMES_CONFIRM  on (default): the user confirms every answer in Hermes; off: Hermes answers alone
  CAST_HERMES_OPEN_URL the address a phone opens CAST at (e.g. your tailscale serve address), for the
                       "Open in CAST" link in notifications (default: none when CAST is on 127.0.0.1)`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flags(args: string[], known: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.replace(/^--/, '');
    if (!a.startsWith('--') || !known.includes(name)) fail(`Unknown argument: ${a}\n\n${USAGE}`);
    if (name === 'test') out.test = '1';
    else if (args[i + 1] === undefined) fail(`${a} needs a value.`);
    else out[name] = args[++i]!;
  }
  return out;
}

const lang = (): Lang => (process.env.CAST_HERMES_LANG?.trim().toLowerCase() === 'th' ? 'th' : 'en');

async function pairCommand(args: string[]): Promise<void> {
  const f = flags(args, ['url', 'token', 'data-dir']);
  if (f['data-dir']) process.env.CAST_DATA_DIR = f['data-dir'];
  applyEnvAliases(process.env);
  const { dir: castData } = resolveDataDir(process.env);
  const url = f.url ?? process.env.CAST_URL ?? readListenInfo(castData)?.url ?? 'http://127.0.0.1:4860';
  let token = f.token;
  if (!token) {
    const file = join(castData, 'token');
    if (!existsSync(file)) fail(`No --token, and no pairing token in ${file}.\nOn the CAST machine pass --data-dir <CAST's data folder>; elsewhere use --token with a one-time code from Settings → Pair a phone.`);
    token = readFileSync(file, 'utf8').trim();
  }
  const dir = stateDir();
  const s = await pair(dir, url, token).catch((err: unknown) => fail(errorMessage(err)));
  console.log(`Paired with CAST at ${s.url} as “${DEVICE_NAME}” (Settings → Devices lists it; revoke it there to sign the bridge out).\nSession saved in ${join(dir, 'session.json')}.`);
}

async function statusCommand(): Promise<void> {
  const link = new CastLink(stateDir());
  link.start();
  await link.ready(15_000).catch((err: unknown) => fail(errorMessage(err)));
  console.log(renderStatus(link));
  link.stop();
}

async function mcpCommand(): Promise<void> {
  const confirm = !/^(0|off|false|no)$/i.test(process.env.CAST_HERMES_CONFIRM?.trim() ?? '');
  const link = new CastLink(stateDir());
  link.start();
  const server = new McpServer({ town: link, confirm, write: (line) => void process.stdout.write(line), log: stderrLog });
  await serveStdio(server);
  link.stop();
  process.exit(0);
}

async function notifyCommand(args: string[]): Promise<void> {
  const f = flags(args, ['test']);
  const url = process.env.HERMES_WEBHOOK_URL?.trim();
  const secret = process.env.HERMES_WEBHOOK_SECRET?.trim();
  if (!url || !secret) fail('Set HERMES_WEBHOOK_URL (e.g. http://127.0.0.1:8644/webhooks/cast) and HERMES_WEBHOOK_SECRET (the route’s secret).');
  const target: WebhookTarget = { url, secret };
  const dir = stateDir();
  if (f.test) {
    const text = lang() === 'th' ? '✅ CAST เชื่อมกับ Hermes แล้ว: เมื่อมีงานรอคุณอนุมัติหรือตอบ จะแจ้งในแชทนี้' : '✅ CAST is connected to Hermes: requests waiting for you will show up in this chat.';
    const payload: NotifyPayload = { event_type: 'cast.test', id: 'test', code: '', house: '', job: '', person: '', title: 'test', text };
    await postWebhook(target, payload, `cast-test-${Date.now()}`).catch((err: unknown) => fail(errorMessage(err)));
    console.log(`Hermes accepted the test message (${url}).`);
    return;
  }
  if (!loadSession(dir)) fail('The bridge is not paired with CAST yet: run bun run hermes pair first.');
  ensureStateDir(dir);
  const openUrl = process.env.CAST_HERMES_OPEN_URL?.trim() || null;
  const link = new CastLink(dir);
  const notifier = new Notifier({
    town: link,
    told: new ToldStore(join(dir, 'notified.json')),
    log: stderrLog,
    deliver: (p, attempt) => postWebhook(target, payloadFor(p, lang(), openUrl ?? (/^https?:\/\/(localhost|127\.|\[::1\])/.test(link.url) ? null : link.url)), `cast-${p.id}-${attempt}`),
  });
  notifier.start();
  link.start();
  stderrLog(`watching CAST (session in ${dir}); telling Hermes at ${url}`);
  const stop = () => {
    notifier.stop();
    link.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'pair':
      return pairCommand(rest);
    case 'mcp':
      return mcpCommand();
    case 'notify':
      return notifyCommand(rest);
    case 'status':
      return statusCommand();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      fail(`Unknown command: ${cmd}\n\n${USAGE}`);
  }
}

if (import.meta.main) await main();
