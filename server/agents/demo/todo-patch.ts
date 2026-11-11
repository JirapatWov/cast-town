// The demo implementer's real code change for the seeded todo-api house:
//   PATCH /todos/:id/done (+ TodoStore.markDone), input validation (400s), tests, README.
// Every change is anchored on the seed's actual lines and is idempotent (already-applied parts are skipped),
// so a second run — or a user who already fixed something — never produces a broken file.
import { planEdit, type AnchorOp, type PlannedEdit } from './hashline';
import { readText } from './project-scan';

export const STORE = 'src/todos.ts';
export const SERVER = 'src/server.ts';
export const TESTS = 'src/todos.test.ts';
export const README = 'README.md';

export type TodoFeature = 'done' | 'validation' | 'tests' | 'errorTests' | 'docs';

export interface FilePatch {
  path: string;
  edit: PlannedEdit;
  what: string; // one-line summary for the agent's reply
}

export interface TodoState {
  hasDone: boolean;
  hasValidation: boolean;
  hasDoneTest: boolean;
  hasValidationTest: boolean;
  hasErrorTests: boolean;
}

/** True when the folder looks like RLT's seeded todo-api (the precise patch only targets that shape). */
export function isTodoSeed(cwd: string): boolean {
  const store = readText(cwd, STORE) ?? '';
  const server = readText(cwd, SERVER) ?? '';
  return store.includes('class TodoStore') && server.includes('createApp');
}

