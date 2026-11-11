// A WebSocket that keeps itself connected: exponential backoff with jitter, immediate retry when
// the tab becomes visible or the network comes back.
//
// When the browser says the network went away, an open socket can look fine for a long time (nothing is sent on an
// idle socket, so nothing fails): a click meanwhile spun until its timeout and went out much later, once the network
// was back. So on `offline` the socket asks `reachable()` (a quick request to the server) and drops at once when the
// server can't be reached — the page then says it is offline and requests fail right away. A server on this machine
// stays reachable without a network: that socket is kept.

export interface SocketHandlers {
  onOpen(): void;
  onClose(): void;
  onMessage(data: string): void;
  /** Can the server still be reached? Asked when the browser reports the network gone (absent: assume not). */
  reachable?(): Promise<boolean>;
}

export interface ReconnectingSocket {
  send(data: string): boolean; // false when not open
  readonly open: boolean;
  close(): void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;
const FACTOR = 1.8;

export function connectSocket(url: string, h: SocketHandlers): ReconnectingSocket {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const nextDelay = () => {
    const raw = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * FACTOR ** attempt);
    attempt++;
    return raw * (0.8 + Math.random() * 0.4);
  };

  const schedule = (delay: number) => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      console.warn('[net] cannot open socket', err);
      schedule(nextDelay());
      return;
    }
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      h.onOpen();
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') h.onMessage(ev.data);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      h.onClose();
      schedule(nextDelay());
    };
    sock.onerror = () => {
      /* onclose follows and handles the retry */
    };
  };

  /** Give up on a socket that can't reach the server any more (the browser may not notice for minutes). */
  const drop = (sock: WebSocket) => {
    if (ws !== sock) return;
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try {
      sock.close();
    } catch {
      /* already closing */
    }
    ws = null;
    h.onClose();
    schedule(nextDelay());
  };
  const onOffline = () => {
    const sock = ws;
    if (stopped || !sock) return;
    const check = h.reachable ? h.reachable().catch(() => false) : Promise.resolve(false);
    void check.then((ok) => {
      if (!ok) drop(sock);
    });
  };

  const retryNow = () => {
    if (stopped || ws) return;
    if (timer) clearTimeout(timer);
    timer = null;
    attempt = 0;
    connect();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') retryNow();
  };
  window.addEventListener('online', retryNow);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);

  connect();

  return {
    get open() {
      return ws?.readyState === WebSocket.OPEN;
    },
    send(data) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(data);
      return true;
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', retryNow);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
      ws = null;
    },
  };
}
