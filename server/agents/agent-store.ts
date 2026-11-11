// Server-side mirror of every person (AgentInfo) and their transcript, broadcasting changes to all clients.
// Streaming transcript updates are throttled to ≤10/s per agent (full text so far); agent upserts are
// coalesced per agent within a short window so chatty sources (subagent progress) don't flood the socket.
// It also keeps the session's spend ledger (shared/spend.ts): every cost change passes through here, including the
// last one of a person who is about to leave, so what they spent stays counted after they're gone.
import type { Hub } from '../contracts';
import type { AgentInfo, TranscriptItem } from '../../shared/protocol';
import { createSpendLedger } from '../../shared/spend';

const STREAM_INTERVAL_MS = 100;
const AGENT_COALESCE_MS = 60;
const MAX_TRANSCRIPT_ITEMS = 600;
/** Spend updates go out at most this often (costs change with every streamed usage report). */
const SPEND_COALESCE_MS = 400;

export class AgentStore {
  #agents = new Map<string, AgentInfo>();
  #transcripts = new Map<string, TranscriptItem[]>();
  #pendingItems = new Map<string, Map<string, TranscriptItem>>(); // agentId → itemId → latest item
  #itemTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #agentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Observers (e.g. the workflow engine) — called after every agent change, before the broadcast. */
  #listeners = new Set<(a: AgentInfo) => void>();
  /** Called after a person's transcript changed (the thread book persists it). */
  #transcriptListeners = new Set<(agentId: string, items: TranscriptItem[]) => void>();

  /** What this server session spent, per vendor — never lowered by people leaving. */
  readonly spend = createSpendLedger();
  #spendTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly hub: Hub) {}

