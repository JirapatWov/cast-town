// "New reply" on the Town board: a job whose people finished a turn while their chat wasn't open. The server keeps no
// read state, so this device remembers it (it survives a reload) from the agent updates the store already gets.
import type { AgentInfo } from '../../../shared/protocol';
import { deviceStorage } from './dom';
import { agentTone } from './format';
import type { Shell } from './shell';

const KEY = 'rlt.board.unread';
const MAX = 200; // jobs removed elsewhere never get opened again: keep the newest only

export interface Unread {
  ts: number;
  agentId: string; // who finished last: the board's row opens their chat
}

const jobKey = (projectId: string, jobId: string) => `${projectId}/${jobId}`;

function load(): Map<string, Unread> {
  try {
    const raw = JSON.parse(deviceStorage.get(KEY) ?? '{}') as Record<string, Unread>;
    return new Map(Object.entries(raw).filter(([, u]) => typeof u?.ts === 'number' && typeof u.agentId === 'string'));
  } catch {
    return new Map();
  }
}

export interface BoardUnread {
  of(projectId: string, jobId: string): Unread | undefined;
  /** Jobs of a house with a reply nobody has read yet. */
  count(projectId: string): number;
  clear(projectId: string, jobId: string): void;
  /** The panel may have opened a chat since the last store change (the board checks when it draws). */
  sync(): void;
  readonly size: number;
}

export function createBoardUnread(shell: Shell, onChange: () => void): BoardUnread {
  const { store } = shell;
  const unread = load();
  const working = new Map<string, boolean>(); // agent id → working at the last store change

  function save() {
    const newest = [...unread].sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX);
    if (newest.length) deviceStorage.set(KEY, JSON.stringify(Object.fromEntries(newest)));
    else deviceStorage.remove(KEY);
    onChange();
  }

  /** That person's chat is open: their job's reply counts as read. */
  function seen(agentId: string | null): boolean {
    const a = agentId ? store.state.agents[agentId] : undefined;
    return !!a && unread.delete(jobKey(a.projectId, a.jobId));
  }

  function finished(a: AgentInfo, now: boolean): boolean {
    const was = working.get(a.id);
    working.set(a.id, now);
    // helpers report to their lead, whose turn ending is the reply; waiting on the user is already "waiting for you"
    if (!was || now || a.kind === 'subagent') return false;
    const tone = agentTone(a);
    return tone !== 'wait' && tone !== 'off';
  }

  store.subscribe((s) => {
    let changed = seen(shell.chatAgentId);
    const open = shell.chatAgentId;
    for (const a of Object.values(s.agents)) {
      if (!finished(a, agentTone(a) === 'work') || a.id === open) continue;
      unread.set(jobKey(a.projectId, a.jobId), { ts: Date.now(), agentId: a.id });
      changed = true;
    }
    if (working.size > Object.keys(s.agents).length) for (const id of working.keys()) if (!s.agents[id]) working.delete(id);
    if (changed) save();
  });

  return {
    of: (projectId, jobId) => unread.get(jobKey(projectId, jobId)),
    count(projectId) {
      let n = 0;
      for (const k of unread.keys()) if (k.startsWith(`${projectId}/`)) n++;
      return n;
    },
    clear(projectId, jobId) {
      if (unread.delete(jobKey(projectId, jobId))) save();
    },
    sync() {
      if (seen(shell.chatAgentId)) save();
    },
    get size() {
      return unread.size;
    },
  };
}
