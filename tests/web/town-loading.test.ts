// Coming back to CAST after a long while (the phone's installed app, a tab left for hours), the socket can take
// seconds to connect and bring the first snapshot; the boot curtain lifts after at most a few seconds anyway, and the
// page used to show "Place your first project" / "No projects yet" / "Connect AI" over a town that has houses and
// accounts. The store now says whether the first snapshot is in (ClientState.synced, net/reducer.ts), and what the
// page says reads it (ui/town-loading.ts, ui/model-state.ts): loading before it, the real empty state after a snapshot
// with no houses or accounts, the houses and accounts after one with them.
// Run: bun test tests/web/town-loading.test.ts
import { describe, expect, test } from 'bun:test';
import type { Lot, ModelInfo, Project, ProviderStatus, ServerMsg } from '../../shared/protocol';
import type { ClientState } from '../../web/src/core/types';
import { applyServerMsg, emptyState } from '../../web/src/net/reducer';
import { ACCOUNTS_LOADING, shownProvidersStatus } from '../../web/src/ui/model-state';
import { onboardingTargets } from '../../web/src/ui/suggestions';
import { CONNECTING, freeLots, housesLoading, LOADING_HOUSES, NO_HOUSES, noHousesItem, whenSynced } from '../../web/src/ui/town-loading';

