// The process groups CAST started and still owns: omp sessions, omp checks (`--version`, `models`, `usage`), sign-ins
// and terminal shells. Each is spawned detached (its own process group, so one signal reaches everything it started)
// and registered here until its leader exits. On shutdown the server first stops them politely (agents, terminals);
// whatever is still listed then is SIGKILLed as the last step, so nothing CAST started outlives it — the Mac app sends
// SIGTERM on Quit and expects a clean exit within 10 s.
const groups = new Set<number>();

/** Remember a detached child's process group; call the returned function when its leader has exited. */
export function trackGroup(pid: number | undefined | null): () => void {
  if (!pid || pid <= 1) return () => {};
  groups.add(pid);
  return () => {
    groups.delete(pid);
  };
}

/** The process groups still listed (tests, logs). */
export function trackedGroups(): number[] {
  return [...groups];
}

/** Signal every listed process group; returns how many were still there. Listed groups stay listed until their
 *  leaders' exit handlers remove them. */
export function signalTrackedGroups(sig: NodeJS.Signals = 'SIGKILL'): number {
  let hit = 0;
  for (const pid of groups) {
    try {
      process.kill(-pid, sig);
      hit++;
    } catch {
      groups.delete(pid); // gone (ESRCH): nothing left to stop
    }
  }
  return hit;
}
