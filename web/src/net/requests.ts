// reqId → pending promise correlation for request/ack style messages.
import type { ServerMsg } from '../../../shared/protocol';

export class RequestError extends Error {
  /** unsure: it went out but its answer never came (the socket dropped, or no answer in time) — the server may
   *  have acted on it anyway, so sending it again could do it twice. */
  constructor(message: string, readonly reqId: string, readonly unsure = false) {
    super(message);
    this.name = 'RequestError';
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
}

let counter = 0;
export function newReqId(): string {
  counter = (counter + 1) % 1e6;
  return `r${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The request never went out: no connection to the server. */
export const OFFLINE_TEXT = 'Not connected to the CAST server, so it wasn’t sent. Try again once it’s back.';
const NOT_SENT_TEXT = OFFLINE_TEXT;

/** onUnsent: a request timed out before it could go out — drop it from the outbox (the caller was told it failed). */
export function createRequestTracker(opts: { onUnsent?(reqId: string): void } = {}) {
  const pending = new Map<string, Pending>();

  const settle = (reqId: string) => {
    const p = pending.get(reqId);
    if (!p) return null;
    clearTimeout(p.timer);
    pending.delete(reqId);
    return p;
  };

  return {
    track<T>(reqId: string, timeoutMs: number, sent: boolean, timeoutText = 'The server did not answer in time. Try again.'): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const p = settle(reqId);
          if (!p) return;
          if (!p.sent) opts.onUnsent?.(reqId);
          reject(p.sent ? new RequestError(timeoutText, reqId, true) : new RequestError(NOT_SENT_TEXT, reqId));
        }, timeoutMs);
        pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer, sent });
      });
    },
    markSent(reqId: string) {
      const p = pending.get(reqId);
      if (p) p.sent = true;
    },
    /** Returns true when the message answered a pending request. */
    handle(msg: ServerMsg): boolean {
      if (msg.t === 'ack') {
        const p = settle(msg.reqId);
        if (!p) return false;
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new RequestError(msg.error || 'Request failed', msg.reqId));
        return true;
      }
      if (msg.t === 'fs_list') {
        const p = settle(msg.reqId);
        if (!p) return false;
        if (msg.error) p.reject(new RequestError(msg.error, msg.reqId));
        else p.resolve(msg);
        return true;
      }
      if (msg.t === 'error' && msg.reqId) {
        const p = settle(msg.reqId);
        if (!p) return false;
        p.reject(new RequestError(msg.message, msg.reqId));
        return true;
      }
      return false;
    },
    /** Offline for a while: requests still waiting to go out fail now (and leave the outbox) instead of at their
     *  timeout. */
    failUnsent(reason: string) {
      for (const [id, p] of [...pending]) {
        if (p.sent) continue;
        settle(id);
        opts.onUnsent?.(id);
        p.reject(new RequestError(reason, id));
      }
    },
    /** The socket dropped: requests already on the wire will never be answered. */
    failSent(reason: string) {
      for (const [id, p] of [...pending]) {
        if (!p.sent) continue;
        settle(id);
        p.reject(new RequestError(reason, id, true));
      }
    },
  };
}
