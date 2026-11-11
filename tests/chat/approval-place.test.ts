// One approval card in one place at a time: the floating stack leaves out what the open side panel shows as a card
// (the inbox its house's, a chat its person's, the Workflow tab its run's). It used to show the same card twice: the
// stack was not redrawn when the panel changed tab (Inbox / Workflow from the panel's own tabs), and a folded panel
// counted as showing cards it had hidden. No DOM here: the rule is pure, the wiring is checked in the source.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { location?: unknown }).location ??= { pathname: '/', protocol: 'http:', host: 'localhost' };

let approvals: typeof import('../../web/src/ui/approvals.ts');
beforeAll(async () => {
  approvals = await import('../../web/src/ui/approvals.ts');
});

type View = import('../../web/src/ui/approvals.ts').PanelView;
const view = (o: Partial<View> = {}): View => ({ open: true, folded: false, tab: 'chat', projectId: 'todo', chatAgentId: 'dev', workflowShows: () => false, ...o });
const ask = { projectId: 'todo', agentId: 'dev' };

describe('shownInPanel', () => {
  test('a closed or folded panel shows no card: the stack has it', () => {
    expect(approvals.shownInPanel(view({ open: false }), ask)).toBe(false);
    expect(approvals.shownInPanel(view({ folded: true }), ask)).toBe(false);
    expect(approvals.shownInPanel(view(), ask)).toBe(true);
  });
  test('chat: only that person’s requests', () => {
    expect(approvals.shownInPanel(view({ chatAgentId: 'reviewer' }), ask)).toBe(false);
    expect(approvals.shownInPanel(view({ chatAgentId: null }), ask)).toBe(false);
  });
  test('inbox: its house’s requests; outside a house every request', () => {
    expect(approvals.shownInPanel(view({ tab: 'inbox' }), ask)).toBe(true);
    expect(approvals.shownInPanel(view({ tab: 'inbox', projectId: 'novel' }), ask)).toBe(false);
    expect(approvals.shownInPanel(view({ tab: 'inbox', projectId: null }), ask)).toBe(true);
  });
  test('workflow: what its run timeline shows; changes: nothing', () => {
    expect(approvals.shownInPanel(view({ tab: 'workflow', workflowShows: (id) => id === 'dev' }), ask)).toBe(true);
    expect(approvals.shownInPanel(view({ tab: 'workflow' }), ask)).toBe(false);
    expect(approvals.shownInPanel(view({ tab: 'changes' }), ask)).toBe(false);
  });
});

describe('the stack follows the panel', () => {
  const ui = readFileSync(resolve(import.meta.dir, '../../web/src/ui/index.ts'), 'utf8');
  const panel = readFileSync(resolve(import.meta.dir, '../../web/src/ui/sidepanel.ts'), 'utf8');
  test('the stack uses the shared rule and is redrawn on every panel change (open, close, tab, fold)', () => {
    expect(ui).toContain('createApprovalStack(shell, (a) => shownInPanel(panel.view, a))');
    expect(ui).toContain("panel.onChange(() => schedule('approvals', approvals.render))");
  });
  test('folding or unfolding the panel is a change; the phone’s asks bar uses the same rule', () => {
    const fold = panel.slice(panel.indexOf('const setCollapsed'), panel.indexOf('collapseBtn.addEventListener'));
    expect(fold).toContain('changed();');
    expect(panel).toContain('.filter((a) => !shownInPanel(shows, a))');
  });
});
