// A short key for "what omp is signed in to" that changes only when the sign-ins do (#69): a sign-in, a sign-out, an
// account omp disabled, a models.yml / config.yml edit. Asking omp itself (`omp models`, the accounts list) starts an
// omp process of a few hundred MB, so CAST only does that again when this key moved.
//
// omp keeps its credentials in <agentDir>/agent.db (SQLite, table auth_credentials) — next to usage counters, caches
// and settings that change with every chat turn, so the file's mtime says little. The key reads the credential rows'
// id, provider, type, disabled cause and identity (never the secret `data` column), read-only, and hashes them. When
// the store can't be read (no SQLite there, locked, another layout), it falls back to the file's mtime and size: more
// checks than needed, never fewer.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** omp's own config files: a change there can change which models exist. */
const CONFIG_FILES = ['models.yml', 'models.yaml', 'models.json', 'config.yml', 'config.yaml'];
/** The credential store and its write-ahead log (the fallback stamps both). */
const STORE_FILES = ['agent.db', 'agent.db-wal'];
/** What identifies a sign-in, without its secret. Older stores lack some of these columns. */
const COLUMNS = ['id', 'provider', 'credential_type', 'disabled_cause', 'identity_key'];

function stamp(dir: string, file: string): string {
  try {
    const st = statSync(join(dir, file));
    return `${file}:${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return `${file}:-`;
  }
}

/** Hash of the stored sign-ins ('none' without a store), or null when the store can't be read as omp's SQLite. */
export function credentialRowsDigest(dbPath: string): string | null {
  if (!existsSync(dbPath)) return 'none';
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.run('PRAGMA busy_timeout = 250'); // omp may be writing: wait a moment rather than fall back at once
    const have = new Set((db.query('PRAGMA table_info(auth_credentials)').all() as { name: string }[]).map((c) => c.name));
    if (!have.has('id') || !have.has('provider')) return null;
    const cols = COLUMNS.filter((c) => have.has(c));
    const rows = db.query(`SELECT ${cols.join(', ')} FROM auth_credentials ORDER BY id`).values();
    return createHash('sha256').update(JSON.stringify([cols, rows])).digest('hex').slice(0, 20);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/** The key for omp's agent dir ('' without one: then nothing is ever "unchanged"). */
export function credentialKey(agentDir: string | undefined): string {
  if (!agentDir) return '';
  const rows = credentialRowsDigest(join(agentDir, 'agent.db'));
  const store = rows !== null ? `auth:${rows}` : STORE_FILES.map((f) => stamp(agentDir, f)).join('|');
  return [store, ...CONFIG_FILES.map((f) => stamp(agentDir, f))].join('|');
}
