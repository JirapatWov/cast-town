// Each house's workflows on the page (shared/house-workflows.ts through the client state, web/src/ui/workflow-library.ts,
// web/src/ui/workflow-use.ts, runs.ts): a house sees its own saved workflows, never another house's, and a new house
// has none (CAST lists no example teams: the server's `workflows` is always empty). The library is listed apart,
// imported as a copy. Older servers still work: one that sent built-ins in `workflows` (every house had them), and one
// that sends one flat list every house saw, and no library. Run: bun test <this file>
import { describe, expect, test } from 'bun:test';
import { workflowOf, workflowsOf } from '../../shared/house-workflows';
import type { Job, LibraryWorkflow, Project, ServerMsg, Workflow, WorkflowRun } from '../../shared/protocol';
import { applyServerMsg, emptyState } from '../../web/src/net/reducer';
import { workflowOf as runWorkflow } from '../../web/src/ui/runs';
import {
  canPromote, houseWorkflowsLine, importAsk, libraryRows, ownWorkflows, promoteAsk, removeFromLibraryAsk,
} from '../../web/src/ui/workflow-library';
import { workflowUse } from '../../web/src/ui/workflow-use';

const wf = (id: string, name = id, o: Partial<Workflow> = {}): Workflow => ({
  id, name, description: `${name} does it`, icon: '🧩', steps: [{ id: 'a', name: 'A', model: 'anthropic/x', persona: '', instruction: '', kind: 'work' }], ...o,
});
// the two example teams an older server had in every house (built-ins); now a house has them only as its own copy
const CODE = wf('decode-implement-review', 'Decode → Implement → Review', { builtin: true });
const NOVEL = wf('novel', 'Novel', { builtin: true });
const lib = (w: Workflow, from?: LibraryWorkflow['from']): LibraryWorkflow => ({ workflow: w, ...(from ? { from } : {}), at: 1 });
const project = (id: string, name = id) => ({ id, name, workflowId: null }) as unknown as Project;
const apply = (s: ReturnType<typeof emptyState>, msg: unknown) => applyServerMsg(s, msg as ServerMsg);
const snapshot = (over: Record<string, unknown>) => ({ t: 'snapshot', city: { lots: [], projects: [project('terminal'), project('my-novel')] }, agents: [], runs: [], approvals: [], models: [], providers: [], jobs: [], ...over });

/** Two houses: terminal has its own “Pair” and its own copy of the old Novel team; my-novel has its own “Pair” (another
 *  copy, the same id) and “Cover”. The server sends no workflows of its own. */
function twoHouses() {
  const s = emptyState();
  apply(s, snapshot({
    workflows: [],
    houseWorkflows: {
      terminal: [wf('novel', 'Novel (terminal’s)'), wf('pair', 'Pair')],
      'my-novel': [wf('pair', 'Pair (novel)'), wf('cover', 'Cover')],
    },
    library: [lib(wf('pair', 'Pair'), { projectId: 'terminal', house: 'terminal' }), lib(wf('review', 'Review pass', { steps: [] }), { projectId: 'gone', house: 'old-house' }), lib(wf('legacy', 'Legacy'))],
  }));
  return s;
}

