// Auto mode: RLT answers omp's tool approvals itself and only asks the user about risky steps, like Claude Code's
// auto mode — but with rules instead of a model, so it is instant, free and says why it stopped. omp runs these
// projects with --approval-mode always-ask, so every write- and exec-tier tool call comes through here first (omp's
// read-tier tools never ask). It never denies on its own: a step it doesn't clear goes to the user as a normal
// approval card with the reason and the id of the rule (shared/auto-rules.ts), which a house may always allow.
// Like Claude Code's defaults: edits and commands inside the project, local testing (requests to this machine), a
// plain git push and the agent's own state pass; what can lose work, leak data or reach outside does not.
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { ASK, autoRuleAllowable, SHELL_RULES } from '../../shared/auto-rules';

export type AutoVerdict = { allow: true } | { allow: false; reason: string; rule: string };
/** A rule that stops a step, or undefined: nothing stops it (so far). */
type Stop = Extract<AutoVerdict, { allow: false }> | undefined;

export interface AutoContext {
  projectDir: string;
  /** The house's standing allows (Project.autoAllow): rules that no longer stop a step there. */
  allow?: readonly string[];
}

/** The verdict of a rule that fired — or undefined when the house always allows it, so the review goes on. */
function stop(ctx: AutoContext, rule: string, reason?: string): Stop {
  if (ctx.allow?.includes(rule) && autoRuleAllowable(rule)) return undefined;
  const text = reason ?? (ASK as Record<string, string>)[rule] ?? SHELL_RULES.find((r) => r.id === rule)?.reason ?? rule;
  return { allow: false, reason: text, rule };
}

/** omp's approval text cuts long values here (truncateForPrompt): what follows wasn't shown, so it can't be cleared. */
const ELIDED = /\[…\d+ch elided…\]/;

const FILE_TOOLS = new Set(['write', 'edit', 'ast_edit', 'notebook', 'notebook_edit']);
/** omp tools that only change the agent's own state, or work it was already allowed to start: no card.
 *  task: a helper's own steps come back here one by one; vibe_send: a message to a worker the user let it start;
 *  retain / learn / context_notes / new_context / goal / manage_skill: the agent's memory, notes, goal and skills;
 *  generate_image: a picture into the session's own files; browser: omp's browser, driven from code already reviewed. */
const OWN_STATE_TOOLS = new Set(['task', 'vibe_send', 'retain', 'learn', 'context_notes', 'new_context', 'goal', 'manage_skill', 'generate_image', 'browser']);
/** omp's read tools only ask for a path that is another machine (ssh://) or a PDF's pictures (local). */
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'find', 'ast_grep']);
const LSP_READ = new Set(['diagnostics', 'definition', 'type_definition', 'implementation', 'references', 'hover', 'symbols', 'status', 'capabilities', 'reload']);
const DEBUG_READ = new Set(['output', 'threads', 'stack_trace', 'scopes', 'variables', 'disassemble', 'read_memory', 'loaded_sources', 'modules', 'sessions']);
const GITHUB_READ = new Set(['repo_view', 'file_read', 'search_issues', 'search_prs', 'search_code', 'search_commits', 'search_repos', 'run_watch']);

/** Build output and caches: deleting them is routine and they come back on the next build/install. */
const REGENERABLE = /(^|\/)(dist|build|out|coverage|node_modules|\.next|\.nuxt|\.cache|\.turbo|\.parcel-cache|__pycache__|\.pytest_cache|\.mypy_cache|target|tmp|\.tmp)(\/.*)?$/;

const SECRET_PATH = /(^|[\s/'"=])(\.ssh\/|id_(rsa|ed25519|ecdsa)\b|\.aws\/|\.config\/gcloud|\.omp\/agent|\.netrc\b|\.npmrc\b|\.pypirc\b|\.git-credentials\b|\.docker\/config\.json|\/etc\/(passwd|shadow|sudoers))/;
const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa))$/;
/** Where output goes that isn't a file: the terminal, the other stream, an open descriptor. */
const STREAMS = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** Review one approval: `args` are the tool call's real arguments when RLT saw it start, else parsed from `detail`. */
export function autoReview(tool: string, detail: string | undefined, args: unknown, ctx: AutoContext): AutoVerdict {
  return review(tool, detail, args, ctx, 0) ?? { allow: true };
}

