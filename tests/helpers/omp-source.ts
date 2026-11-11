// Where the agent's TypeScript source lives, for the few tests that check CAST's output with the agent's own code (for
// example tests/auto/p3-helpers.test.ts reads a generated helper-agent file with its parser). It is in agent/, but it
// loads only once agent/ is built (its node_modules), so those tests skip cleanly when it doesn't.
//
// Looked up in order:
//   1. $CAST_OMP_SRC — another omp coding-agent package folder (the one holding src/task/agents.ts), or the root of an
//      omp checkout (then packages/coding-agent inside it is used);
//   2. agent/packages/coding-agent of this repository (cast-agent).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Folders that may hold the agent's coding-agent package source, most specific first. */
export function ompSourceRoots(env: Record<string, string | undefined> = process.env, repoRoot = resolve(import.meta.dir, '../..')): string[] {
  const roots: string[] = [];
  const custom = env.CAST_OMP_SRC?.trim();
  if (custom) roots.push(resolve(custom), resolve(custom, 'packages', 'coding-agent'));
  roots.push(join(repoRoot, 'agent', 'packages', 'coding-agent'));
  return roots;
}

/** Absolute path of `rel` (e.g. "src/task/agents.ts") in the first source found; null when none has it. */
export function ompSourceFile(rel: string, env: Record<string, string | undefined> = process.env, repoRoot?: string): string | null {
  for (const root of ompSourceRoots(env, repoRoot)) {
    const file = join(root, rel);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Import a module of the agent's source, or null when it isn't found or doesn't load (e.g. agent/ not built yet). */
export async function importOmpSource<T>(rel: string): Promise<T | null> {
  const file = ompSourceFile(rel);
  if (!file) return null;
  try {
    return (await import(file)) as T;
  } catch (err) {
    console.warn(`agent source at ${file} did not load (${(err as Error).message}); the tests that need it are skipped`);
    return null;
  }
}
