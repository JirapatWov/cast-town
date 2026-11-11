// Turn what is on disk into short, specific prose for demo replies (project overviews, file notes, review
// findings). Everything here reads the real files, so the demo talks about the project the user opened.
import {
  classMethods,
  documentedRoutes,
  entryFile,
  exportsOf,
  firstParagraph,
  headings,
  isCode,
  isTest,
  lineCount,
  lineOf,
  listFiles,
  mdTitle,
  readText,
  testNames,
  type ProjectFile,
} from './project-scan';

export type ProjectKind = 'code' | 'novel' | 'docs' | 'empty';

export interface ProjectView {
  cwd: string;
  files: ProjectFile[];
  kind: ProjectKind;
  name: string;
  readme: string | null;
  /** Files worth opening first for this kind of project (≤3). */
  keyFiles: string[];
}

const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

export function viewProject(cwd: string): ProjectView {
  const files = listFiles(cwd);
  const readme = readText(cwd, files.find((f) => /^readme\.md$/i.test(f.path))?.path ?? 'README.md');
  const name = mdTitle(readme ?? '') ?? cwd.split('/').filter(Boolean).at(-1) ?? 'this project';
  const md = files.filter((f) => f.path.endsWith('.md'));
  const code = files.filter((f) => isCode(f.path));
  let kind: ProjectKind = 'empty';
  if (files.some((f) => f.path.startsWith('chapters/')) || (md.some((f) => /outline|characters/i.test(f.path)) && code.length === 0)) kind = 'novel';
  else if (code.length) kind = 'code';
  else if (files.length) kind = 'docs';

  const keyFiles: string[] = [];
  const push = (p?: string) => p && !keyFiles.includes(p) && keyFiles.length < 3 && keyFiles.push(p);
  if (kind === 'code') {
    push(entryFile(files));
    push(code.find((f) => !isTest(f.path) && f.path !== keyFiles[0])?.path);
    push(code.find((f) => isTest(f.path))?.path);
  } else if (kind === 'novel') {
    for (const p of ['outline.md', 'characters.md', 'style-guide.md']) if (files.some((f) => f.path === p)) push(p);
  } else {
    for (const f of md) push(f.path);
  }
  return { cwd, files, kind, name, readme, keyFiles };
}

/** Unchecked "- [ ]" items of the README (known gaps / status). */
export function openItems(md: string | null): string[] {
  // "- [ ] **You can't mark a todo as done.** `done` is always…" → the bold headline when there is one.
  return [...(md ?? '').matchAll(/^- \[ \]\s+(.+)$/gm)].map((m) => plain(m[1].match(/^\*\*(.+?)\*\*/)?.[1] ?? m[1]));
}

/** One bullet per file: what it is, from its contents. */
export function fileNote(cwd: string, path: string): string {
  const text = readText(cwd, path);
  if (text === null) return `\`${path}\``;
  const n = lineCount(text);
  if (isTest(path)) {
    const t = testNames(text);
    const todo = t.todo.length ? `, plus ${t.todo.length} \`test.todo\` placeholder${t.todo.length === 1 ? '' : 's'} (${t.todo.map((s) => `"${s}"`).join(', ')})` : '';
    return `\`${path}\` (${n} lines) — ${t.done.length} test${t.done.length === 1 ? '' : 's'}${todo}`;
  }
  if (isCode(path)) {
    const ex = exportsOf(text);
    const classes = [...text.matchAll(/class\s+(\w+)/g)].map((m) => m[1]);
    const cls = classes.map((c) => {
      const m = classMethods(text, c);
      return m.length ? `\`${c}\` (${m.join(' / ')})` : `\`${c}\``;
    });
    const rest = ex.filter((e) => !classes.includes(e)).map((e) => `\`${e}\``);
    const what = [...cls, ...rest].slice(0, 5).join(', ');
    return `\`${path}\` (${n} lines)${what ? ` — ${what}` : ''}`;
  }
  if (path.endsWith('.md')) {
    const title = mdTitle(text);
    return `\`${path}\` (${n} lines)${title ? ` — "${title}"` : ''}`;
  }
  return `\`${path}\` (${n} lines)`;
}

