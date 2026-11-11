// Open WebSockets (/ws and /term) by the credential that opened them, so signing a device out — or changing the
// pairing token — ends that device's live connections at once instead of when they happen to reconnect.
import type { AuthVia, RevokeEvent } from './auth';

/** Close code the client reads as "this device was signed out" (4000–4999 are application codes). */
export const WS_SIGNED_OUT = 4401;

export interface CredentialedSocket {
  data: { deviceId?: string | null; via?: AuthVia };
  close(code?: number, reason?: string): void;
}

export function createDeviceSockets<T extends CredentialedSocket>() {
  const byDevice = new Map<string, Set<T>>();
  const byToken = new Set<T>();

  function closeAll(set: Iterable<T>, reason: string) {
    for (const ws of [...set]) {
      try {
        ws.close(WS_SIGNED_OUT, reason);
      } catch {
        /* already closed */
      }
    }
  }

  return {
    add(ws: T) {
      const id = ws.data.deviceId;
      if (id) {
        let set = byDevice.get(id);
        if (!set) byDevice.set(id, (set = new Set()));
        set.add(ws);
      } else if (ws.data.via === 'token') byToken.add(ws);
    },
    remove(ws: T) {
      const id = ws.data.deviceId;
      if (id) {
        const set = byDevice.get(id);
        set?.delete(ws);
        if (set && !set.size) byDevice.delete(id);
      }
      byToken.delete(ws);
    },
    /** Auth said these sessions ended: close their sockets. */
    revoked(e: RevokeEvent) {
      for (const id of e.deviceIds) {
        const set = byDevice.get(id);
        if (!set) continue;
        byDevice.delete(id);
        closeAll(set, 'Signed out');
      }
      if (e.token) {
        const set = [...byToken];
        byToken.clear();
        closeAll(set, 'Pairing token changed');
      }
    },
    count(): number {
      let n = byToken.size;
      for (const s of byDevice.values()) n += s.size;
      return n;
    },
  };
}
