// Markdown → HTML for agent replies. Raw HTML in model output is escaped (never rendered), links
// are restricted to safe schemes, and remote images are shown as links instead of being loaded.
// With a files context (a person's folder), paths become links to the built-in viewer: link targets, images and
// inline code spans that look like paths, and plain-text paths with a folder in them (`chapters/prologue.md`, finding
// #49 — agents don't always put paths in backticks). Inside the house → <a class="md-file" data-file…> (the caller's click
// delegate opens the viewer; fileRefOf reads it back) and house images become thumbnails; outside the house (or a
// hidden file) → plain text whose tooltip says why it can't be opened.
import { Marked, type Tokens } from 'marked';
import { escapeHtml } from './dom';
import { fileKind, isImageKind } from './file-kinds';
import { looksLikeFilePath, type FileRef, type Resolved } from './file-paths';
import { iconSvg } from './icons';

const SAFE_URL = /^(https?:|mailto:|#)/i;

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_URL.test(trimmed) ? trimmed : null;
}

/** How rendered Markdown finds files (see file-links.ts). */
export interface MdFiles {
  /** Where a link target / image / code span points; null → not a local path (a web link…). */
  resolve(raw: string): Resolved | null;
  /** An image file's URL when it can be shown right away; null → the <img> gets data-pending (fill it later). */
  srcNow(ref: FileRef): string | null;
}

let files: MdFiles | null = null; // the context of the renderMarkdown call in progress (parsing is synchronous)
let inLink = 0; // rendering a link's text: its code spans stay plain (no link inside a link)

function fileAttrs(ref: FileRef): string {
  const job = ref.folder.jobId ? ` data-job="${escapeHtml(ref.folder.jobId)}"` : '';
  const dir = ref.dir ? ' data-dir="1"' : '';
  return `href="#" data-project="${escapeHtml(ref.folder.projectId)}"${job} data-file="${escapeHtml(ref.path)}"${dir}`;
}

function openTitle(ref: FileRef): string {
  return escapeHtml(`Open ${ref.path || 'the folder'} in the viewer`);
}

function fileLink(ref: FileRef, inner: string, cls = 'md-file'): string {
  return `<a class="${cls}" ${fileAttrs(ref)} title="${openTitle(ref)}">${inner}</a>`;
}

function outside(inner: string, why: string, tag: 'span' | 'code' = 'span'): string {
  return `<${tag} class="md-path is-outside" title="${escapeHtml(why)}">${inner}</${tag}>`;
}

