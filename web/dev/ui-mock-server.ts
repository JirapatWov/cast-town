// Dev-only mock of the RLT bridge for the UI harness. Speaks shared/protocol.ts with realistic fake data:
// two projects, a team of people, a streaming reply with tool cards, a workflow run waiting on an approval,
// a git diff, signed-in models/providers and a fake folder tree for fs_list.
// Run: bun run web/dev/ui-mock-server.ts   (ws://127.0.0.1:4962/ws)
import type { ServerWebSocket } from 'bun';
import { LOTS } from '../../shared/city-layout';
import type {
  AgentInfo, ApprovalRequest, ClientMsg, FsEntry, GitSummary, ModelInfo, Project, ProviderStatus,
  ServerMsg, TranscriptItem, Workflow, WorkflowRun,
} from '../../shared/protocol';

const PORT = Number(process.env.UI_MOCK_PORT ?? 4962);
const now = Date.now();
const sockets = new Set<ServerWebSocket<unknown>>();
const send = (ws: ServerWebSocket<unknown>, m: ServerMsg) => ws.send(JSON.stringify(m));
const broadcast = (m: ServerMsg) => sockets.forEach((ws) => send(ws, m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────── models / providers (all signed in) ─────────────
const models: ModelInfo[] = [
  { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', vendor: 'anthropic', available: true },
  { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', vendor: 'anthropic', available: true },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', vendor: 'openai', available: true },
  { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra', vendor: 'openai', available: true },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'deepseek', available: true },
  { id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash', vendor: 'deepseek', available: true },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', vendor: 'google', available: true },
];
const providers: ProviderStatus[] = [
  { vendor: 'anthropic', label: 'Anthropic', connected: true, how: 'export ANTHROPIC_API_KEY=… or `omp login anthropic`' },
  { vendor: 'openai', label: 'OpenAI', connected: true, how: 'export OPENAI_API_KEY=…' },
  { vendor: 'deepseek', label: 'DeepSeek', connected: true, how: 'export DEEPSEEK_API_KEY=…' },
  { vendor: 'google', label: 'Google', connected: true, how: 'export GEMINI_API_KEY=…' },
];

// ───────────── city ─────────────
const projects: Project[] = [
  { id: 'todo-api', name: 'todo-api', path: '/home/you/CAST/todo-api', lotId: 'A-N3', style: 'house', isGit: true, workflowId: 'decode-implement-review', approvalMode: 'write', createdAt: now - 86_400_000 },
  { id: 'moonlight-novel', name: 'moonlight-novel', path: '/home/you/CAST/moonlight-novel', lotId: 'C-E1', style: 'cottage', isGit: true, workflowId: 'novel', approvalMode: 'write', createdAt: now - 80_000_000 },
];
const city = () => ({ lots: LOTS, projects });

// ───────────── workflows ─────────────
const workflows: Workflow[] = [
  {
    id: 'decode-implement-review',
    name: 'Decode → Implement → Review',
    description: 'Opus plans, DeepSeek builds, GPT reviews and sends it back when needed.',
    icon: '🧩',
    steps: [
      { id: 'decoder', name: 'Decoder', model: 'anthropic/claude-opus-5-5', thinking: 'high', kind: 'work', persona: 'You are the Decoder. Analysis only: read code, trace behaviour, write a plan another engineer can follow without asking questions. Never edit source files.', instruction: 'Task:\n{{task}}\n\nWrite your plan to {{runDir}}/analysis.md with sections: Findings, Plan, Risks, How to verify.' },
      { id: 'implementer', name: 'Implementer', model: 'deepseek/deepseek-v4-pro', thinking: 'medium', kind: 'work', persona: 'You are the Implementer. Follow the plan exactly, keep changes small, add tests.', instruction: 'Implement this plan from {{prevName}}:\n\n{{prev}}\n\n{{feedback}}' },
      { id: 'reviewer', name: 'Reviewer', model: 'openai/gpt-6.1-sol', thinking: 'high', kind: 'review', loopBackTo: 'implementer', maxLoops: 2, persona: 'You are a strict reviewer from a different vendor than the implementer.', instruction: 'Review the diff against the task:\n{{task}}\n\nEnd with ```json {"verdict":"approve"|"revise","notes":"…"} ```' },
    ],
  },
  {
    id: 'novel',
    name: 'Novel: Idea → Write → Edit',
    description: 'Gemini pitches premises, Opus writes the chapter, GPT edits it.',
    icon: '📖',
    steps: [
      { id: 'idea-maker', name: 'Idea-maker', model: 'google/gemini-4-argon', thinking: 'medium', kind: 'work', persona: 'You pitch bold, distinct story concepts.', instruction: 'Pitch three premises for: {{task}}. Write them to {{runDir}}/ideas.md' },
      { id: 'writer', name: 'Writer', model: 'anthropic/claude-opus-5-5', thinking: 'low', kind: 'work', persona: 'You are a novelist writing vivid Thai prose.', instruction: 'Write chapter 1 from the strongest premise:\n\n{{prev}}\n\n{{feedback}}' },
      { id: 'editor', name: 'Editor', model: 'openai/gpt-6.1-sol', thinking: 'medium', kind: 'review', loopBackTo: 'writer', maxLoops: 2, persona: 'You are a demanding fiction editor fluent in Thai.', instruction: 'Edit chapters/chapter-01.md. End with the verdict JSON block.' },
    ],
  },
];

// ───────────── people ─────────────
let seed = 7;
function agent(projectId: string, roleId: string, name: string, model: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  const m = models.find((x) => x.id === model)!;
  seed = (seed * 9301 + 49297) % 233280;
  return {
    id: `${projectId}:${roleId}`, projectId, kind: roleId === 'assistant' ? 'resident' : 'role', name, roleId, model,
    modelLabel: m.label, vendor: m.vendor, demo: false, status: 'idle', activity: 'idle',
    appearance: { seed, gender: seed % 2 ? 'f' : 'm' }, ...extra,
  };
}
const agents = new Map<string, AgentInfo>();
const put = (a: AgentInfo) => {
  agents.set(a.id, a);
  return a;
};
put(agent('todo-api', 'assistant', 'Assistant', 'anthropic/claude-opus-5-5', { status: 'busy', activity: 'writing', detail: 'Explaining the project', tokens: { input: 18_400, output: 2_100 }, costUsd: 0.13 }));
put(agent('todo-api', 'decoder', 'Decoder', 'anthropic/claude-opus-5-5', { activity: 'done', tokens: { input: 31_200, output: 3_900 }, costUsd: 0.2 }));
put(agent('todo-api', 'implementer', 'Implementer', 'deepseek/deepseek-v4-pro', { status: 'busy', activity: 'waiting_approval', tool: 'bash', detail: 'Wants to run bun test', tokens: { input: 44_800, output: 6_300 }, costUsd: 0.09 }));
put(agent('todo-api', 'reviewer', 'Reviewer', 'openai/gpt-6.1-sol', { activity: 'idle', tokens: { input: 12_100, output: 900 }, costUsd: 0.05 }));
put({ ...agent('todo-api', 'sub:1', 'Explore helper', 'anthropic/claude-sonnet-5-5', { status: 'busy', activity: 'chore', detail: 'Reading test/todos.test.ts' }), kind: 'subagent', parentId: 'todo-api:assistant' });
put(agent('moonlight-novel', 'assistant', 'Assistant', 'google/gemini-4-argon', { costUsd: 0.02 }));
put(agent('moonlight-novel', 'writer', 'Writer', 'anthropic/claude-opus-5-5', { activity: 'idle', costUsd: 0.11 }));
put(agent('moonlight-novel', 'idea-maker', 'Idea-maker', 'google/gemini-4-argon'));
put(agent('moonlight-novel', 'editor', 'Editor', 'openai/gpt-6.1-sol'));

// ───────────── transcripts ─────────────
const ASSISTANT_REPLY = `**todo-api** is a tiny Bun HTTP server that keeps todos in memory. Three files do all the work:

- \`src/server.ts\` — routes \`GET /todos\` and \`POST /todos\` with \`Bun.serve\`
- \`src/todos.ts\` — the in-memory store (\`addTodo\`, \`listTodos\`)
- \`test/todos.test.ts\` — two happy-path tests

### What's missing

1. **No way to finish a todo.** There is no \`done\` field and no \`PATCH /todos/:id\` route.
2. **No input validation.** \`POST /todos\` accepts an empty or missing \`title\`:

\`\`\`ts
export function addTodo(title: string): Todo {
  const todo = { id: nextId++, title, createdAt: Date.now() };
  todos.push(todo);
  return todo;
}
\`\`\`

3. Errors return \`200\` with an empty body instead of a \`4xx\`.

> ถ้าต้องการ ผมให้ทีม Decode → Implement → Review แก้ทั้งสองข้อพร้อมเขียนเทสต์ได้เลยครับ

Want me to hand this to the workflow, or fix the validation myself?`;

const transcripts = new Map<string, TranscriptItem[]>();
transcripts.set('todo-api:assistant', [
  { kind: 'user', id: 'u1', text: 'What does this project do? Is anything obviously missing?', ts: now - 60_000 },
  { kind: 'assistant', id: 'a1', text: '', thinking: 'The user wants an overview. I should list the source files first, then read the store and the server to see which routes exist and how input is handled.', ts: now - 58_000 },
  { kind: 'tool', id: 't1', tool: 'find', title: 'find **/*.ts', args: { pattern: '**/*.ts' }, result: 'src/server.ts\nsrc/todos.ts\ntest/todos.test.ts', status: 'done', ts: now - 57_000 },
  { kind: 'tool', id: 't2', tool: 'read', title: 'read src/todos.ts', args: { path: 'src/todos.ts' }, result: 'export interface Todo {\n  id: number;\n  title: string;\n  createdAt: number;\n}\n\nconst todos: Todo[] = [];\nlet nextId = 1;\n…', status: 'done', ts: now - 56_000 },
  { kind: 'tool', id: 't3', tool: 'read', title: 'read src/server.ts', args: { path: 'src/server.ts' }, result: "Bun.serve({\n  port: 3000,\n  fetch(req) {\n    const url = new URL(req.url);\n    if (url.pathname === '/todos' && req.method === 'GET') …", status: 'done', ts: now - 55_000 },
  { kind: 'assistant', id: 'a2', text: '', streaming: true, ts: now - 54_000 },
]);
transcripts.set('todo-api:implementer', [
  { kind: 'user', id: 'iu1', text: 'Implement this plan from Decoder:\n\n1. Add `done: boolean` to Todo…\n\nReviewer asked for changes: Return 404 when the todo id does not exist, and add a test for it.', ts: now - 45_000 },
  { kind: 'tool', id: 'it1', tool: 'edit', title: 'edit src/server.ts', args: { path: 'src/server.ts' }, result: 'Applied 1 edit (+6 −1)', status: 'done', ts: now - 30_000 },
  { kind: 'tool', id: 'it2', tool: 'edit', title: 'edit test/todos.test.ts', args: { path: 'test/todos.test.ts' }, result: 'Applied 1 edit (+9)', status: 'done', ts: now - 20_000 },
  { kind: 'tool', id: 'it3', tool: 'bash', title: 'bun test test/todos.test.ts', args: { command: 'bun test test/todos.test.ts' }, status: 'running', ts: now - 8_000 },
]);
transcripts.set('todo-api:decoder', [
  { kind: 'user', id: 'du1', text: 'Task:\nAdd a way to mark todos as done (PATCH /todos/:id) and reject empty titles with a 400. Cover both with tests.', ts: now - 250_000 },
  { kind: 'assistant', id: 'da1', text: '## Findings\n- `src/todos.ts` has no `done` field.\n- `POST /todos` never validates `title`.\n\n## Plan\n1. Add `done: boolean` and `markDone(id)` to `src/todos.ts`.\n2. Add a `ValidationError` and reject empty titles.\n3. Route `PATCH /todos/:id` in `src/server.ts`.\n4. Tests for both in `test/todos.test.ts`.', thinking: 'Reading the store first, then the server routes.', ts: now - 190_000 },
]);

const approvals = new Map<string, ApprovalRequest>();
approvals.set('ap-1', {
  id: 'ap-1', agentId: 'todo-api:implementer', projectId: 'todo-api', tool: 'bash', title: 'Allow tool: bash',
  detail: 'Command: bun test test/todos.test.ts', options: ['Approve', 'Approve bash for this session', 'Deny'], ts: now - 8_000,
});

approvals.set('ap-2', {
  id: 'ap-2', agentId: 'moonlight-novel:writer', projectId: 'moonlight-novel', tool: 'write', title: 'Allow tool: write',
  detail: 'Path: chapters/chapter-01.md', options: ['Approve', 'Approve write for this session', 'Deny'], ts: now - 3_000,
});
agents.set('moonlight-novel:writer', { ...agents.get('moonlight-novel:writer')!, status: 'busy', activity: 'waiting_approval', tool: 'write', detail: 'Wants to write chapters/chapter-01.md' });

// ───────────── runs ─────────────
const runs = new Map<string, WorkflowRun>();
runs.set('run-1', {
  id: 'run-1', workflowId: 'decode-implement-review', workflowName: 'Decode → Implement → Review', projectId: 'todo-api',
  task: 'Add a way to mark todos as done (PATCH /todos/:id) and reject empty titles with a 400. Cover both with tests.',
  status: 'waiting_approval', currentStepId: 'implementer', loop: 1, checkpoint: 'refs/rlt/checkpoints/run-1',
  startedAt: now - 252_000, costUsd: 0.34,
  steps: [
    { stepId: 'decoder', status: 'done', agentId: 'todo-api:decoder', startedAt: now - 252_000, endedAt: now - 190_000, output: '## Findings\n- `src/todos.ts` has no `done` field and `addTodo` accepts any title.\n- `src/server.ts` only routes `GET` and `POST /todos`.\n\n## Plan\n1. Add `done: boolean` and `markDone(id)` to `src/todos.ts`.\n2. Throw `ValidationError` for empty titles; map it to `400`.\n3. Route `PATCH /todos/:id` → `markDone`.\n4. Tests for both paths.' },
    { stepId: 'implementer', status: 'done', agentId: 'todo-api:implementer', startedAt: now - 188_000, endedAt: now - 101_000, output: 'Added `done`, `markDone()`, `ValidationError` and the `PATCH /todos/:id` route. Two new tests pass locally.' },
    { stepId: 'reviewer', status: 'done', agentId: 'todo-api:reviewer', verdict: 'revise', startedAt: now - 99_000, endedAt: now - 47_000, output: 'Validation looks right and the tests are clear. One gap: `PATCH /todos/999` returns `200` with `null`.\n\n```json\n{"verdict":"revise","notes":"Return 404 when the todo id does not exist, and add a test for it."}\n```' },
    { stepId: 'implementer', status: 'running', agentId: 'todo-api:implementer', startedAt: now - 45_000 },
  ],
});

// ───────────── git ─────────────
const DIFF = `diff --git a/src/todos.ts b/src/todos.ts
index 3b18e51..a4c9f02 100644
--- a/src/todos.ts
+++ b/src/todos.ts
@@ -1,18 +1,33 @@
 export interface Todo {
   id: number;
   title: string;
+  done: boolean;
   createdAt: number;
 }

 const todos: Todo[] = [];
 let nextId = 1;

-export function addTodo(title: string): Todo {
-  const todo = { id: nextId++, title, createdAt: Date.now() };
+export class ValidationError extends Error {}
+
+export function addTodo(title: unknown): Todo {
+  if (typeof title !== 'string' || title.trim() === '') {
+    throw new ValidationError('title must be a non-empty string');
+  }
+  const todo: Todo = { id: nextId++, title: title.trim(), done: false, createdAt: Date.now() };
   todos.push(todo);
   return todo;
 }

 export function listTodos(): Todo[] {
   return [...todos];
 }
+
+export function markDone(id: number): Todo | undefined {
+  const todo = todos.find((t) => t.id === id);
+  if (todo) todo.done = true;
+  return todo;
+}
diff --git a/src/server.ts b/src/server.ts
index 77ac0d2..5e1b9a4 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,4 +1,4 @@
-import { addTodo, listTodos } from './todos';
+import { addTodo, listTodos, markDone, ValidationError } from './todos';

 Bun.serve({
   port: 3000,
@@ -8,10 +8,25 @@ Bun.serve({
     if (url.pathname === '/todos' && req.method === 'GET') {
       return Response.json(listTodos());
     }
     if (url.pathname === '/todos' && req.method === 'POST') {
       const body = await req.json().catch(() => ({}));
-      return Response.json(addTodo(body.title));
+      try {
+        return Response.json(addTodo(body.title), { status: 201 });
+      } catch (err) {
+        if (err instanceof ValidationError) return Response.json({ error: err.message }, { status: 400 });
+        throw err;
+      }
+    }
+    const match = url.pathname.match(/^\\/todos\\/(\\d+)$/);
+    if (match && req.method === 'PATCH') {
+      const todo = markDone(Number(match[1]));
+      return todo ? Response.json(todo) : Response.json({ error: 'not found' }, { status: 404 });
     }
     return new Response('Not found', { status: 404 });
   },
 });
diff --git a/test/todos.test.ts b/test/todos.test.ts
index 1c2d3e4..9f8e7d6 100644
--- a/test/todos.test.ts
+++ b/test/todos.test.ts
@@ -1,4 +1,4 @@
-import { addTodo, listTodos } from '../src/todos';
+import { addTodo, listTodos, markDone, ValidationError } from '../src/todos';
 import { expect, test } from 'bun:test';

 test('adds a todo', () => {
@@ -10,3 +10,17 @@ test('lists todos', () => {
   addTodo('second');
   expect(listTodos().length).toBeGreaterThan(1);
 });
+
+test('rejects an empty title', () => {
+  expect(() => addTodo('   ')).toThrow(ValidationError);
+});
+
+test('marks a todo as done', () => {
+  const todo = addTodo('ship it');
+  expect(markDone(todo.id)?.done).toBe(true);
+});
+
+test('returns undefined for an unknown id', () => {
+  expect(markDone(9999)).toBeUndefined();
+});
diff --git a/README.md b/README.md
index 0a1b2c3..4d5e6f7 100644
--- a/README.md
+++ b/README.md
@@ -6,3 +6,5 @@ bun run src/server.ts

 - \`GET /todos\` — list todos
 - \`POST /todos\` — create a todo \`{ "title": "…" }\`
+- \`PATCH /todos/:id\` — mark a todo as done
+- Empty titles are rejected with \`400\`
`;
const git = new Map<string, GitSummary>();
git.set('todo-api', {
  projectId: 'todo-api', isGit: true, branch: 'main', diff: DIFF, ts: now,
  files: [
    { path: 'src/todos.ts', status: 'M', additions: 16, deletions: 2 },
    { path: 'src/server.ts', status: 'M', additions: 16, deletions: 2 },
    { path: 'test/todos.test.ts', status: 'M', additions: 15, deletions: 1 },
    { path: 'README.md', status: 'M', additions: 2, deletions: 0 },
  ],
});
git.set('moonlight-novel', { projectId: 'moonlight-novel', isGit: true, branch: 'main', diff: '', ts: now, files: [] });

// ───────────── fs tree ─────────────
const TREE: Record<string, FsEntry[]> = {
  '/home/you': [
    { name: 'notes', isDir: true }, { name: 'projects', isDir: true }, { name: 'CAST', isDir: true }, { name: 'readme.txt', isDir: false },
  ],
  '/home/you/projects': [
    { name: 'blog-engine', isDir: true, isGit: true }, { name: 'design-system', isDir: true, isGit: true },
    { name: 'rust-cli', isDir: true, isGit: true }, { name: 'scratch', isDir: true }, { name: 'ข้อมูลลูกค้า', isDir: true },
  ],
  '/home/you/CAST': [{ name: 'moonlight-novel', isDir: true, isGit: true }, { name: 'todo-api', isDir: true, isGit: true }],
  '/home/you/notes': [{ name: 'journal.md', isDir: false }],
};
function fsList(path: string): { path: string; parent: string | null; entries: FsEntry[]; error?: string } {
  const clean = path.replace(/\/+$/, '') || '/';
  if (!clean.startsWith('/home/you')) return { path: clean, parent: null, entries: [], error: 'Only folders under /home/you can be placed.' };
  const parent = clean === '/home/you' ? null : clean.slice(0, clean.lastIndexOf('/')) || '/';
  const entries = TREE[clean] ?? [{ name: 'src', isDir: true }, { name: 'docs', isDir: true }, { name: 'package.json', isDir: false }];
  return { path: clean, parent, entries };
}

// ───────────── behaviours ─────────────
function setAgent(id: string, patch: Partial<AgentInfo>) {
  const a = agents.get(id);
  if (!a) return;
  const next = { ...a, ...patch };
  agents.set(id, next);
  broadcast({ t: 'agent', agent: next });
}
function upsert(agentId: string, item: TranscriptItem) {
  const list = transcripts.get(agentId) ?? [];
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
  transcripts.set(agentId, list);
  broadcast({ t: 'transcript_upsert', agentId, item });
}
async function stream(agentId: string, id: string, text: string, opts: { thinking?: string; cps?: number } = {}) {
  const cps = opts.cps ?? 55;
  let shown = 0;
  const ts = Date.now();
  while (shown < text.length) {
    shown = Math.min(text.length, shown + Math.max(2, Math.round(cps / 10 + (Math.random() - 0.5) * 4)));
    upsert(agentId, { kind: 'assistant', id, text: text.slice(0, shown), thinking: opts.thinking, streaming: shown < text.length, ts });
    await sleep(100);
  }
}

// The opening reply replays every time a client loads the Assistant's transcript, so each visit (and each
// screenshot) sees it stream in.
let assistantStreaming = false;
async function streamInitialAssistant() {
  if (assistantStreaming) return;
  assistantStreaming = true;
  upsert('todo-api:assistant', { kind: 'assistant', id: 'a2', text: '', streaming: true, ts: Date.now() });
  setAgent('todo-api:assistant', { status: 'busy', activity: 'writing', detail: 'Explaining the project' });
  await stream('todo-api:assistant', 'a2', ASSISTANT_REPLY, { cps: 90 });
  setAgent('todo-api:assistant', { status: 'idle', activity: 'done', detail: undefined, costUsd: 0.16 });
  assistantStreaming = false;
}

let replyN = 0;
async function scriptedReply(agentId: string, text: string) {
  const a = agents.get(agentId);
  if (!a) return;
  const n = ++replyN;
  upsert(agentId, { kind: 'user', id: `pu${n}`, text, ts: Date.now() });
  setAgent(agentId, { status: 'busy', activity: 'listening', detail: undefined });
  await sleep(900);
  setAgent(agentId, { activity: 'thinking' });
  const thinking = `They asked: "${text.slice(0, 80)}". I'll look at the relevant file before answering.`;
  upsert(agentId, { kind: 'assistant', id: `pa${n}`, text: '', thinking, streaming: true, ts: Date.now() });
  await sleep(1200);
  setAgent(agentId, { activity: 'reading', tool: 'read', detail: 'Reading src/todos.ts' });
  upsert(agentId, { kind: 'tool', id: `pt${n}`, tool: 'read', title: 'read src/todos.ts', args: { path: 'src/todos.ts' }, status: 'running', ts: Date.now() });
  await sleep(1300);
  upsert(agentId, { kind: 'tool', id: `pt${n}`, tool: 'read', title: 'read src/todos.ts', args: { path: 'src/todos.ts' }, result: 'export interface Todo { … }\n(42 lines)', status: 'done', ts: Date.now() });
  setAgent(agentId, { activity: 'writing', tool: undefined, detail: 'Writing a reply' });
  upsert(agentId, { kind: 'assistant', id: `pa${n}`, text: '', thinking, streaming: false, ts: Date.now() });
  await stream(agentId, `pr${n}`, `Sure — I checked \`src/todos.ts\`.\n\n- The store lives in a plain array, so restarting the server clears it.\n- Adding a \`done\` flag is a two-line change plus a route.\n\nShall I go ahead?`);
  setAgent(agentId, { status: 'idle', activity: 'done', detail: undefined, costUsd: (a.costUsd ?? 0) + 0.02 });
  await sleep(4000);
  setAgent(agentId, { activity: 'idle' });
}

function upsertRun(run: WorkflowRun) {
  runs.set(run.id, run);
  broadcast({ t: 'run', run });
}

async function finishCurrentRun() {
  // Called after the approval: implementer finishes, reviewer approves, run completes.
  const run = runs.get('run-1');
  if (!run || run.status === 'aborted') return;
  upsert('todo-api:implementer', { kind: 'tool', id: 'it3', tool: 'bash', title: 'bun test test/todos.test.ts', args: { command: 'bun test test/todos.test.ts' }, result: ' 5 pass\n 0 fail\nRan 5 tests across 1 file. [41.00ms]', status: 'done', ts: Date.now() });
  setAgent('todo-api:implementer', { activity: 'writing', detail: 'Writing a summary', tool: undefined });
  upsertRun({ ...run, status: 'running' });
  await sleep(2500);
  const t = Date.now();
  run.steps[3] = { ...run.steps[3], status: 'done', endedAt: t, output: 'PATCH now returns 404 for unknown ids; added a test. All 5 tests pass.' };
  setAgent('todo-api:implementer', { status: 'idle', activity: 'done', detail: undefined });
  broadcast({ t: 'handoff', projectId: 'todo-api', fromAgentId: 'todo-api:implementer', toAgentId: 'todo-api:reviewer', label: 'changes' });
  run.steps.push({ stepId: 'reviewer', status: 'running', agentId: 'todo-api:reviewer', startedAt: t });
  upsertRun({ ...run, status: 'running', currentStepId: 'reviewer', costUsd: 0.39 });
  setAgent('todo-api:reviewer', { status: 'busy', activity: 'reading', detail: 'Reading the diff' });
  await sleep(4000);
  run.steps[4] = { ...run.steps[4], status: 'done', verdict: 'approve', endedAt: Date.now(), output: 'All requested changes are in and covered by tests.\n\n```json\n{"verdict":"approve","notes":"Ship it."}\n```' };
  setAgent('todo-api:reviewer', { status: 'idle', activity: 'done', detail: undefined, costUsd: 0.08 });
  upsertRun({ ...run, status: 'completed', currentStepId: null, endedAt: Date.now(), costUsd: 0.42 });
  broadcast({ t: 'toast', level: 'success', text: 'todo-api: Decode → Implement → Review finished — reviewer approved', projectId: 'todo-api' });
}

async function newRun(projectId: string, workflowId: string, task: string) {
  const wf = workflows.find((w) => w.id === workflowId)!;
  const id = `run-${Date.now().toString(36)}`;
  const run: WorkflowRun = { id, workflowId, workflowName: wf.name, projectId, task, status: 'running', currentStepId: wf.steps[0].id, loop: 0, steps: [], checkpoint: `refs/rlt/checkpoints/${id}`, startedAt: Date.now(), costUsd: 0 };
  for (const step of wf.steps) {
    const agentId = `${projectId}:${step.id}`;
    if (!agents.has(agentId)) put(agent(projectId, step.id, step.name, step.model));
    if (runs.get(id)?.status === 'aborted') return;
    run.steps.push({ stepId: step.id, status: 'running', agentId, startedAt: Date.now() });
    run.currentStepId = step.id;
    upsertRun({ ...run });
    setAgent(agentId, { status: 'busy', activity: step.kind === 'review' ? 'reading' : 'writing', detail: step.kind === 'review' ? 'Reviewing the diff' : 'Working on the task' });
    await sleep(3500);
    if (runs.get(id)?.status === 'aborted') return;
    const last = run.steps[run.steps.length - 1];
    last.status = 'done';
    last.endedAt = Date.now();
    last.output = step.kind === 'review' ? 'Looks good.\n\n```json\n{"verdict":"approve","notes":"Clean change."}\n```' : `Finished my part of: ${task}`;
    if (step.kind === 'review') last.verdict = 'approve';
    run.costUsd += 0.07;
    setAgent(agentId, { status: 'idle', activity: 'done', detail: undefined });
  }
  upsertRun({ ...run, status: 'completed', currentStepId: null, endedAt: Date.now() });
  broadcast({ t: 'toast', level: 'success', text: `${projects.find((p) => p.id === projectId)?.name}: ${wf.name} finished`, projectId });
}

function handle(ws: ServerWebSocket<unknown>, msg: ClientMsg) {
  const ack = (reqId: string, data?: unknown) => send(ws, { t: 'ack', reqId, ok: true, data });
  switch (msg.t) {
    case 'get_transcript':
      send(ws, { t: 'transcript_reset', agentId: msg.agentId, items: transcripts.get(msg.agentId) ?? [] });
      if (msg.agentId === 'todo-api:assistant') void streamInitialAssistant();
      break;
    case 'prompt':
      void scriptedReply(msg.agentId, msg.text);
      break;
    case 'abort':
      setAgent(msg.agentId, { status: 'idle', activity: 'idle', detail: undefined });
      broadcast({ t: 'toast', level: 'info', text: 'Stopped' });
      break;
    case 'approve': {
      const ap = approvals.get(msg.approvalId);
      approvals.delete(msg.approvalId);
      broadcast({ t: 'approval_resolved', id: msg.approvalId });
      if (ap?.id === 'ap-1') {
        if (/deny/i.test(msg.value)) {
          setAgent(ap.agentId, { activity: 'thinking', detail: 'Approval denied — rethinking' });
          upsertRun({ ...runs.get('run-1')!, status: 'running' });
        } else void finishCurrentRun();
      }
      break;
    }
    case 'run_workflow':
      ack(msg.reqId);
      void newRun(msg.projectId, msg.workflowId, msg.task);
      break;
    case 'abort_run': {
      const run = runs.get(msg.runId);
      if (run) {
        upsertRun({ ...run, status: 'aborted', endedAt: Date.now(), steps: run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed', endedAt: Date.now() } : s)) });
        broadcast({ t: 'toast', level: 'info', text: `Stopped ${run.workflowName}`, projectId: run.projectId });
      }
      break;
    }
    case 'revert_run':
      setTimeout(() => ack(msg.reqId), 600);
      break;
    case 'save_workflow': {
      const i = workflows.findIndex((w) => w.id === msg.workflow.id);
      if (i >= 0) workflows[i] = msg.workflow;
      else workflows.push(msg.workflow);
      broadcast({ t: 'workflows', workflows });
      ack(msg.reqId);
      break;
    }
    case 'get_git': {
      const g = git.get(msg.projectId);
      if (g) send(ws, { t: 'git', summary: { ...g, ts: Date.now() } });
      break;
    }
    case 'fs_list': {
      const r = fsList(msg.path);
      setTimeout(() => send(ws, { t: 'fs_list', reqId: msg.reqId, ...r }), 120);
      break;
    }
    case 'place_project':
    case 'create_project': {
      if (projects.some((p) => p.lotId === msg.lotId)) {
        send(ws, { t: 'ack', reqId: msg.reqId, ok: false, error: 'That lot already has a building.' });
        break;
      }
      const name = msg.name;
      const p: Project = {
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, lotId: msg.lotId, style: msg.style, isGit: true,
        path: msg.t === 'place_project' ? msg.path : `/home/you/CAST/${name}`, workflowId: 'decode-implement-review', approvalMode: 'write', createdAt: Date.now(),
      };
      projects.push(p);
      put(agent(p.id, 'assistant', 'Assistant', 'anthropic/claude-opus-5-5'));
      broadcast({ t: 'city', city: city() });
      broadcast({ t: 'agent', agent: agents.get(`${p.id}:assistant`)! });
      setTimeout(() => ack(msg.reqId, p), 400);
      break;
    }
    case 'refresh_models':
      setTimeout(() => {
        broadcast({ t: 'models', models, providers });
        broadcast({ t: 'toast', level: 'info', text: 'No new sign-ins found.' });
      }, 900);
      break;
    case 'enter_project':
    case 'move_project':
    case 'remove_project':
    case 'set_project':
      if ('reqId' in msg) ack(msg.reqId);
      break;
  }
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, server) {
    if (new URL(req.url).pathname === '/ws' && server.upgrade(req)) return;
    return new Response('CAST UI mock — connect to /ws', { status: 200 });
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      send(ws, { t: 'hello', serverVersion: '0.1.0-mock', ompVersion: '18.13.2', ompTested: '18.13.2', user: 'local', demoMode: false, workspaceRoot: '/home/you/CAST' });
      send(ws, {
        t: 'snapshot', city: city(), agents: [...agents.values()], workflows, runs: [...runs.values()],
        approvals: [...approvals.values()], models, providers,
      });
      for (const g of git.values()) send(ws, { t: 'git', summary: g });
    },
    message(ws, raw) {
      try {
        handle(ws, JSON.parse(String(raw)) as ClientMsg);
      } catch (err) {
        send(ws, { t: 'error', message: `bad message: ${(err as Error).message}` });
      }
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
});
console.log(`[ui-mock] ws://127.0.0.1:${PORT}/ws`);
