// Fake omp binaries for the resilience tests: small bash scripts that answer `--version` / `models --json` the way a
// healthy, slow, broken or missing omp would, and count how often they were run.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
export function tmp(prefix = 'cast-test-res-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
export function cleanupTmp(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface FakeOmpOptions {
  version?: string; // printed by --version (default 18.13.2)
  models?: { provider: string; id: string }[];
  /** seconds `models` sleeps before answering */
  modelsDelay?: number;
  /** seconds `--version` sleeps */
  versionDelay?: number;
  /** exit code of `models` (0 = answer) */
  modelsExit?: number;
  /** a bare --mode rpc-ui run: what it does (default: exit 3) */
  rpc?: string;
}

/** Writes <dir>/<name>.sh; `<dir>/<name>.count` gets one line per `models` run. */
export function fakeOmp(dir: string, name: string, o: FakeOmpOptions = {}): { bin: string; count: () => number } {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `${name}.sh`);
  const countFile = join(dir, `${name}.count`);
  const json = JSON.stringify({ models: (o.models ?? []).map((m) => ({ ...m, selector: `${m.provider}/${m.id}` })) });
  writeFileSync(
    bin,
    `#!/bin/bash
if [ "$1" = "--version" ]; then sleep ${o.versionDelay ?? 0}; echo "omp/${o.version ?? '18.13.2'}"; exit 0; fi
if [ "$1" = "models" ]; then echo run >> ${countFile}; sleep ${o.modelsDelay ?? 0}; if [ ${o.modelsExit ?? 0} -ne 0 ]; then echo "boom: no config" >&2; exit ${o.modelsExit ?? 0}; fi; echo '${json}'; exit 0; fi
${o.rpc ?? 'exit 3'}
`,
  );
  chmodSync(bin, 0o755);
  return { bin, count: () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length : 0) };
}