describe('workflowsOf: what one house sees', () => {
  test('its own, in order — never another house’s; a house with none (a new one) sees nothing', () => {
    const s = twoHouses();
    expect(workflowsOf(s, 'terminal').map((w) => w.name)).toEqual(['Novel (terminal’s)', 'Pair']);
    expect(workflowsOf(s, 'my-novel').map((w) => w.name)).toEqual(['Pair (novel)', 'Cover']);
    expect(workflowOf(s, 'terminal', 'cover')).toBeUndefined();
    expect(workflowOf(s, 'my-novel', 'pair')?.name).toBe('Pair (novel)');
    expect(workflowOf(s, 'my-novel', 'novel')).toBeUndefined(); // the old example only where the house has a copy
    expect(workflowOf(s, 'terminal', 'novel')?.name).toBe('Novel (terminal’s)');
    expect(workflowsOf(s, 'new-house')).toEqual([]);
    expect(workflowsOf(s, null)).toEqual([]);
    expect(workflowOf(s, 'new-house', 'decode-implement-review')).toBeUndefined();
    expect(workflowOf(s, 'terminal', null)).toBeUndefined();
    // nothing is marked as an example
    expect(workflowsOf(s, 'terminal').some((w) => w.builtin)).toBe(false);
  });
  test('a slightly older server that still sends built-ins: every house has them, its own copy in their place', () => {
    const s = emptyState();
    apply(s, snapshot({ workflows: [CODE, NOVEL], houseWorkflows: { terminal: [wf('pair', 'Pair'), wf('novel', 'Novel (terminal’s)', { builtin: true })] } }));
    expect(workflowsOf(s, 'terminal').map((w) => w.name)).toEqual(['Decode → Implement → Review', 'Novel (terminal’s)', 'Pair']);
    expect(workflowsOf(s, 'new-house').map((w) => w.id)).toEqual(['decode-implement-review', 'novel']);
  });
  test('an older server: its one list is every house’s', () => {
    const s = emptyState();
    apply(s, snapshot({ workflows: [CODE, NOVEL, wf('pair', 'Pair')] }));
    expect(s.houseWorkflows).toBeUndefined();
    expect(s.library).toBeUndefined();
    expect(workflowsOf(s, 'terminal').map((w) => w.id)).toEqual(['decode-implement-review', 'novel', 'pair']);
    expect(workflowOf(s, 'my-novel', 'pair')?.name).toBe('Pair');
    // no library there: nothing to promote, import or list
    expect(canPromote(s, 'terminal', 'pair')).toBe(false);
    expect(libraryRows(s, 'terminal')).toEqual([]);
    expect(houseWorkflowsLine(s, 'terminal')).toBeNull();
  });
  test("a run's workflow is its house's", () => {
    const s = twoHouses();
    const run = (projectId: string, workflowId: string) => ({ id: 'r', projectId, workflowId }) as WorkflowRun;
    expect(runWorkflow(s, run('terminal', 'pair'))?.name).toBe('Pair');
    expect(runWorkflow(s, run('my-novel', 'pair'))?.name).toBe('Pair (novel)');
    expect(runWorkflow(s, run('terminal', 'cover'))).toBeUndefined();
    expect(runWorkflow(s, run('terminal', ''))).toBeUndefined(); // a one-off team
  });
});

describe("reducer: {t:'workflows'}", () => {
  test('takes each house’s own and the library (the server’s own list is empty)', () => {
    const s = twoHouses();
    apply(s, { t: 'workflows', workflows: [], houseWorkflows: { 'my-novel': [wf('cover', 'Cover 2')] }, library: [lib(wf('cover', 'Cover 2'), { projectId: 'my-novel', house: 'my-novel' })] });
    expect(s.workflows).toEqual([]);
    expect(Object.keys(s.houseWorkflows ?? {})).toEqual(['my-novel']);
    expect(workflowsOf(s, 'terminal')).toEqual([]); // its own are gone
    expect(workflowOf(s, 'my-novel', 'cover')?.name).toBe('Cover 2');
    expect(s.library?.map((e) => e.workflow.id)).toEqual(['cover']);
  });
  test('from an older server (one list, no library): every house sees that list again', () => {
    const s = twoHouses();
    apply(s, { t: 'workflows', workflows: [CODE, wf('pair', 'Pair')] });
    expect(s.houseWorkflows).toBeUndefined();
    expect(s.library).toBeUndefined();
    expect(workflowsOf(s, 'my-novel').map((w) => w.id)).toEqual(['decode-implement-review', 'pair']);
  });
});

describe('workflowUse per house', () => {
  test('the same id in two houses: each counts only its own jobs and runs', () => {
    const s = twoHouses();
    const job = (projectId: string, id: string, name: string, workflowId: string | null) => ({ projectId, id, name, workflowId }) as Job;
    s.jobs = { terminal: [job('terminal', 'main', 'Main', 'pair')], 'my-novel': [job('my-novel', 'main', 'Main', null), job('my-novel', 'cover', 'Cover art', 'pair')] };
    s.runs = { r1: { id: 'r1', projectId: 'my-novel', jobId: 'cover', workflowId: 'pair', status: 'running', steps: [], startedAt: 1 } as unknown as WorkflowRun };
    expect(workflowUse(s, 'terminal', 'pair')).toEqual({ teams: [{ projectId: 'terminal', jobId: 'main', label: 'Main' }], runs: [], everywhere: false });
    expect(workflowUse(s, 'my-novel', 'pair')).toEqual({ teams: [{ projectId: 'my-novel', jobId: 'cover', label: 'Cover art' }], runs: [{ runId: 'r1', label: 'Cover art' }], everywhere: false });
  });
});

