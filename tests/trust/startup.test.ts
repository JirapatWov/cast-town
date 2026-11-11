// Startup messages a person acts on: the root warning must send them to advice that exists (it once pointed at a
// README section that had been renamed), and the terminal chip must name the account the shell really runs as.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT_ADVICE_HEADING, ROOT_WARNING, shellUser } from '../../server/startup';

const REPO = resolve(import.meta.dir, '../..');

describe('root warning', () => {
  test('names a SECURITY.md heading that exists', () => {
    const security = readFileSync(join(REPO, 'SECURITY.md'), 'utf8');
    expect(security).toMatch(new RegExp(`^#+ ${ROOT_ADVICE_HEADING}$`, 'm'));
    expect(ROOT_WARNING).toContain('SECURITY.md');
    expect(ROOT_WARNING).toContain(ROOT_ADVICE_HEADING);
  });

  test('every README / SECURITY section a server message quotes exists', () => {
    // Messages quote docs as (FILE, "Heading"); each heading must be a real one in that file.
    const sources = ['server/startup.ts', 'server/pages.ts', 'server/index.ts'].map((f) => readFileSync(join(REPO, f), 'utf8')).join('\n');
    const resolved = sources.replace(/\$\{ROOT_ADVICE_HEADING\}/g, ROOT_ADVICE_HEADING);
    const refs = [...resolved.matchAll(/(README|SECURITY)(?:\.md)?,\s*"([^"$]+)"/g)].map((m) => ({ file: `${m[1]}.md`, heading: m[2]! }));
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      const doc = readFileSync(join(REPO, r.file), 'utf8');
      expect({ ...r, found: new RegExp(`^#+ ${r.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(doc) }).toEqual({ ...r, found: true });
    }
  });
});

describe('commands CAST tells people to run', () => {
  test('every `bun run <name>` in server messages and the docs is a package.json script or a file', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const files = ['server/pages.ts', 'server/startup.ts', 'server/index.ts', 'scripts/pair.ts', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'tests/README.md', 'ARCHITECTURE.md'];
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(join(REPO, f), 'utf8').matchAll(/bun run ([\w:./-]+)/g)) {
        const name = m[1]!;
        if (/\.(ts|js|mjs)$/.test(name)) continue; // a file (bun run server/index.ts, a project's src/server.ts)
        if (!(name in pkg.scripts)) bad.push(`${f}: bun run ${name}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('shellUser', () => {
  test('the uid’s own name wins over $USER (sudo -E / env USER=… must not hide a root shell)', () => {
    expect(shellUser(() => ({ username: 'root' }), 'alice')).toBe('root');
  });
  test('$USER only when the uid has no passwd entry', () => {
    expect(
      shellUser(() => {
        throw new Error('ENOENT');
      }, 'alice'),
    ).toBe('alice');
    expect(
      shellUser(() => {
        throw new Error('ENOENT');
      }, undefined),
    ).toBe('unknown');
  });
});
