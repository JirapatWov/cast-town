// The owner (2026-11-05): "a workflow made in one session shows up in another — make it stay in the project where it
// was made, except when it is promoted to global and another project imports it: a shared library." The lead's side:
// workflow_list shows this house's workflows and, apart, the library; workflow_save, from_run, the twin-name check and
// the new id look at this house only; a library workflow runs only once imported (workflow_import), and goes into the
// library only through workflow_promote.
import { afterAll, describe, expect, test } from 'bun:test';
import { parseWorkflowList } from '../../server/agents/demo/auto.ts';
import { LEAD_TOOL_NAMES, LEAD_TOOLS, prepareWorkflowSave } from '../../server/agents/lead-tools.ts';
import { activityForTool, toolDetail, toolTitle } from '../../server/agents/tool-display.ts';
import { cleanup, GPT, makeWorld, OPUS, runEnd, SONNET, type World } from './world';
afterAll(cleanup);

const STEPS = [
  { name: 'Planner', model: OPUS, persona: 'You plan.' },
  { name: 'Checker', model: GPT, persona: 'You check.', kind: 'review', loopBackTo: 'Planner' },
];
const runOf = (text: string) => text.match(/run (run-\w+)/)![1]!;

/** “todo” (the world's house) made “Planner → Checker” (id planner-checker); `blog` is another house. */
async function twoHouses(): Promise<{ w: World; blog: string }> {
  const w = makeWorld();
  const blog = w.addHouse('blog');
  const saved = await w.call('workflow_save', { name: 'Planner → Checker', steps: STEPS });
  expect(saved.text).toStartWith('Saved workflow “Planner → Checker” (id planner-checker)');
  return { w, blog };
}

describe('workflow_list: this house’s workflows, then the library', () => {
  test('a workflow saved in one house is listed, run and read only there', async () => {
    const { w, blog } = await twoHouses();
    const here = (await w.call('workflow_list', {})).text;
    expect(here).toContain("This house's workflows (other houses don't see them; changing one changes only this house's):");
    expect(here).toContain('- ⚙️ “Planner → Checker” (id planner-checker)');
    expect(here).not.toContain('shared by every house');
    expect(here).not.toContain('The library'); // nothing promoted: no library section
    expect(parseWorkflowList(here).workflows.map((x) => x.id)).toEqual(['decode-implement-review', 'novel', 'planner-checker']);

    const there = (await w.callIn({ projectId: blog }, 'workflow_list', {})).text;
    expect(there).not.toContain('Planner → Checker');
    expect(parseWorkflowList(there).workflows.map((x) => x.id)).toEqual(['decode-implement-review', 'novel']);
    const none = 'No workflow with id “planner-checker” in this house — workflow_list shows them.';
    expect(await w.callIn({ projectId: blog }, 'team_start', { task: 'x', workflow_id: 'planner-checker' })).toEqual({ text: none, isError: true });
    expect(await w.callIn({ projectId: blog }, 'team_assign', { workflow_id: 'planner-checker' })).toEqual({ text: none, isError: true });
    expect(await w.callIn({ projectId: blog }, 'workflow_get', { id: 'planner-checker' })).toEqual({ text: none, isError: true });
    w.dispose();
  });

  test('a house with no workflows (every new house): the lead is told how to make a team', async () => {
    const { w } = await twoHouses();
    const empty = w.addHouse('fresh', { workflowId: null, examples: false });
    const text = (await w.callIn({ projectId: empty }, 'workflow_list', {})).text;
    expect(text).toContain('This house has no workflows yet — team_start with steps makes a one-off team; workflow_save keeps one.');
    expect(text).not.toContain("This house's workflows (");
    expect(parseWorkflowList(text).workflows).toEqual([]);
    w.dispose();
  });

  test('the library is a section apart (who promoted it, how many people) that the scripted test model does not take for this house’s', async () => {
    const { w, blog } = await twoHouses();
    const promoted = await w.call('workflow_promote', { id: 'planner-checker' });
    expect(promoted.isError).toBeFalsy();
    const there = (await w.callIn({ projectId: blog }, 'workflow_list', {})).text;
    expect(there).toContain("The library (copies the user promoted from houses; not this house's — workflow_import copies one here, then it runs and changes as this house's own):");
    expect(there).toContain('* ⚙️ “Planner → Checker” — library id planner-checker, 2 people (Planner → Checker), promoted from the “todo” house');
    const parsed = parseWorkflowList(there);
    expect(parsed.workflows.map((x) => x.id)).toEqual(['decode-implement-review', 'novel']);
    expect(parsed.models).toBeNull(); // the lines after the library still read
    // in the house it came from
    const here = (await w.call('workflow_list', {})).text;
    expect(here).toContain('library id planner-checker, 2 people (Planner → Checker), promoted from this house; this house has it too');
    expect(parseWorkflowList(here).workflows.filter((x) => x.id === 'planner-checker')).toHaveLength(1);
    w.dispose();
  });
});

