// At the town level the Town board opened the side panel on the first house's people — whichever house came first in
// the list. It now opens on the house last used on this device (remembered per city), else on the only house, else on
// the town's Inbox. The bell does the same at the town level (its count is the whole town's).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inboxScope, lastHouse, townPanelHouse } from '../../web/src/ui/last-house';

const UI = join(import.meta.dir, '../../web/src/ui');
const src = (f: string) => readFileSync(join(UI, f), 'utf8');

describe('where the board’s panel opens at the town level', () => {
  test('the house last used, while it still stands', () => {
    expect(townPanelHouse(['todo-api', 'novel', 'notes'], 'novel')).toBe('novel');
    expect(lastHouse(['todo-api', 'novel'], 'novel')).toBe('novel');
  });
  test('not a house that was removed since; then the only house, if there is one', () => {
    expect(lastHouse(['todo-api'], 'gone')).toBeNull();
    expect(townPanelHouse(['todo-api'], 'gone')).toBe('todo-api');
    expect(townPanelHouse(['todo-api'], null)).toBe('todo-api');
  });
  test('several houses and none used yet: no house (the town’s Inbox), never the first in the list', () => {
    expect(townPanelHouse(['todo-api', 'novel'], null)).toBeNull();
    expect(townPanelHouse([], null)).toBeNull();
  });
  test('the bell opens the town’s Inbox at the town level and the house’s inside it', () => {
    expect(inboxScope({ view: 'city' })).toBeNull();
    expect(inboxScope({ view: 'drive' })).toBeNull();
    expect(inboxScope({ view: 'house' })).toBeUndefined();
  });
});

describe('wiring', () => {
  test('the board opens the panel on townPanelHouse at the town level, the Inbox when there is none', () => {
    const index = src('index.ts');
    expect(index).toMatch(/const pid = view\.view === 'house' && view\.projectId \? view\.projectId : townPanelHouse\(/);
    expect(index).toContain("shell.openPanel(pid ? 'chat' : 'inbox', pid);");
    // a board start opens it before the town (and so the houses) arrive: it moves to the house once they do
    expect(index).toMatch(/if \(boardOpenedPanel && panel\.isOpen && !panel\.projectId && view\.view !== 'house'\) \{\s*const pid = townPanelHouse\(/);
    // "this house" for the palette and the keys: the last one used before the first in the list
    expect(index).toMatch(/return lastHouse\(ids\) \?\? ids\[0\] \?\? null;/);
    expect(index).toMatch(/if \(next\.view === 'house' && next\.projectId\) \{\s*rememberHouse\(next\.projectId\);/);
  });
  test('the panel keeps a town Inbox (no house) and remembers houses opened on purpose', () => {
    const panel = src('sidepanel.ts');
    expect(panel).toMatch(/else if \(pid === null && nextTab === 'inbox'\) projectId = null;/);
    expect(panel).toMatch(/if \(!projectId && !\(pid === null && nextTab === 'inbox'\)\) projectId = shell\.contextProjectId\(\);/);
    expect(panel).toMatch(/projectId = pid;\s*rememberHouse\(pid\);/);
    // there, a house's tabs (Chat, Workflow, Changes) wait until a house is picked: they'd pick one for you
    expect(panel).toContain("b.hidden = !project && t.id !== 'inbox';");
    // and the bar naming the oldest request elsewhere stays quiet: the town's Inbox lists every house's
    // (one rule for the bar and the floating stack: shownInPanel, whose Inbox without a house lists every request)
    expect(panel).toContain('.filter((a) => !shownInPanel(shows, a))');
    expect(src('approvals.ts')).toContain("if (p.tab === 'inbox') return !p.projectId || p.projectId === a.projectId;");
  });
  test('every "open the Inbox" outside its tab uses inboxScope', () => {
    for (const f of ['topbar.ts', 'palette.ts', 'approvals.ts']) expect(src(f)).not.toContain("shell.openPanel('inbox')");
    expect(src('topbar.ts')).toContain("onclick: () => shell.openPanel('inbox', inboxScope(shell.view))");
  });
});
