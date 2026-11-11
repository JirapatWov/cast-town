// g9 (first run, providers copy, wording), server side: git setup when placing a folder, ask-first for folders without
// git, what the server says about the machine, Auto's rule list matching what it checks, and the scripted test model
// (CAST_MOCK_LLM) answering Thai in Thai, explaining a chapter number it changed and quoting the note of a "Run again".
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOTS } from '../../shared/city-layout.ts';
import { ASK, autoAsksAbout } from '../../shared/auto-rules.ts';
import { autoReview } from '../../server/agents/auto-review.ts';
import { assistantTurn } from '../../server/agents/demo/assistant.ts';
import type { Conversation, ToolCallRecord } from '../../server/agents/demo/conversation.ts';
import { chapterAsked, chapterMismatchNote, editorTurn } from '../../server/agents/demo/novel.ts';
import { makeCtx } from '../../server/agents/demo/script.ts';
import { noteOf } from '../../server/agents/demo/workflow-prompt.ts';
import { createCityStore } from '../../server/city-store.ts';
import { createFsBrowser, insideGitRepo } from '../../server/fs-browse.ts';
import { createGitService, SETUP_EXCLUDES } from '../../server/git.ts';
import { createJobStore } from '../../server/job-store.ts';
import { machineInfo, ompAgentDir } from '../../server/machine-info.ts';
import { createProjectService, defaultApprovalMode } from '../../server/projects.ts';
import { writeFiles } from '../../server/project-templates.ts';
import { MOONLIGHT_FILES } from '../../server/agents/demo/fixtures/moonlight.ts';
import { continueNote } from '../../server/agents/templates.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `cast-test-g9-${name}-`));
  roots.push(d);
  return d;
}

function world() {
  const root = tmp('place');
  const ws = join(root, 'ws');
  const dataDir = join(root, 'data');
  mkdirSync(ws, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const city = createCityStore(dataDir, ws);
  const jobs = createJobStore(dataDir, city);
  const git = createGitService({ worktreesDir: join(root, 'wt') });
  const fs = createFsBrowser([ws]);
  const agents = { onProjectAdded: async () => {}, onProjectUpdated: async () => {} };
  const projects = createProjectService({ city, jobs, git, fs, agents: agents as never, workspaceRoot: ws });
  return { ws, city, projects };
}

function folder(ws: string, name: string): string {
  const dir = join(ws, name);
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'notes.md'), '# Notes\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '');
  return dir;
}

const tracked = (dir: string) => execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

describe('placing a folder without git (#20)', () => {
  test('defaults: Accept edits with git (undo exists), Ask first without', () => {
    expect(defaultApprovalMode(true)).toBe('write');
    expect(defaultApprovalMode(false)).toBe('always-ask');
  });

  test('placed as it is: not git, Ask first', async () => {
    const w = world();
    const dir = folder(w.ws, 'plain');
    const p = await w.projects.place({ path: dir, name: 'plain', lotId: LOTS[0]!.id, style: 'house' });
    expect(p.isGit).toBe(false);
    expect(p.approvalMode).toBe('always-ask');
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(insideGitRepo(dir)).toBe(false);
  });

  test('initGit: a repo with a first commit, deps and secrets left out, Accept edits', async () => {
    const w = world();
    const dir = folder(w.ws, 'setup');
    const p = await w.projects.place({ path: dir, name: 'setup', lotId: LOTS[1]!.id, style: 'house', initGit: true });
    expect(p.isGit).toBe(true);
    expect(p.approvalMode).toBe('write');
    expect(p.gitError).toBeUndefined();
    expect(insideGitRepo(dir)).toBe(true);
    expect(tracked(dir)).toEqual(['notes.md']);
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.env');
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('Starting point (set up by CAST)');
    expect(existsSync(join(dir, '.gitignore'))).toBe(false); // their files are untouched
  });

  test('the checkbox says exactly what Set up git does: a local commit, and what it leaves out', async () => {
    const { SET_UP_GIT_TEXT } = await import('../../web/src/ui/format');
    expect(SET_UP_GIT_TEXT).toMatch(/local commit/);
    expect(SET_UP_GIT_TEXT).toMatch(/nothing is uploaded/);
    // every kind of thing SETUP_EXCLUDES leaves out is named (the OS's .DS_Store and Python caches go unsaid)
    const named: Record<string, string> = { 'node_modules/': 'node_modules', '.venv/': 'venv', 'venv/': 'venv', '*.log': 'logs', '.env': '.env files', '.env.*': '.env files' };
    for (const pattern of SETUP_EXCLUDES) if (named[pattern]) expect(SET_UP_GIT_TEXT).toContain(named[pattern]!);
  });

  test('Set up git later (Changes tab): the house becomes a git house; twice is harmless', async () => {
    const w = world();
    const dir = folder(w.ws, 'later');
    const p = await w.projects.place({ path: dir, name: 'later', lotId: LOTS[2]!.id, style: 'house' });
    const after = await w.projects.initGit(p.id);
    expect(after.isGit).toBe(true);
    expect(w.city.project(p.id)!.isGit).toBe(true);
    expect(tracked(dir)).toEqual(['notes.md']);
    expect((await w.projects.initGit(p.id)).isGit).toBe(true);
    // its permission mode is the user's: setting up git doesn't loosen it
    expect(w.city.project(p.id)!.approvalMode).toBe('always-ask');
  });
});

