// When to tell a paired device that someone needs the user — by Web Push, with CAST in the background or the phone
// locked. It watches what the hub broadcasts (approval and question cards, plan cards, people stopping with an
// error, team runs ending) and asks the same attentionOf() the Mac menu bar's /api/status uses who is waiting.
//
//  • Debounced: a burst of messages is looked at once, 2 s after the first quiet moment (at most 5 s after it began).
//    Something answered within that time never notifies.
//  • Quiet while looking: a device with a visible, focused CAST page (POST /api/push/presence, kept 75 s) is skipped —
//    its page shows the card, the chime and the title count. While another device's page is visible, a device waits
//    60 s and is told only about what still waits then.
//  • Never twice: each device remembers what it was told (forgotten once answered).
//  • Coalesced and capped: one new item → a notification about it (tag = the approval id or plan:<id>, the same tags
//    the page's own notify.ts uses, so they replace each other); more → one "<n> things need you". At most one such
//    push per device per 20 s (the rest fold into the next) and 30 pushes per device per hour.
//  • Generic: a notification says who and where (person, house, workflow name) and never what — no approval title or
//    detail, no command, question, task text, diff, path or token. Apple and Google carry it (encrypted end to end).
import type { AttentionItem } from '../../shared/app-status';
import type { ServerMsg, WorkflowRun } from '../../shared/protocol';
import { attentionOf, houseNext } from '../app-routes';
import type { AgentSnapshot } from '../contracts';
import { log } from '../util';
import type { SendResult, Sender, Urgency } from './send';
import type { PushPrefs, PushStore, PushSubscriptionRecord } from './store';
import { vapidContact } from './vapid';

export const DEBOUNCE_MS = 2000;
export const DEBOUNCE_MAX_MS = 5000;
export const PRESENCE_TTL_MS = 75_000;
export const HOLD_MS = 60_000;
export const WAITING_GAP_MS = 20_000;
export const HOURLY_CAP = 30;
const HOUR = 3_600_000;
const MAX_PRESENCE = 500;
const NAME_MAX = 60;

export const TTL = { waiting: 43_200, run: 3600, error: 3600, test: 60 } as const;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface NotificationSpec {
  title: string;
  body: string;
  /** Same-origin path the notification opens. */
  next: string;
  tag: string;
  kind: 'waiting' | 'run' | 'error' | 'test';
  /** The app badge to show (answers owed), when known. */
  badge?: number;
}

/** The message: declarative Web Push (Safari 18.4+ shows it even without the service worker) and the plain data the
 *  worker reads (web/sw/policy.ts payloadToNotification), in one. Nothing secret. */
export function pushPayload(n: NotificationSpec, origin: string): string {
  const data = { v: 1, kind: n.kind, next: n.next, ...(n.badge !== undefined ? { badge: n.badge } : {}) };
  const notification = {
    title: n.title,
    body: n.body,
    ...(/^https?:\/\/[^/]+$/.test(origin) ? { navigate: `${origin}${n.next}` } : {}),
    tag: n.tag,
    lang: 'en',
    dir: 'ltr',
    silent: false,
    ...(n.badge !== undefined ? { app_badge: String(n.badge) } : {}),
    data,
  };
  return JSON.stringify('navigate' in notification ? { web_push: 8030, mutable: true, notification } : { notification });
}

const short = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t;
};

/** One waiting item → its notification (who and where only). */
export function itemNotification(item: AttentionItem, badge: number): NotificationSpec {
  const person = short(item.person);
  const house = short(item.house);
  if (item.kind === 'error') return { title: `${person} stopped with an error`, body: `${house} · tap to see what happened`, next: item.next, tag: item.id, kind: 'error', badge };
  const title = item.id.startsWith('plan:') ? `${person} has a plan for you` : item.kind === 'question' ? `${person} has a question` : `${person} needs your OK`;
  // the page's own notifications (web/src/ui/notify.ts) tag approvals by their id and plans as plan:<id>
  const tag = item.id.startsWith('approval:') ? item.id.slice('approval:'.length) : item.id;
  return { title, body: `${house} · tap to answer`, next: item.next, tag, kind: 'waiting', badge };
}

