// What the people of this town can reach on this machine, sent with hello so the welcome card and Models & providers
// can say it plainly and truthfully (instead of a hard-coded ~/.omp/agent, or nothing at all).
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { MachineInfo } from '../shared/protocol';

/** The OS user this server runs as: every omp, helper and terminal shell it starts runs as the same user. */
function osUser(env: Record<string, string | undefined>): string {
  try {
    return userInfo().username;
  } catch {
    return env.USER || env.LOGNAME || 'this user';
  }
}

/** omp's own folder for sign-ins and keys: what omp itself reads (PI_CODING_AGENT_DIR, else ~/.omp/agent). */
export function ompAgentDir(env: Record<string, string | undefined> = process.env): string {
  const set = env.PI_CODING_AGENT_DIR?.trim();
  return set ? resolve(set) : join(env.HOME || homedir(), '.omp', 'agent');
}

export function machineInfo(fsRoots: string[], env: Record<string, string | undefined> = process.env): MachineInfo {
  return { runAs: osUser(env), home: env.HOME || homedir(), agentDir: ompAgentDir(env), fsRoots };
}
