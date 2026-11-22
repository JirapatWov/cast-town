// Standing allows in Auto mode (Claude Code's autoMode.allow): a card Auto stopped carries the id of the rule that
// stopped it; "Always allow in <house>" approves that step, keeps the rule on the house (city.json) and clears the
// house's other waiting cards that only this rule held. Later steps stopped only by it pass in that house, not in
// another one; rules a house can never always allow (deleting outside the project, credentials, downloaded scripts,
// raw device writes) are refused on the card, in set_project and when city.json is read.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOTS } from '../../shared/city-layout';
import type { ApprovalMode, ApprovalRequest, ServerMsg } from '../../shared/protocol';
import { ApprovalBook } from '../../server/agents/approvals';
import { createCityStore } from '../../server/city-store';
import { createFsBrowser } from '../../server/fs-browse';
import { createGitService } from '../../server/git';
import { createJobStore } from '../../server/job-store';
import { createProjectService } from '../../server/projects';
import { parseClientMsg } from '../../server/validate';

const roots: string[] = [];
const tmp = (name: string) => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), `auto-allow-${name}-`));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** An approval book whose houses' modes and standing allows live in `houses`, as the agent system reads them. */
function town(mode: ApprovalMode = 'auto') {
  const dir = tmp('book');
  const houses: Record<string, { allow: string[] }> = { a: { allow: [] }, b: { allow: [] } };
  const sent: ServerMsg[] = [];
  const answers: Record<string, unknown> = {};
  const labelled: string[] = [];
  const book = new ApprovalBook({ broadcast: (m) => void sent.push(m), clients: () => [] }, { added: () => {}, resolved: () => {} }, (projectId) => ({ mode, dir, allow: houses[projectId]!.allow }));
  let n = 0;
  const offer = (command: string, house = 'a') => {
    const id = `ui-${++n}`;
    book.offer({ id, method: 'select', title: `Allow tool: bash\nCommand: ${command}`, options: ['Approve', 'Deny'] }, `${house}:developer`, house, (p) => (answers[id] = p), { command }, () => void labelled.push(id));
    return id;
  };
  const card = (id: string) => book.get(id);
  const remember = (projectId: string, rule: string) => void houses[projectId]!.allow.push(rule);
  return { book, houses, sent, answers, labelled, offer, card, remember };
}

describe('Always allow in <house>', () => {
  test('a card names the rule that stopped it', () => {
    const t = town();
    const id = t.offer('git push --force');
    expect(t.card(id)).toMatchObject({ autoRule: 'gitForcePush' } satisfies Partial<ApprovalRequest>);
    expect(t.card(t.offer('rm -rf /etc/x'))?.autoRule).toBe('deletesOutside');
  });

  test('approves the step, keeps the rule, and clears the waiting cards only that rule held — in that house only', () => {
    const t = town();
    const first = t.offer('git push --force');
    const second = t.offer('git push -f origin feature');
    const twoRules = t.offer('git push --force && git reset --hard');
    const otherHouse = t.offer('git push --force', 'b');
    const outside = t.offer('rm -rf /etc/x');

    expect(t.book.alwaysAllow(first, t.remember)).toBe(true);
    expect(t.houses.a!.allow).toEqual(['gitForcePush']);
    expect(t.answers[first]).toEqual({ value: 'Approve' });
    expect(t.answers[second]).toEqual({ value: 'Approve' });
    expect(t.labelled).toEqual([second]); // cleared by Auto, so labelled Auto-approved in the chat
    // still waiting: another rule holds it now, another house, a different rule
    expect(t.card(twoRules)?.autoRule).toBe('gitDiscard');
    expect(t.card(otherHouse)?.autoRule).toBe('gitForcePush');
    expect(t.card(outside)?.autoRule).toBe('deletesOutside');
    // the next force push in that house goes straight through; the near miss still asks
    expect(t.card(t.offer('git push --force-with-lease'))).toBeUndefined();
    expect(t.card(t.offer('git reset --hard'))?.autoRule).toBe('gitDiscard');
  });

  test('a rule a house can never always allow is refused and the card stays', () => {
    const t = town();
    const id = t.offer('rm -rf /etc/x');
    expect(() => t.book.alwaysAllow(id, t.remember)).toThrow();
    expect(t.houses.a!.allow).toEqual([]);
    expect(t.card(id)).toBeDefined();
    expect(t.answers[id]).toBeUndefined();
    // a house that lists it anyway (a hand-edited file) still gets the card
    t.houses.a!.allow.push('deletesOutside');
    t.book.reconsider('a');
    expect(t.card(id)?.autoRule).toBe('deletesOutside');
  });

  test('outside Auto a card has no rule to allow', () => {
    const t = town('always-ask');
    const id = t.offer('git push --force');
    expect(t.card(id)?.autoRule).toBeUndefined();
    expect(() => t.book.alwaysAllow(id, t.remember)).toThrow();
  });
});

