// #80 with the network dropped (not the server stopped): an idle WebSocket can look open for minutes, so a click
// spun until its timeout and went out later. On the browser's `offline` event the socket asks whether the server can
// still be reached and drops at once when it can't (a server on this machine stays reachable: that socket is kept).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connectSocket } from '../../web/src/net/socket';

class FakeSocket {
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
