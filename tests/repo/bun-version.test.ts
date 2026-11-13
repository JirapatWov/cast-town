// The oldest Bun CAST runs on: one number, package.json engines.bun. The server and `bun run pair` stop on an older
// Bun with what was found, the minimum and `bun upgrade`; the README and CONTRIBUTING state the same minimum, and the
// Bun CI pins satisfies it.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bunTooOld, bunTooOldMessage, MIN_BUN_VERSION } from '../../server/bun-version';

const REPO = resolve(import.meta.dir, '../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

describe('the Bun version check', () => {
  test('x.y.z compared as numbers, not as text', () => {
    expect(bunTooOld('1.3.13', '1.3.14')).toBe(true);
    expect(bunTooOld('1.3.14', '1.3.14')).toBe(false);
    expect(bunTooOld('1.3.9', '1.3.14')).toBe(true); // "1.3.9" > "1.3.14" as text
    expect(bunTooOld('1.10.0', '1.3.14')).toBe(false);
    expect(bunTooOld('1.4.4', '1.3.14')).toBe(false);
    expect(bunTooOld('0.9.99', '1.3.14')).toBe(true);
    expect(bunTooOld('2.0.0', '1.3.14')).toBe(false);
  });

  test('a pre-release or build suffix counts as that release', () => {
    expect(bunTooOld('1.3.14-canary.3+abc', '1.3.14')).toBe(false);
    expect(bunTooOld('1.3.13-canary.9', '1.3.14')).toBe(true);
  });

  test('the message names what was found, the minimum and how to upgrade; none on a new enough Bun', () => {
    const msg = bunTooOldMessage('1.2.0', '1.3.14');
    expect(msg).toContain('1.2.0');
    expect(msg).toContain('1.3.14');
    expect(msg).toContain('bun upgrade');
    expect(bunTooOldMessage('1.3.14', '1.3.14')).toBeNull();
    expect(bunTooOldMessage(Bun.version)).toBeNull(); // the Bun running these tests is supported
  });
});

describe('one minimum everywhere', () => {
  test('package.json engines.bun is where it comes from', () => {
    const pkg = JSON.parse(read('package.json')) as { engines: { bun: string } };
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
    expect(MIN_BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('the README and CONTRIBUTING state it', () => {
    expect(read('README.md')).toContain(`Bun](https://bun.sh) ${MIN_BUN_VERSION} or newer`);
    expect(read('CONTRIBUTING.md')).toContain(`Bun ${MIN_BUN_VERSION} or newer`);
  });

  test('the Bun CI pins is supported', () => {
    const dir = join(REPO, '.github', 'workflows');
    const pins = readdirSync(dir).flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/bun-version:\s*([\d.]+)/g)].map((m) => m[1]!));
    expect(pins.length).toBeGreaterThan(0);
    for (const v of pins) expect({ v, tooOld: bunTooOld(v) }).toEqual({ v, tooOld: false });
  });
});