function review(tool: string, detail: string | undefined, args: unknown, ctx: AutoContext, depth: number): Stop {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const field = (label: string) => fieldOf(detail, label);
  let v: Stop;

  if (OWN_STATE_TOOLS.has(tool)) return undefined;
  if (READ_TOOLS.has(tool)) return /\bssh:\/\//i.test(`${JSON.stringify(a)}\n${detail ?? ''}`) ? stop(ctx, 'remote') : undefined;
  if (tool === 'write') {
    const path = unwrapHashline(str('path') ?? filePaths(detail)[0] ?? '');
    const device = /^xd:\/\/([\w-]+)/i.exec(path)?.[1];
    if (device) return reviewDevice(device, str('content'), ctx, depth);
  }
  if (FILE_TOOLS.has(tool)) {
    const paths = filePaths(detail);
    if (!paths.length && str('path')) paths.push(unwrapHashline(str('path')!));
    if (!paths.length || paths.some((p) => ELIDED.test(p) || p === '(unknown)' || p === '(missing)')) return stop(ctx, 'unreadable', "couldn't tell which file it changes");
    for (const p of paths) if ((v = reviewPath(p, ctx))) return v;
    return undefined;
  }
  if (tool === 'bash') {
    const command = str('command') ?? field('Command');
    if (!command || (!str('command') && ELIDED.test(command))) return stop(ctx, 'unreadable', 'the command is too long to check');
    const cwd = str('cwd') ? resolve(ctx.projectDir, expandHome(str('cwd')!)) : ctx.projectDir;
    return reviewShell(command, ctx, cwd, 0);
  }
  if (tool === 'eval') {
    const code = str('code') ?? field('Code');
    if (!code || (!str('code') && ELIDED.test(code))) return stop(ctx, 'unreadable', 'the code is too long to check');
    return reviewCode(code, str('language') ?? field('Language') ?? '', ctx, 0);
  }
  if (tool === 'lsp') {
    // renames and code actions edit the files the language server names: the file asked about (and a renamed file's new name)
    const action = (str('action') ?? field('Action') ?? '').toLowerCase();
    if (LSP_READ.has(action)) return undefined;
    const files = [str('file') ?? field('File')].filter((f): f is string => !!f);
    if (action === 'rename_file' && str('new_name')) files.push(str('new_name')!);
    for (const f of files) if ((v = reviewPath(f, ctx))) return v;
    return undefined;
  }
  if (tool === 'debug') return reviewDebug(a, field('Action'), field('Program'), ctx);
  if (tool === 'github') {
    const op = str('op') ?? '';
    if (GITHUB_READ.has(op)) return undefined;
    if (op === 'pr_create') return stop(ctx, 'githubPr');
    if (op === 'pr_push') return a.forceWithLease === true ? stop(ctx, 'gitForcePush') : undefined; // the PR's own branch
    if (op === 'pr_checkout') return a.force === true ? stop(ctx, 'gitDiscard') : undefined; // force resets a local branch
    return stop(ctx, `tool:${tool}`, `uses GitHub's “${op || 'unknown'}” operation, which Auto has no rule for`);
  }
  if (tool === 'ida') {
    // IDA: list reads, exec runs Python inside IDA, the rest change the analysis database
    const action = str('action') ?? field('Action');
    if (action === 'list') return undefined;
    if (action === 'exec') {
      const code = str('code') ?? field('Code');
      return code && !(!str('code') && ELIDED.test(code)) ? reviewCode(code, 'python', ctx, 0) : stop(ctx, 'unreadable', 'the code is too long to check');
    }
    const db = str('db') ?? field('DB');
    return db ? reviewPath(db, ctx) : undefined;
  }
  if (tool === 'security_scan') {
    if (str('action') === 'cloud_start') return stop(ctx, 'cloudScan');
    return str('output_root') ? reviewPath(str('output_root')!, ctx) : undefined;
  }
  if (tool === 'tts') {
    const out = str('output_path');
    return out ? reviewPath(out, ctx) : stop(ctx, 'unreadable', "couldn't tell where it saves the audio");
  }
  if (tool === 'computer') return stop(ctx, 'computer');
  if (tool === 'vibe_spawn') return stop(ctx, 'autonomousAgent');
  if (tool.startsWith('mcp__')) return stop(ctx, `tool:${tool}`, `uses “${tool}” from an MCP server — Auto can't see what it does`);
  return stop(ctx, `tool:${tool}`, `auto mode doesn't know the “${tool}” tool`);
}

/** `write xd://<tool>`: omp's tool devices run that tool with the JSON written — reviewed like the tool itself. */
function reviewDevice(device: string, content: string | undefined, ctx: AutoContext, depth: number): Stop {
  if (device === 'report_issue') return undefined; // omp's own note about a tool that misbehaved
  let payload: unknown;
  try {
    payload = content === undefined ? undefined : JSON.parse(content);
  } catch {
    payload = undefined;
  }
  if (!payload || typeof payload !== 'object' || depth > 2) return stop(ctx, 'unreadable', `couldn't tell what it asks ${device} to do`);
  return review(device, undefined, payload, ctx, depth + 1);
}

function reviewDebug(a: Record<string, unknown>, actionField: string | undefined, programField: string | undefined, ctx: AutoContext): Stop {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const action = (str('action') ?? actionField ?? '').toLowerCase();
  if (DEBUG_READ.has(action)) return undefined;
  if (action === 'launch') {
    // runs a local program: like the same command line
    const program = str('program') ?? programField;
    if (!program) return undefined;
    const argv = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === 'string') : [];
    return reviewShell([program, ...argv].map(shellQuote).join(' '), ctx, ctx.projectDir, 0);
  }
  if (action === 'attach') {
    const host = str('host');
    if (host && !LOOPBACK.test(host)) return stop(ctx, 'remote');
    return typeof a.pid === 'number' ? stop(ctx, 'debugAttach') : undefined; // a port: the debug server it started
  }
  // gdb/lldb run shell commands from their prompt (`shell …`, `!…`, `platform shell …`)
  const expression = str('expression');
  const shell = expression && /^\s*(?:shell\s+|!|platform\s+shell\s+)([\s\S]+)$/.exec(expression);
  return shell ? reviewShell(shell[1]!, ctx, ctx.projectDir, 0) : undefined;
}

function fieldOf(detail: string | undefined, label: string): string | undefined {
  if (!detail) return undefined;
  const m = new RegExp(`(?:^|\\n)${label}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n[A-Z][A-Za-z]*:|(?![\\s\\S]))`).exec(detail);
  return m?.[1]?.trim() || undefined;
}

/** Every file an edit names: `Path:` (write), `File:` / `Move: a → b` (edit), `Paths: a, b` (ast_edit). */
function filePaths(detail: string | undefined): string[] {
  const out: string[] = [];
  for (const line of (detail ?? '').split('\n')) {
    const m = /^(Path|File|Move|Paths):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1] === 'Move' ? m[2].split(/\s*→\s*/) : m[1] === 'Paths' ? m[2].split(/,\s*/) : [m[2]];
    out.push(...parts.map(unwrapHashline).filter(Boolean));
  }
  return out;
}

/** omp may name a file as a hashline header, `[path#TAG]`. */
function unwrapHashline(p: string): string {
  const t = p.trim();
  return /^\[.*\]$/.test(t) ? t.slice(1, -1).replace(/#[^/#]*$/, '') : t;
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir()).replace(/^\$\{?HOME\}?(?=\/|$)/, homedir());
}

