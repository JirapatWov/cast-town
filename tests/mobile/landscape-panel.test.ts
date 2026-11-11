// A phone held sideways (iPhone 13: 750 × 342): the docked panel showed ~90 px of conversation under its header, the
// tab row, the person's line and the chat box, and opening the chevron's rows (job, people, chats) pushed the chat box
// off the panel. Now the tabs are a rail down the panel's edge (panels ≥ 360 px wide), a short panel with its rows
// open scrolls with the chat box pinned at its foot, and picking a person or starting to type folds the rows again.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCss } from '../helpers/css-rules';

const mobile = readCss('mobile.css');
const panel = readFileSync(join(import.meta.dir, '../../web/src/ui/sidepanel.ts'), 'utf8');

/** [selector, body] pairs inside every `@media <query>` block whose query is exactly `query`. */
function blockRules(css: string, query: string): [string, string][] {
  const out: [string, string][] = [];
  const head = `@media ${query} {`;
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) {
    let depth = 1;
    let i = at + head.length;
    const start = i;
    while (depth && i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    for (const r of css.slice(start, i - 1).matchAll(/([^{}]+)\{([^}]*)\}/g)) out.push([r[1]!.trim(), r[2]!]);
  }
  return out;
}
/** Top-level rules (outside any @media / @container block). */
function topRules(css: string): [string, string][] {
  let flat = '';
  let depth = 0;
  let inAt = false;
  for (const ch of css) {
    if (ch === '@' && depth === 0) inAt = true;
    if (ch === '{') depth++;
    if (!inAt) flat += ch;
    if (ch === '}') {
      depth--;
      if (depth === 0 && inAt) inAt = false;
    }
  }
  return [...flat.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);
}
const body = (rules: [string, string][], sel: string) => rules.find(([s]) => s === sel)?.[1] ?? '';

describe('a phone held sideways: the tabs become a rail', () => {
  const rail = blockRules(mobile, '(min-width: 667px) and (max-width: 820px) and (max-height: 520px) and (orientation: landscape)');
  test('only where the panel is at least 360 px wide (54vw of 667 px)', () => {
    expect(rail.length).toBeGreaterThan(0);
  });
  test('the panel is a grid: header across, the rail down the left, the rest beside it', () => {
    expect(body(rail, '.rlt-ui .sidepanel')).toMatch(/display:\s*grid/);
    expect(body(rail, '.rlt-ui .sidepanel')).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    expect(body(rail, '.rlt-ui .sidepanel > .panel-head')).toMatch(/grid-column:\s*1 \/ -1/);
    const tabs = body(rail, '.rlt-ui .sidepanel > .panel-tabs');
    expect(tabs).toMatch(/grid-column:\s*1;/);
    expect(tabs).toMatch(/flex-direction:\s*column/);
    for (const part of ['.jobs', '.panel-asks', '.panel-body']) expect(body(rail, `.rlt-ui .sidepanel > ${part}`)).toMatch(/grid-column:\s*2;/);
  });
  test('each tab keeps its name under its icon, at a touch size', () => {
    const tab = body(rail, '.rlt-ui .sidepanel .panel-tab');
    expect(tab).toMatch(/flex-direction:\s*column/);
    expect(tab).toMatch(/height:\s*2\.875rem/);
    expect(tab).toMatch(/font-size:\s*[\d.]+rem/);
  });
  test('the keyboard still folds the header and the tabs there (its rule is more specific)', () => {
    expect(mobile).toMatch(/\.rlt-ui\.is-kb \.sidepanel:not\(\.is-chrome-open\) :is\(\.jobs, \.people, \.thread-bar, \.panel-tabs\)/);
  });
});

describe('a short panel with its rows open keeps the chat box', () => {
  const top = topRules(mobile);
  test('the whole panel scrolls (on the chat) instead of pushing the chat box out', () => {
    expect(body(top, '.rlt-ui .sidepanel.is-short.is-chrome-open:has(#ppane-chat:not([hidden]))')).toMatch(/overflow-y:\s*auto/);
    expect(body(top, '.rlt-ui .sidepanel.is-short.is-chrome-open #ppane-chat')).toMatch(/position:\s*relative/);
  });
  test('the chat box stays pinned at its foot, opaque, and the conversation keeps a few lines', () => {
    const box = body(top, '.rlt-ui .sidepanel.is-short.is-chrome-open .tab-chat > .composer');
    expect(box).toMatch(/position:\s*sticky/);
    expect(box).toMatch(/bottom:\s*0/);
    expect(box).toMatch(/rgb\(var\(--surface-rgb\)\);/);
    expect(body(top, '.rlt-ui .sidepanel.is-short.is-chrome-open .tab-chat > .transcript-wrap')).toMatch(/flex:\s*0 0 4\.5rem/);
  });
  test('a waiting "Message Assistant…" stays on one line beside Stop and Send now (half its second line showed)', () => {
    const ph = body(top, '.rlt-ui .sidepanel.is-short .composer-input:placeholder-shown');
    expect(ph).toMatch(/white-space:\s*nowrap/);
    expect(ph).toMatch(/overflow:\s*hidden/);
  });
  test('picking a person (a click, not Tab) or starting to type folds the rows away again', () => {
    expect(panel).toMatch(/el\.addEventListener\('click', \(ev\) => foldPicked\(ev\.target, '\.people \.person'\), true\);/);
    expect(panel).toMatch(/el\.addEventListener\('focusin', \(ev\) => foldPicked\(ev\.target, '\.composer-input'\)\);/);
    expect(panel).toMatch(/if \(!el\.classList\.contains\('is-short'\) \|\| !el\.classList\.contains\('is-chrome-open'\)/);
  });
  test('the person’s one-line card keeps a long cost on one line (it doubled the line’s height)', () => {
    expect(body(top, '.rlt-ui .sidepanel.is-tight .agent-cost')).toMatch(/white-space:\s*nowrap/);
  });
});

describe('the top bar of a phone held sideways, inside a house', () => {
  test('the town view switch gives way to the house name (More → Town board)', () => {
    const land = blockRules(mobile, '(max-width: 820px) and (max-height: 520px) and (orientation: landscape)');
    expect(body(land, ".rlt-ui[data-view='house'] .tb-right .tb-focus")).toMatch(/display:\s*none/);
  });
});

describe('opening a tab that shows a request takes it out of the stack', () => {
  // the stack skips a request the panel already shows (Inbox, that person's chat, the Workflow asks), but it only
  // re-rendered on store changes: opening Inbox left the same card in the stack and in the tab, one over the other
  const ui = readFileSync(join(import.meta.dir, '../../web/src/ui/index.ts'), 'utf8');
  test('the stack asks the panel what it shows', () => {
    expect(ui).toContain('createApprovalStack(shell, (a) => shownInPanel(panel.view, a))');
  });
  test('and re-renders whenever the panel changes (one hook)', () => {
    expect(ui.split("panel.onChange(() => schedule('approvals', approvals.render))").length).toBe(2);
    const blocks = [...ui.matchAll(/panel\.onChange\(\(\) => \{([\s\S]*?)\n {4,6}\}\);/g)].map((m) => m[1]!);
    expect(blocks.some((b) => b.includes('approvals.render'))).toBe(false);
  });
});
