// Models & providers asks for usage limits (the server's `omp usage`, a few hundred MB) only once a card's usage part is
// unfolded and on screen — not on every open, never while every usage part is folded, and never on a page with no
// account to show limits for. whenSeen is the seam; the page's
// wiring is checked in its source (no DOM in these tests).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { whenSeen } from '../../web/src/ui/when-seen';

/** A stand-in IntersectionObserver the test drives by hand. */
function fakeIO() {
  const made: { cb: (e: { isIntersecting: boolean }[]) => void; observed: unknown[]; disconnected: boolean }[] = [];
  class IO {
    rec: (typeof made)[number];
    constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
      this.rec = { cb, observed: [], disconnected: false };
      made.push(this.rec);
    }
    observe(el: unknown) {
      this.rec.observed.push(el);
    }
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  return { IO, made };
}

describe('whenSeen', () => {
  test('runs once, on the first time something is on screen', () => {
    const { IO, made } = fakeIO();
    let n = 0;
    const els = [{}, {}] as unknown as Element[];
    whenSeen(els, () => n++, IO);
    expect(made[0]!.observed).toHaveLength(2);
    made[0]!.cb([{ isIntersecting: false }]); // attached but scrolled away
    expect(n).toBe(0);
    made[0]!.cb([{ isIntersecting: false }, { isIntersecting: true }]);
    made[0]!.cb([{ isIntersecting: true }]);
    expect(n).toBe(1);
    expect(made[0]!.disconnected).toBe(true);
  });

  test('stopped before it was seen: never runs; nothing to watch: never runs; no IntersectionObserver: runs at once', () => {
    const { IO, made } = fakeIO();
    let n = 0;
    const stop = whenSeen([{}] as unknown as Element[], () => n++, IO);
    stop();
    made[0]!.cb([{ isIntersecting: true }]);
    expect(n).toBe(0);
    whenSeen([], () => n++, IO);
    expect(n).toBe(0);
    whenSeen([{}] as unknown as Element[], () => n++, undefined);
    expect(n).toBe(1);
  });
});

describe('Models & providers wiring', () => {
  const src = readFileSync(resolve(import.meta.dir, '../../web/src/ui/providers.ts'), 'utf8');
  const open = src.slice(src.indexOf('    open() {'), src.indexOf('/** A step of the running sign-in'));
  test('opening the page reads the accounts, not the usage limits or the order (they wait for the usage part)', () => {
    expect(open).toContain('void loadAccounts();');
    expect(open).not.toContain('loadUsage(');
    expect(open).not.toContain('order.ensure(');
    expect(open).toContain('watchUsage();');
  });
  test('the usage part is an unfolded usage block; folded ones never ask; re-reads after a change only once wanted', () => {
    expect(src).toContain("querySelectorAll('.usage-block.is-open')");
    expect(src).not.toContain('.vendor-accounts\')'); // the account list no longer asks for usage when seen
    // unfolding a usage part asks at once (it is on screen: the user just clicked it)
    expect(src).toMatch(/if \(next\) wantUsage\(\);/);
    for (const call of src.matchAll(/^(.*)void loadUsage\(\);/gm)) {
      if (call[1]!.includes('function wantUsage')) continue;
      expect(call[1]).toMatch(/usageWanted|^\s*$/);
    }
    expect(src.match(/^\s*void loadUsage\(\);$/gm)).toHaveLength(1); // the one in wantUsage
  });
});