describe('workflow_import', () => {
  test('a library workflow runs only once imported; then it is the house’s own copy', async () => {
    const { w, blog } = await twoHouses();
    await w.call('workflow_promote', { id: 'planner-checker' });
    const inLibrary = "“Planner → Checker” (id planner-checker) is in the library, not in this house — workflow_import it first (then it is this house's own).";
    expect(await w.callIn({ projectId: blog }, 'team_start', { task: 'x', workflow_id: 'planner-checker' })).toEqual({ text: inLibrary, isError: true });
    expect(await w.callIn({ projectId: blog }, 'team_assign', { workflow_id: 'planner-checker' })).toEqual({ text: inLibrary, isError: true });
    // workflow_get shows it read-only, marked as the library's
    const got = await w.callIn({ projectId: blog }, 'workflow_get', { id: 'planner-checker' });
    expect(got.isError).toBeFalsy();
    expect(got.text).toStartWith('“Planner → Checker” (id planner-checker) is in the library, not in this house (promoted from the “todo” house) — read-only here: workflow_import copies it into this house');
    expect(JSON.parse(got.text.slice(got.text.indexOf('\n') + 1)).steps).toHaveLength(2);
    // nor can it be changed or deleted here before
    const save = await w.callIn({ projectId: blog }, 'workflow_save', { id: 'planner-checker', replace: true, name: 'Planner → Checker', steps: STEPS });
    expect(save).toEqual({ text: '“Planner → Checker” (id planner-checker) is in the library, not in this house — workflow_import it first, then change it here (id and replace: true); or leave id out to make a new one.', isError: true });
    expect((await w.callIn({ projectId: blog }, 'workflow_delete', { id: 'planner-checker' })).text).toContain('is in the library, not in this house — there is nothing to delete here');

    const imp = await w.callIn({ projectId: blog }, 'workflow_import', { id: 'planner-checker' });
    expect(imp.isError).toBeFalsy();
    const lines = imp.text.split('\n');
    expect(lines[0]).toBe("Imported “Planner → Checker” (id planner-checker) from the library (promoted from the “todo” house): Planner → Checker. It is this house's own now — changing it changes only this house's copy, not the library or other houses.");
    expect(lines[1]).toBe('It is not this job\'s team — team_assign with workflow_id "planner-checker" sets it, or team_start with workflow_id "planner-checker" runs it once.');
    expect(w.workflows.get(blog, 'planner-checker')!.steps.map((s) => s.id)).toEqual(['planner', 'checker']);
    expect(parseWorkflowList((await w.callIn({ projectId: blog }, 'workflow_list', {})).text).workflows.map((x) => x.id)).toContain('planner-checker');
    const run = await w.callIn({ projectId: blog }, 'team_start', { task: 'x', workflow_id: 'planner-checker' });
    expect(run.text).toStartWith('Started “Planner → Checker” (Planner → Checker)');
    expect(w.engine.get(runOf(run.text))!.projectId).toBe(blog);
    await runEnd(w, runOf(run.text));

    // the blog changes its copy: the library's and todo's stay
    const changed = await w.callIn({ projectId: blog }, 'workflow_save', { id: 'planner-checker', replace: true, name: 'Planner → Checker', steps: STEPS.map((s) => (s.name === 'Checker' ? { ...s, model: SONNET } : s)) });
    expect(changed.isError).toBeFalsy();
    expect(changed.text).not.toContain("The library's copy");
    expect(w.workflows.get(blog, 'planner-checker')!.steps[1]!.model).toBe(SONNET);
    expect(w.workflows.get(w.projectId, 'planner-checker')!.steps[1]!.model).toBe(GPT);
    expect(w.workflows.libraryGet('planner-checker')!.workflow.steps[1]!.model).toBe(GPT);
    expect((await w.callIn({ projectId: blog }, 'workflow_list', {})).text).toContain('promoted from the “todo” house; this house has a different “Planner → Checker” under this id');

    // importing again: refused without replace; replace takes the library's; the same one: nothing to do
    const again = await w.callIn({ projectId: blog }, 'workflow_import', { id: 'planner-checker' });
    expect(again.isError).toBe(true);
    expect(again.text).toBe("This house already has a workflow with id “planner-checker”: “Planner → Checker”, not the same as the library's “Planner → Checker”. Pass replace: true to replace this house's with the library's (only when the user wants that), or keep this house's. workflow_get with library: true shows the library's.");
    const replaced = await w.callIn({ projectId: blog }, 'workflow_import', { id: 'planner-checker', replace: true }, { usedBy: () => ['Main'] });
    expect(replaced.isError).toBeFalsy();
    expect(replaced.text).toContain('Replaced the earlier version; used by the Main job.');
    expect(w.workflows.get(blog, 'planner-checker')!.steps[1]!.model).toBe(GPT);
    expect((await w.callIn({ projectId: blog }, 'workflow_import', { id: 'planner-checker' })).text).toStartWith('This house already has “Planner → Checker” (id planner-checker) as it is in the library — nothing to import.');
    expect(await w.callIn({ projectId: blog }, 'workflow_import', { id: 'nope' })).toEqual({ text: 'The library has no workflow with id “nope” — workflow_list lists the library.', isError: true });
    w.dispose();
  });

  test("the job's team only in the library (e.g. a house made before): workflow_list and team_start say to import it", async () => {
    const { w, blog } = await twoHouses();
    await w.call('workflow_promote', { id: 'planner-checker' });
    w.jobs.update(blog, 'main', { workflowId: 'planner-checker' });
    const list = (await w.callIn({ projectId: blog }, 'workflow_list', {})).text;
    expect(list.split('\n')[0]).toBe("This job's team “Planner → Checker” (id planner-checker) is in the library, not in this house — workflow_import it to use it.");
    expect(parseWorkflowList(list).teamId).toBeNull();
    expect((await w.callIn({ projectId: blog }, 'team_start', { task: 'x' })).text).toContain('is in the library, not in this house — workflow_import it first');
    const imp = await w.callIn({ projectId: blog }, 'workflow_import', { id: 'planner-checker' });
    expect(imp.text.split('\n')[1]).toBe("This job's team is now “Planner → Checker”. Start it with team_start.");
    w.dispose();
  });
});