/** The absolute path a word names from `cwd`; undefined when only the running shell knows it ($VAR, `cmd`, ~user). */
function absPath(path: string, cwd: string | undefined): string | undefined {
  const p = expandHome(path).replace(/^\$\{?PWD\}?(?=\/|$)/, '.');
  if (/^[$`~]/.test(p)) return undefined;
  if (isAbsolute(p)) return resolve(p);
  return cwd === undefined ? undefined : resolve(cwd, p);
}

/** Where the agent may write without asking: its project, scratch space, and the terminal's own streams. */
function writable(path: string, ctx: AutoContext, cwd: string | undefined = ctx.projectDir): boolean {
  if (STREAMS.test(path)) return true;
  const abs = absPath(path, cwd);
  return abs !== undefined && (inside(ctx.projectDir, abs) || inside(tmpdir(), abs) || inside('/tmp', abs));
}

function reviewPath(path: string, ctx: AutoContext): Stop {
  const scheme = /^([a-z][\w+.-]*):\/\//i.exec(path)?.[1]?.toLowerCase();
  let v: Stop;
  if (scheme) {
    // local://: the session's scratch space; conflict://: merge-conflict blocks of files it read; agent://: a message
    // to its own helper; proc://<id>/kill or /mode: its own job
    if (scheme === 'local' || scheme === 'conflict' || scheme === 'agent') return undefined;
    if (scheme === 'proc') return /\/(kill|mode)\/?$/.test(path) ? undefined : stop(ctx, 'typesInto');
    if (scheme !== 'file') return stop(ctx, 'storage', `writes to ${scheme}:// storage`);
    path = decodeURIComponent(path.replace(/^file:\/\//i, ''));
  }
  if (!writable(path, ctx) && (v = stop(ctx, 'outside'))) return v;
  if (SECRET_FILE.test(path) && (v = stop(ctx, 'secretsFile'))) return v;
  if (/(^|\/)\.git\//.test(path) && (v = stop(ctx, 'gitInternals'))) return v;
  return undefined;
}

// ───────────── shell ─────────────

interface Segment {
  /** The words of one command, quotes removed. */
  words: string[];
  /** The words again for the text rules, with quoted text that has spaces (a message, a script) hidden. */
  text: string;
  /** A here-document fed to this line's commands. */
  stdin?: string;
}

/** A command line in commands, the files it redirects output to, and the commands inside $( ) and backticks. Quotes,
 *  comments and here-documents are understood well enough that quoted text isn't taken for commands. */
function parseShell(src: string): { segs: Segment[]; redirects: string[]; nested: string[] } {
  const segs: Segment[] = [];
  const redirects: string[] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let shown: string[] = [];
  let word = '';
  let show = '';
  let inWord = false;
  let spaced = false;
  let target: 'redirect' | 'drop' | 'heredoc' | null = null;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let lineStart = 0;
  const endWord = () => {
    if (!inWord) return;
    if (target === 'redirect') redirects.push(word);
    else if (target === 'heredoc') heredocs.push({ delim: word, strip: show.startsWith('-') });
    else if (target !== 'drop') {
      words.push(word);
      shown.push(spaced ? '"…"' : show);
    }
    target = null;
    word = show = '';
    inWord = spaced = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segs.push({ words, text: shown.join(' ') });
    words = [];
    shown = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const add = (s: string) => {
      word += s;
      show += s;
      inWord = true;
    };
    if (c === '\\') {
      if (i + 1 < src.length) add(src[++i]!);
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (c === '"' && src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      add(s);
      if (/\s/.test(s)) spaced = true;
      i = j;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endSeg();
      if (heredocs.length) {
        // the body of each here-document follows, up to its delimiter line
        let body = '';
        for (const h of heredocs) {
          let j = i + 1;
          for (;;) {
            const end = src.indexOf('\n', j);
            const line = src.slice(j, end < 0 ? src.length : end);
            j = end < 0 ? src.length : end + 1;
            if ((h.strip ? line.trim() : line) === h.delim || j >= src.length) break;
            body += `${line}\n`;
          }
          i = j - 1;
        }
        for (let k = lineStart; k < segs.length; k++) segs[k]!.stdin = body;
        heredocs.length = 0;
      }
      lineStart = segs.length;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    if (c === '>' || (c === '&' && src[i + 1] === '>')) {
      if (c === '&') i++;
      else if (inWord && /^\d+$/.test(word)) word = show = '', (inWord = false); // 2> file: the number is the stream
      endWord();
      let j = i + 1;
      if (src[j] === '>' || src[j] === '|') j++;
      if (src[j] === '&') {
        // >&2, 2>&1: one stream into another
        j++;
        while (/[\d-]/.test(src[j] ?? '')) j++;
        i = j - 1;
        continue;
      }
      target = 'redirect';
      i = j - 1;
      continue;
    }
    if (c === '<') {
      endWord();
      if (src[i + 1] === '<' && src[i + 2] === '<') {
        target = 'drop'; // here-string: text, not a file
        i += 2;
      } else if (src[i + 1] === '<') {
        i++;
        if (src[i + 1] === '-') {
          i++;
          show = '-';
        }
        target = 'heredoc';
      } else if (src[i + 1] === '(') {
        endSeg();
        i++;
      } else target = 'drop'; // input file
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      endSeg();
      i++;
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      endSeg();
      continue;
    }
    add(c);
  }
  endSeg();
  for (const m of src.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) nested.push(m[1] ?? m[2] ?? '');
  return { segs, redirects, nested };
}

function shellQuote(w: string): string {
  return /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

function reviewShell(command: string, ctx: AutoContext, cwd: string | undefined, depth: number): Stop {
  const cmd = command.replace(/\\\n/g, ' ');
  let v: Stop;
  if (SECRET_PATH.test(cmd) && (v = stop(ctx, 'credentials'))) return v;
  for (const rule of SHELL_RULES) if (rule.whole && rule.re?.test(cmd) && (v = stop(ctx, rule.id, rule.reason))) return v;
  const { segs, redirects, nested } = parseShell(cmd);
  let dir = cwd;
  for (const seg of segs) {
    // the rules in their order (sudo before what it runs): by text, or by the program run
    const programs = programsOf(seg.words);
    for (const rule of SHELL_RULES) {
      if (rule.whole) continue;
      const byText = !!rule.re?.test(seg.text) && !(rule.id === 'sendsData' && loopbackOnly(seg.words));
      const byProgram = programs.some((p) => rule.bins?.includes(p.bin.replace(/\..*$/, '')) && !(rule.id === 'system' && readOnlySystem(p.bin, seg.words.slice(p.at + 1))));
      if ((byText || byProgram) && (v = stop(ctx, rule.id, rule.reason))) return v;
    }
    if ((v = reviewWords(seg.words, ctx, dir, depth, seg.stdin))) return v;
    // `cd x && …`: later relative paths are inside x (unknown once it goes somewhere only the shell knows)
    if (seg.words[0] === 'cd') dir = seg.words[1] === undefined ? homedir() : absPath(seg.words[1], dir);
  }
  for (const r of redirects) if (!writable(r, ctx, dir) && (v = stop(ctx, 'writesOutside'))) return v;
  if (depth < 3) for (const n of nested) if ((v = reviewShell(n, ctx, dir, depth + 1))) return v;
  return undefined;
}

/** Programs that run the command after them, with their options that take a value. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-p', '-U', '-h', '-r', '-t'],
  doas: ['-u', '-C'],
  su: [],
  pkexec: ['--user'],
  run0: ['-u', '--user'],
  env: ['-u', '-C', '-S', '--unset', '--chdir'],
  nohup: [],
  time: ['-f', '-o'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: ['-I', '-L', '-P', '-n', '-d', '-E', '-s', '-a'],
  watch: ['-n', '-d'],
  exec: ['-a'],
  command: [],
  builtin: [],
};
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'fi', 'done']);
const SHELLS = /^(ba|z|da|k|)sh$/;

/** The programs a command runs: the wrappers (sudo, env, xargs …) and the program after them, past variable
 *  assignments and keywords. `at`: the program's index in `words`. */
function programsOf(words: string[]): { bin: string; at: number }[] {
  const out: { bin: string; at: number }[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(w) || KEYWORDS.has(w)) {
      i++;
      continue;
    }
    out.push({ bin: basename(w), at: i });
    const wrapper = WRAPPERS[basename(w)];
    if (!wrapper) break;
    i++;
    while (i < words.length && (words[i]!.startsWith('-') || words[i] === '{}' || /^[A-Za-z_]\w*=/.test(words[i]!))) {
      if (wrapper.includes(words[i]!)) i++;
      i++;
    }
    if (basename(w) === 'timeout' && /^\d/.test(words[i] ?? '')) i++;
  }
  return out;
}

function reviewWords(words: string[], ctx: AutoContext, cwd: string | undefined, depth: number, stdin?: string): Stop {
  let v: Stop;
  const programs = programsOf(words);
  for (const p of programs) if ((v = ruleOfBin(p.bin, words.slice(p.at + 1), ctx))) return v;
  const last = programs.at(-1);
  if (!last || WRAPPERS[last.bin]) return undefined;
  const bin = last.bin;
  const rest = words.slice(last.at + 1);
  const paths = rest.filter((w) => !w.startsWith('-'));
  const script = (flag: RegExp) => {
    const at = rest.findIndex((w) => flag.test(w));
    return at >= 0 ? rest[at + 1] : undefined;
  };

  if (SHELLS.test(bin)) {
    const s = script(/^-[a-zA-Z]*c[a-zA-Z]*$/) ?? (paths.length ? undefined : stdin);
    return s !== undefined && depth < 3 ? reviewShell(s, ctx, cwd, depth + 1) : undefined;
  }
  if (bin === 'eval') return depth < 3 ? reviewShell(rest.join(' '), ctx, cwd, depth + 1) : undefined;
  if (/^python[\d.]*$/.test(bin)) {
    const s = script(/^-c$/) ?? (paths.length ? undefined : stdin);
    return s !== undefined && depth < 3 ? reviewCode(s, 'python', ctx, depth + 1) : undefined;
  }
  if (bin === 'node' || bin === 'bun' || bin === 'deno') {
    const s = script(/^(-e|--eval|-p|--print)$/);
    return s !== undefined && depth < 3 ? reviewCode(s, 'js', ctx, depth + 1) : undefined;
  }
  if (bin === 'git') return reviewGit(rest, ctx);
  if (bin === 'find') {
    // what -exec runs gets each found path ({}): somewhere under the roots find searches
    const firstFlag = rest.findIndex((w) => w.startsWith('-'));
    const roots = (firstFlag < 0 ? rest : rest.slice(0, firstFlag)).filter(Boolean);
    for (let k = 0; k < rest.length; k++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(rest[k]!)) continue;
      const end = rest.findIndex((w, j) => j > k && (w === ';' || w === '+'));
      const run = rest.slice(k + 1, end < 0 ? undefined : end);
      for (const root of roots.length ? roots : ['.']) if ((v = reviewWords(run.map((w) => w.replaceAll('{}', root)), ctx, cwd, depth))) return v;
    }
    if (rest.includes('-delete')) {
      for (const p of roots.length ? roots : ['.']) if (!writable(p, ctx, cwd) && (v = stop(ctx, 'deletesOutside'))) return v;
    }
    return undefined;
  }
  if (bin === 'rm' || bin === 'rmdir' || bin === 'shred' || bin === 'unlink') {
    const recursive = rest.some((w) => /^-\w*[rR]/.test(w) || w === '--recursive');
    for (const p of paths) {
      if (/[*?]/.test(p) && !p.includes('/')) {
        if (recursive && (v = stop(ctx, 'wildcard'))) return v;
        continue;
      }
      if (!writable(p, ctx, cwd)) {
        if ((v = stop(ctx, 'deletesOutside'))) return v;
        continue;
      }
      const abs = absPath(p, cwd);
      const rel = abs === undefined ? '' : relative(ctx.projectDir, abs);
      if (recursive && (rel === '' || !REGENERABLE.test(rel)) && inside(ctx.projectDir, abs ?? ctx.projectDir) && (v = stop(ctx, 'deletesFolder'))) return v;
    }
    return undefined;
  }
  if (['mv', 'cp', 'ln', 'tee', 'install', 'touch', 'mkdir', 'truncate'].includes(bin)) {
    const targets = bin === 'tee' || bin === 'touch' || bin === 'mkdir' || bin === 'truncate' ? paths : paths.slice(-1);
    if (bin === 'mv' && paths.some((p) => !writable(p, ctx, cwd)) && (v = stop(ctx, 'movesOutside'))) return v;
    for (const p of targets) if (!writable(p, ctx, cwd) && (v = stop(ctx, 'writesOutside'))) return v;
    return undefined;
  }
  if (bin === 'chmod' || bin === 'chown' || bin === 'chgrp') {
    const byReference = rest.some((w) => w.startsWith('--reference'));
    const [mode, ...files] = byReference ? ['', ...paths] : paths;
    const open = bin === 'chmod' && mode !== undefined && worldWritable(mode);
    const outside = !files.length || files.some((p) => {
      const abs = absPath(p, cwd);
      return abs === undefined || !inside(ctx.projectDir, abs);
    });
    if ((open || outside) && (v = stop(ctx, 'permissions'))) return v;
  }
  return undefined;
}

/** A rule that fires because of the program run (sudo, ssh, systemctl …), except the read-only forms of system tools. */
function ruleOfBin(bin: string, rest: string[], ctx: AutoContext): Stop {
  const name = bin.replace(/\..*$/, ''); // mkfs.ext4
  for (const rule of SHELL_RULES) {
    if (!rule.bins?.includes(name)) continue;
    if (rule.id === 'system' && readOnlySystem(name, rest)) continue;
    const v = stop(ctx, rule.id, rule.reason);
    if (v) return v;
  }
  return undefined;
}

/** systemctl status, service X status, tailscale status, crontab -l, plain mount: they only look. */
function readOnlySystem(bin: string, rest: string[]): boolean {
  const positional = (valueFlags: string[]) => {
    const out: string[] = [];
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k]!;
      if (w.startsWith('-')) {
        if (valueFlags.includes(w)) k++;
      } else out.push(w);
    }
    return out;
  };
  switch (bin) {
    case 'systemctl': {
      if (rest.some((w) => /^(-H|--host|-M|--machine)(=|$)/.test(w))) return false;
      const verb = positional(['-n', '--lines', '-t', '--type', '-p', '--property', '--state', '-o', '--output'])[0];
      return /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|show|cat)$/.test(verb ?? '');
    }
    case 'service': {
      const pos = positional([]);
      return rest.includes('--status-all') || (pos.length === 2 && pos[1] === 'status');
    }
    case 'tailscale':
      return /^(status|ip|ping|netcheck|whois|version)$/.test(positional(['--socket'])[0] ?? '');
    case 'crontab':
      return rest.length === 1 && rest[0] === '-l';
    case 'mount':
      return positional(['-t']).length === 0 && rest.every((w, k) => w === '-l' || w === '-t' || rest[k - 1] === '-t');
    default:
      return false;
  }
}

/** chmod modes that give everyone write access: 777, 666, o+w, a=rwx. */
function worldWritable(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) return /[2367]$/.test(mode);
  return mode.split(',').some((clause) => {
    const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
    return !!m && m[2] !== '-' && m[3]!.includes('w') && /[oa]/.test(m[1]!);
  });
}

/** The whole working tree as a pathspec. */
const WHOLE_TREE = /^(\.|\.\/|\*|\.\/\*|:\/|:\/\.|:\/\*|:\(top\)|:\/:)$/;
/** Branches and remotes named like a deploy target: pushing there ships. */
const DEPLOY = /^(prod(uction)?([-_./].*)?|gh-pages|release.*|deploy.*)$/i;

function reviewGit(args: string[], ctx: AutoContext): Stop {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    if (/^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[i]!)) i++;
    i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const flags = rest.filter((w) => w.startsWith('-'));
  const pos = rest.filter((w) => !w.startsWith('-'));
  const has = (re: RegExp) => flags.some((f) => re.test(f));
  const discard = () => stop(ctx, 'gitDiscard');
  switch (sub) {
    case 'push':
      return reviewPush(rest, ctx);
    case 'reset':
      return has(/^--hard$/) ? discard() : undefined;
    case 'clean':
      return (has(/^-[a-zA-Z]*f/) || has(/^--force$/)) && !has(/^(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)$/) ? discard() : undefined;
    case 'checkout': {
      if (has(/^(-[a-zA-Z]*f[a-zA-Z]*|--force)$/)) return discard();
      return pos.some((p) => WHOLE_TREE.test(p)) ? discard() : undefined;
    }
    case 'switch':
      return has(/^(-f|--force|--discard-changes)$/) ? discard() : undefined;
    case 'restore': {
      const paths: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        if (/^(-s|--source)$/.test(rest[k]!)) k++;
        else if (!rest[k]!.startsWith('-')) paths.push(rest[k]!);
      }
      const worktree = has(/^(-W|--worktree|-[a-zA-Z]*W[a-zA-Z]*)$/) || !has(/^(-S|--staged|-[a-zA-Z]*S[a-zA-Z]*)$/);
      return worktree && (paths.length === 0 || paths.some((p) => WHOLE_TREE.test(p))) ? discard() : undefined;
    }
    case 'stash':
      return pos[0] === 'drop' || pos[0] === 'clear' ? discard() : undefined;
    case 'branch':
      return has(/^-[a-zA-Z]*D/) || (has(/^(-d|--delete)$/) && has(/^(-f|--force)$/)) ? discard() : undefined;
    case 'reflog':
      return pos[0] === 'expire' || pos[0] === 'delete' ? discard() : undefined;
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
      return discard();
    default:
      return undefined;
  }
}