export function codeOverview(v: ProjectView): string {
  const intro = firstParagraph(v.readme ?? '');
  const pkg = readText(v.cwd, 'package.json');
  let stack = '';
  try {
    const p = pkg ? (JSON.parse(pkg) as { scripts?: Record<string, string>; dependencies?: Record<string, string> }) : null;
    if (p?.scripts?.test) stack = ` Tests run with \`${p.scripts.test}\`.`;
  } catch {
    /* not JSON */
  }
  const routes = documentedRoutes(v.readme ?? '');
  const gaps = openItems(v.readme);
  const lines = [
    `**${v.name}** — ${intro ? plain(intro) : `${v.files.length} files, mostly ${v.files.filter((f) => isCode(f.path)).length ? 'code' : 'docs'}.`}${stack}`,
    '',
    ...v.keyFiles.map((p) => `- ${fileNote(v.cwd, p)}`),
  ];
  if (routes.length) lines.push('', `Routes in the README: ${routes.map((r) => `\`${r}\``).join(', ')}.`);
  if (gaps.length) lines.push('', `Known gaps it lists: ${gaps.map((g) => g.replace(/\.$/, '')).join('; ')}.`);
  return lines.join('\n');
}

export function novelOverview(v: ProjectView): string {
  const chars = headings(readText(v.cwd, 'characters.md') ?? '').map((h) => h.split(/\s+[—-]\s+/)[0]).filter((h) => !/ลูกค้า/.test(h));
  const outline = readText(v.cwd, 'outline.md') ?? '';
  const chapters = v.files.filter((f) => f.path.startsWith('chapters/')).map((f) => f.path.replace('chapters/', ''));
  const planned = [...outline.matchAll(/^\s*\d+\.\s+\*\*(.+?)\*\*/gm)].map((m) => m[1]);
  const status = openItems(v.readme);
  const tagline = (v.readme ?? '').match(/^\*([^*]+)\*/m)?.[1];
  const lines = [
    `**${v.name}**${tagline ? ` (*${tagline.trim()}*)` : ''} is a novel project${planned.length ? ` planned in ${planned.length} chapters` : ''}.`,
    '',
    `- Premise: ${plain(firstParagraph(v.readme ?? '').slice(0, 220)) || '—'}`,
  ];
  if (chars.length) lines.push(`- Characters (\`characters.md\`): ${chars.slice(0, 5).join(', ')}`);
  if (planned.length) lines.push(`- Outline (\`outline.md\`): starts with "${planned[0]}"${planned[1] ? `, then "${planned[1]}"` : ''}`);
  lines.push(`- Written so far (\`chapters/\`): ${chapters.length ? chapters.join(', ') : 'nothing yet'}`);
  if (status.length) lines.push('', `Still open: ${status.join('; ')}.`);
  return lines.join('\n');
}

export function overview(v: ProjectView): string {
  if (v.kind === 'code') return codeOverview(v);
  if (v.kind === 'novel') return novelOverview(v);
  if (v.kind === 'empty') return `This folder is empty so far — there's nothing to summarize yet. Tell me what you'd like to build and I'll start with a README.`;
  return [`**${v.name}** has ${v.files.length} files:`, '', ...v.keyFiles.map((p) => `- ${fileNote(v.cwd, p)}`)].join('\n');
}

// ───────────────────────── Thai (an ask in Thai gets the whole answer in Thai) ─────────────────────────

/** fileNote in Thai: the counts are in Thai words; file contents (names, titles) stay as written. */
export function fileNoteTh(cwd: string, path: string): string {
  return fileNote(cwd, path)
    .replace(/\((\d+) lines\)/, '($1 บรรทัด)')
    .replace(/— (\d+) tests?(, plus (\d+) `test\.todo` placeholders? )?/, (_m, n: string, plus?: string, k?: string) => `— เทสต์ ${n} ตัว${plus ? ` และ \`test.todo\` ที่ยังว่าง ${k} ตัว ` : ''}`);
}

function codeOverviewTh(v: ProjectView): string {
  const intro = firstParagraph(v.readme ?? '');
  let test = '';
  try {
    const pkg = readText(v.cwd, 'package.json');
    const p = pkg ? (JSON.parse(pkg) as { scripts?: Record<string, string> }) : null;
    if (p?.scripts?.test) test = ` รันเทสต์ด้วย \`${p.scripts.test}\``;
  } catch {
    /* not JSON */
  }
  const routes = documentedRoutes(v.readme ?? '');
  const gaps = openItems(v.readme);
  const lines = [`**${v.name}** — ${intro ? plain(intro) : `มี ${v.files.length} ไฟล์`}${test}`, '', ...v.keyFiles.map((p) => `- ${fileNoteTh(v.cwd, p)}`)];
  if (routes.length) lines.push('', `เส้นทาง (route) ที่ README บอกไว้: ${routes.map((r) => `\`${r}\``).join(', ')}`);
  if (gaps.length) lines.push('', `สิ่งที่ README บอกว่ายังขาด: ${gaps.map((g) => g.replace(/\.$/, '')).join('; ')}`);
  return lines.join('\n');
}

function novelOverviewTh(v: ProjectView): string {
  const chars = headings(readText(v.cwd, 'characters.md') ?? '').map((h) => h.split(/\s+[—-]\s+/)[0]).filter((h) => !/ลูกค้า/.test(h));
  const outline = readText(v.cwd, 'outline.md') ?? '';
  const chapters = v.files.filter((f) => f.path.startsWith('chapters/')).map((f) => f.path.replace('chapters/', ''));
  const planned = [...outline.matchAll(/^\s*\d+\.\s+\*\*(.+?)\*\*/gm)].map((m) => m[1]);
  const status = openItems(v.readme);
  const tagline = (v.readme ?? '').match(/^\*([^*]+)\*/m)?.[1];
  const lines = [
    `**${v.name}**${tagline ? ` (*${tagline.trim()}*)` : ''} เป็นโปรเจกต์นิยาย${planned.length ? ` วางโครงไว้ ${planned.length} บท` : ''}`,
    '',
    `- เรื่องย่อ: ${plain(firstParagraph(v.readme ?? '').slice(0, 220)) || '—'}`,
  ];
  if (chars.length) lines.push(`- ตัวละคร (\`characters.md\`): ${chars.slice(0, 5).join(', ')}`);
  if (planned.length) lines.push(`- โครงเรื่อง (\`outline.md\`): เริ่มด้วย "${planned[0]}"${planned[1] ? ` ต่อด้วย "${planned[1]}"` : ''}`);
  lines.push(`- เขียนแล้ว (\`chapters/\`): ${chapters.length ? chapters.join(', ') : 'ยังไม่มีบทไหน'}`);
  if (status.length) lines.push('', `ที่ยังค้างอยู่: ${status.join('; ')}`);
  return lines.join('\n');
}