describe('the library', () => {
  test('ownWorkflows / canPromote: the house’s own saved workflows, its copy of an old example included', () => {
    const s = twoHouses();
    expect(ownWorkflows(s, 'terminal').map((w) => w.id)).toEqual(['novel', 'pair']);
    expect(canPromote(s, 'terminal', 'pair')).toBe(true);
    expect(canPromote(s, 'terminal', 'novel')).toBe(true); // its own copy: an ordinary workflow of the house
    expect(canPromote(s, 'terminal', 'decode-implement-review')).toBe(false); // the house has none
    expect(canPromote(s, 'terminal', 'cover')).toBe(false); // my-novel's
    expect(canPromote(s, 'my-novel', 'cover')).toBe(true);
    expect(canPromote(s, 'my-novel', 'novel')).toBe(false);
    expect(canPromote(s, null, 'pair')).toBe(false);
  });
  test('libraryRows: people, where it came from (the house’s name now), and whether this house has it', () => {
    const s = twoHouses();
    s.city.projects = [project('terminal', 'Terminal (renamed)'), project('my-novel')];
    expect(libraryRows(s, 'my-novel')).toEqual([
      { id: 'pair', name: 'Pair', icon: '🧩', description: 'Pair does it', people: 1, from: 'from Terminal (renamed)', here: true },
      { id: 'review', name: 'Review pass', icon: '🧩', description: 'Review pass does it', people: 0, from: 'from old-house', here: false },
      { id: 'legacy', name: 'Legacy', icon: '🧩', description: 'Legacy does it', people: 1, from: 'from the old shared list', here: false },
    ]);
    expect(libraryRows(s, 'terminal')[0]?.from).toBe('from this house');
  });
  test('import asks first only when the house has that id (it is replaced)', () => {
    const s = twoHouses();
    expect(importAsk(s, 'my-novel', 'review')).toBeNull();
    expect(importAsk(s, 'my-novel', 'pair')).toEqual({
      title: 'Import “Pair”?',
      text: ['This house already has “Pair (novel)” — replace it with the library’s?', 'Jobs here that have it as their team get the library’s team. Other houses are not touched.'],
      confirmLabel: 'Replace it',
      danger: true,
    });
  });
  test('promote asks first only when the library has that id; removing says the copies stay', () => {
    const s = twoHouses();
    expect(promoteAsk(s, wf('cover', 'Cover'))).toBeNull();
    expect(promoteAsk(s, wf('pair', 'Pair'))?.text[0]).toBe('The library already has “Pair” — replace it with this house’s?');
    expect(removeFromLibraryAsk('Pair')).toMatchObject({ title: 'Take “Pair” out of the library?', confirmLabel: 'Remove from library' });
  });
  test('removing a house: its own workflows not in the library go with it', () => {
    const s = twoHouses();
    // Pair is in the library; terminal's copy of the old Novel team is its own and not there: it is named
    expect(houseWorkflowsLine(s, 'terminal')).toBe('Its own workflow (“Novel (terminal’s)”) goes with the house — put any you want to keep in the library first (Workflow tab).');
    // my-novel's own “Pair (novel)” has the library's id but isn't the library's version: it is lost too, so it is named
    expect(houseWorkflowsLine(s, 'my-novel')).toBe('Its own workflows (“Pair (novel)” (not the library’s version) and “Cover”) go with the house — put any you want to keep in the library first (Workflow tab).');
    s.houseWorkflows!['my-novel'] = ['a', 'b', 'c', 'd', 'e'].map((x) => wf(x, x.toUpperCase()));
    expect(houseWorkflowsLine(s, 'my-novel')).toBe('Its own workflows (“A”, “B”, “C” and 2 more) go with the house — put any you want to keep in the library first (Workflow tab).');
    expect(houseWorkflowsLine(s, 'nobody')).toBeNull();
    s.houseWorkflows!['terminal'] = [wf('pair', 'Pair')];
    expect(houseWorkflowsLine(s, 'terminal')).toBeNull(); // all of it is in the library
  });
});