function thumb(ref: FileRef, alt: string): string {
  const src = files?.srcNow(ref);
  const img = `<img ${src ? `src="${escapeHtml(src)}"` : 'data-pending=""'} alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
  return `<a class="md-file md-thumb" ${fileAttrs(ref)} title="${openTitle(ref)}">${img}</a>`;
}

/** A path in plain text: folder/…/name.ext (at least one slash; a known file name decides), optionally :line[:col]. */
const TEXT_PATH = /(^|[^\w@+.~/:-])((?:~|\.{1,2})?\/?[\w@+.~-]+(?:\/[\w@+.~-]+)+(?::\d+(?::\d+)?)?)/g;

/** Plain text with the paths inside the house turned into viewer links; null when there are none. */
function linkTextPaths(text: string, ctx: MdFiles): string | null {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TEXT_PATH)) {
    let cand = m[2];
    while (/[.~-]$/.test(cand)) cand = cand.slice(0, -1); // the end of a sentence isn't part of the name
    if (cand.endsWith('/') || !looksLikeFilePath(cand)) continue;
    const r = ctx.resolve(cand);
    if (!r?.ok) continue; // outside the house: plain text, without the noise of a marker in running prose
    const start = m.index + m[1].length;
    out += escapeHtml(text.slice(last, start)) + fileLink(r, escapeHtml(cand), 'md-file md-textpath');
    last = start + cand.length;
  }
  return last ? out + escapeHtml(text.slice(last)) : null;
}

/** A local path when there is no files context: its text only (it used to become a link that 404'd). */
const isLocal = (href: string) => !/^[a-z][a-z0-9+.-]*:/i.test(href.trim()) && !href.trim().startsWith('#');

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    text(token: Tokens.Text | Tokens.Escape) {
      if (token.type !== 'text' || token.tokens || token.escaped || !files || inLink) return false;
      return linkTextPaths(token.text, files) ?? false;
    },
    link({ href, title, tokens }: Tokens.Link) {
      inLink++;
      let inner: string;
      try {
        inner = this.parser.parseInline(tokens);
      } finally {
        inLink--;
      }
      const r = files?.resolve(href);
      if (r) return r.ok ? fileLink(r, inner) : outside(inner, r.why);
      const url = safeHref(href);
      if (!url) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const label = escapeHtml(text || 'image');
      const r = files?.resolve(href);
      if (r) {
        if (!r.ok) return outside(`[${label}]`, r.why);
        return !r.dir && isImageKind(fileKind(r.path)) ? thumb(r, text || r.path) : fileLink(r, `[${label}]`);
      }
      const url = safeHref(href);
      return url && !isLocal(href) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">[${label}]</a>` : `[${label}]`;
    },
    codespan({ text }: Tokens.Codespan) {
      const code = escapeHtml(text);
      if (files && !inLink && looksLikeFilePath(text)) {
        const r = files.resolve(text);
        if (r) return r.ok ? fileLink(r, `<code>${code}</code>`, 'md-file md-codepath') : outside(code, r.why, 'code');
      }
      return `<code>${code}</code>`;
    },
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').split(/\s/)[0];
      const head = `<div class="md-code-head"><span>${escapeHtml(language || 'text')}</span><button type="button" class="md-copy" data-copy aria-label="Copy code">${iconSvg('copy', 13)}<span>Copy</span></button></div>`;
      return `<div class="md-code">${head}<pre><code>${escapeHtml(text)}</code></pre></div>`;
    },
  },
});

/** ctx: resolve paths against a person's folder (file links, thumbnails); without it local paths are plain text. */
export function renderMarkdown(src: string, ctx?: MdFiles | null): string {
  files = ctx ?? null;
  inLink = 0;
  try {
    return md.parse(src, { async: false }) as string;
  } catch (err) {
    console.warn('[ui] markdown render failed', err);
    return `<p>${escapeHtml(src)}</p>`;
  } finally {
    files = null;
  }
}

/** The file a rendered link (a.md-file) points at. */
export function fileRefOf(el: Element): FileRef | null {
  const projectId = el.getAttribute('data-project');
  const path = el.getAttribute('data-file');
  if (!projectId || path === null) return null;
  const jobId = el.getAttribute('data-job') ?? undefined;
  return { folder: jobId ? { projectId, jobId } : { projectId }, path, ...(el.hasAttribute('data-dir') ? { dir: true } : {}) };
}

/** Wire copy buttons inside rendered markdown (event delegation, call once per container). */
/** While a reply is still streaming, close any half-written code fence, inline code or bold run so the
 *  partial text renders as it will look when finished (instead of flashing raw backticks/asterisks). */
export function closeOpenMarkdown(src: string): string {
  const fences = src.match(/^\s*```/gm)?.length ?? 0;
  if (fences % 2 === 1) return `${src}\n\`\`\``;
  const lastBlock = src.slice(src.lastIndexOf('\n\n') + 1);
  let out = src.replace(/\s+$/, '');
  let tail = '';
  const ticks = lastBlock.replace(/```/g, '').match(/`/g)?.length ?? 0;
  if (ticks % 2 === 1) {
    if (out.endsWith('`')) out = out.slice(0, -1);
    else tail += '`';
  }
  const bold = (lastBlock.replace(/`[^`]*`?/g, '').match(/\*\*/g)?.length ?? 0) % 2 === 1;
  if (bold) {
    if (out.endsWith('**')) out = out.slice(0, -2);
    else tail = `${tail}**`;
  }
  return out + tail;
}

export function wireCodeCopy(container: HTMLElement, copy: (text: string) => Promise<boolean>) {
  container.addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.md-code')?.querySelector('code')?.textContent ?? '';
    const ok = await copy(code);
    const label = btn.querySelector('span');
    if (label) {
      label.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => (label.textContent = 'Copy'), 1400);
    }
  });
}
