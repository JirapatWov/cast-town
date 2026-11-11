// Hub: the set of connected browser clients. Serializes each broadcast once and fans it out.
import type { ServerWebSocket } from 'bun';
import type { ServerMsg } from '../shared/protocol';
import type { AuthVia } from './auth';
import type { ClientConn, Hub } from './contracts';
import type { CitySocket } from './city-proxy';
import type { TermParams } from './terminal';
import { log } from './util';

export interface WsData {
  connId: string;
  user: string | null;
  /** The paired device that opened it (auth.ts), so signing that device out closes it (device-sockets.ts). */
  deviceId?: string | null;
  via?: AuthVia;
  /** Set for /term sockets (plain shells); those never join the hub. */
  term?: TermParams;
  /** Set for sockets bridged to another city (/city/<id>/ws, …, server/city-proxy.ts); those never join the hub. */
  city?: CitySocket;
}

export interface CoreHub extends Hub {
  attach(ws: ServerWebSocket<WsData>): ClientConn;
  detach(ws: ServerWebSocket<WsData>): void;
  get(ws: ServerWebSocket<WsData>): ClientConn | undefined;
  closeAll(code?: number, reason?: string): void;
}

const OPEN = 1;
/** Above this many queued bytes a client is considered stuck and is disconnected (it will reconnect and resync). */
const MAX_BUFFERED = 64 * 1024 * 1024;

export function createHub(): CoreHub {
  const conns = new Map<ServerWebSocket<WsData>, ClientConn>();

  function sendRaw(ws: ServerWebSocket<WsData>, json: string): void {
    if (ws.readyState !== OPEN) return;
    if (ws.getBufferedAmount() > MAX_BUFFERED) {
      log('hub', `client ${ws.data.connId} is not keeping up; closing it`);
      ws.close(1013, 'Too slow, please reconnect');
      return;
    }
    try {
      ws.send(json);
    } catch (err) {
      log('hub', `send to ${ws.data.connId} failed`, err);
    }
  }

  return {
    attach(ws) {
      const conn: ClientConn = {
        id: ws.data.connId,
        user: ws.data.user,
        send: (msg: ServerMsg) => sendRaw(ws, JSON.stringify(msg)),
      };
      conns.set(ws, conn);
      return conn;
    },
    detach(ws) {
      conns.delete(ws);
    },
    get(ws) {
      return conns.get(ws);
    },
    broadcast(msg) {
      if (conns.size === 0) return;
      const json = JSON.stringify(msg);
      for (const ws of conns.keys()) sendRaw(ws, json);
    },
    clients() {
      return [...conns.values()];
    },
    closeAll(code = 1001, reason = 'Server shutting down') {
      for (const ws of conns.keys()) {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      }
      conns.clear();
    },
  };
}
