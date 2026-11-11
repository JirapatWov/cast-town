// The agent CAST runs: cast-agent, CAST's own fork of omp in the repository's agent/ folder (server/agents/index.ts
// resolveOmpBin). It is omp OMP_TESTED_VERSION. CAST_AGENT_BIN may point at another build: another version still
// starts, with a warning in the server log and a dismissible banner in the app.

/** The agent program's name. */
export const AGENT_NAME = 'cast-agent';

export const OMP_TESTED_VERSION = '18.13.2';

/** Builds the agent (and the web app), in the CAST folder. */
export const AGENT_BUILD_COMMAND = 'bun run build';

/** What to do about a missing agent, in one sentence for logs and error messages. */
export function agentBuildHint(): string {
  return `Build it: run \`${AGENT_BUILD_COMMAND}\` in the CAST folder (or point CAST_AGENT_BIN at a ${AGENT_NAME}).`;
}

/** The x.y.z of an `omp --version` answer ("18.13.2", "omp/18.13.2-cast.1" → "18.13.2"); null without one. */
export function ompCoreVersion(version: string): string | null {
  return version.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

/** The warning for a detected agent that isn't the tested release; null when it is, or when no agent was found (that
 *  has its own message: agents can't start at all). */
export function ompVersionWarning(version: string | null | undefined, tested: string = OMP_TESTED_VERSION): string | null {
  if (!version) return null;
  const core = ompCoreVersion(version);
  if (core && core === ompCoreVersion(tested)) return null;
  return `${AGENT_NAME} ${version} is not the tested version ${tested}, some features may break`;
}
