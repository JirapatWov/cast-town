// Workflows belong to houses (server/agents/workflow-store.ts): what the review of that change found, kept fixed —
// a house id longer than a workflow id, a move from before houses that stopped half way, going back to an older CAST,
// an import whose name another workflow of the house has, a house called "constructor"; and CAST has no workflows of
// its own (a new house lists none; the old example ids are ordinary ids). Run: bun test <this file>
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownOf, workflowOf, workflowsOf } from '../../shared/house-workflows';
import type { Workflow } from '../../shared/protocol';
import { WorkflowStore } from '../../server/agents/workflow-store';
import { LEGACY_EXAMPLES } from '../../server/agents/legacy-examples';
import { giveExamples, NOVEL_EXAMPLE } from '../legacy-examples';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'cast-house-wf-'));
  dirs.push(d);
  return d;
};
const OPUS = 'anthropic/claude-opus-5-5';
const GPT = 'openai/gpt-6.1-sol';
const wf = (id: string, name: string, model = OPUS): Workflow => ({
  id,
  name,
  description: '',
  icon: '🧪',
  steps: [{ id: 'maker', name: 'Maker', model, kind: 'work', persona: 'You make it.', instruction: '{{task}}' }],
});

describe('house ids', () => {
  test('a house id longer than a workflow id (a 48-letter name + "-2") keeps its workflows over a restart', () => {
    const dir = fresh();
    const house = `${'customer-onboarding-portal-frontend-for-the-acme'}-2`;
    expect(house.length).toBe(50);
    const s = new WorkflowStore(dir);
    s.save(house, wf('my-team', 'My team'));
    s.save('other', wf('theirs', 'Theirs')); // a later save elsewhere rewrites the file
    const again = new WorkflowStore(dir);
    expect(again.get(house, 'my-team')?.name).toBe('My team');
    expect(again.chatBase(house, 'my-team')?.name).toBe('My team');
  });

  test('a house called "constructor" with no workflows of its own: the lists stay empty, nothing throws', () => {
    const lists = JSON.parse(JSON.stringify({ workflows: [], houseWorkflows: { other: [wf('x', 'X')] }, library: [] }));
    expect(ownOf(lists, 'constructor')).toEqual([]);
    expect(ownOf(lists, '__proto__')).toEqual([]);
    expect(workflowsOf(lists, 'constructor')).toEqual([]);
    expect(workflowOf(lists, 'constructor', 'x')).toBeUndefined();
    expect(workflowOf(lists, 'other', 'x')?.name).toBe('X');
    // an older server's lists (its built-ins in `workflows`, every house had them) still read
    const old = JSON.parse(JSON.stringify({ workflows: LEGACY_EXAMPLES, houseWorkflows: { other: [wf('x', 'X')] }, library: [] }));
    expect(workflowsOf(old, 'constructor').map((w) => w.id)).toEqual(LEGACY_EXAMPLES.map((b) => b.id));
  });
});

describe('the move from before houses', () => {
  const v1 = (dir: string) => {
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify({ workflows: [wf('pair', 'Pair'), wf('lonely', 'Lonely')] }));
    writeFileSync(join(dir, 'workflow-bases.json'), JSON.stringify({ bases: [{ workflow: wf('pair', 'Pair'), at: 5, handSet: { maker: { model: 9 } } }] }));
  };
  const migrate = { houses: () => ['a', 'b'], usersOf: (id: string) => (id === 'pair' ? ['a', 'b'] : []) };

  test('both old files are kept before either is rewritten; each copy gets the base and its hand-set times', () => {
    const dir = fresh();
    v1(dir);
    const before = { w: readFileSync(join(dir, 'workflows.json'), 'utf8'), b: readFileSync(join(dir, 'workflow-bases.json'), 'utf8') };
    const s = new WorkflowStore(dir, { migrate });
    expect(readFileSync(join(dir, 'workflows.v1.json'), 'utf8')).toBe(before.w);
    expect(readFileSync(join(dir, 'workflow-bases.v1.json'), 'utf8')).toBe(before.b);
    for (const p of ['a', 'b']) {
      expect(s.get(p, 'pair')?.name).toBe('Pair');
      expect(s.chatBaseSeeded(p, 'pair')).toBe(false);
      expect(s.handSetAt(p, 'pair', 'maker', 'model')).toBe(9);
    }
    expect(s.libraryGet('lonely')?.workflow.name).toBe('Lonely');
    expect(existsSync(join(dir, 'workflows.v1.json.tmp-' + process.pid))).toBe(false);
  });

  test('stopped after workflows.json was moved but before the bases were: the old base rows still reach each copy', () => {
    const dir = fresh();
    v1(dir);
    new WorkflowStore(dir, { migrate }); // the move…
    // …as if the server had stopped before writing the new bases file: the old one is still there
    writeFileSync(join(dir, 'workflow-bases.json'), readFileSync(join(dir, 'workflow-bases.v1.json')));
    const s = new WorkflowStore(dir, { migrate });
    for (const p of ['a', 'b']) {
      expect(s.chatBaseSeeded(p, 'pair')).toBe(false); // not a fresh seeded base: the old one, with its times
      expect(s.handSetAt(p, 'pair', 'maker', 'model')).toBe(9);
    }
  });

  test('going back to an older CAST: the file still has the one list it reads (each id once), so nothing is lost', () => {
    const dir = fresh();
    const s = new WorkflowStore(dir);
    s.save('a', wf('pair', 'Pair (a)'));
    s.save('b', wf('pair', 'Pair (b)'));
    s.save('b', wf('cover', 'Cover'));
    s.promote('b', 'cover', { house: 'b' });
    const file = JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8')) as { version: number; workflows: Workflow[] };
    expect(file.version).toBe(2);
    expect(file.workflows.map((w) => w.id).sort()).toEqual(['cover', 'pair']);
    // and the new store still reads its own format, not that list
    const again = new WorkflowStore(dir);
    expect(again.get('a', 'pair')?.name).toBe('Pair (a)');
    expect(again.get('b', 'pair')?.name).toBe('Pair (b)');
    expect(again.get('a', 'cover')).toBeUndefined();
  });
});

