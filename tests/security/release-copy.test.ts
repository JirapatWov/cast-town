// What the docs and the Add a city dialog promise about trust must match what the code does (final check):
// a city's pages run on the hub's own origin, so an added city can act on the hub; and the dev history still
// holds personal names, so the release checklist must say not to push it. And nothing a user reads calls anything a
// demo: CAST has no demo mode (the scripted test model is a CAST_MOCK_LLM test/dev facility, documented only for
// developers) and no example workflows.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('city trust copy', () => {
  test('the Add a city dialog says a city can act on this CAST, not only on what is opened through it', () => {
    const line = read('web/src/ui/cities.ts').match(/const TRUST_LINE = '([^']+)'/)?.[1] ?? '';
    expect(line).toContain('Only add machines you control');
    expect(line).toMatch(/run inside this CAST/);
    expect(line).not.toMatch(/what you open through it/);
  });
  test('SECURITY.md and the README name the hub-side risk', () => {
    expect(read('SECURITY.md')).toMatch(/could act on the hub/);
    expect(read('README.md')).toMatch(/a city can\s+act on the home machine/);
  });
});

describe('release checklist', () => {
  test('says not to push the development history', () => {
    const s = read('RELEASE-CHECKLIST.md');
    expect(s).toMatch(/Don't push the development history/);
    expect(s).toMatch(/--orphan/);
  });
});

/** Every line of `text` that says "demo" as a word (identifiers such as demoMode don't match). */
const demoLines = (text: string, skip: RegExp | null = null) =>
  text.split('\n').map((line, i) => `${i + 1}: ${line.trim()}`).filter((line) => /\bdemo\b/i.test(skip ? line.replace(skip, '') : line));

/** The files under `dir` (relative to the repo) whose name ends with one of `ext`, recursively. */
function filesIn(dir: string, ext: string[]): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && ext.some((x) => e.name.endsWith(x)))
    .map((e) => join(e.parentPath, e.name).slice(root.length + 1));
}

describe('no demo in what users read', () => {
  const docs = ['README.md', 'SECURITY.md', 'mac/README.md', ...filesIn('mac/CASTMenu', ['.swift'])];
  const ui = [
    ...['help', 'help-info', 'providers', 'onboarding', 'welcome-copy', 'topbar', 'model-chip', 'model-picker', 'job-dialog', 'chat-tab', 'omp-warning', 'agents-health', 'wipe-text', 'widgets'].map((f) => `web/src/ui/${f}.ts`),
    'web/src/people/tag.ts',
  ];
  test('the docs and the Mac app, comments included', () => {
    expect(docs.length).toBeGreaterThan(4);
    for (const f of docs) expect({ file: f, lines: demoLines(read(f)) }).toEqual({ file: f, lines: [] });
  });
  test('the app’s copy: the welcome, the top bar, Models & providers, Help, chips, the chat box — comments included', () => {
    for (const f of ui) expect({ file: f, lines: demoLines(read(f)) }).toEqual({ file: f, lines: [] });
  });
  test('the rest of the web app: no demo text, class or label (the person’s scripted-model flag, a.demo, is not text)', () => {
    const all = [...filesIn('web/src', ['.ts', '.css']), 'web/index.html'];
    expect(all.length).toBeGreaterThan(50);
    for (const f of all) expect({ file: f, lines: demoLines(read(f), /\.demo\b/g) }).toEqual({ file: f, lines: [] });
  });
  test('the README names neither the test model’s switches nor its port; it says to connect an AI account', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/CAST_MOCK_|RLT_MOCK_|\b4871\b/);
    expect(readme).toContain('**Connect AI**');
  });
  test('the switch is documented for developers only, and says it is off by default', () => {
    expect(read('CONTRIBUTING.md')).toContain('CAST_MOCK_LLM=1');
    expect(read('SECURITY.md')).toMatch(/CAST_MOCK_LLM=1/);
    expect(read('SECURITY.md')).toMatch(/off by\s+default/);
  });
});