describe('workflow_promote', () => {
  test("a copy of this house's workflow goes into the library (its copy of an old example team too); an id the library has asks for replace", async () => {
    const { w, blog } = await twoHouses();
    expect(await w.call('workflow_promote', { id: 'nope' })).toEqual({ text: 'No workflow with id “nope” in this house — workflow_list shows them.', isError: true });
    const empty = w.addHouse('docs', { examples: false }); // a new house has no "novel" of its own
    expect(await w.callIn({ projectId: empty }, 'workflow_promote', { id: 'novel' })).toEqual({ text: 'No workflow with id “novel” in this house — workflow_list shows them.', isError: true });
    expect(w.workflows.library()).toEqual([]);

    const promoted = await w.call('workflow_promote', { id: 'planner-checker' });
    expect(promoted).toEqual({
      text: [
        'Put a copy of “Planner → Checker” (id planner-checker) in the library: every house sees it there now and can workflow_import it.',
        'This house keeps its own — later changes to it reach the library only when it is promoted again (replace: true).',
      ].join('\n'),
    });
    expect(w.workflows.libraryGet('planner-checker')).toMatchObject({ workflow: { name: 'Planner → Checker' }, from: { projectId: w.projectId, house: 'todo' } });
    expect(w.workflows.get(w.projectId, 'planner-checker')).toBeDefined(); // the house keeps its own
    expect((await w.call('workflow_promote', { id: 'planner-checker' })).text).toBe('The library already has “Planner → Checker” (id planner-checker) as it is in this house — nothing to promote.');
    // changing it here later doesn't reach the library — and the lead is told
    const later = await w.call('workflow_save', { id: 'planner-checker', replace: true, name: 'Planner → Checker', steps: STEPS.map((s) => ({ ...s, persona: `${s.persona} Carefully.` })) });
    expect(later.text).toContain("The library's copy (promoted from this house) stays as it was — workflow_promote with replace: true updates it, only when the user asks.");
    expect(w.workflows.libraryGet('planner-checker')!.workflow.steps[0]!.persona).toBe('You plan.');

    // the blog made its own workflow under the same id: promoting it would replace todo's in the library
    w.workflows.save(blog, { id: 'planner-checker', name: 'Blog pair', steps: STEPS.map((s, i) => ({ ...s, id: `s${i}`, kind: 'work', loopBackTo: undefined })) });
    const clash = await w.callIn({ projectId: blog }, 'workflow_promote', { id: 'planner-checker' });
    expect(clash).toEqual({
      text: "The library already has a workflow with id “planner-checker”: “Planner → Checker” (promoted from the “todo” house). Pass replace: true to replace it with this house's (only when the user wants that), or save this one as a new workflow and promote that.",
      isError: true,
    });
    const over = await w.callIn({ projectId: blog }, 'workflow_promote', { id: 'planner-checker', replace: true });
    expect(over.text).toStartWith("Put a copy of “Blog pair” (id planner-checker) in the library, replacing the library's earlier one");
    expect(over.text).toContain('Houses that imported the earlier one keep their copies');
    expect(w.workflows.libraryGet('planner-checker')).toMatchObject({ workflow: { name: 'Blog pair' }, from: { projectId: blog, house: 'blog' } });
    expect(w.workflows.get(w.projectId, 'planner-checker')!.name).toBe('Planner → Checker');
    // the house's copy of an old example team is one of its workflows: promoted as it is
    const novel = await w.call('workflow_promote', { id: 'novel' });
    expect(novel.isError).toBeFalsy();
    expect(novel.text).toStartWith('Put a copy of “Idea → Write → Edit” (id novel) in the library');
    expect(w.workflows.libraryGet('novel')!.workflow.builtin).toBeUndefined();
    w.dispose();
  });

  test('a copy of an old example team changed in this house: listed like any other (no built-in tag), promoted as it is', async () => {
    const { w } = await twoHouses();
    w.workflows.save(w.projectId, { ...w.workflows.get(w.projectId, 'novel')!, description: 'Our own way' });
    const list = (await w.call('workflow_list', {})).text;
    expect(list).toContain('- 🌙 “Idea → Write → Edit” (id novel)\n  Our own way');
    expect(list).not.toContain('built-in');
    expect(list).not.toContain('edited in this house');
    expect(parseWorkflowList(list).workflows.find((x) => x.id === 'novel')).toMatchObject({ builtin: false });
    const r = await w.call('workflow_promote', { id: 'novel' });
    expect(r.isError).toBeFalsy();
    expect(w.workflows.libraryGet('novel')).toMatchObject({ workflow: { id: 'novel', description: 'Our own way' }, from: { projectId: w.projectId, house: 'todo' } });
    w.dispose();
  });
});