describe('import', () => {
  test('a name another workflow of the house has gets a number, as a save does', () => {
    const dir = fresh();
    const s = new WorkflowStore(dir);
    s.save('a', wf('twin-a', 'Twin crew'));
    s.promote('a', 'twin-a', { house: 'a' });
    s.save('b', wf('twin-b', 'Twin crew'));
    expect(s.importFromLibrary('b', 'twin-a').name).toBe('Twin crew 2');
    expect(s.libraryGet('twin-a')?.workflow.name).toBe('Twin crew'); // the library's keeps its name
    // the name of an old example team the house has counts too
    giveExamples(s, 'b');
    s.save('a', { ...wf('my-novel', NOVEL_EXAMPLE.name) });
    expect(s.get('a', 'my-novel')?.name).toBe(NOVEL_EXAMPLE.name);
    s.promote('a', 'my-novel', { house: 'a' });
    expect(s.importFromLibrary('b', 'my-novel').name).toBe(`${NOVEL_EXAMPLE.name} 2`);
  });

  test('replacing the house’s copy keeps its base and counts the models it brings as set by hand now', () => {
    const dir = fresh();
    const s = new WorkflowStore(dir);
    s.save('a', wf('pair', 'Pair', OPUS));
    s.promote('a', 'pair', { house: 'a' });
    s.save('b', wf('pair', 'Pair', GPT));
    s.setChatBase('b', wf('pair', 'Pair', GPT)); // B's lead saved it
    const leadAt = Date.now();
    expect(s.handSetSinceBase('b', 'pair', 'maker.model')).toBe(false);
    s.importFromLibrary('b', 'pair', { replace: true });
    expect(s.get('b', 'pair')?.steps[0]?.model).toBe(OPUS);
    expect(s.chatBase('b', 'pair')?.steps[0]?.model).toBe(GPT); // what B's lead last sent
    expect(s.handSetSinceBase('b', 'pair', 'maker.model')).toBe(true); // so its older copy can't undo the import
    expect(s.handSetAt('b', 'pair', 'maker', 'model')).toBeGreaterThanOrEqual(leadAt);
    expect(s.handSetSinceBase('b', 'pair', 'maker.thinking')).toBe(false); // the effort didn't change
    // a first import (the house had none) starts fresh
    s.save('c', wf('other', 'Other'));
    s.importFromLibrary('c', 'pair');
    expect(s.chatBase('c', 'pair')?.steps[0]?.model).toBe(OPUS);
    expect(s.handSetSinceBase('c', 'pair', 'maker.model')).toBe(false);
  });
});

describe('no workflows of its own', () => {
  test('a new store lists nothing for any house; an old example id is unknown until a house saves one', () => {
    const s = new WorkflowStore(fresh());
    for (const h of ['a', 'constructor']) {
      expect(s.list(h)).toEqual([]);
      expect(s.own(h)).toEqual([]);
    }
    expect(s.get('a', 'novel')).toBeUndefined();
    expect(s.get('a', 'decode-implement-review')).toBeUndefined();
    expect(s.all()).toEqual([]);
    expect(s.byHouse()).toEqual({});
  });

  test('a workflow saved as "novel" is an ordinary one: no builtin flag, promoted and removed like any other', () => {
    const dir = fresh();
    const s = new WorkflowStore(dir);
    const saved = s.save('a', structuredClone(NOVEL_EXAMPLE));
    expect(saved.builtin).toBeUndefined();
    expect(s.list('a').map((w) => w.id)).toEqual(['novel']);
    expect(s.list('b')).toEqual([]); // another house doesn't see it
    expect(s.promote('a', 'novel', { house: 'a' }).workflow.id).toBe('novel');
    expect(s.libraryGet('novel')?.workflow.builtin).toBeUndefined();
    expect(s.remove('a', 'novel')).toBe(true);
    expect(s.get('a', 'novel')).toBeUndefined(); // nothing comes back in its place
    expect(s.list('a')).toEqual([]);
    expect(s.libraryGet('novel')?.workflow.name).toBe(NOVEL_EXAMPLE.name); // the library keeps its copy
    const file = readFileSync(join(dir, 'workflows.json'), 'utf8');
    expect(file).not.toContain('"builtin"');
  });

  test('a stored row with builtin: true (an older CAST wrote it) is read without the flag', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify({ version: 2, houses: { a: [{ ...structuredClone(NOVEL_EXAMPLE), builtin: true }] }, library: [], workflows: [] }));
    const s = new WorkflowStore(dir);
    expect(s.get('a', 'novel')?.builtin).toBeUndefined();
    expect(s.remove('a', 'novel')).toBe(true);
  });
});
