// The notifier: tells Hermes Agent — and through it the user on LINE, Telegram… — when something in CAST waits for
// them: an approval card, a question, a team plan card. It watches the same live connection the web app has and POSTs
// one signed webhook per request to a Hermes webhook route (Hermes' "generic V2" scheme: hex HMAC-SHA256 of
// "<timestamp>.<body>"); the route delivers the payload's `text` to the chat as is (deliver_only) and mirrors it into
// that chat's session, so the user's reply ("approve a7k2q") reaches a Hermes that knows what it refers to.
//
//  • Debounced: a burst is looked at once, 2 s after the first quiet moment (at most 5 s after it began). A card
//    answered within that time never notifies.
//  • Once: every request is told once, even across restarts (the ids told are kept in the bridge's state folder). A
//    request already waiting when the notifier starts is told then.
//  • Retried: a failed POST is tried again later (10 s, 30 s, 2 min, then every 10 min) under a new request id — Hermes
//    drops a repeated id as a duplicate.
//
// Unlike CAST's own Web Push, the message says what is asked (the command, the files, the question): the user decides
// from it. It travels through Hermes and the chat service.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ServerMsg } from '../shared/protocol';
import { errorMessage, writeFileAtomic } from '../server/util';
import type { Logger } from './client';
import { notificationText, pendingItems, type Lang, type Pending, type TownView } from './view';

export const DEBOUNCE_MS = 2000;
export const DEBOUNCE_MAX_MS = 5000;
export const RETRY_MS = [10_000, 30_000, 120_000, 600_000];
const KEEP_TOLD = 500;
const POST_TIMEOUT_MS = 15_000;

export interface WebhookTarget {
  url: string;
  secret: string;
}

/** Hermes' generic V2 signature headers for one body. */
export function signatureHeaders(secret: string, body: string, nowMs: number): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  return {
    'X-Webhook-Timestamp': ts,
    'X-Webhook-Signature-V2': createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'),
  };
}

/** What a webhook carries: `text` is the message; the rest is there for a route that builds its own. */
export interface NotifyPayload {
  event_type: 'cast.approval' | 'cast.question' | 'cast.plan' | 'cast.test';
  id: string;
  code: string;
  house: string;
  job: string;
  person: string;
  title: string;
  text: string;
}

export function payloadFor(p: Pending, lang: Lang, openUrl: string | null): NotifyPayload {
  return {
    event_type: `cast.${p.kind}`,
    id: p.id,
    code: p.code,
    house: p.house,
    job: p.job,
    person: p.person,
    title: p.plan ? p.plan.title : p.approval!.title,
    text: notificationText(p, lang, openUrl),
  };
}

/** POST one payload; throws with what Hermes said when it isn't accepted. */
export async function postWebhook(target: WebhookTarget, payload: NotifyPayload, requestId: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetchFn(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Request-ID': requestId, ...signatureHeaders(target.secret, body, now) },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Hermes did not answer at ${target.url}: ${errorMessage(err)}`);
  }
  const text = await res.text().catch(() => '');
  if (res.ok) return;
  const hint =
    res.status === 401 ? ' (the signature: HERMES_WEBHOOK_SECRET must be the route’s secret, and the route must accept the generic scheme)'
    : res.status === 404 ? ' (no such route: check the path /webhooks/<route> and that the gateway runs with webhooks on)'
    : '';
  throw new Error(`Hermes answered HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
}

/** The requests already told, kept across restarts. */
export class ToldStore {
  #ids: string[] = [];
  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as { ids?: unknown };
      if (Array.isArray(v.ids)) this.#ids = v.ids.filter((x): x is string => typeof x === 'string').slice(-KEEP_TOLD);
    } catch {
      /* start over: at worst a waiting request is told again */
    }
  }

  has(id: string): boolean {
    return this.#ids.includes(id);
  }

  add(id: string): void {
    this.#ids = [...this.#ids.filter((x) => x !== id), id].slice(-KEEP_TOLD);
    if (this.file) writeFileAtomic(this.file, `${JSON.stringify({ ids: this.#ids })}\n`, 0o600);
  }
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The CastLink part the notifier watches. */
export interface Watched extends TownView {
  on(fn: (msg: ServerMsg) => void): () => void;
}

const WATCHED: ServerMsg['t'][] = ['snapshot', 'approval', 'approval_resolved', 'plan'];

export interface NotifierOptions {
  town: Watched;
  /** Delivers one request (throws when it couldn't); `attempt` counts from 0. */
  deliver: (p: Pending, attempt: number) => Promise<void>;
  told: ToldStore;
  log: Logger;
  clock?: Clock;
}

export class Notifier {
  readonly #clock: Clock;
  #off: (() => void) | null = null;
  #timer: unknown = null;
  #burstAt = 0;
  #retryTimer: unknown = null;
  #failures = new Map<string, { attempts: number; nextAt: number }>();
  #sending = new Set<string>();

  constructor(private readonly o: NotifierOptions) {
    this.#clock = o.clock ?? realClock;
  }

  start(): void {
    this.#off = this.o.town.on((msg) => {
      if (WATCHED.includes(msg.t)) this.#schedule();
    });
  }

  stop(): void {
    this.#off?.();
    this.#off = null;
    this.#clock.clearTimeout(this.#timer);
    this.#clock.clearTimeout(this.#retryTimer);
  }

  #schedule(): void {
    const now = this.#clock.now();
    if (this.#timer === null) this.#burstAt = now;
    else this.#clock.clearTimeout(this.#timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.#burstAt + DEBOUNCE_MAX_MS - now));
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, wait);
  }

  /** Tell every waiting request not told yet (and not waiting for its retry). */
  async flush(): Promise<void> {
    const now = this.#clock.now();
    const items = pendingItems(this.o.town);
    const waiting = new Set(items.map((p) => p.id));
    for (const id of this.#failures.keys()) if (!waiting.has(id)) this.#failures.delete(id); // answered meanwhile
    const due = items.filter((p) => !this.o.told.has(p.id) && !this.#sending.has(p.id) && (this.#failures.get(p.id)?.nextAt ?? 0) <= now);
    await Promise.all(due.map((p) => this.#tell(p)));
    this.#armRetry();
  }

  async #tell(p: Pending): Promise<void> {
    const failed = this.#failures.get(p.id);
    const attempt = failed?.attempts ?? 0;
    this.#sending.add(p.id);
    try {
      await this.o.deliver(p, attempt);
      this.o.told.add(p.id);
      this.#failures.delete(p.id);
      this.o.log(`told Hermes about ${p.kind} ${p.code} (${p.house} / ${p.job} · ${p.person})`);
    } catch (err) {
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
      this.#failures.set(p.id, { attempts: attempt + 1, nextAt: this.#clock.now() + delay });
      this.o.log(`could not tell Hermes about ${p.code} (try ${attempt + 1}; again in ${Math.round(delay / 1000)} s): ${errorMessage(err)}`);
    } finally {
      this.#sending.delete(p.id);
    }
  }

  #armRetry(): void {
    this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (!this.#failures.size) return;
    const next = Math.min(...[...this.#failures.values()].map((f) => f.nextAt));
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = null;
      void this.flush();
    }, Math.max(0, next - this.#clock.now()));
  }
}
