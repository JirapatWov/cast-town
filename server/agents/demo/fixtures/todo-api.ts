// Scripted-model test fixture (CAST_MOCK_LLM, tests only — CAST never creates it): a tiny, realistic Bun HTTP API
// with tests and two obvious gaps (no way to mark a todo done, no title validation) that the scripted Decode →
// Implement → Review team fixes (todo-patch.ts).
import type { FileMap } from '../../../project-templates';

const README = `# todo-api

A tiny todo-list HTTP API — Bun + TypeScript, zero dependencies. Todos live in memory, so restarting the
server gives you a clean slate.

## Run it

\`\`\`bash
bun run start      # http://localhost:3000
bun run dev        # same, restarts on save
bun test
\`\`\`

## Endpoints

| Method | Path          | Description                              |
|--------|---------------|------------------------------------------|
| GET    | \`/health\`     | Liveness check → \`{ "ok": true }\`          |
| GET    | \`/todos\`      | List all todos (oldest first)            |
| POST   | \`/todos\`      | Create a todo — body \`{ "title": "…" }\`   |
| GET    | \`/todos/:id\`  | Fetch one todo                           |
| DELETE | \`/todos/:id\`  | Delete a todo                            |

A todo looks like this:

\`\`\`json
{ "id": 1, "title": "Buy jasmine rice", "done": false, "createdAt": "2026-10-27T08:30:00.000Z" }
\`\`\`

## Try it

\`\`\`bash
curl -s localhost:3000/todos
curl -s -X POST localhost:3000/todos -H 'content-type: application/json' -d '{"title":"Water the basil"}'
curl -s -X DELETE localhost:3000/todos/1 -i
\`\`\`

## Known gaps

- [ ] **You can't mark a todo as done.** \`done\` is always \`false\`; there is no \`PATCH /todos/:id\` yet.
- [ ] **No input validation.** \`POST /todos\` happily accepts an empty or missing \`title\` (and non-JSON bodies).
- [ ] Persistence — everything is in memory (fine for now).
`;

const PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'todo-api',
      version: '0.3.0',
      description: 'A tiny todo-list HTTP API on Bun',
      private: true,
      type: 'module',
      scripts: {
        start: 'bun run src/server.ts',
        dev: 'bun --watch src/server.ts',
        test: 'bun test',
      },
    },
    null,
    2,
  ) + '\n';

const TODOS_TS = `// In-memory todo store. Deliberately small: the HTTP layer lives in server.ts.

export interface Todo {
  id: number;
  title: string;
  done: boolean;
  createdAt: string; // ISO-8601
}

export class TodoStore {
  private todos = new Map<number, Todo>();
  private nextId = 1;

  list(): Todo[] {
    return [...this.todos.values()];
  }

  get(id: number): Todo | undefined {
    return this.todos.get(id);
  }

  create(title: string): Todo {
    const todo: Todo = { id: this.nextId++, title, done: false, createdAt: new Date().toISOString() };
    this.todos.set(todo.id, todo);
    return todo;
  }

  remove(id: number): boolean {
    return this.todos.delete(id);
  }
}

/** A few friendly todos so the API isn't empty on first run. */
export function seedTodos(store: TodoStore): void {
  store.create('Buy jasmine rice');
  store.create('Water the basil on the balcony');
  store.create('Call grandma on Sunday');
}
`;

const SERVER_TS = `// HTTP layer for the todo API. \`createApp\` returns a plain fetch handler, so tests can call it
// directly without opening a socket.
import { seedTodos, TodoStore } from './todos';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const notFound = (what = 'Not found') => json({ error: what }, 404);
const methodNotAllowed = () => json({ error: 'Method not allowed' }, 405);

export function createApp(store = new TodoStore()) {
  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === '/health') return json({ ok: true });

    const [resource, rawId, ...rest] = pathname.split('/').filter(Boolean);
    if (resource !== 'todos' || rest.length > 0) return notFound();

    // /todos
    if (rawId === undefined) {
      if (req.method === 'GET') return json(store.list());
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { title?: string };
        const todo = store.create(body.title as string); // no validation yet
        return json(todo, 201);
      }
      return methodNotAllowed();
    }

    // /todos/:id
    const id = Number(rawId);
    const todo = Number.isInteger(id) ? store.get(id) : undefined;
    if (!todo) return notFound('Todo not found');
    if (req.method === 'GET') return json(todo);
    if (req.method === 'DELETE') {
      store.remove(id);
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed();
  };
}

if (import.meta.main) {
  const store = new TodoStore();
  seedTodos(store);
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: createApp(store) });
  console.log(\`todo-api listening on http://localhost:\${port}\`);
}
`;

const TEST_TS = `import { describe, expect, test } from 'bun:test';
import { createApp } from './server';
import { TodoStore } from './todos';

function setup() {
  const store = new TodoStore();
  const app = createApp(store);
  const call = (method: string, path: string, body?: unknown) =>
    app(
      new Request(\`http://todo.test\${path}\`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { store, call };
}

describe('todo-api', () => {
  test('GET /health', async () => {
    const { call } = setup();
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('creates a todo and lists it', async () => {
    const { call } = setup();
    const created = await call('POST', '/todos', { title: 'Buy jasmine rice' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 1, title: 'Buy jasmine rice', done: false });

    const list = await (await call('GET', '/todos')).json();
    expect(list).toHaveLength(1);
  });

  test('fetches a single todo', async () => {
    const { store, call } = setup();
    const todo = store.create('Water the basil');
    const res = await call('GET', \`/todos/\${todo.id}\`);
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('Water the basil');
  });

  test('deletes a todo', async () => {
    const { store, call } = setup();
    const todo = store.create('Call grandma');
    expect((await call('DELETE', \`/todos/\${todo.id}\`)).status).toBe(204);
    expect(store.list()).toHaveLength(0);
  });

  test('unknown todo is a 404', async () => {
    const { call } = setup();
    expect((await call('GET', '/todos/42')).status).toBe(404);
  });

  test.todo('PATCH /todos/:id marks a todo as done');
  test.todo('POST /todos rejects an empty title with 400');
});
`;

const GITIGNORE = `node_modules/
.env
*.log
.DS_Store
`;

export const TODO_API_FILES: FileMap = {
  'README.md': README,
  'package.json': PACKAGE_JSON,
  'src/todos.ts': TODOS_TS,
  'src/server.ts': SERVER_TS,
  'src/todos.test.ts': TEST_TS,
  '.gitignore': GITIGNORE,
};
