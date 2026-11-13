// The oldest Bun CAST runs on. One source of truth: package.json `engines.bun` (">=x.y.z"), which the README states
// and CI's newer pinned Bun satisfies. On an older Bun the server (and `bun run pair`) stop at once with what was
// found, what is needed and how to upgrade, instead of failing later in some unrelated way.
import pkg from '../package.json';

/** "1.3.14" from package.json engines.bun (">=1.3.14"). */
export const MIN_BUN_VERSION = pkg.engines.bun.replace(/^\s*>=\s*/, '').trim();

/** x.y.z as numbers; a pre-release or build suffix ("1.4.0-canary.12+abc") counts as that release. */
function parts(version: string): number[] {
  return version.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

/** True when `found` is older than `min` (x.y.z compared as numbers). */
export function bunTooOld(found: string, min: string = MIN_BUN_VERSION): boolean {
  const a = parts(found);
  const b = parts(min);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

/** What to tell the person starting CAST on a Bun older than `min`; null when `found` is new enough. */
export function bunTooOldMessage(found: string, min: string = MIN_BUN_VERSION): string | null {
  if (!bunTooOld(found, min)) return null;
  return `CAST needs Bun ${min} or newer, but this is Bun ${found}. Upgrade with: bun upgrade (then start CAST again).`;
}

/** Stop the process with that message when the running Bun is too old. */
export function exitIfBunTooOld(): void {
  const message = bunTooOldMessage(Bun.version);
  if (!message) return;
  console.error(message);
  process.exit(1);
}