export function summaryNotification(items: AttentionItem[], badge: number): NotificationSpec {
  const people = [...new Set(items.map((i) => short(i.person)))];
  const who = people.length <= 2 ? people.join(' and ') : `${people.slice(0, 2).join(', ')} and ${people.length - 2} more`;
  return { title: `${items.length} things need you`, body: `${who} · tap to open the Inbox`, next: '/?panel=inbox', tag: 'cast-waiting', kind: 'waiting', badge };
}

type EndedRun = Pick<WorkflowRun, 'id' | 'status' | 'workflowName' | 'projectId' | 'jobId'>;

export function runNotification(run: EndedRun, house: string, badge: number): NotificationSpec {
  return {
    title: run.status === 'failed' ? 'Team run failed' : 'Team run finished',
    body: `“${short(run.workflowName || 'Team')}” · ${short(house)}`,
    next: houseNext(run.projectId, run.jobId),
    tag: `run:${run.id}`,
    kind: 'run',
    badge,
  };
}

export const TEST_NOTIFICATION: NotificationSpec = { title: 'Test from CAST', body: 'Notifications work on this device.', next: '/', tag: 'cast-test', kind: 'test' };

export interface AttentionSource {
  snapshot(): Pick<AgentSnapshot, 'agents' | 'approvals' | 'plans' | 'runs'>;
  projects(): { id: string; name: string }[];
}

export interface NotifierDeps {
  store: PushStore;
  sender: Sender;
  /** CAST_PUSH_CONTACT (null: the device's own https origin). */
  contact: string | null;
  /** Paired devices: a subscription whose device is gone (signed out, forgotten) is dropped before a send. */
  devices: { get(id: string): unknown };
  clock?: Clock;
}

interface DeviceState {
  /** Item ids this device was told about (or saw on its own screen), until they are answered. */
  told: Set<string>;
  /** Items to tell it about → since when. */
  owed: Map<string, number>;
  owedRuns: { run: EndedRun; at: number }[];
  lastWaitingAt: number;
  sent: number[];
  timer: unknown;
  dueAt: number;
}

const ACTIVE = new Set(['running', 'waiting_approval']);
const WATCHED = new Set<ServerMsg['t']>(['approval', 'approval_resolved', 'plan', 'agent', 'agent_removed', 'run']);

