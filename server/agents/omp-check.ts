// Running omp's short commands (`omp --version`, `omp models --json`) and telling their failures apart.
//
// On a slow or busy machine omp can take a minute to answer: a timeout is not "omp not found". Every caller gets one
// of four outcomes so the log and the app can say what really happened:
//   ok       — it answered (stdout)
//   missing  — nothing to run at that path (ENOENT / EACCES), or the launcher found no build (exit 127)
//   timeout  — it runs but didn't answer within the limit (killed)
//   failed   — it answered with an error exit code (stderr tail)
//
// Env knobs:
//   CAST_AGENT_TIMEOUT        seconds `omp --version` / `omp models` may take (default 60)
//   CAST_AGENT_START_TIMEOUT  seconds a person's omp may take to start (default 45; omp-process.ts waits longer while
//                             omp still reports startup progress, up to 4×)
import { spawn, type ChildProcess } from 'node:child_process';
import { agentBuildHint } from '../../shared/omp-version';
import { trackGroup } from '../child-groups';
import { tail } from './util';

/** CAST_<name>, else the older RLT_<name> (trimmed; undefined when neither is set). */
export function envSetting(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[`CAST_${name}`]?.trim() || env[`RLT_${name}`]?.trim();
  return v || undefined;
}

export interface OmpTimeouts {
  /** `omp --version` and `omp models --json`. */
  checkMs: number;
  /** A person's omp, from spawn to its `ready` frame (the base: it is extended while omp reports progress). */
  startMs: number;
}

export const DEFAULT_CHECK_TIMEOUT_S = 60;
export const DEFAULT_START_TIMEOUT_S = 45;

function seconds(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  // Under 5 s omp can't even load on a fast machine; over an hour is a typo.
  return Number.isFinite(n) && n >= 5 && n <= 3600 ? n : fallback;
}

export function ompTimeouts(env: Record<string, string | undefined>): OmpTimeouts {
  return {
    checkMs: seconds(env.CAST_AGENT_TIMEOUT, DEFAULT_CHECK_TIMEOUT_S) * 1000,
    startMs: seconds(env.CAST_AGENT_START_TIMEOUT, DEFAULT_START_TIMEOUT_S) * 1000,
  };
}

export type OmpRun =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' | 'timeout' | 'failed'; error: string };

/** How to get the agent, said once for every message that needs it. */
export const AGENT_BUILD_HINT = agentBuildHint();

/** Run `omp <args>` once, killed after `timeoutMs`. Never throws. omp runs in its own process group and the whole
 *  group is killed on a timeout: whatever omp started (its bun runtime, workers) must not linger — nor keep the
 *  output pipes open, which would hold the answer up until they finish. */
export function runOmp(bin: string, args: string[], env: Record<string, string | undefined>, timeoutMs: number, cwd?: string): Promise<OmpRun> {
  return new Promise<OmpRun>((resolve) => {
    let settled = false;
    const done = (r: OmpRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: cwd ?? env.HOME ?? '/', env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve(spawnError(bin, err));
      return;
    }
    const untrack = trackGroup(child.pid); // a shutdown while it runs kills the group (child-groups.ts)
    child.once('exit', untrack);
    child.once('error', untrack);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-16_000)));
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      done({ kind: 'timeout', error: `the agent didn't answer within ${Math.round(timeoutMs / 1000)} s (the computer may be busy)` });
    }, timeoutMs);
    child.once('error', (err) => done(spawnError(bin, err)));
    child.once('close', (code, signal) => {
      if (code === 0) return done({ kind: 'ok', stdout });
      // agent/bin/cast-agent exits 127 when it hasn't been built: as good as not there
      if (code === 127 && !signal) return done({ kind: 'missing', error: `the agent (cast-agent) isn't built at ${bin}` });
      const why = stderr.trim() ? `: ${tail(stderr.trim().split('\n').slice(-3).join(' · '), 300)}` : '';
      const what = args[0] && !args[0].startsWith('-') ? `cast-agent ${args[0]}` : 'cast-agent';
      done({ kind: 'failed', error: signal ? `${what} was killed (${signal})${why}` : `${what} exited with code ${code}${why}` });
    });
  });
}

function spawnError(bin: string, err: unknown): OmpRun {
  const code = (err as { code?: string }).code ?? '';
  const text = err instanceof Error ? err.message : String(err);
  if (code === 'ENOENT' || code === 'EACCES' || /ENOENT|EACCES|no such file/i.test(text)) return { kind: 'missing', error: `the agent (cast-agent) wasn't found at ${bin}` };
  return { kind: 'failed', error: `couldn't run the agent (${text})` };
}

export type VersionProbe = { kind: 'ok'; version: string } | { kind: 'missing' | 'timeout' | 'failed'; error: string };

/** `omp --version` → "18.13.2" (or what it printed), with the reason when it couldn't be read. */
export async function probeOmpVersion(bin: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<VersionProbe> {
  const r = await runOmp(bin, ['--version'], env, timeoutMs);
  if (r.kind !== 'ok') return r;
  const out = r.stdout.trim();
  const version = out.match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? out.split('\n')[0]?.trim();
  return version ? { kind: 'ok', version } : { kind: 'failed', error: 'cast-agent --version printed nothing' };
}
