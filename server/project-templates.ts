// Starter content for `create_project` (empty / node-api / novel) and a helper to write a file map to disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type TemplateId = 'empty' | 'node-api' | 'novel';
export type FileMap = Record<string, string>;

const GITIGNORE = `node_modules/
dist/
.env
.env.*
*.log
.DS_Store
`;

function emptyTemplate(name: string): FileMap {
  return {
    'README.md': `# ${name}

A fresh project, created with CAST.

Click the Assistant in the house and tell it what you want to build.
`,
    '.gitignore': GITIGNORE,
  };
}

function nodeApiTemplate(name: string, slug: string): FileMap {
  return {
    'README.md': `# ${name}

A tiny HTTP API that runs on [Bun](https://bun.sh) with no dependencies.

\`\`\`bash
bun run start   # http://localhost:3000
bun test
\`\`\`

## Endpoints

| Method | Path      | Description          |
|--------|-----------|----------------------|
| GET    | /health   | liveness check       |
| GET    | /hello    | \`?name=\` greeting    |
`,
    'package.json': JSON.stringify(
      {
        name: slug,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { start: 'bun run src/server.ts', dev: 'bun --watch src/server.ts', test: 'bun test' },
      },
      null,
      2,
    ) + '\n',
    'src/server.ts': `// HTTP entry point. \`handle\` is a plain fetch handler so it is easy to test without a socket.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export function handle(req: Request): Response {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true });
  if (req.method === 'GET' && url.pathname === '/hello') {
    const name = url.searchParams.get('name') ?? 'world';
    return json({ message: \`Hello, \${name}!\` });
  }
  return json({ error: 'Not found' }, 404);
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: handle });
  console.log(\`Listening on http://localhost:\${port}\`);
}
`,
    'src/server.test.ts': `import { describe, expect, test } from 'bun:test';
import { handle } from './server';

const get = (path: string) => handle(new Request(\`http://test\${path}\`));

describe(${JSON.stringify(name)}, () => {
  test('health check', async () => {
    const res = get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('greets by name', async () => {
    expect(await get('/hello?name=Ada').json()).toEqual({ message: 'Hello, Ada!' });
  });

  test('unknown routes are 404', () => {
    expect(get('/nope').status).toBe(404);
  });
});
`,
    '.gitignore': GITIGNORE,
  };
}

function novelTemplate(name: string): FileMap {
  return {
    'README.md': `# ${name}

> One line that makes someone want to read this book.

## Premise

Who wants what, what stands in the way, and why it matters — in a short paragraph.

## Files

- \`outline.md\` — the shape of the story, chapter by chapter
- \`characters.md\` — who lives in it
- \`chapters/\` — the manuscript, one file per chapter
`,
    'outline.md': `# Outline

## Act I — Setup
1.

## Act II — Confrontation
2.

## Act III — Resolution
3.
`,
    'characters.md': `# Characters

## Protagonist
- **Name:**
- **Wants:**
- **Needs:**
- **Flaw:**
`,
    'chapters/.gitkeep': '',
    '.gitignore': '.DS_Store\n',
  };
}

export function templateFiles(template: TemplateId, name: string, slug: string): FileMap {
  if (template === 'node-api') return nodeApiTemplate(name, slug);
  if (template === 'novel') return novelTemplate(name);
  return emptyTemplate(name);
}

export function writeFiles(root: string, files: FileMap): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}