describe('workflow_save looks at this house only', () => {
  test("from_run: a run of another house is refused (this house's runs are fine)", async () => {
    const { w, blog } = await twoHouses();
    const r = await w.call('team_start', { task: 'Fix it', steps: STEPS });
    const id = runOf(r.text);
    await runEnd(w, id);
    const refused = { text: `No run with id “${id}” in this house (team_status shows this job's runs).`, isError: true };
    expect(await w.callIn({ projectId: blog }, 'workflow_save', { name: 'Kept', from_run: id })).toEqual(refused);
    expect(w.workflows.list(blog).some((x) => x.name === 'Kept')).toBe(false);
    const ctx = { projectId: blog, workflows: w.workflows, engine: w.engine, usedBy: () => [], models: w.models };
    expect(prepareWorkflowSave({ name: 'Kept', from_run: id }, ctx)).toEqual({ error: refused.text });
    const kept = await w.call('workflow_save', { name: 'Kept', from_run: id });
    expect(kept.text).toStartWith('Saved workflow “Kept” (id kept)');
    w.dispose();
  });

  test("the twin-name check ignores other houses' names; a new id never takes one in the library", async () => {
    const { w, blog } = await twoHouses();
    // the same name in another house: no “… 2”, the same id (ids are per house)
    const there = await w.callIn({ projectId: blog }, 'workflow_save', { name: 'Planner → Checker', steps: STEPS });
    expect(there.text).toStartWith('Saved workflow “Planner → Checker” (id planner-checker)');
    expect(there.text).not.toContain('already exists');
    // in its own house it still is a twin
    const here = await w.call('workflow_save', { name: 'Planner → Checker', steps: STEPS });
    expect(here.text).toStartWith('Saved workflow “Planner → Checker 2” (id planner-checker-2)');
    expect(here.text).toContain('A workflow called “Planner → Checker” already exists, so this one is “Planner → Checker 2”.');
    // the name of the house's copy of an old example team is a twin like any (it can be replaced: it is the house's)
    const twin = (await w.callIn({ projectId: blog }, 'workflow_save', { name: 'Idea → Write → Edit', steps: STEPS })).text;
    expect(twin).toStartWith('Saved workflow “Idea → Write → Edit 2”');
    expect(twin).toContain('To change that one instead, save with id "novel" and replace: true.');
    // a house without one: no twin
    const plain = w.addHouse('plain', { examples: false });
    expect((await w.callIn({ projectId: plain }, 'workflow_save', { name: 'Idea → Write → Edit', steps: STEPS })).text).toStartWith('Saved workflow “Idea → Write → Edit” (id idea-write-edit)');
    // an id in the library isn't given to a new workflow (importing that one here would clash)
    await w.call('workflow_promote', { id: 'planner-checker' });
    const docs = w.addHouse('docs');
    const fresh = await w.callIn({ projectId: docs }, 'workflow_save', { name: 'Planner → Checker', steps: STEPS });
    expect(fresh.text).toStartWith('Saved workflow “Planner → Checker” (id planner-checker-2)');
    expect(fresh.text).not.toContain('already exists');
    w.dispose();
  });
});