  #noteSpend(a: AgentInfo): void {
    if (!this.spend.observe(a.id, a.vendor, a.costUsd, !!a.demo)) return;
    if (this.#spendTimer) return;
    this.#spendTimer = setTimeout(() => {
      this.#spendTimer = undefined;
      this.hub.broadcast({ t: 'spend', spend: this.spend.totals() });
    }, SPEND_COALESCE_MS);
  }

  list(): AgentInfo[] {
    return [...this.#agents.values()];
  }
  get(id: string): AgentInfo | undefined {
    return this.#agents.get(id);
  }
  has(id: string): boolean {
    return this.#agents.has(id);
  }
  onChange(fn: (a: AgentInfo) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  onTranscript(fn: (agentId: string, items: TranscriptItem[]) => void): () => void {
    this.#transcriptListeners.add(fn);
    return () => this.#transcriptListeners.delete(fn);
  }

  /** Replace a person's transcript (thread switch / load from disk); `broadcast` sends transcript_reset to everyone. */
  setTranscript(id: string, items: TranscriptItem[], broadcast: boolean): void {
    const t = this.#itemTimers.get(id);
    if (t) clearTimeout(t);
    this.#itemTimers.delete(id);
    this.#pendingItems.delete(id);
    this.#transcripts.set(id, items);
    if (broadcast) this.hub.broadcast({ t: 'transcript_reset', agentId: id, items });
  }

  /** Insert or replace an agent and broadcast it immediately. */
  upsert(agent: AgentInfo): void {
    this.#agents.set(agent.id, agent);
    this.#noteSpend(agent);
    if (!this.#transcripts.has(agent.id)) this.#transcripts.set(agent.id, []);
    this.#clearAgentTimer(agent.id);
    this.#emit(agent);
  }

  /** Merge fields into an agent; broadcast (coalesced) only when something actually changed. */
  patch(id: string, patch: Partial<AgentInfo>, immediate = false): AgentInfo | undefined {
    const cur = this.#agents.get(id);
    if (!cur) return undefined;
    let changed = false;
    for (const [k, v] of Object.entries(patch) as [keyof AgentInfo, unknown][]) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(v)) {
        changed = true;
        break;
      }
    }
    if (!changed) return cur;
    const next = { ...cur, ...patch } as AgentInfo;
    for (const k of Object.keys(patch) as (keyof AgentInfo)[]) if (patch[k] === undefined) delete next[k];
    this.#agents.set(id, next);
    if ('costUsd' in patch || 'vendor' in patch) this.#noteSpend(next);
    if (immediate) {
      this.#clearAgentTimer(id);
      this.#emit(next);
    } else if (!this.#agentTimers.has(id)) {
      this.#agentTimers.set(id, setTimeout(() => {
        this.#agentTimers.delete(id);
        const a = this.#agents.get(id);
        if (a) this.#emit(a);
      }, AGENT_COALESCE_MS));
    }
    return next;
  }

  remove(id: string): void {
    if (!this.#agents.delete(id)) return;
    this.spend.forget(id); // what they spent stays in the totals
    this.#clearAgentTimer(id);
    this.#flushItems(id);
    this.#transcripts.delete(id);
    this.hub.broadcast({ t: 'agent_removed', agentId: id });
  }

  transcript(id: string): TranscriptItem[] {
    this.#flushItems(id);
    return this.#transcripts.get(id) ?? [];
  }

  findItem(agentId: string, itemId: string): TranscriptItem | undefined {
    return this.#pendingItems.get(agentId)?.get(itemId) ?? this.#transcripts.get(agentId)?.find((i) => i.id === itemId);
  }

  /** Upsert a transcript item. `stream` = part of a fast-changing stream → throttled. */
  upsertItem(agentId: string, item: TranscriptItem, stream = false): void {
    this.#store(agentId, item);
    if (stream) {
      let pending = this.#pendingItems.get(agentId);
      if (!pending) this.#pendingItems.set(agentId, (pending = new Map()));
      pending.set(item.id, item);
      if (!this.#itemTimers.has(agentId)) {
        this.#itemTimers.set(agentId, setTimeout(() => this.#flushItems(agentId), STREAM_INTERVAL_MS));
      }
      return;
    }
    this.#pendingItems.get(agentId)?.delete(item.id);
    this.#flushItems(agentId); // keep ordering: earlier streamed items go out first
    this.hub.broadcast({ t: 'transcript_upsert', agentId, item });
  }

  /** Take an item out of a person's chat (a message handed back to the composer): everyone gets the chat again. */
  removeItem(agentId: string, itemId: string): void {
    this.#flushItems(agentId);
    const list = this.#transcripts.get(agentId);
    const i = list ? list.findIndex((x) => x.id === itemId) : -1;
    if (!list || i < 0) return;
    list.splice(i, 1);
    for (const fn of this.#transcriptListeners) {
      try {
        fn(agentId, list);
      } catch (err) {
        console.error('[agents] transcript listener failed', err);
      }
    }
    this.hub.broadcast({ t: 'transcript_reset', agentId, items: list });
  }

  /** Push the latest agent state right away (e.g. before a terminal transition). */
  flushAgent(id: string): void {
    if (!this.#agentTimers.has(id)) return;
    this.#clearAgentTimer(id);
    const a = this.#agents.get(id);
    if (a) this.#emit(a);
  }

  dispose(): void {
    for (const t of this.#itemTimers.values()) clearTimeout(t);
    for (const t of this.#agentTimers.values()) clearTimeout(t);
    this.#itemTimers.clear();
    this.#agentTimers.clear();
  }

  #store(agentId: string, item: TranscriptItem) {
    let list = this.#transcripts.get(agentId);
    if (!list) this.#transcripts.set(agentId, (list = []));
    let i = -1;
    for (let k = list.length - 1; k >= 0; k--) {
      if (list[k].id === item.id) {
        i = k;
        break;
      }
    }
    if (i >= 0) list[i] = item;
    else {
      list.push(item);
      if (list.length > MAX_TRANSCRIPT_ITEMS) list.splice(0, list.length - MAX_TRANSCRIPT_ITEMS);
    }
    for (const fn of this.#transcriptListeners) {
      try {
        fn(agentId, list);
      } catch (err) {
        console.error('[agents] transcript listener failed', err);
      }
    }
  }

  #flushItems(agentId: string) {
    const t = this.#itemTimers.get(agentId);
    if (t) clearTimeout(t);
    this.#itemTimers.delete(agentId);
    const pending = this.#pendingItems.get(agentId);
    if (!pending?.size) return;
    this.#pendingItems.delete(agentId);
    for (const item of pending.values()) this.hub.broadcast({ t: 'transcript_upsert', agentId, item });
  }

  #clearAgentTimer(id: string) {
    const t = this.#agentTimers.get(id);
    if (t) clearTimeout(t);
    this.#agentTimers.delete(id);
  }

  #emit(a: AgentInfo) {
    for (const fn of this.#listeners) {
      try {
        fn(a);
      } catch (err) {
        console.error('[agents] listener failed', err);
      }
    }
    this.hub.broadcast({ t: 'agent', agent: a });
  }
}
