// Which models people can work on, as their name tags show it ("not connected" on the others). Its own module without
// three: main.ts sets it from the first snapshot, long before the 3D town (and three) has loaded.
import type { AgentInfo } from '../../../shared/protocol';

/** The models that work now; null → mark nobody (the first account check still runs and the server holds messages
 *  for it, or the scripted test model plays every model). */
let ready: Set<string> | null = null;
let shown = 'null';

/** The server won't start this person: their model isn't connected (the same test as ui/format.ts agentBlocked:
 *  the server's word, else the list; never a helper). */
export function tagNotConnected(a: Pick<AgentInfo, 'model'> & Partial<Pick<AgentInfo, 'kind' | 'notConnected'>>): boolean {
  if (ready === null || a.kind === 'subagent') return false;
  return a.notConnected ?? !ready.has(a.model);
}

/** True when it changed (tags update on their next sync). */
export function setTagModels(ids: string[] | null): boolean {
  const next = JSON.stringify(ids && [...ids].sort());
  if (next === shown) return false;
  shown = next;
  ready = ids ? new Set(ids) : null;
  return true;
}
