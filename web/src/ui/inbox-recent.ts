// The Inbox's "Recent": the house activity log the server keeps (the same on every device, it survives a reload)
// plus what happened only on this page (answers to this browser's own actions: "Couldn't send that…", "Copied").
// A server from before the activity log sends none; then the page's own toast history is all there is.
// Pure (no DOM).
import type { ActivityEntry } from '../../../shared/protocol';

export interface RecentItem {
  key: string;
  level: ActivityEntry['level'];
  text: string;
  ts: number;
  projectId?: string;
  agentId?: string;
}

interface LocalNote {
  id: number;
  level: ActivityEntry['level'];
  text: string;
  ts: number;
  projectId?: string;
  agentId?: string;
}

/** Newest first, at most `limit`. */
export function recentItems(activity: ActivityEntry[] | undefined, local: LocalNote[], limit = 40): RecentItem[] {
  const items: RecentItem[] = [
    ...(activity ?? []).map((e) => ({ key: `s:${e.id}`, level: e.level, text: e.text, ts: e.ts, projectId: e.projectId, agentId: e.agentId })),
    ...local.map((n) => ({ key: `l:${n.id}`, level: n.level, text: n.text, ts: n.ts, projectId: n.projectId, agentId: n.agentId })),
  ];
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, limit);
}

/** Errors that came in since the Inbox was last looked at on this device — the bell's red dot. */
export function unseenProblems(items: RecentItem[], seenTs: number): number {
  return items.filter((i) => i.ts > seenTs && i.level === 'error').length;
}