/** A plain push to one of the project's remotes passes (Claude Code's default); force, deletes, mirrors, deploy
 *  branches, release tags and pushes to a bare address don't. */
function reviewPush(rest: string[], ctx: AutoContext): Stop {
  const flags: string[] = [];
  const pos: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]!;
    if (w === '--') {
      pos.push(...rest.slice(k + 1));
      break;
    }
    if (w.startsWith('-')) {
      flags.push(w);
      if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(w)) k++;
    } else pos.push(w);
  }
  const [remote, ...refspecs] = pos;
  let v: Stop;
  const force =
    flags.some((f) => /^--(force|force-with-lease|force-if-includes|delete|mirror|prune)(=.*)?$/.test(f) || /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(f)) ||
    refspecs.some((r) => r.startsWith('+') || r.startsWith(':'));
  if (force && (v = stop(ctx, 'gitForcePush'))) return v;
  if (remote && /:\/\/|^[\w.-]+@[\w.-]+:/.test(remote) && (v = stop(ctx, 'gitPushUrl'))) return v;
  const targets = refspecs.map((r) => r.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, ''));
  const deploy =
    flags.some((f) => /^--(tags|follow-tags)$/.test(f)) ||
    (remote !== undefined && DEPLOY.test(remote)) ||
    targets.some((t) => DEPLOY.test(t) || t.startsWith('refs/tags/') || /^v?\d+(\.\d+)+/.test(t));
  if (deploy && (v = stop(ctx, 'gitPushDeploy'))) return v;
  return undefined;
}