/** overview() for an ask written in Thai. */
export function overviewTh(v: ProjectView): string {
  if (v.kind === 'code') return codeOverviewTh(v);
  if (v.kind === 'novel') return novelOverviewTh(v);
  if (v.kind === 'empty') return 'โฟลเดอร์นี้ยังว่างอยู่ค่ะ ยังไม่มีอะไรให้สรุป — บอกได้เลยว่าอยากทำอะไร แล้วจะเริ่มจาก README ให้ค่ะ';
  return [`**${v.name}** มี ${v.files.length} ไฟล์:`, '', ...v.keyFiles.map((p) => `- ${fileNoteTh(v.cwd, p)}`)].join('\n');
}

/** Concrete review observations for a code file (used by helpers and reviewers). */
export function codeFindings(cwd: string, path: string): string[] {
  const text = readText(cwd, path);
  if (text === null) return [];
  const out: string[] = [];
  const at = (re: RegExp | string) => {
    const n = lineOf(text, re);
    return n ? `${path}:${n}` : path;
  };
  if (/no validation/i.test(text)) out.push(`\`${at(/no validation/i)}\` creates a todo from \`body.title\` without checking it — an empty or non-string title is stored as-is (should be a 400).`);
  if (/rest\.length > 0\) return notFound/.test(text) && !text.includes("'done'"))
    out.push(`\`${at('rest.length > 0')}\` rejects any extra path segment, so there's no way to add \`/todos/:id/done\`; \`done\` can never become \`true\` over HTTP.`);
  if (/await req\.json\(\)/.test(text) && !/req\.json\(\)\.catch/.test(text)) out.push(`\`${at('await req.json()')}\` throws on a malformed JSON body, which surfaces as a 500 instead of a 400.`);
  if (/Number\(rawId\)/.test(text) && !/id < 1/.test(text)) out.push(`\`${at('Number(rawId)')}\` accepts \`0\` and negative ids — harmless today, but they should be rejected with 400.`);
  if (/private nextId/.test(text)) out.push(`\`${at('nextId')}\` never reuses ids after a delete — good, keep that.`);
  if (/class TodoStore/.test(text) && !/markDone|setDone|toggle/.test(text)) out.push(`\`${at('class TodoStore')}\` has no method that changes \`done\`; the route will need one (e.g. \`markDone(id)\`).`);
  const t = testNames(text);
  if (isTest(path)) {
    if (t.todo.length) out.push(`\`${path}\` still has ${t.todo.length} \`test.todo\` placeholder${t.todo.length === 1 ? '' : 's'}: ${t.todo.map((s) => `"${s}"`).join(', ')}.`);
    if (t.done.length) out.push(`${t.done.length} real test${t.done.length === 1 ? '' : 's'} cover the happy paths; error cases (404 / 400) are thin.`);
  }
  for (const m of text.matchAll(/\/\/\s*(TODO|FIXME|HACK)[:\s](.+)$/gm)) out.push(`\`${at(m[0])}\` — ${m[1]}: ${m[2].trim()}`);
  if (!out.length) out.push(`\`${path}\` (${lineCount(text)} lines) reads cleanly — nothing blocking.`);
  return out;
}