export function todoState(cwd: string): TodoState {
  const store = readText(cwd, STORE) ?? '';
  const server = readText(cwd, SERVER) ?? '';
  const tests = readText(cwd, TESTS) ?? '';
  return {
    hasDone: store.includes('markDone(') && server.includes("action === 'done'"),
    hasValidation: server.includes('badRequest('),
    hasDoneTest: /test\(\s*'PATCH \/todos\/:id\/done marks/.test(tests),
    hasValidationTest: /test\(\s*'POST \/todos rejects/.test(tests),
    hasErrorTests: tests.includes("'/todos/42/done'"),
  };
}

const tick = (line: string) => line.replace('- [ ]', '- [x]');

function storePatch(content: string): AnchorOp[] {
  if (content.includes('markDone(')) return [];
  return [
    {
      from: 'return this.todos.delete(id);',
      anchor: /^ {2}}$/,
      op: 'after',
      lines: [
        '',
        '  /** Marks a todo as done. Returns the updated todo, or undefined when the id is unknown. */',
        '  markDone(id: number): Todo | undefined {',
        '    const todo = this.todos.get(id);',
        '    if (todo) todo.done = true;',
        '    return todo;',
        '  }',
      ],
    },
  ];
}

function serverPatch(content: string, f: Set<TodoFeature>): AnchorOp[] {
  const ops: AnchorOp[] = [];
  const wantValidation = f.has('validation') && !content.includes('badRequest(');
  const wantDone = f.has('done') && !content.includes("action === 'done'");
  if (wantValidation) {
    ops.push({
      anchor: 'const methodNotAllowed = () =>',
      op: 'after',
      lines: ["const badRequest = (message: string) => json({ error: message }, 400);", '', 'const MAX_TITLE_LENGTH = 200;'],
    });
    ops.push({
      anchor: 'const body = (await req.json()',
      op: 'replace',
      span: 3,
      lines: [
        '        const body = (await req.json().catch(() => null)) as { title?: unknown } | null;',
        "        const title = typeof body?.title === 'string' ? body.title.trim() : '';",
        "        if (!title) return badRequest('title is required and must be a non-empty string');",
        '        if (title.length > MAX_TITLE_LENGTH) return badRequest(`title must be at most ${MAX_TITLE_LENGTH} characters`);',
        '        return json(store.create(title), 201);',
      ],
    });
  }
  if (wantDone) {
    ops.push({
      anchor: "const [resource, rawId, ...rest] = pathname.split('/')",
      op: 'replace',
      span: 2,
      lines: [
        "    const [resource, rawId, action, ...rest] = pathname.split('/').filter(Boolean);",
        "    if (resource !== 'todos' || rest.length > 0 || (action !== undefined && action !== 'done')) return notFound();",
      ],
    });
  }
  if (wantValidation || wantDone) {
    const doneBlock = wantDone
      ? ["    if (action === 'done') {", "      return req.method === 'PATCH' ? json(store.markDone(id)) : methodNotAllowed();", '    }']
      : [];
    if (wantValidation) {
      ops.push({
        anchor: 'const id = Number(rawId);',
        op: 'replace',
        span: 3,
        lines: [
          '    const id = Number(rawId);',
          "    if (!Number.isInteger(id) || id < 1) return badRequest('id must be a positive integer');",
          '    const todo = store.get(id);',
          "    if (!todo) return notFound('Todo not found');",
          ...doneBlock,
        ],
      });
    } else {
      ops.push({ anchor: "if (!todo) return notFound('Todo not found');", op: 'after', lines: doneBlock });
    }
  }
  // The replaced POST block must still look like the seed's (3 lines); otherwise don't guess.
  if (wantValidation && !content.includes('const todo = store.create(body.title')) return [];
  if (wantValidation && !content.includes('const todo = Number.isInteger(id) ? store.get(id) : undefined;')) return [];
  if (wantDone && !content.includes("if (resource !== 'todos' || rest.length > 0) return notFound();")) return [];
  return ops;
}

const DONE_TEST = [
  "  test('PATCH /todos/:id/done marks a todo as done', async () => {",
  '    const { store, call } = setup();',
  "    const todo = store.create('Buy jasmine rice');",
  '    const res = await call(\'PATCH\', `/todos/${todo.id}/done`);',
  '    expect(res.status).toBe(200);',
  '    expect(await res.json()).toMatchObject({ id: todo.id, done: true });',
  '    expect(store.get(todo.id)?.done).toBe(true);',
  '  });',
];

const VALIDATION_TEST = [
  "  test('POST /todos rejects an empty title with 400', async () => {",
  '    const { store, call } = setup();',
  "    for (const body of [{ title: '   ' }, {}, { title: 42 }]) {",
  "      const res = await call('POST', '/todos', body);",
  '      expect(res.status).toBe(400);',
  "      expect((await res.json()).error).toContain('title');",
  '    }',
  '    expect(store.list()).toHaveLength(0);',
  '  });',
];

function testsPatch(content: string, f: Set<TodoFeature>, serverHasValidation: boolean): AnchorOp[] {
  const ops: AnchorOp[] = [];
  if (f.has('tests')) {
    if (f.has('done') && !content.includes("test('PATCH /todos/:id/done marks")) {
      const todoLine = content.split('\n').find((l) => /test\.todo\(.*PATCH/.test(l));
      if (todoLine) ops.push({ anchor: todoLine.trim(), op: 'replace', lines: [...DONE_TEST, ''] });
      else ops.push({ anchor: /^}\);$/, last: true, op: 'before', lines: ['', ...DONE_TEST] });
    }
    if (f.has('validation') && !content.includes("test('POST /todos rejects")) {
      const todoLine = content.split('\n').find((l) => /test\.todo\(.*POST/.test(l));
      if (todoLine) ops.push({ anchor: todoLine.trim(), op: 'replace', lines: VALIDATION_TEST });
      else ops.push({ anchor: /^}\);$/, last: true, op: 'before', lines: ['', ...VALIDATION_TEST] });
    }
  }
  if (f.has('errorTests') && !content.includes("'/todos/42/done'")) {
    const lines = [
      '',
      "  test('PATCH /todos/:id/done on an unknown todo is a 404', async () => {",
      '    const { call } = setup();',
      "    expect((await call('PATCH', '/todos/42/done')).status).toBe(404);",
      "    expect((await call('GET', '/todos/42/done')).status).toBe(404);",
      '  });',
    ];
    if (serverHasValidation) {
      lines.push(
        '',
        "  test('a malformed id is rejected with 400', async () => {",
        '    const { call } = setup();',
        "    expect((await call('PATCH', '/todos/abc/done')).status).toBe(400);",
        "    expect((await call('GET', '/todos/0')).status).toBe(400);",
        '  });',
      );
    }
    ops.push({ anchor: /^}\);$/, last: true, op: 'before', lines });
  }
  return ops;
}