describe('standing allows on the house', () => {
  function world() {
    const root = tmp('city');
    const ws = join(root, 'ws');
    const dataDir = join(root, 'data');
    mkdirSync(join(ws, 'app'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const open = () => {
      const city = createCityStore(dataDir, ws);
      const jobs = createJobStore(dataDir, city);
      const projects = createProjectService({ city, jobs, git: createGitService({ worktreesDir: join(root, 'wt') }), fs: createFsBrowser([ws]), agents: { onProjectAdded: async () => {}, onProjectUpdated: async () => {} } as never, workspaceRoot: ws });
      return { city, projects };
    };
    return { ws, dataDir, open };
  }

  test('set through set_project, kept in city.json across a restart, removed again', async () => {
    const w = world();
    const first = w.open();
    const p = await first.projects.place({ path: join(w.ws, 'app'), name: 'app', lotId: LOTS[0]!.id, style: 'house' });
    await first.projects.update(p.id, { autoAllow: ['gitForcePush', 'tool:mcp__notion__create_page'] });
    expect(w.open().city.project(p.id)?.autoAllow).toEqual(['gitForcePush', 'tool:mcp__notion__create_page']);
    const again = w.open();
    await again.projects.update(p.id, { autoAllow: ['tool:mcp__notion__create_page'] });
    expect(w.open().city.project(p.id)?.autoAllow).toEqual(['tool:mcp__notion__create_page']);
    await again.projects.update(p.id, { autoAllow: [] });
    expect(w.open().city.project(p.id)?.autoAllow).toBeUndefined();
  });

  test('never-allowable rules are refused by set_project and dropped from a hand-edited city.json', async () => {
    const w = world();
    const { projects } = w.open();
    const p = await projects.place({ path: join(w.ws, 'app'), name: 'app', lotId: LOTS[0]!.id, style: 'house' });
    for (const never of ['deletesOutside', 'credentials', 'secretsFile', 'pipeToShell', 'rawWrite']) {
      await expect(projects.update(p.id, { autoAllow: ['gitForcePush', never] })).rejects.toThrow();
    }
    const file = join(w.dataDir, 'city.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.projects[0].autoAllow = ['gitForcePush', 'credentials', 'no-such-rule', 7];
    writeFileSync(file, JSON.stringify(data));
    expect(w.open().city.project(p.id)?.autoAllow).toEqual(['gitForcePush']);
  });

  test('the messages: autoAllow takes only Auto’s rule ids, approve takes alwaysAllow', () => {
    const set = (autoAllow: unknown) => parseClientMsg(JSON.stringify({ t: 'set_project', reqId: 'r', projectId: 'p', patch: { autoAllow } }));
    expect(set(['gitForcePush', 'tool:mcp__x__y'])).toEqual({ ok: true, msg: { t: 'set_project', reqId: 'r', projectId: 'p', patch: { autoAllow: ['gitForcePush', 'tool:mcp__x__y'] } } });
    expect(set(['made-up']).ok).toBe(false);
    expect(set('gitForcePush').ok).toBe(false);
    expect(parseClientMsg(JSON.stringify({ t: 'approve', approvalId: 'ui-1', value: 'Approve', alwaysAllow: true }))).toEqual({ ok: true, msg: { t: 'approve', approvalId: 'ui-1', value: 'Approve', alwaysAllow: true } });
  });
});
