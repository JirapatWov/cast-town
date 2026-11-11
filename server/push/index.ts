// Web Push for CAST (opt-in per device in Settings → Notifications & app): the pieces put together for
// server/index.ts. CAST_PUSH=off turns it off entirely: no push.json, no requests to any push service.
//   ece.ts       RFC 8291 encryption        vapid.ts   RFC 8292 signing (the install's key pair)
//   store.ts     <dataDir>/push.json        send.ts    one message to one push service (allowlisted)
//   notifier.ts  when to tell whom          routes.ts  /api/push…
import type { ServerMsg } from '../../shared/protocol';
import { createNotifier, type AttentionSource, type Clock } from './notifier';
import { createPushRoutes } from './routes';
import { createSender } from './send';
import { createPushStore } from './store';
import { createVapid } from './vapid';

export interface PushOptions {
  dataDir: string;
  enabled: boolean;
  devices: { get(id: string): unknown };
  contact: string | null;
  extraEndpoints: readonly string[];
  allowedOrigins: string[];
  clock?: Clock;
  fetch?: typeof fetch;
}

export function createPush(o: PushOptions) {
  const store = o.enabled ? createPushStore(o.dataDir) : null;
  const sender = store ? createSender({ vapid: createVapid(store.vapid, o.clock?.now), extraEndpoints: o.extraEndpoints, fetch: o.fetch, now: o.clock?.now }) : null;
  const notifier = store && sender ? createNotifier({ store, sender, contact: o.contact, devices: o.devices, clock: o.clock }) : null;
  const routes = createPushRoutes({ enabled: o.enabled, store, notifier, allowedOrigins: o.allowedOrigins, extraEndpoints: o.extraEndpoints, now: o.clock?.now });
  return {
    enabled: o.enabled,
    store,
    notifier,
    tap: <H extends { broadcast(msg: ServerMsg): void }>(hub: H): H => (notifier ? notifier.tap(hub) : hub),
    attach: (src: AttentionSource) => notifier?.attach(src),
    routes,
    forget: (ids: string[]) => {
      if (ids.length) notifier?.forget(ids);
    },
    /** Shutdown: push.json is not written any more (Delete all CAST data wipes the folder right after). */
    stop: () => store?.close(),
  };
}
export type Push = ReturnType<typeof createPush>;
