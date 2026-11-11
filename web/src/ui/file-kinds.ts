// What kind of file a name is, for the built-in viewer: which renderer shows it, how to highlight it, its label.
// Pure (no DOM): the chat's path links and the viewer share it.

export type FileKind =
  | 'image' // png, jpg, gif, webp, avif, bmp, ico: an <img>
  | 'svg' // an <img> too (its scripts never run there), with a Source toggle
  | 'html' // a sandboxed <iframe>
  | 'pdf' // an <iframe> without a sandbox attribute (a sandboxed one kills Chrome's PDF viewer)
  | 'markdown'
  | 'json'
  | 'csv'
  | 'tsv'
  | 'audio'
  | 'video'
  | 'code' // highlighted text
  | 'text' // plain text
  | 'binary' // known not to be text: a card with Download
  | 'unknown'; // no idea from the name: the viewer peeks at what the server says it is

const EXT: Record<Exclude<FileKind, 'unknown'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'apng', 'jfif'],
  svg: ['svg'],
  html: ['html', 'htm', 'xhtml'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown', 'mdx', 'mdown'],
  json: ['json', 'jsonc', 'json5', 'geojson', 'webmanifest', 'ipynb'],
  csv: ['csv'],
  tsv: ['tsv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
  code: [
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'sass', 'less', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt',
    'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'yaml', 'yml', 'toml', 'ini',
    'cfg', 'conf', 'xml', 'xsl', 'plist', 'sql', 'diff', 'patch', 'vue', 'svelte', 'astro', 'swift', 'lua', 'r', 'dart', 'ex', 'exs',
    'erl', 'hs', 'ml', 'clj', 'scala', 'pl', 'gradle', 'proto', 'graphql', 'gql', 'tf', 'hcl', 'nix', 'zig', 'sol', 'glsl', 'wgsl',
    'lock', 'properties', 'dockerfile', 'mk', 'cmake', 'bat', 'cmd', 'vb', 'm', 'jl', 'elm', 'fs', 'fsx', 'groovy', 'prisma',
  ],
  text: ['txt', 'log', 'rst', 'adoc', 'tex', 'srt', 'vtt', 'text', 'out', 'err', 'nfo'],
  binary: [
    'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'o', 'a', 'class', 'jar',
    'woff', 'woff2', 'ttf', 'otf', 'eot', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'psd', 'ai', 'sketch',
    'fig', 'blend', 'glb', 'gltf', 'fbx', 'obj', 'stl', 'hdr', 'exr', 'tif', 'tiff', 'heic', 'heif', 'sqlite', 'db', 'pyc', 'iso', 'dmg',
    'mid', 'midi', 'avi', 'mkv', 'wmv', 'flv',
  ],
};

/** Files known by their whole name (no extension). */
const NAMES: Record<string, FileKind> = {
  makefile: 'code', dockerfile: 'code', containerfile: 'code', gemfile: 'code', rakefile: 'code', procfile: 'code',
  vagrantfile: 'code', jenkinsfile: 'code', brewfile: 'code', justfile: 'code', readme: 'text', license: 'text', licence: 'text',
  changelog: 'text', authors: 'text', contributors: 'text', notice: 'text', copying: 'text', todo: 'text',
};

const KIND_OF = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(EXT) as [FileKind, string[]][]) for (const e of exts) KIND_OF.set(e, kind);

/** The lower-case extension without its dot; '' for none, a dotfile (".env") or a trailing dot. */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 || i === base.length - 1 ? '' : base.slice(i + 1).toLowerCase();
}

export function baseName(path: string): string {
  const p = path.replace(/\/+$/, '');
  return p.slice(p.lastIndexOf('/') + 1);
}