/** Every target of a curl / wget / HTTPie command is this machine (localhost, 127.x, [::1]): local testing. */
function loopbackOnly(words: string[]): boolean {
  const at = words.findIndex((w) => /^(curl|wget|http|https|httpie|xh)$/.test(basename(w)));
  if (at < 0) return false;
  const httpie = !/^(curl|wget)$/.test(basename(words[at]!));
  const valueFlags = /^(-d|--data[\w-]*|--json|-H|--header|-X|--request|--method|-o|--output|-O|--output-document|-u|--user|-F|--form[\w-]*|-T|--upload-file|-A|--user-agent|-U|-e|--referer|-b|--cookie|-c|--cookie-jar|-w|--write-out|-m|--max-time|--connect-timeout|-K|--config|-r|--range|--retry|--cacert|--cert|--key|-E|-D|--dump-header|--limit-rate|--unix-socket|--abstract-unix-socket|--post-data|--post-file|--body-data|--body-file|-P|--directory-prefix|-t|--tries|--timeout|--output-dir)$/;
  let seen = false;
  for (let k = at + 1; k < words.length; k++) {
    const w = words[k]!.replace(/\$\{?\w+\}?|\$\([^)]*\)/g, '\u0000');
    if (/^(-x|--proxy|--preproxy|--socks\w*|--connect-to|--resolve|--doh-url)(=|$)/.test(w)) return false;
    if (w.startsWith('-')) {
      if (valueFlags.test(w) || (/^-[a-zA-Z]{2,}$/.test(w) && /[dHXouFTAebcwmKrED]$/.test(w))) k++;
      continue;
    }
    if (httpie && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(w)) continue;
    if (httpie && seen && /^[\w.-]+(:=|==|=|@|:)/.test(w)) continue; // request items: field=value, Header:value
    if (httpie && /^:\d*(\/|$)/.test(w)) {
      seen = true; // :3000/api is localhost to HTTPie
      continue;
    }
    if (!isLoopbackUrl(w, true)) return false;
    seen = true;
  }
  return seen;
}