function readmePatch(content: string, f: Set<TodoFeature>): AnchorOp[] {
  const ops: AnchorOp[] = [];
  const lines = content.split('\n');
  if (f.has('done') && !content.includes('/todos/:id/done')) {
    ops.push({ anchor: /^\|\s*DELETE\s*\|/, op: 'after', lines: ['| PATCH  | `/todos/:id/done` | Mark a todo as done                 |'] });
    const gap = lines.find((l) => l.startsWith("- [ ] **You can't mark a todo as done.**"));
    if (gap) ops.push({ anchor: gap, op: 'replace', lines: [tick(gap).replace(/; there is no `PATCH \/todos\/:id` yet\./, '. Fixed: `PATCH /todos/:id/done`.')] });
  }
  if (f.has('validation')) {
    const gap = lines.find((l) => l.startsWith('- [ ] **No input validation.**'));
    if (gap) ops.push({ anchor: gap, op: 'replace', lines: ['- [x] **No input validation.** `POST /todos` now rejects empty, missing or non-string titles (and malformed ids) with `400`.'] });
  }
  return ops;
}

/** Concrete edits for the requested features, skipping files that need nothing. */
export function todoPatches(cwd: string, features: TodoFeature[]): FilePatch[] {
  const f = new Set(features);
  const out: FilePatch[] = [];
  const add = (path: string, ops: AnchorOp[], what: string) => {
    const content = readText(cwd, path);
    if (content === null || ops.length === 0) return;
    const edit = planEdit(path, content, ops);
    if (edit && edit.newContent !== content) out.push({ path, edit, what });
  };
  const store = readText(cwd, STORE) ?? '';
  const server = readText(cwd, SERVER) ?? '';
  if (f.has('done')) add(STORE, storePatch(store), '`TodoStore.markDone(id)`');
  if (f.has('done') || f.has('validation')) {
    const what = [f.has('done') && '`PATCH /todos/:id/done`', f.has('validation') && '400s for bad titles and ids'].filter(Boolean).join(' + ');
    add(SERVER, serverPatch(server, f), what);
  }
  if (f.has('tests') || f.has('errorTests')) {
    const willValidate = server.includes('badRequest(') || f.has('validation');
    add(TESTS, testsPatch(readText(cwd, TESTS) ?? '', f, willValidate), f.has('errorTests') ? 'tests for the 404 / 400 paths' : 'tests replacing the two `test.todo` placeholders');
  }
  if (f.has('docs')) add(README, readmePatch(readText(cwd, README) ?? '', f), 'documented the endpoint, ticked the known gaps');
  return out;
}

/** Which parts of the todo-api change a free-text ask is about (both known gaps when it names neither). */
export function todoFeaturesFor(ask: string): TodoFeature[] {
  const done = /\bdone\b|complete|finish|mark|patch|toggle|เสร็จ/i.test(ask);
  const validation = /valid|empty|blank|400|reject|bad (input|request)|title/i.test(ask);
  const core: TodoFeature[] = done || validation ? [...(done ? ['done' as const] : []), ...(validation ? ['validation' as const] : [])] : ['done', 'validation'];
  return [...core, 'tests', 'docs'];
}

/** Does a free-text ask look like it is about the todo-api's known gaps? */
export const isTodoAsk = (ask: string) => /\bdone\b|complete|mark|patch|toggle|valid|empty title|known gaps?|400/i.test(ask);