describe('workflow_import / workflow_promote as tools', () => {
  test('registered, answered without an approval card, and shown in plain words', () => {
    for (const name of ['workflow_import', 'workflow_promote']) {
      expect(LEAD_TOOL_NAMES.has(name)).toBe(true);
      expect(LEAD_TOOLS.find((t) => t.name === name)?.parameters).toMatchObject({ required: ['id'] });
      expect(activityForTool(name)).toBe('thinking');
    }
    expect(toolTitle('workflow_import', { id: 'pair' })).toBe('import workflow “pair” from the library');
    expect(toolTitle('workflow_import', { id: 'pair', replace: true })).toBe('import workflow “pair” from the library (replace this house’s)');
    expect(toolTitle('workflow_promote', { id: 'pair' })).toBe('put workflow “pair” in the library');
    expect(toolTitle('workflow_promote', { id: 'pair', replace: true })).toBe('put workflow “pair” in the library (replace the library’s)');
    expect(toolDetail('workflow_import', { id: 'pair' })).toBe('Importing a workflow');
    expect(toolDetail('workflow_promote', { id: 'pair' })).toBe('Putting a workflow in the library');
  });
});

describe('workflow_get library: true', () => {
  test("reads the library's version of an id this house also has (to say what an import with replace would change)", async () => {
    const { w, blog } = await twoHouses();
    expect((await w.call('workflow_promote', { id: 'planner-checker' })).isError).toBeFalsy();
    // blog has its own, different planner-checker (imported once, then changed there)
    w.workflows.save(blog, { id: 'planner-checker', name: 'Blog checker', description: '', icon: '', steps: [{ id: 'checker', name: 'Checker', model: SONNET, kind: 'work', persona: 'You check twice.', instruction: '{{task}}' }] });
    const mine = await w.callIn({ projectId: blog }, 'workflow_get', { id: 'planner-checker' });
    expect(JSON.parse(mine.text).name).toBe('Blog checker');
    const lib = await w.callIn({ projectId: blog }, 'workflow_get', { id: 'planner-checker', library: true });
    expect(lib.isError).toBeFalsy();
    const [first, ...json] = lib.text.split('\n');
    expect(first).toBe(
      '“Planner → Checker” (id planner-checker) is the library\'s (promoted from the “todo” house); this house has its own “Blog checker” under this id — read-only here: workflow_import with replace: true would put this one in its place (only when the user wants that).',
    );
    expect(JSON.parse(json.join('\n')).steps.map((s: { model: string }) => s.model)).toEqual([OPUS, GPT]);
    expect(await w.callIn({ projectId: blog }, 'workflow_get', { id: 'nope', library: true })).toEqual({ text: 'The library has no workflow with id “nope” — workflow_list lists the library.', isError: true });
    // an import whose name the house has already gets a number, and the lead is told
    const named = await w.callIn({ projectId: blog }, 'workflow_save', { name: 'Planner → Checker', steps: [{ name: 'Solo', model: OPUS, persona: 'You do it.' }] });
    expect(named.text).toStartWith('Saved workflow “Planner → Checker”');
    const imported = await w.callIn({ projectId: blog }, 'workflow_import', { id: 'planner-checker', replace: true });
    expect(imported.text).toContain('Imported “Planner → Checker” (id planner-checker) from the library (promoted from the “todo” house) (named “Planner → Checker 2”: this house already has a workflow called “Planner → Checker”)');
    w.dispose();
  });
});
