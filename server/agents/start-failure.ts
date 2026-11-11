// A person's omp didn't start: say why in a line a person understands, and keep omp's own output for "Details".
// (A wall of raw stderr in the chat — log paths, PI_DEBUG_STARTUP hints — looked like a crash, and on a phone it
// filled the whole transcript.)
import { OmpStartTimeout } from './omp-process';
import { AGENT_BUILD_HINT } from './omp-check';
import { errorText } from './util';

export type StartFailureKind = 'missing' | 'timeout' | 'credentials' | 'exited' | 'model' | 'other';

export interface StartFailure {
  kind: StartFailureKind;
  /** One plain sentence or two, shown in the chat and the composer. */
  summary: string;
  /** omp's own words and what to try, behind "Details". */
  details: string;
}

export interface StartFailureContext {
  name: string; // "Assistant"
  modelLabel: string; // "Claude Opus 5.5"
  ompBin: string;
  /** CAST_AGENT_START_TIMEOUT in seconds (the base wait). */
  startTimeoutS: number;
}

export function describeStartFailure(err: unknown, c: StartFailureContext): StartFailure {
  const raw = errorText(err);
  if (err instanceof OmpStartTimeout) {
    return {
      kind: 'timeout',
      summary: `${c.name} took too long to start (over ${err.seconds} s). The computer may be busy — try again.`,
      details: [
        err.progressed ? 'The agent was still starting up (it kept reporting progress) when CAST stopped waiting.' : 'The agent said nothing while it was starting.',
        `To give it more time, start CAST with CAST_AGENT_START_TIMEOUT=<seconds> (now ${c.startTimeoutS}; CAST waits up to 4× that while the agent reports progress).`,
        err.stderr.trim() ? `\nThe agent's output:\n${err.stderr.trim().slice(-4000)}` : '',
      ].filter(Boolean).join('\n'),
    };
  }
  if (/ENOENT|EACCES|no such file/i.test(raw) && /Could not start the agent/i.test(raw)) {
    return {
      kind: 'missing',
      summary: `${c.name} couldn't start: the agent (cast-agent) wasn't found at ${c.ompBin}.`,
      details: `${AGENT_BUILD_HINT}\n\n${raw}`,
    };
  }
  if (/No API key|No default model|credential|not authenticated|unauthori[sz]ed|login required/i.test(raw)) {
    return {
      kind: 'credentials',
      summary: `${c.name} couldn't start: ${c.modelLabel} needs a sign-in. Sign in under Models & providers, or pick another model.`,
      details: raw,
    };
  }
  if (/refusing to run on a different model|instead of the requested/i.test(raw)) {
    return {
      kind: 'model',
      summary: `${c.name} couldn't start: the agent would have used another model than ${c.modelLabel}, and CAST never swaps models silently.`,
      details: raw,
    };
  }
  const exited = /^The agent exited \(code ([^,)]+)(?:, (\w+))?\)/.exec(raw);
  if (exited) {
    const how = exited[2] ? `was stopped (${exited[2]})` : `quit (exit code ${exited[1]})`;
    return { kind: 'exited', summary: `${c.name} couldn't start: the agent ${how} while starting.`, details: raw };
  }
  if (/The agent didn't answer the \S+ command in time/i.test(raw)) {
    return { kind: 'timeout', summary: `${c.name} couldn't start: the agent started but didn't answer CAST in time. The computer may be busy — try again.`, details: raw };
  }
  return { kind: 'other', summary: `${c.name} couldn't start.`, details: raw };
}
