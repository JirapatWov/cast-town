// How this server was started: from a source checkout (`bun run server/index.ts`) or as one compiled file
// (`bun run build:server` = `bun build --compile`, the Mac app's CAST.app/Contents/Resources/cast-server).
//
// Inside a compiled binary import.meta.dir is a virtual folder (/$bunfs/root, or B:\~BUN\root on Windows) with no
// repository around it: the code is embedded, but web/dist, package.json and the old in-repo data folder are not.
// So nothing may read a file relative to the source tree at run time. What the server needs instead:
//   - its version: embedded at build time (config.ts imports package.json, which the bundler inlines);
//   - the web app: CAST_WEB_DIST, else web/dist next to the binary (the kit and CAST.app both put it there);
//   - the agent: CAST_AGENT_BIN, else the cast-agent next to the binary (agents/index.ts resolveOmpBin);
//   - everything else it writes or reads lives in the data folder, or is a string in the code (project templates,
//     helper agents, the scripted test model's scripts, the server's own HTML pages).
// The legacy `<repo>/data` folder is never looked for in a binary (there is no repo).
import { dirname, resolve } from 'node:path';

/** True for the virtual folder a `bun build --compile` binary runs its code from. */
export function isCompiledDir(dir: string): boolean {
  return dir.startsWith('/$bunfs/') || dir === '/$bunfs' || /^[A-Za-z]:[\\/]~BUN([\\/]|$)/.test(dir);
}

/** This process is a compiled CAST binary (not `bun run server/index.ts`). */
export const COMPILED = isCompiledDir(import.meta.dir);

/** The source checkout this server runs from; null in a compiled binary. */
export const SOURCE_ROOT: string | null = COMPILED ? null : resolve(import.meta.dir, '..');

/** The folder of the running executable: the compiled binary's own folder (web/dist and cast-agent sit beside it). In
 *  a source checkout this is wherever bun is installed, so only compiled code may rely on it. */
export function binaryDir(execPath: string = process.execPath): string {
  return dirname(execPath);
}

/** Who started the server and supervises it: 'mac-app' when the CAST menu-bar app did (CAST_LAUNCHED_BY=mac-app). The
 *  app restarts the server itself, shows the pairing link from its menu, and stops it with SIGTERM on Quit. */
export function launchedBy(env: Record<string, string | undefined> = process.env): 'mac-app' | null {
  const v = (env.CAST_LAUNCHED_BY ?? env.RLT_LAUNCHED_BY ?? '').trim().toLowerCase();
  return v === 'mac-app' ? 'mac-app' : null;
}

/** The command line that starts this same server again: `bun server/index.ts …` from source, `cast-server …` compiled
 *  (there process.argv[1] is the virtual entry path, which the binary must not get as an argument). */
export function selfCommand(compiled = COMPILED, execPath = process.execPath, argv = process.argv): string[] {
  return compiled ? [execPath, ...argv.slice(2)] : [execPath, ...argv.slice(1)];
}
