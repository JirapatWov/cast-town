// Auto mode: RLT answers omp's tool approvals itself and only asks the user about risky steps, like Claude Code's
// auto mode — but with rules instead of a model, so it is instant, free and says why it stopped. omp runs these
// projects with --approval-mode always-ask, so every edit, command, code run and helper comes through here first.
// It never denies on its own: a step it doesn't clear goes to the user as a normal approval card with the reason.
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { ASK, JS_RULES, PY_RULES, SHELL_RULES } from '../../shared/auto-rules';

export type AutoVerdict = { allow: true } | { allow: false; reason: string };

const ALLOW: AutoVerdict = { allow: true };
const ask = (reason: string): AutoVerdict => ({ allow: false, reason });

/** omp's approval text cuts long values here (truncateForPrompt): what follows wasn't shown, so it can't be cleared. */
const ELIDED = /\[…\d+ch elided…\]/;

const FILE_TOOLS = new Set(['write', 'edit', 'ast_edit', 'notebook', 'notebook_edit']);
/** Build output and caches: deleting them is routine and they come back on the next build/install. */
const REGENERABLE = /^(\.\/)?(dist|build|out|coverage|node_modules|\.next|\.nuxt|\.cache|\.turbo|\.parcel-cache|__pycache__|\.pytest_cache|\.mypy_cache|target|tmp|\.tmp)(\/.*)?$/;

const SECRET_PATH = /(^|[\s/'"=])(\.ssh\/|id_(rsa|ed25519|ecdsa)\b|\.aws\/|\.config\/gcloud|\.omp\/agent|\.netrc\b|\.npmrc\b|\.pypirc\b|\.git-credentials\b|\.docker\/config\.json|\/etc\/(passwd|shadow|sudoers))/;
const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa))$/;

export interface AutoContext {
  projectDir: string;
}

/** Review one approval: `args` are the tool call's real arguments when RLT saw it start, else parsed from `detail`. */
export function autoReview(tool: string, detail: string | undefined, args: unknown, ctx: AutoContext): AutoVerdict {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const field = (label: string) => fieldOf(detail, label);

  if (tool === 'task') return ALLOW; // helpers' own edits and commands come back here one by one
  if (FILE_TOOLS.has(tool)) {
    const paths = filePaths(detail);
    if (!paths.length && str('path')) paths.push(str('path')!);
    if (!paths.length || paths.some((p) => ELIDED.test(p) || p === '(unknown)' || p === '(missing)')) return ask("couldn't tell which file it changes");
    for (const p of paths) {
      const v = reviewPath(p, ctx);
      if (!v.allow) return v;
    }
    return ALLOW;
  }
  if (tool === 'bash') {
    const command = str('command') ?? field('Command');
    if (!command || (!str('command') && ELIDED.test(command))) return ask('the command is too long to check');
    return reviewShell(command, ctx);
  }
  if (tool === 'eval') {
    const code = str('code') ?? field('Code');
    if (!code || (!str('code') && ELIDED.test(code))) return ask('the code is too long to check');
    const lang = (str('language') ?? field('Language') ?? '').toLowerCase();
    return reviewCode(code, /py/.test(lang) ? PY_RULES : JS_RULES, ctx);
  }
  return ask(`auto mode doesn't know the “${tool}” tool`);
}