const project = (id: string, name: string, lotId = `lot-${id}`): Project => ({ id, name, path: `/w/${id}`, lotId, style: 'cottage' }) as unknown as Project;
const lot = (id: string): Lot => ({ id, district: 'Main Ave', x: 0, z: 0, rotY: 0, width: 20, depth: 20 }) as unknown as Lot;
const LOTS = [lot('lot-todo'), lot('lot-b'), lot('lot-c')];
const snapshot = (projects: Project[], accounts: { providers?: ProviderStatus[]; models?: ModelInfo[] } = {}): ServerMsg => ({
  t: 'snapshot', city: { lots: LOTS, projects }, agents: [], workflows: [], runs: [], approvals: [], models: accounts.models ?? [], providers: accounts.providers ?? [], jobs: [], plans: [],
});
const anthropic = { vendor: 'anthropic', label: 'Anthropic', connected: true, how: '' } as ProviderStatus;
/** The menus and the welcome, the way the UI builds them from the state. */
const menu = (s: ClientState) => (s.city.projects.length ? s.city.projects.map((p) => p.name) : [noHousesItem(s).label]);
const fakeStore = (state: ClientState) => {
  const subs = new Set<(s: ClientState) => void>();
  return {
    state,
    subscribe(fn: (s: ClientState) => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    apply(msg: ServerMsg) {
      applyServerMsg(state, msg);
      for (const fn of [...subs]) fn(state);
    },
    get listeners() {
      return subs.size;
    },
  };
};

describe('before the first snapshot: loading, never "no projects"', () => {
  test('a fresh page is not synced; the houses are loading (connecting, while there is no connection)', () => {
    const s = emptyState();
    expect(s.synced).toBe(false);
    expect(housesLoading(s)).toEqual({ title: LOADING_HOUSES, detail: CONNECTING });
    s.connected = true;
    applyServerMsg(s, { t: 'hello' } as ServerMsg); // hello comes first: still nothing known about the houses
    expect(s.synced).toBe(false);
    expect(housesLoading(s)?.title).toBe(LOADING_HOUSES);
    expect(housesLoading(s)?.detail).not.toBe(CONNECTING);
  });
  test('the menus say "Loading your projects…", not "No projects yet"', () => {
    const s = emptyState();
    expect(menu(s)).toEqual([LOADING_HOUSES]);
    expect(menu(s)).not.toContain(NO_HOUSES);
    expect(noHousesItem(s).disabled).toBe(true);
  });
  test('the welcome is not opened until the snapshot is in (it would offer "Place your first project")', () => {
    const store = fakeStore(emptyState());
    let opened = 0;
    whenSynced(store, () => opened++);
    store.apply({ t: 'hello' } as ServerMsg);
    expect(opened).toBe(0);
    store.apply(snapshot([project('todo', 'todo-api')]));
    expect(opened).toBe(1);
    expect(onboardingTargets(store.state.city.projects).map((t) => t.label)).toEqual(['Enter todo-api']);
    store.apply(snapshot([])); // a later snapshot (a reconnect) doesn't open it again
    expect(opened).toBe(1);
    expect(store.listeners).toBe(0);
  });
  test('already synced: whenSynced runs at once; a cancelled wait never runs', () => {
    const synced = fakeStore(emptyState());
    synced.apply(snapshot([]));
    let n = 0;
    whenSynced(synced, () => n++);
    expect(n).toBe(1);
    const waiting = fakeStore(emptyState());
    const off = whenSynced(waiting, () => n++);
    off();
    waiting.apply(snapshot([]));
    expect(n).toBe(1);
  });
});

describe('after the first snapshot', () => {
  test('no houses: the real empty state', () => {
    const s = emptyState();
    s.connected = true;
    applyServerMsg(s, snapshot([]));
    expect(s.synced).toBe(true);
    expect(housesLoading(s)).toBeNull();
    expect(menu(s)).toEqual([NO_HOUSES]);
    expect(onboardingTargets(s.city.projects)).toEqual([{ id: null, label: 'Place your first project', kind: 'place' }]);
  });
  test('houses: they show', () => {
    const s = emptyState();
    s.connected = true;
    applyServerMsg(s, snapshot([project('todo', 'todo-api'), project('novel', 'my-novel')]));
    expect(housesLoading(s)).toBeNull();
    expect(menu(s)).toEqual(['todo-api', 'my-novel']);
    expect(onboardingTargets(s.city.projects)[0]).toMatchObject({ id: 'todo', kind: 'enter' });
  });
  test('a lost connection keeps the town: still synced, nothing "loading"', () => {
    const s = emptyState();
    s.connected = true;
    applyServerMsg(s, snapshot([project('todo', 'todo-api')]));
    s.connected = false;
    expect(s.synced).toBe(true);
    expect(housesLoading(s)).toBeNull();
    expect(menu(s)).toEqual(['todo-api']);
  });
});

describe('AI accounts: not known before the first snapshot — never "Connect AI" then', () => {
  test('before it: a neutral loading state (top bar pill, More menu hint)', () => {
    const s = emptyState();
    s.connected = true;
    applyServerMsg(s, { t: 'hello' } as ServerMsg);
    const st = shownProvidersStatus('ok', s);
    expect(st).toEqual(ACCOUNTS_LOADING);
    expect(st.tone).not.toBe('none');
    expect(st.label).not.toBe('Connect AI');
    expect(st.aria).not.toContain('No AI account');
  });
  test('after a snapshot with no account: "Connect AI"', () => {
    const s = emptyState();
    applyServerMsg(s, snapshot([]));
    expect(shownProvidersStatus('ok', s)).toMatchObject({ tone: 'none', label: 'Connect AI' });
  });
  test('after a snapshot with an account: live', () => {
    const s = emptyState();
    applyServerMsg(s, snapshot([], { providers: [anthropic] }));
    expect(shownProvidersStatus('ok', s)).toMatchObject({ tone: 'live', label: '1 live' });
  });
  test('what the agent check says still wins once the accounts are known', () => {
    const s = emptyState();
    applyServerMsg(s, snapshot([]));
    expect(shownProvidersStatus('omp-missing', s)).toMatchObject({ tone: 'warn', label: 'No agent' });
  });
});

describe('placing a project: the free lots', () => {
  test('before the first snapshot: not known (the dialog says loading), not "no lot free"', () => {
    expect(freeLots(emptyState())).toBeNull();
  });
  test('after it: the lots no house stands on, and an empty town has them all', () => {
    const s = emptyState();
    applyServerMsg(s, snapshot([]));
    expect(freeLots(s)?.map((l) => l.id)).toEqual(['lot-todo', 'lot-b', 'lot-c']);
    applyServerMsg(s, snapshot([project('todo', 'todo-api')]));
    expect(freeLots(s)?.map((l) => l.id)).toEqual(['lot-b', 'lot-c']);
  });
  test('a full town: none free (an empty list, not loading)', () => {
    const s = emptyState();
    applyServerMsg(s, snapshot([project('a', 'a', 'lot-todo'), project('b', 'b', 'lot-b'), project('c', 'c', 'lot-c')]));
    expect(freeLots(s)).toEqual([]);
  });
});