describe('what the server says about this machine (#29, #32)', () => {
  test('agentDir follows PI_CODING_AGENT_DIR, else ~/.omp/agent', () => {
    expect(ompAgentDir({ HOME: '/home/x' })).toBe('/home/x/.omp/agent');
    expect(ompAgentDir({ HOME: '/home/x', PI_CODING_AGENT_DIR: '/data/omp' })).toBe('/data/omp');
    const m = machineInfo(['/srv/ws'], { HOME: '/home/x' });
    expect(m.home).toBe('/home/x');
    expect(m.fsRoots).toEqual(['/srv/ws']);
    expect(m.runAs.length).toBeGreaterThan(0);
  });
});

describe("Auto's rule list is what it checks (#61)", () => {
  const ctx = { projectDir: '/srv/ws/app' };
  test('the menu lists the reasons Auto stops for', () => {
    const list = autoAsksAbout();
    expect(list).toContain('runs a command as another user (sudo)');
    expect(list).toContain(ASK.deletesFolder);
    expect(list).toContain('opens a server to every network'); // the advice after " — " is cut for the list
    expect(new Set(list).size).toBe(list.length);
  });
  test('the rules still apply: sudo and deleting a folder ask, a plain test run does not', () => {
    expect(autoReview('bash', undefined, { command: 'sudo apt install x' }, ctx)).toEqual({ allow: false, reason: 'runs a command as another user (sudo)' });
    expect(autoReview('bash', undefined, { command: 'rm -rf src' }, ctx).allow).toBe(false);
    expect(autoReview('bash', undefined, { command: 'bun test' }, ctx)).toEqual({ allow: true });
  });
});

// ───────────────────────── scripted test model replies (#39) ─────────────────────────

function conv(cwd: string, userText: string, turn: ToolCallRecord[] = []): Conversation {
  return {
    model: 'claude-opus-5-5',
    system: '',
    role: 'assistant',
    stepKind: null,
    cwd,
    tools: new Set(['read', 'edit', 'write']),
    editMode: 'replace',
    isJudgment: false,
    userText,
    isWake: false,
    wakeText: '',
    wakeTexts: [],
    spawnedTasks: 0,
    userTexts: [userText],
    turn,
    promptChars: 0,
  };
}
const ran = (step: string, name = 'read', result = 'ok'): ToolCallRecord => ({ id: `rlt_${step}_1`, name, args: {}, step, result });
const hasLatin = (s: string, words: string[]) => words.filter((w) => s.includes(w));