/** The folder part of a '/'-separated path ('' at the top). */
export function dirName(path: string): string {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function fileKind(name: string): FileKind {
  const ext = extOf(name);
  if (ext) return KIND_OF.get(ext) ?? 'unknown';
  return NAMES[baseName(name).toLowerCase()] ?? 'unknown';
}

/** A name the chat may link even without a folder in it: a known extension or a well-known file name. */
export function isKnownFileName(name: string): boolean {
  const base = baseName(name);
  if (!base || base.startsWith('.')) return false;
  const ext = extOf(base);
  return ext ? KIND_OF.has(ext) : base.toLowerCase() in NAMES;
}

/** Kinds that show as a picture (a thumbnail in the chat). */
export function isImageKind(kind: FileKind): boolean {
  return kind === 'image' || kind === 'svg';
}

/** The PDF frame is the one viewer frame without a sandbox attribute (Chrome's PDF viewer dies in one): only what the
 *  server really serves as a PDF goes in it. A folder named "x.pdf" redirects to its index.html — a page whose own CSP
 *  allows alert(), which an unsandboxed frame would let lock the CAST tab. */
export function pdfFrameOk(contentType: string): boolean {
  return /^application\/pdf\s*(;|$)/i.test(contentType.trim());
}

/** The `cast` field of the messages a web page's frame shell sends the viewer (server/files.ts PAGE_MESSAGE_TAG). */
export const PAGE_MESSAGE_TAG = 'cast-viewer';

/** What a web page may tell the viewer: "open this link" (it can't open popups or leave its frame itself) and "the
 *  browser blocked a load from this host" (CAST's CSP lets pages load only from known CDNs). */
export type PageMessage = { t: 'open'; url: string } | { t: 'blocked'; host: string; directive: string };

/** A page shell's message, checked field by field (page code can send anything); null when it isn't one. */
export function pageMessage(data: unknown): PageMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.cast !== PAGE_MESSAGE_TAG) return null;
  if (m.t === 'open' && typeof m.url === 'string' && m.url.length <= 4096) return { t: 'open', url: m.url };
  if (m.t === 'blocked' && typeof m.host === 'string' && m.host.length > 0 && m.host.length <= 255) {
    return { t: 'blocked', host: m.host, directive: typeof m.directive === 'string' ? m.directive.slice(0, 64) : '' };
  }
  return null;
}

export type OpenTarget = { kind: 'house'; url: string } | { kind: 'site'; url: string; host: string };

/** Where a page's "open this" may go: a file of the same house (under its key's `base` on CAST's own origin) opens in
 *  a new tab as is; another site (http/https, mailto, tel) only after the user says yes; anything else — CAST's own
 *  pages, javascript:, data:, blob:… — never (null). */
export function openTarget(raw: string, origin: string, base: string | null): OpenTarget | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.origin === origin) return base && u.pathname.startsWith(base) ? { kind: 'house', url: u.href } : null;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return { kind: 'site', url: u.href, host: u.host };
  if (u.protocol === 'mailto:') return { kind: 'site', url: u.href, host: 'your mail app' };
  if (u.protocol === 'tel:') return { kind: 'site', url: u.href, host: 'your phone app' };
  return null;
}

/** Kinds worth a visible "View" button on a tool card (code and text get a quieter one). */
export function isVisualKind(kind: FileKind): boolean {
  return kind !== 'code' && kind !== 'text' && kind !== 'unknown' && kind !== 'binary' && kind !== 'json';
}

// highlight.js languages bundled lazily (web/src/ui/hljs.ts): the 13 common ones plus ini (covers toml).
const LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json', webmanifest: 'json', ipynb: 'json',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', xsl: 'xml', svg: 'xml', plist: 'xml', vue: 'xml', svelte: 'xml', astro: 'xml',
  py: 'python', pyi: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', mdown: 'markdown',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
};

/** The highlight.js language for a file, or null (shown as plain text). */
export function hljsLanguage(name: string): string | null {
  const ext = extOf(name);
  if (ext) return LANG[ext] ?? null;
  return baseName(name).toLowerCase() === 'dockerfile' || baseName(name).toLowerCase() === 'makefile' ? 'bash' : null;
}

const KIND_LABEL: Record<FileKind, string> = {
  image: 'Image', svg: 'SVG image', html: 'Web page', pdf: 'PDF', markdown: 'Markdown', json: 'JSON', csv: 'CSV table',
  tsv: 'TSV table', audio: 'Audio', video: 'Video', code: 'Code', text: 'Text', binary: 'File', unknown: 'File',
};

/** "PNG image", "Web page", "TypeScript"-ish short label for the viewer's header. */
export function kindLabel(name: string, kind: FileKind = fileKind(name)): string {
  const ext = extOf(name).toUpperCase();
  if (kind === 'image') return ext ? `${ext} image` : 'Image';
  if (kind === 'code' || kind === 'binary' || (kind === 'text' && ext)) return ext ? `${ext} file` : KIND_LABEL[kind];
  return KIND_LABEL[kind];
}

/** Icon name (icons.ts / viewer-icons.ts) for a kind. */
export function kindIcon(kind: FileKind): string {
  switch (kind) {
    case 'image':
    case 'svg':
      return 'image';
    case 'html':
      return 'globe';
    case 'pdf':
    case 'markdown':
    case 'text':
      return 'doc';
    case 'json':
    case 'code':
      return 'code';
    case 'csv':
    case 'tsv':
      return 'table';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
      return 'file';
  }
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