function fieldOf(detail: string | undefined, label: string): string | undefined {
  if (!detail) return undefined;
  const m = new RegExp(`(?:^|\\n)${label}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n[A-Z][a-z]+:|(?![\\s\\S]))`).exec(detail);
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

/** Where the agent may write without asking: its project, scratch space, and omp's own session storage. */
function writable(path: string, ctx: AutoContext): boolean {
  const abs = resolve(ctx.projectDir, path.replace(/^~(?=\/|$)/, homedir()));
  return inside(ctx.projectDir, abs) || inside(tmpdir(), abs) || inside('/tmp', abs) || abs === '/dev/null';
}

function reviewPath(path: string, ctx: AutoContext): AutoVerdict {
  const scheme = /^([a-z][\w+.-]*):\/\//i.exec(path)?.[1];
  if (scheme) return scheme === 'local' ? ALLOW : ask(`writes to ${scheme}:// storage`);
  if (!writable(path, ctx)) return ask(ASK.outside);
  if (SECRET_FILE.test(path)) return ask(ASK.secretsFile);
  if (/(^|\/)\.git\//.test(path)) return ask(ASK.gitInternals);
  return ALLOW;
}

function reviewShell(command: string, ctx: AutoContext): AutoVerdict {
  const cmd = command.replace(/\\\n/g, ' ');
  if (SECRET_PATH.test(cmd)) return ask(ASK.credentials);
  for (const [re, reason] of SHELL_RULES) if (re.test(cmd)) return ask(reason);
  for (const seg of cmd.split(/&&|\|\||[;\n|]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const verdict = reviewWords(words, ctx);
    if (!verdict.allow) return verdict;
  }
  // redirections: `> file`, `>> file`, `tee file`
  for (const m of cmd.matchAll(/(?:^|[^0-9&<>])>{1,2}\s*([^\s;&|<>]+)/g)) {
    if (!writable(unquote(m[1]), ctx)) return ask(ASK.writesOutside);
  }
  return ALLOW;
}

function reviewWords(words: string[], ctx: AutoContext): AutoVerdict {
  const [bin, ...rest] = words;
  if (!bin) return ALLOW;
  const paths = rest.filter((w) => !w.startsWith('-')).map(unquote);
  if (bin === 'rm' || bin === 'rmdir' || bin === 'shred' || bin === 'unlink') {
    const recursive = rest.some((w) => /^-\w*[rR]/.test(w) || w === '--recursive');
    for (const p of paths) {
      if (/[*?]/.test(p) && !p.includes('/')) {
        if (recursive) return ask(ASK.wildcard);
        continue;
      }
      if (!writable(p, ctx)) return ask(ASK.deletesOutside);
      const rel = relative(ctx.projectDir, resolve(ctx.projectDir, p));
      if (recursive && (rel === '' || !REGENERABLE.test(rel))) return ask(ASK.deletesFolder);
    }
    return ALLOW;
  }
  if (['mv', 'cp', 'ln', 'tee', 'install', 'touch', 'mkdir', 'truncate'].includes(bin)) {
    const targets = bin === 'tee' || bin === 'touch' || bin === 'mkdir' || bin === 'truncate' ? paths : paths.slice(-1);
    if (bin === 'mv' && paths.some((p) => !writable(p, ctx))) return ask(ASK.movesOutside);
    for (const p of targets) if (!writable(p, ctx)) return ask(ASK.writesOutside);
  }
  return ALLOW;
}

function reviewCode(code: string, rules: [RegExp, string][], ctx: AutoContext): AutoVerdict {
  if (SECRET_PATH.test(code)) return ask(ASK.credentials);
  if (/0\.0\.0\.0/.test(code)) return ask(ASK.openServer);
  for (const [re, reason] of rules) if (re.test(code)) return ask(reason);
  // files the code opens for writing: open("/abs/path", "w"), writeFileSync("/abs/path"), Path("/abs").write_text
  const writes = [
    ...code.matchAll(/\bopen\(\s*[rfb]*['"]([^'"]+)['"]\s*,\s*[rfb]*['"][^'"]*[wax+]/g),
    ...code.matchAll(/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|Bun\.write)\(\s*['"`]([^'"`]+)['"`]/g),
    ...code.matchAll(/\bPath\(\s*[rfb]*['"]([^'"]+)['"]\s*\)\.(?:write_text|write_bytes|open\([^)]*[wa])/g),
  ];
  for (const m of writes) if (!writable(m[1], ctx)) return ask(ASK.writesOutside);
  return ALLOW;
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}
