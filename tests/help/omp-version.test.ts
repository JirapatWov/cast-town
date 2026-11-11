// The agent CAST runs (finding #5): CAST finds its own cast-agent without any machine-specific path, the build command
// the app shows really builds it, the bundled agent is the tested version, and no doc tells people to install an
// unpinned or other omp.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json';
import { resolveOmpBin } from '../../server/agents/index';
import { AGENT_BUILD_COMMAND, AGENT_NAME, OMP_TESTED_VERSION, agentBuildHint, ompVersionWarning } from '../../shared/omp-version';

const tmp = mkdtempSync(join(tmpdir(), 'cast-test-ompver-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const repo = join(import.meta.dir, '..', '..');

/** Repo-relative paths of the .ts / .md / .mjs files under the given files and folders (missing ones are skipped). */
function textFiles(root: string, entries: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs)) walk(join(rel, name));
    else if (/\.(ts|md|mjs)$/.test(rel)) out.push(rel);
  };
  entries.forEach(walk);
  return out;
}

describe('build hint', () => {
  test('the command the app shows builds the agent in agent/', () => {
    expect(agentBuildHint()).toContain(AGENT_BUILD_COMMAND);
    const scripts: Record<string, string> = pkg.scripts;
    const script = AGENT_BUILD_COMMAND.match(/^bun run ([\w:-]+)$/)?.[1];
    expect(script && scripts[script]).toContain('bun run build:agent');
    expect(scripts['build:agent']).toBe('bash agent/cast/build.sh');
    expect(existsSync(join(repo, 'agent', 'cast', 'build.sh'))).toBe(true);
  });

  test('the bundled agent is the tested version, so only another CAST_AGENT_BIN can be untested', () => {
    const agentPkg = JSON.parse(readFileSync(join(repo, 'agent', 'packages', 'coding-agent', 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> };
    expect(agentPkg.version).toBe(OMP_TESTED_VERSION);
    expect(Object.keys(agentPkg.bin)).toEqual([AGENT_NAME]);
  });

  test('no source file or doc tells people to install an unpinned or other omp', () => {
    const files = textFiles(repo, ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'ARCHITECTURE.md', 'docs', 'server', 'shared', 'web/src', 'scripts']);
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const text = readFileSync(join(repo, f), 'utf8');
      // `@oh-my-pi/pi-coding-agent` right after an install verb must carry @<version>
      for (const m of text.matchAll(/bun (?:add|install) -g @oh-my-pi\/pi-coding-agent(@[\w.${}-]+)?/g)) {
        expect({ file: f, match: m[0], pinned: !!m[1] }).toEqual({ file: f, match: m[0], pinned: true });
        // a literal version (not a template placeholder) must be the tested one
        if (m[1] && !m[1].includes('$')) expect({ file: f, version: m[1] }).toEqual({ file: f, version: `@${OMP_TESTED_VERSION}` });
      }
    }
  });

  test('the version warning is unchanged for the tested release and fires for another one', () => {
    expect(ompVersionWarning(OMP_TESTED_VERSION)).toBeNull();
    expect(ompVersionWarning(`omp/${OMP_TESTED_VERSION}-cast.1`)).toBeNull();
    expect(ompVersionWarning('18.14.2')).toContain('not the tested version');
    expect(ompVersionWarning(null)).toBeNull();
  });
});

describe('which agent CAST runs', () => {
  test('CAST_AGENT_BIN wins (blank counts as unset)', () => {
    expect(resolveOmpBin({ CAST_AGENT_BIN: ' /opt/cast-agent ' }, '/app/cast-agent', '/repo')).toBe('/opt/cast-agent');
    expect(resolveOmpBin({ CAST_AGENT_BIN: '  ' }, null, '/repo')).toBe('/repo/agent/bin/cast-agent');
  });

  test('a compiled CAST runs the cast-agent next to it, even before it is there (the check then says it is missing)', () => {
    expect(resolveOmpBin({}, '/app/Resources/cast-agent', null)).toBe('/app/Resources/cast-agent');
  });

  test('from a checkout: agent/bin/cast-agent of this repository, never an omp on PATH or under ~/.bun', () => {
    const home = join(tmp, 'home');
    const bin = join(tmp, 'bin');
    for (const f of [join(home, '.bun', 'bin', 'omp'), join(bin, 'omp'), join(bin, 'cast-agent')]) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, '#!/bin/sh\necho 18.13.2\n');
      chmodSync(f, 0o755);
    }
    expect(resolveOmpBin({ HOME: home, PATH: bin })).toBe(join(repo, 'agent', 'bin', 'cast-agent'));
  });
});

