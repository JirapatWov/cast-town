// The Inbox's "Recent" (finding #65): agent errors and other house events are kept by the server (activity log),
// sent with the snapshot and as toasts carrying the entry's id, so every device shows the same list and a reload
// keeps it. Run: bun test tests/chat/activity.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMsg } from '../../shared/protocol';
import { ACTIVITY_MAX, ActivityLog, recordToasts } from '../../server/activity-log';
import { applyServerMsg, emptyState } from '../../web/src/net/reducer';
import { recentItems, unseenProblems } from '../../web/src/ui/inbox-recent';

function fakeHub() {
  const sent: ServerMsg[] = [];
  return { sent, broadcast: (m: ServerMsg) => void sent.push(m), clients: () => [] };
}

describe('server activity log', () => {
  test('every broadcast toast is recorded and goes out with the entry id; other messages pass untouched', () => {
    const log = new ActivityLog(null, () => 1000);
    const hub = recordToasts(fakeHub(), log);
    hub.broadcast({ t: 'toast', level: 'error', text: "Assistant: Couldn't start omp: boom", projectId: 'todo-api', agentId: 'todo-api:assistant' });
    hub.broadcast({ t: 'agent_removed', agentId: 'x' });
    const [toast, other] = hub.sent;
    expect(toast.t).toBe('toast');
    const e = log.list()[0];
    expect(e).toMatchObject({ level: 'error', text: "Assistant: Couldn't start omp: boom", projectId: 'todo-api', agentId: 'todo-api:assistant', ts: 1000 });
    expect(toast).toMatchObject({ id: e.id, ts: 1000 });
    expect(other).toEqual({ t: 'agent_removed', agentId: 'x' });
  });

  test('newest first, capped, persisted (0600) and read back after a restart', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'activity-'));
    let t = 0;
    const log = new ActivityLog(dir, () => ++t);
    for (let i = 0; i < ACTIVITY_MAX + 10; i++) log.add({ level: 'info', text: `event ${i}`, projectId: i % 2 ? 'a' : 'b' });
    log.flush();
    const file = join(dir, 'activity.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).entries.length).toBe(ACTIVITY_MAX);
    const again = new ActivityLog(dir);
    expect(again.list()[0].text).toBe(`event ${ACTIVITY_MAX + 9}`);
    again.forgetProject('a');
    expect(again.list().every((e) => e.projectId === 'b')).toBe(true);
  });

  test('a broken file starts a new log instead of failing', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'activity-'));
    writeFileSync(join(dir, 'activity.json'), '{nope');
    expect(new ActivityLog(dir).list()).toEqual([]);
  });
});

describe('client: Recent', () => {
  test('the snapshot brings the server’s list; a toast with an id joins it once', () => {
    const s = emptyState();
    applyServerMsg(s, {
      t: 'snapshot', city: { lots: [], projects: [] }, agents: [], workflows: [], runs: [], approvals: [], models: [], providers: [], jobs: [], plans: [],
      activity: [{ id: 'a-1', ts: 10, level: 'success', text: 'Team finished' }],
    });
    const toast: ServerMsg = { t: 'toast', level: 'error', text: 'Assistant: Couldn’t start omp', id: 'a-2', ts: 20, agentId: 'p:assistant' };
    applyServerMsg(s, toast);
    applyServerMsg(s, toast);
    expect(s.activity!.map((e) => e.id)).toEqual(['a-2', 'a-1']);
  });

  test('an older server (no activity log) leaves the page’s own history in charge', () => {
    const s = emptyState();
    applyServerMsg(s, { t: 'snapshot', city: { lots: [], projects: [] }, agents: [], workflows: [], runs: [], approvals: [], models: [], providers: [], jobs: [], plans: [] });
    applyServerMsg(s, { t: 'toast', level: 'error', text: 'x' });
    expect(s.activity).toBeUndefined();
  });

  test('server entries and this page’s own notes merge newest first; unseen errors count for the bell', () => {
    const items = recentItems(
      [{ id: 'a-2', ts: 30, level: 'error', text: 'start failed' }, { id: 'a-1', ts: 10, level: 'success', text: 'run done' }],
      [{ id: 1, ts: 20, level: 'error', text: 'Couldn’t send that' }],
    );
    expect(items.map((i) => i.text)).toEqual(['start failed', 'Couldn’t send that', 'run done']);
    expect(unseenProblems(items, 0)).toBe(2);
    expect(unseenProblems(items, 25)).toBe(1);
    expect(unseenProblems(items, 30)).toBe(0);
  });
});