describe('the scripted test model answers Thai in Thai', () => {
  const novel = () => {
    const d = tmp('novel');
    writeFiles(d, MOONLIGHT_FILES);
    return d;
  };

  test('explain: the whole overview is Thai, not "is a novel project … Premise:"', () => {
    const d = novel();
    const out = assistantTurn(makeCtx(conv(d, 'ช่วยเล่าโครงเรื่องให้ฟังหน่อย', [ran('survey'), ran('read')])));
    expect(out.text).toStartWith('สรุปให้ค่ะ');
    expect(out.text).toContain('เป็นโปรเจกต์นิยาย');
    expect(hasLatin(out.text!, ['is a novel project', 'Premise:', 'Characters', 'Written so far', 'Still open', 'Next up'])).toEqual([]);
    expect(out.thinking).not.toMatch(/I have what I need/);
  });

  test('explain in English stays English', () => {
    const d = novel();
    const out = assistantTurn(makeCtx(conv(d, 'what is this about?', [ran('survey'), ran('read')])));
    expect(out.text).toContain('is a novel project');
  });

  test('change in a novel house: "make real changes", not "write real code"; Thai when asked in Thai', () => {
    const d = novel();
    const en = assistantTurn(makeCtx(conv(d, 'add an epilogue idea to the README', [ran('read'), ran('edit', 'edit', 'Successfully applied')])));
    // the answer step reads what changed on disk; with nothing changed it says so — both in the right words
    expect(en.text).not.toContain('write real code');
    const th = assistantTurn(makeCtx(conv(d, 'แก้ README.md ให้มีบทส่งท้าย', [ran('read'), ran('edit', 'edit', 'Successfully applied')])));
    expect(th.text).toMatch(/[฀-๿]/);
    expect(th.text).not.toMatch(/Nothing needed changing|offline \*\*demo\*\* model/);
  });

  test('a Thai change answer lists what it noted in Thai too, not "recorded the request under Notes" (#39)', () => {
    const d = novel();
    const ask = 'แก้ README.md ให้สถานะบทที่ 1 เป็นเสร็จแล้ว';
    const planned = assistantTurn(makeCtx(conv(d, ask, [ran('read')])));
    const call = planned.calls?.find((c) => c.name === 'edit');
    expect(String(call?.args.i)).toContain('จดคำขอไว้');
    const edited: ToolCallRecord = { id: 'rlt_edit_1', name: 'edit', args: call!.args, step: 'edit', result: 'Successfully applied' };
    const out = assistantTurn(makeCtx(conv(d, ask, [ran('read'), edited])));
    expect(out.text).toContain('จดคำขอไว้');
    expect(out.text).not.toContain('recorded the request');
    // asked in English, the line stays English
    const en = assistantTurn(makeCtx(conv(d, 'add an epilogue idea to the README', [ran('read')])));
    expect(String(en.calls?.find((c) => c.name === 'edit')?.args.i)).toContain('recorded the request under "Notes"');
  });
});

describe('the novel team explains a chapter number it changed', () => {
  test('chapterAsked reads English and Thai briefs', () => {
    expect(chapterAsked('Write chapter 2')).toBe(2);
    expect(chapterAsked('เขียนบทที่ 3 ให้หน่อย')).toBe(3);
    expect(chapterAsked('write the next chapter')).toBeNull();
    expect(chapterAsked('fix chapters/chapter-01.md')).toBeNull();
  });
  test('asked for 2 with no chapter 1 yet → says it writes 1 first; same number → nothing', () => {
    expect(chapterMismatchNote(2, 1)).toContain('ยังไม่มีบทที่ 1');
    expect(chapterMismatchNote(1, 2)).toContain('บทที่ 1 มีอยู่แล้ว');
    expect(chapterMismatchNote(1, 1)).toBe('');
    expect(chapterMismatchNote(null, 1)).toBe('');
  });
});

describe('"Run again" with a note: the reviewer quotes it', () => {
  test('noteOf reads the note continueNote writes (its first line)', () => {
    const text = `Task: T\n\n${continueNote('run-a', true, true, undefined, 'Be strict about the dialogue tags.')}\n\nmore`;
    expect(noteOf(text)).toBe('Be strict about the dialogue tags.');
    expect(noteOf('Task: T')).toBeNull();
  });
  test('the editor (novel) starts its verdict with the note', () => {
    const d = tmp('editor');
    writeFiles(d, MOONLIGHT_FILES);
    const text = `Brief: chapter 1\n\n${continueNote('run-a', true, true, undefined, 'ตรวจบทสนทนาให้ละเอียดขึ้น')}`;
    const c = { ...conv(d, text, [ran('read'), ran('edit', 'edit', 'Successfully applied')]), role: 'editor' };
    const out = editorTurn(makeCtx(c));
    expect(out.text).toStartWith('รอบนี้อ่านใหม่ตามโน้ตของคุณ: “ตรวจบทสนทนาให้ละเอียดขึ้น”');
  });
});
