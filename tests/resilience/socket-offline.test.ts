// #80 with the network dropped (not the server stopped): an idle WebSocket can look open for minutes, so a click
// spun until its timeout and went out later. On the browser's `offline` event the socket asks whether the server can
// still be reached and drops at once when it can't (a server on this machine stays reachable: that socket is kept).
// And a socket that never opens (a phone back from sleep or behind a VPN coming up) is given up after OPEN_TIMEOUT_MS
// and retried through the backoff, on a fake clock.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connectSocket, OPEN_TIMEOUT_MS } from '../../web/src/net/socket';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const saved: Record<string, unknown> = {};
let win: EventTarget;

beforeEach(() => {
  for (const k of ['window', 'document', 'WebSocket']) saved[k] = (globalThis as Record<string, unknown>)[k];
  win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.assign(globalThis, { window: win, document: doc, WebSocket: FakeSocket });
  FakeSocket.all = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function open(reachable?: () => Promise<boolean>) {
  const events: string[] = [];
  const sock = connectSocket('ws://x/ws', { onOpen: () => events.push('open'), onClose: () => events.push('close'), onMessage: () => {}, reachable });
  FakeSocket.all[0]!.open();
  return { sock, events };
}

describe('#80 the network goes away', () => {
  test('the server can no longer be reached: the socket drops at once', async () => {
    const { sock, events } = open(async () => false);
    expect(sock.open).toBe(true);
    win.dispatchEvent(new Event('offline'));
    await tick();
    expect(events).toEqual(['open', 'close']);
    expect(FakeSocket.all[0]!.closed).toBe(true);
    expect(sock.open).toBe(false);
    expect(sock.send('{}')).toBe(false); // a request now fails at once instead of waiting on a dead socket
    sock.close();
  });

  test('a server still reachable (on this machine): the socket is kept', async () => {
    const { sock, events } = open(async () => true);
    win.dispatchEvent(new Event('offline'));
    await tick();
    expect(events).toEqual(['open']);
    expect(FakeSocket.all[0]!.closed).toBe(false);
    sock.close();
  });

  test('a failing check counts as unreachable; a late close of the old socket is ignored', async () => {
    const { sock, events } = open(() => Promise.reject(new Error('net')));
    const first = FakeSocket.all[0]!;
    win.dispatchEvent(new Event('offline'));
    await tick();
    expect(events).toEqual(['open', 'close']);
    first.onclose?.(); // handlers were taken off: nothing happens twice
    expect(events).toEqual(['open', 'close']);
    sock.close();
  });

  test('the network comes back: it connects again right away', async () => {
    const { sock } = open(async () => false);
    win.dispatchEvent(new Event('offline'));
    await tick();
    win.dispatchEvent(new Event('online'));
    expect(FakeSocket.all.length).toBe(2);
    sock.close();
  });
});

/** setTimeout / clearTimeout on a clock that only moves when told to. */
function fakeClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  Object.assign(globalThis, {
    setTimeout: (fn: () => void, ms = 0) => (due.set(++seq, { at: now + ms, fn }), seq),
    clearTimeout: (id?: number) => void (id !== undefined && due.delete(id)),
  });
  return {
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    restore: () => Object.assign(globalThis, real),
  };
}

describe('a socket that never opens', () => {
  test('it is closed after OPEN_TIMEOUT_MS and a new one is tried through the backoff', () => {
    const clock = fakeClock();
    try {
      const events: string[] = [];
      const sock = connectSocket('ws://x/ws', { onOpen: () => events.push('open'), onClose: () => events.push('close'), onMessage: () => {} });
      const first = FakeSocket.all[0]!;
      clock.advance(OPEN_TIMEOUT_MS - 1);
      expect(first.closed).toBe(false); // still within its time
      clock.advance(1);
      expect(first.closed).toBe(true);
      expect(events).toEqual(['close']); // the page says it is reconnecting
      expect(FakeSocket.all.length).toBe(1); // the retry waits for the backoff (at most 0.6 s for the first one)
      clock.advance(600);
      expect(FakeSocket.all.length).toBe(2);
      FakeSocket.all[1]!.open();
      expect(events).toEqual(['close', 'open']);
      first.onclose?.(); // the given-up socket closing late changes nothing
      expect(events).toEqual(['close', 'open']);
      expect(sock.open).toBe(true);
      sock.close();
    } finally {
      clock.restore();
    }
  });

  test('one that opens in time is kept: its timer never fires', () => {
    const clock = fakeClock();
    try {
      const events: string[] = [];
      const sock = connectSocket('ws://x/ws', { onOpen: () => events.push('open'), onClose: () => events.push('close'), onMessage: () => {} });
      clock.advance(OPEN_TIMEOUT_MS - 100);
      FakeSocket.all[0]!.open();
      clock.advance(OPEN_TIMEOUT_MS * 3);
      expect(events).toEqual(['open']);
      expect(FakeSocket.all[0]!.closed).toBe(false);
      expect(FakeSocket.all.length).toBe(1);
      sock.close();
    } finally {
      clock.restore();
    }
  });
});
