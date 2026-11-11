// What a tool card shows as the tool's input (finding #28: "read project folder" showed `Input { "path": "." }` —
// JSON is a programmer's word for "what it was asked"). Simple inputs read as lines of words: "Path: this folder".
// Anything nested or long stays pretty-printed JSON, which is still the clearest form for it. Pure, for tests.

const MAX_JSON = 4000;
const MAX_KEYS = 8;
const MAX_VALUE = 400;

type Scalar = string | number | boolean | null;
const isScalar = (v: unknown): v is Scalar => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** "file_path" / "filePath" → "File path". */
export function keyWords(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const PATH_KEY = /^(path|dir|directory|cwd|folder|root|file_?path)$/i;

function valueWords(key: string, v: Scalar): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' && PATH_KEY.test(key) && (v === '.' || v === './' || v === '')) return 'this folder';
  return String(v);
}

/** The tool's input as text for the card, or null when there is none. */
export function toolArgsText(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === 'string') return args;
  if (typeof args === 'object' && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    if (!entries.length) return null;
    const simple =
      entries.length <= MAX_KEYS &&
      entries.every(([, v]) => (isScalar(v) && String(v).length <= MAX_VALUE) || (Array.isArray(v) && v.length <= 6 && v.every((x) => isScalar(x) && String(x).length <= 120)));
    if (simple) {
      return entries
        .map(([k, v]) => {
          const text = Array.isArray(v) ? (v.length ? v.map((x) => valueWords(k, x as Scalar)).join(', ') : '—') : valueWords(k, v as Scalar);
          // a multi-line value (a command, a short snippet) starts on its own line
          return text.includes('\n') ? `${keyWords(k)}:\n${text}` : `${keyWords(k)}: ${text}`;
        })
        .join('\n');
    }
  }
  try {
    const text = JSON.stringify(args, null, 2);
    return text.length > MAX_JSON ? `${text.slice(0, MAX_JSON)}\n…` : text;
  } catch {
    return String(args);
  }
}