export function createNotifier(d: NotifierDeps) {
  const clock = d.clock ?? realClock;
  let src: AttentionSource | null = null;
  let known = new Set<string>();
  const runStatus = new Map<string, string>();
  const endedRuns: EndedRun[] = [];
  const errorSince = new Map<string, number>();
  const presence = new Map<string, { deviceId: string | null; until: number }>();
  const states = new Map<string, DeviceState>();
  let evalTimer: unknown = null;
  let burstStart = 0;

  const state = (id: string): DeviceState => {
    let s = states.get(id);
    if (!s) states.set(id, (s = { told: new Set(), owed: new Map(), owedRuns: [], lastWaitingAt: -Infinity, sent: [], timer: null, dueAt: 0 }));
    return s;
  };

  function attention() {
    if (!src) return { items: new Map<string, AttentionItem>(), badge: 0 };
    const a = attentionOf({ snapshot: src.snapshot(), projects: src.projects(), errorSince, now: clock.now() });
    return { items: new Map(a.attention.map((i) => [i.id, i])), badge: a.approvalsWaiting };
  }

  const houseName = (projectId: string) => src?.projects().find((p) => p.id === projectId)?.name ?? 'a house';

  function visible(deviceId: string | null, other: boolean): boolean {
    const t = clock.now();
    for (const [k, p] of presence) {
      if (p.until <= t) {
        presence.delete(k);
        continue;
      }
      if (other ? p.deviceId !== deviceId : p.deviceId === deviceId) return true;
    }
    return false;
  }

  const wants = (prefs: PushPrefs, item: AttentionItem) => (item.kind === 'error' ? prefs.errors : prefs.waiting);

  async function deliver(sub: PushSubscriptionRecord, n: NotificationSpec, opts: { ttl: number; urgency: Urgency; topic: string }): Promise<SendResult> {
    const r = await d.sender.send(sub, pushPayload(n, sub.origin), opts, vapidContact(d.contact, sub.origin));
    if (r.gone) d.store.removeEndpoint(sub.endpoint);
    else if (r.ok) d.store.update(sub.deviceId, { lastOkAt: clock.now(), failures: 0, lastError: undefined });
    else if (r.status !== 429) d.store.update(sub.deviceId, { failures: (d.store.get(sub.deviceId)?.failures ?? 0) + 1, lastError: r.error });
    return r;
  }

  function arm(id: string, s: DeviceState, at: number) {
    if (s.timer && s.dueAt <= at) return;
    if (s.timer) clock.clearTimeout(s.timer);
    s.dueAt = at;
    s.timer = clock.setTimeout(() => {
      s.timer = null;
      void pump(id, attention());
    }, Math.max(0, at - clock.now()));
  }

  /** Tell one device what it is owed, if it is time. */
  async function pump(deviceId: string, now: { items: Map<string, AttentionItem>; badge: number }): Promise<void> {
    const s = states.get(deviceId);
    const sub = d.store.get(deviceId);
    if (!s || !sub) return;
    for (const id of [...s.owed.keys()]) if (!now.items.has(id) || s.told.has(id)) s.owed.delete(id);
    if (!s.owed.size && !s.owedRuns.length) return;
    if (!d.devices.get(deviceId)) {
      d.store.remove([deviceId]);
      states.delete(deviceId);
      return;
    }
    if (visible(deviceId, false)) {
      // its own page shows it all
      for (const id of s.owed.keys()) s.told.add(id);
      s.owed.clear();
      s.owedRuns = [];
      return;
    }
    const t = clock.now();
    if (visible(deviceId, true)) {
      const oldest = Math.min(...s.owed.values(), ...s.owedRuns.map((r) => r.at));
      if (oldest + HOLD_MS > t) return arm(deviceId, s, oldest + HOLD_MS);
    }
    if (s.owed.size && t - s.lastWaitingAt < WAITING_GAP_MS) return arm(deviceId, s, s.lastWaitingAt + WAITING_GAP_MS);
    s.sent = s.sent.filter((x) => t - x < HOUR);

    const items = [...s.owed.keys()].map((id) => now.items.get(id)!).sort((a, b) => b.since - a.since);
    const runs = s.owedRuns.map((r) => r.run);
    for (const i of items) s.told.add(i.id);
    s.owed.clear();
    s.owedRuns = [];
    const batch: { n: NotificationSpec; ttl: number; urgency: Urgency; topic: string }[] = [];
    if (items.length === 1) {
      const n = itemNotification(items[0]!, now.badge);
      batch.push({ n, ttl: n.kind === 'error' ? TTL.error : TTL.waiting, urgency: n.kind === 'error' ? 'normal' : 'high', topic: n.kind === 'error' ? 'error' : 'waiting' });
    } else if (items.length > 1) {
      batch.push({ n: summaryNotification(items, now.badge), ttl: TTL.waiting, urgency: 'high', topic: 'waiting' });
    }
    for (const r of runs) batch.push({ n: runNotification(r, houseName(r.projectId), now.badge), ttl: TTL.run, urgency: 'normal', topic: 'run' });
    for (const b of batch) {
      if (s.sent.length >= HOURLY_CAP) {
        log('push', `a device reached ${HOURLY_CAP} notifications this hour; holding the rest back`);
        break;
      }
      s.sent.push(clock.now());
      if (b.n.kind === 'waiting' || b.n.kind === 'error') s.lastWaitingAt = clock.now();
      await deliver(sub, b.n, b);
    }
  }

  function evaluate() {
    evalTimer = null;
    if (!src) return;
    const now = attention();
    const fresh = [...now.items.values()].filter((i) => !known.has(i.id));
    known = new Set(now.items.keys());
    const runs = endedRuns.splice(0);
    const t = clock.now();
    for (const sub of d.store.list()) {
      const s = state(sub.deviceId);
      for (const id of [...s.told]) if (!now.items.has(id)) s.told.delete(id);
      for (const item of fresh) if (wants(sub.prefs, item) && !s.told.has(item.id) && !s.owed.has(item.id)) s.owed.set(item.id, t);
      if (sub.prefs.runs) for (const run of runs) s.owedRuns.push({ run, at: t });
      void pump(sub.deviceId, now);
    }
  }

  function schedule() {
    const t = clock.now();
    if (evalTimer) {
      clock.clearTimeout(evalTimer);
    } else {
      burstStart = t;
    }
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, burstStart + DEBOUNCE_MAX_MS - t));
    evalTimer = clock.setTimeout(evaluate, wait);
  }

  function observe(msg: ServerMsg) {
    if (!WATCHED.has(msg.t)) return;
    if (msg.t === 'run') {
      const r = msg.run;
      const before = runStatus.get(r.id);
      if (ACTIVE.has(r.status)) runStatus.set(r.id, r.status);
      else runStatus.delete(r.id);
      // finished or failed on its own; not stopped by the user (aborted) or by CAST stopping (interrupted)
      if (before && ACTIVE.has(before) && (r.status === 'completed' || r.status === 'failed') && !r.interrupted) {
        endedRuns.push({ id: r.id, status: r.status, workflowName: r.workflowName, projectId: r.projectId, jobId: r.jobId });
      }
      if (runStatus.size > 1000) runStatus.clear();
    }
    schedule();
  }

  return {
    /** Wrap the hub: every broadcast is also looked at here (never throwing into the broadcast). */
    tap<H extends { broadcast(msg: ServerMsg): void }>(hub: H): H {
      const broadcast = hub.broadcast.bind(hub);
      hub.broadcast = (msg: ServerMsg) => {
        broadcast(msg);
        try {
          observe(msg);
        } catch (err) {
          log('push', 'could not look at a message', err);
        }
      };
      return hub;
    },
    /** Start: what waits right now is known (nothing already waiting notifies after a restart). */
    attach(source: AttentionSource) {
      src = source;
      const snap = source.snapshot();
      for (const r of snap.runs) if (ACTIVE.has(r.status)) runStatus.set(r.id, r.status);
      known = new Set(attention().items.keys());
    },
    observe,
    /** A page says whether it is visible and focused (page: a random id per page load). */
    presence(page: string, deviceId: string | null, isVisible: boolean) {
      if (!isVisible) {
        presence.delete(page);
        return;
      }
      if (presence.size >= MAX_PRESENCE && !presence.has(page)) presence.delete(presence.keys().next().value!);
      presence.set(page, { deviceId, until: clock.now() + PRESENCE_TTL_MS });
    },
    /** Devices signed out: their subscriptions go with them. */
    forget(deviceIds: string[]) {
      for (const id of deviceIds) {
        const s = states.get(id);
        if (s?.timer) clock.clearTimeout(s.timer);
        states.delete(id);
        for (const [k, p] of presence) if (p.deviceId === id) presence.delete(k);
      }
      if (d.store.remove(deviceIds)) log('push', `stopped notifications for ${deviceIds.length === 1 ? 'a signed-out device' : 'signed-out devices'}`);
    },
    /** Settings → "Send a test notification". */
    async sendTest(deviceId: string): Promise<SendResult> {
      const sub = d.store.get(deviceId);
      if (!sub) return { ok: false, status: 0, error: 'Notifications are not on for this device.' };
      return deliver(sub, { ...TEST_NOTIFICATION, badge: attention().badge }, { ttl: TTL.test, urgency: 'high', topic: 'test' });
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
