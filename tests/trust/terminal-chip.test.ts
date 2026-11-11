// #7 on phones: the terminal dock hides its chips below 820 px to make room, and that used to take the red root@host
// marker with it — a root shell on a phone looked like any other. The phone rule for the root chip must stay, and must
// beat the generic "hide the chips" rule (higher specificity, same breakpoint).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mediaRules, readCss as read, specificity } from '../helpers/css-rules';

describe('terminal dock on phones', () => {
  test('the generic chip rule hides chips at 820 px (what the root rule has to beat)', () => {
    const hide = mediaRules(read('terminal.css'), '820px').find(([sel, body]) => /\.term-chip\b/.test(sel) && /display:\s*none/.test(body));
    expect(hide).toBeDefined();
  });

  test('a root shell keeps its red chip, without the host name', () => {
    const rules = mediaRules(read('trust.css'), '820px');
    const show = rules.find(([sel, body]) => /\.term-who\.is-root/.test(sel) && !/term-who-host/.test(sel) && /display:\s*inline-flex/.test(body));
    expect(show).toBeDefined();
    const hide = mediaRules(read('terminal.css'), '820px').find(([sel]) => /\.term-chip\b/.test(sel))!;
    expect(specificity(show![0])).toBeGreaterThan(specificity(hide[0]));
    // never shown while the chip is [hidden] (no session info yet)
    expect(show![0]).toContain(':not([hidden])');
    expect(rules.some(([sel, body]) => /\.term-who-host/.test(sel) && /display:\s*none/.test(body))).toBe(true);
  });

  test('the chip renders user and host as separate parts the phone rule can split', () => {
    const src = readFileSync(resolve(import.meta.dir, '../../web/src/ui/terminal-gate.ts'), 'utf8');
    expect(src).toContain("class: 'term-who-user'");
    expect(src).toContain("class: 'term-who-host'");
  });
});
