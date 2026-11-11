// #51: a folder with a long name placed as a house. The name is clipped (the same limit on both sides), never refused
// with "place_project.name is too long (max 80)"; a refusal that does show is a sentence.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clipName, MAX_PROJECT_NAME } from '../../shared/limits.ts';
import type { Project } from '../../shared/protocol.ts';
import { createProjectService, type ProjectDeps } from '../../server/projects.ts';
import { parseClientMsg } from '../../server/validate.ts';
import { cleanupTmp, tmp } from './fake-omp';

afterAll(cleanupTmp);

const LONG = 'a-really-long-folder-name-that-someone-made-for-a-client-project-archive-2026-final-v2-copy';

describe('clipName', () => {
  test('short names stay (trimmed); long ones end in … within the limit', () => {
    expect(clipName('  my-app ', 60)).toBe('my-app');
    const c = clipName(LONG, MAX_PROJECT_NAME);
    expect(c.length).toBeLessThanOrEqual(MAX_PROJECT_NAME);
    expect(c.endsWith('…')).toBe(true);
    expect(LONG.startsWith(c.slice(0, -1))).toBe(true);
  });

  test('never splits an emoji or a letter with its accent', () => {
    const family = '👩‍👩‍👧‍👦'; // 11 UTF-16 units, one character
    const c = clipName(`${'x'.repeat(5)}${family}${'y'.repeat(10)}`, 10);
    expect(c).toBe('xxxxx…');
    const accents = 'é'.repeat(20); // é as e + combining accent
    const a = clipName(accents, 9);
    expect(a.length).toBeLessThanOrEqual(9);
    expect(a.slice(0, -1)).toBe('é'.repeat(4));
  });
});

describe('the server', () => {
  test('a long name is accepted by the message check and clipped when the house is placed', async () => {
    const parsed = parseClientMsg(JSON.stringify({ t: 'place_project', reqId: 'r', path: '/x', name: LONG, lotId: 'l1', style: 'house' }));
    expect(parsed.ok).toBe(true);

    const dir = join(tmp(), LONG);
    mkdirSync(dir, { recursive: true });
    const added: Project[] = [];
    const deps = {
      city: {
        projectByPath: () => undefined,
        projectOnLot: () => undefined,
        get: () => ({ lots: [{ id: 'l1' }] }),
        addProject: (p: Omit<Project, 'id'>) => {
          const project = { ...p, id: `p${added.length + 1}` } as Project;
          added.push(project);
          return project;
        },
      },
      jobs: { list: () => [] },
      git: { isGit: async () => false },
      fs: { resolveDir: (p: string) => p },
      agents: { onProjectAdded: async () => {} },
      workspaceRoot: tmp(),
    } as unknown as ProjectDeps;
    const projects = createProjectService(deps);
    const typed = await projects.place({ path: dir, name: LONG, lotId: 'l1', style: 'house' });
    expect(typed.name.length).toBeLessThanOrEqual(MAX_PROJECT_NAME);
    expect(typed.name.endsWith('…')).toBe(true);
    added.length = 0;
    const fromFolder = await projects.place({ path: dir, name: '   ', lotId: 'l1', style: 'house' });
    expect(fromFolder.name).toBe(clipName(LONG, MAX_PROJECT_NAME));
  });

  test('a refusal reads as a sentence, not a field path', () => {
    const r = parseClientMsg(JSON.stringify({ t: 'place_project', reqId: 'r', path: 'x'.repeat(5000), name: '', lotId: 'l1', style: 'house' }));
    expect(r).toEqual({ ok: false, error: 'The folder path is too long (at most 4096 characters).', reqId: 'r' });
    const e = parseClientMsg(JSON.stringify({ t: 'create_project', reqId: 'r', name: '', lotId: 'l1', style: 'house', template: 'empty' }));
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toBe('The name must not be empty.');
    const l = parseClientMsg(JSON.stringify({ t: 'move_project', reqId: 'r', projectId: 'p', lotId: 5 }));
    if (!l.ok) expect(l.error).toBe('The lot id must be a string.');
  });
});