/** The host of a URL (with or without a scheme) is this machine. Parts only known while running (\0) leave it open. */
function isLoopbackUrl(url: string, bareAllowed = false): boolean {
  const m = /^[a-z][\w+.-]*:\/\/([^/?#]*)/i.exec(url) ?? (bareAllowed ? /^([^/?#]*)/.exec(url) : null);
  if (!m) return false;
  const authority = m[1]!.slice(m[1]!.lastIndexOf('@') + 1);
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]!;
  return !host.includes('\u0000') && LOOPBACK.test(host);
}

// ───────────── code (eval) ─────────────

type Lit = { value: string; dynamic: boolean };

/** A string literal (Python or JavaScript); parts filled in while running are \0 and make it `dynamic`. */
function literal(text: string): Lit | null {
  const t = text.trim();
  const py = /^([rRbBuUfF]{0,2})('''|"""|'|")([\s\S]*)\2$/.exec(t);
  // 'a' + 'b' also starts and ends with a quote: one literal only when its quote doesn't close inside
  if (py && !(py[2]!.length === 1 && new RegExp(`(^|[^\\\\])(\\\\\\\\)*${py[2]}`).test(py[3]!))) {
    const f = /f/i.test(py[1]!);
    const raw = /r/i.test(py[1]!);
    let value = py[3]!;
    if (f) value = value.replace(/\{\{|\}\}/g, (b) => b[0]!).replace(/\{[^{}]*\}/g, '\u0000');
    if (!raw) value = value.replace(/\\(.)/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
    return { value, dynamic: value.includes('\u0000') };
  }
  const tpl = /^`([\s\S]*)`$/.exec(t);
  if (tpl && !/(^|[^\\])(\\\\)*`/.test(tpl[1]!)) {
    const value = tpl[1]!.replace(/\$\{[^}]*\}/g, '\u0000').replace(/\\(.)/g, '$1');
    return { value, dynamic: value.includes('\u0000') };
  }
  return null;
}

/** Split call arguments (or list items) at top-level commas, keeping strings and brackets whole. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const triple = s.startsWith(c.repeat(3), i) && c !== '`';
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < s.length && !s.startsWith(q, j)) j += s[j] === '\\' ? 2 : 1;
      cur += s.slice(i, j + q.length);
      i = j + q.length - 1;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The text between the parenthesis at `open` and its match. */
function callText(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const triple = code.startsWith(c.repeat(3), i) && c !== '`';
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < code.length && !code.startsWith(q, j)) j += code[j] === '\\' ? 2 : 1;
      i = j + q.length - 1;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/** Literal words of a list/tuple of string literals; null when any item is computed. */
function literalList(text: string): string[] | null {
  const m = /^[[(]([\s\S]*)[\])]$/.exec(text.trim());
  if (!m) return null;
  const out: string[] = [];
  for (const item of splitTop(m[1]!)) {
    const lit = literal(item);
    if (!lit || lit.dynamic) return null;
    out.push(lit.value);
  }
  return out;
}

/** A command a call runs: a string → a command line, a list → its words; null when it is built while running. */
function commandOf(arg: string | undefined, extra?: string): string | null {
  if (arg === undefined) return null;
  const a = arg.replace(/^(args|cmd|command)\s*=\s*/, '');
  const lit = literal(a);
  if (lit) {
    if (lit.dynamic) return null;
    if (extra === undefined) return lit.value;
    const more = literalList(extra);
    return more ? [lit.value, ...more].map(shellQuote).join(' ') : null;
  }
  const list = literalList(a);
  if (list) return list.map(shellQuote).join(' ');
  const cmdKey = /^\{[\s\S]*\bcmd\s*:\s*(\[[\s\S]*?\])/.exec(a); // Bun.spawn({ cmd: [...] })
  const words = cmdKey ? literalList(cmdKey[1]!) : null;
  return words ? words.map(shellQuote).join(' ') : null;
}

function matchesWithArgs(code: string, re: RegExp): { name: string; args: string[] }[] {
  const out: { name: string; args: string[] }[] = [];
  for (const m of code.matchAll(re)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    out.push({ name: m[1] ?? '', args: splitTop(callText(code, open)) });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The commands Python code runs (null: built while running), its `!cmd` lines and shell cell magics included. */
function pyCommands(code: string): (string | null)[] {
  const out: (string | null)[] = [];
  for (const m of code.matchAll(/^[ \t]*(?:\w+\s*=\s*)?!(.+)$/gm)) out.push(m[1]!);
  for (const m of code.matchAll(/^[ \t]*%(?:sx|system)\s+(.+)$/gm)) out.push(m[1]!);
  for (const m of code.matchAll(/^[ \t]*%pip\s+(.+)$/gm)) out.push(`pip ${m[1]}`);
  const cell = /^[ \t]*%%(bash|sh|script\s+\S*sh|sx|system)\b[^\n]*\n([\s\S]*)$/m.exec(code);
  if (cell) out.push(cell[2]!);

  const mods = ['subprocess', ...[...code.matchAll(/\bimport\s+subprocess\s+as\s+(\w+)/g)].map((m) => m[1]!)];
  const bare: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+subprocess\s+import\s+\(?([^)\n]+)\)?/g)) {
    for (const part of m[1]!.split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name) bare.push(alias ?? name);
    }
  }
  const fns = 'run|call|check_call|check_output|Popen|getoutput|getstatusoutput';
  const modRe = mods.map(escapeRe).join('|');
  for (const c of matchesWithArgs(code, new RegExp(`(?<![\\w.])(?:${modRe})\\.(${fns})\\s*\\(`, 'g'))) out.push(commandOf(c.args[0]));
  if (bare.length) for (const c of matchesWithArgs(code, new RegExp(`(?<![\\w.])(${bare.map(escapeRe).join('|')})\\s*\\(`, 'g'))) out.push(commandOf(c.args[0]));
  // subprocess used any other way (passed around, getattr): can't follow it
  const consts = /^(PIPE|DEVNULL|STDOUT|CalledProcessError|TimeoutExpired|CompletedProcess|SubprocessError)$/;
  for (const m of code.matchAll(new RegExp(`(?<![\\w.])(?:${modRe})\\b(\\.\\w+)?(\\s*\\()?`, 'g'))) {
    const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index) >>> 0);
    if (/^\s*(import|from)\s/.test(line)) continue;
    const attr = m[1]?.slice(1);
    const called = attr !== undefined && new RegExp(`^(${fns})$`).test(attr) && m[2] !== undefined;
    if (!called && !consts.test(attr ?? '')) out.push(null);
  }
  for (const c of matchesWithArgs(code, /\bos\.(system|popen)\s*\(/g)) out.push(commandOf(c.args[0]));
  for (const c of matchesWithArgs(code, /\bpty\.spawn\s*\(/g)) out.push(commandOf(c.args[0]));
  for (const c of matchesWithArgs(code, /\basyncio\.create_subprocess_(shell|exec)\s*\(/g)) {
    if (c.name === 'shell') out.push(commandOf(c.args[0]));
    else {
      const words = c.args.filter((x) => !/^\w+\s*=/.test(x)).map(literal);
      out.push(words.every((w) => w && !w.dynamic) ? words.map((w) => shellQuote(w!.value)).join(' ') : null);
    }
  }
  for (const c of matchesWithArgs(code, /\bos\.(exec\w*|spawn\w*|posix_spawnp?)\s*\(/g)) {
    const argv = c.args.map(literalList).find((l) => l !== null);
    out.push(argv ? argv.map(shellQuote).join(' ') : null);
  }
  if (/\bfrom\s+(os|pty)\s+import\b[^\n]*\b(system|popen|exec\w*|spawn\w*)\b/.test(code)) out.push(null);
  return out;
}

/** The commands JavaScript code runs (null: built while running): child_process, Bun.spawn, Bun's $`…`, Deno.Command. */
function jsCommands(code: string): (string | null)[] {
  const out: (string | null)[] = [];
  if (/child_process/.test(code)) {
    for (const c of matchesWithArgs(code, /(?<![\w$])(?:[\w$]+\.)?(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/g)) {
      if (c.name === 'fork') out.push(commandOf(c.args[0]) === null ? null : `node ${commandOf(c.args[0])}`);
      else if (c.name.startsWith('exec') && !c.name.startsWith('execFile')) out.push(commandOf(c.args[0]));
      else out.push(literalList(c.args[1] ?? '') ? commandOf(c.args[0], c.args[1]) : commandOf(c.args[0]));
    }
    // a child_process function under another name can't be followed
    if (/\b(exec\w*|spawn\w*|fork)\s+as\s+[\w$]+|\b(exec\w*|spawn\w*|fork)\s*:\s*[\w$]+\s*[,}]/.test(code)) out.push(null);
  } else {
    for (const c of matchesWithArgs(code, /\bBun\.(spawn|spawnSync)\s*\(/g)) out.push(commandOf(c.args[0]));
  }
  for (const c of matchesWithArgs(code, /\bnew\s+Deno\.Command\s*\(/g)) {
    const args = /\bargs\s*:\s*(\[[\s\S]*?\])/.exec(c.args[1] ?? '')?.[1];
    out.push(args ? commandOf(c.args[0], args) : commandOf(c.args[0]));
  }
  // Bun shell: $`cmd` / Bun.$`cmd` — interpolated values are only known while running
  for (const m of code.matchAll(/(?<![\w$])(?:Bun\.)?\$\s*`((?:[^`\\]|\\.)*)`/g)) out.push(m[1]!.includes('${') ? null : m[1]!);
  return out;
}

type Deletion = { path: string | null; recursive: boolean };

function pyDeletes(code: string): Deletion[] {
  const out: Deletion[] = [];
  const target = (arg: string | undefined) => {
    const lit = arg === undefined ? null : literal(arg);
    return lit && !lit.dynamic ? lit.value : null;
  };
  for (const c of matchesWithArgs(code, /\b(shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|os\.removedirs)\s*\(/g)) out.push({ path: target(c.args[0]), recursive: c.name === 'shutil.rmtree' });
  if (/\bfrom\s+shutil\s+import\b[^\n]*\brmtree\b/.test(code)) {
    for (const c of matchesWithArgs(code, /(?<![\w.])(rmtree)\s*\(/g)) out.push({ path: target(c.args[0]), recursive: true });
  }
  // Path("x").unlink() names its file; p.unlink() on a path worked out while running doesn't
  for (const m of code.matchAll(/(\bPath\(\s*([^()]*?)\s*\))?\.(unlink|rmdir)\s*\(/g)) {
    if (m.index !== undefined && /\bos$/.test(code.slice(Math.max(0, m.index - 2), m.index))) continue;
    out.push({ path: m[2] !== undefined ? target(m[2]) : null, recursive: false });
  }
  return out;
}

function jsDeletes(code: string): Deletion[] {
  const out: Deletion[] = [];
  const target = (arg: string | undefined) => {
    const lit = arg === undefined ? null : literal(arg);
    return lit && !lit.dynamic ? lit.value : null;
  };
  if (/\bfs\b|['"](node:)?fs(\/promises)?['"]/.test(code)) {
    for (const c of matchesWithArgs(code, /(?<![\w$])(?:[\w$]+\.){0,2}(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/g)) {
      out.push({ path: target(c.args[0]), recursive: c.name.startsWith('rm') && /\brecursive\s*:\s*true/.test(c.args.slice(1).join(',')) });
    }
  }
  for (const m of code.matchAll(/\bBun\.file\(([^()]*)\)\.(delete|unlink)\s*\(/g)) out.push({ path: target(m[1]), recursive: false });
  return out;
}

/** Where the code sends data over the network: the URL (\0 for parts known only while running), or null: unknown. */
function pySends(code: string): (string | null)[] {
  const out: (string | null)[] = [];
  const url = (arg: string | undefined) => (arg === undefined ? null : literal(arg)?.value ?? null);
  for (const c of matchesWithArgs(code, /\b(?:requests|httpx)\.(post|put|patch|delete)\s*\(/g)) out.push(url(c.args[0]));
  for (const c of matchesWithArgs(code, /\b(?:requests|httpx)\.request\s*\(/g)) {
    const method = literal(c.args[0] ?? '')?.value.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') out.push(url(c.args[1]));
  }
  // urlopen(url, data) or urlopen(url, data=…) sends a body; urlopen(url, timeout=5) only reads
  for (const c of matchesWithArgs(code, /\burlopen\s*\(/g)) if (c.args.slice(1).some((x, k) => /^data\s*=/.test(x) || (k === 0 && !/^\w+\s*=/.test(x)))) out.push(url(c.args[0]));
  if (/\b(smtplib|ftplib|paramiko)\b/.test(code)) out.push(null);
  if (/\bsocket\.(socket|create_connection)\b/.test(code)) {
    const hosts = [...code.matchAll(/(?:\.connect|create_connection)\(\s*\(\s*([^,]+),/g)].map((m) => literal(m[1]!)?.value ?? null);
    out.push(...(hosts.length ? hosts.map((h) => (h === null ? null : `tcp://${h}`)) : [null]));
  }
  return out;
}

function jsSends(code: string): (string | null)[] {
  const out: (string | null)[] = [];
  const url = (arg: string | undefined) => (arg === undefined ? null : literal(arg)?.value ?? null);
  for (const c of matchesWithArgs(code, /\bfetch\s*\(/g)) if (/\bmethod\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i.test(c.args.slice(1).join(','))) out.push(url(c.args[0]));
  for (const c of matchesWithArgs(code, /\baxios\.(post|put|patch|delete)\s*\(/g)) out.push(url(c.args[0]));
  return out;
}

function reviewCode(code: string, language: string, ctx: AutoContext, depth: number): Stop {
  const py = /py/i.test(language);
  let v: Stop;
  if (SECRET_PATH.test(code) && (v = stop(ctx, 'credentials'))) return v;
  // a server on every network: 0.0.0.0, or Python's socket bound to '' / '::'
  if ((/0\.0\.0\.0/.test(code) || /\.bind\(\s*\(\s*(''|""|'::'|"::")\s*,/.test(code)) && (v = stop(ctx, 'openServer'))) return v;
  // what it runs: the same check as the command line in bash
  for (const command of py ? pyCommands(code) : jsCommands(code)) {
    if (command === null) {
      if ((v = stop(ctx, 'codeCommand'))) return v;
    } else if (depth < 3 && (v = reviewShell(command, ctx, ctx.projectDir, depth + 1))) return v;
  }
  // what it deletes: the same verdict as rm (rm -r for a tree) on that path
  for (const d of py ? pyDeletes(code) : jsDeletes(code)) {
    if (d.path === null) {
      if ((v = stop(ctx, 'codeDeletes'))) return v;
    } else if ((v = reviewWords(['rm', ...(d.recursive ? ['-r'] : []), d.path], ctx, ctx.projectDir, depth))) return v;
  }
  // what it sends: fine to this machine
  for (const target of py ? pySends(code) : jsSends(code)) if ((target === null || !isLoopbackUrl(target)) && (v = stop(ctx, 'sendsData'))) return v;
  // files the code opens for writing: open("/abs/path", "w"), writeFileSync("/abs/path"), Path("/abs").write_text
  const writes = [
    ...code.matchAll(/\bopen\(\s*[rfb]*['"]([^'"]+)['"]\s*,\s*[rfb]*['"][^'"]*[wax+]/g),
    ...code.matchAll(/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|Bun\.write)\(\s*['"`]([^'"`]+)['"`]/g),
    ...code.matchAll(/\bPath\(\s*[rfb]*['"]([^'"]+)['"]\s*\)\.(?:write_text|write_bytes|open\([^)]*[wa])/g),
  ];
  for (const m of writes) if (!writable(m[1]!, ctx) && (v = stop(ctx, 'writesOutside'))) return v;
  return undefined;
}
