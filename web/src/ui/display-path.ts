// Folder paths as people can tell them apart. Long absolute paths cut at the end all look the same
// ("/tmp/build-cache/runner-7f3a9c/session-…") — the part that names the folder is the end, so shorten the middle instead,
// and write the home folder as "~". Pure: callers put the full path in a tooltip.

/** "/home/me/code/app" → "~/code/app" when home is "/home/me"; other paths as they are. */
export function tildePath(path: string, home?: string | null): string {
  const h = home?.replace(/\/+$/, '');
  if (!h || h === '/') return path;
  if (path === h) return '~';
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/** A path that fits in about `max` characters: home as "~", then whole folders dropped from the middle ("/…/") — the
 *  first folder and as many of the last ones as fit stay. The last folder is never cut. */
export function shortPath(path: string, home?: string | null, max = 40): string {
  const p = tildePath(path, home);
  if (p.length <= max) return p;
  const lead = p.startsWith('~') ? '~' : '';
  const parts = p.slice(lead.length).split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  const head = lead ? '~' : `/${parts[0]}`;
  const rest = lead ? parts : parts.slice(1);
  const tail: string[] = [rest[rest.length - 1]!];
  for (let i = rest.length - 2; i >= 0; i--) {
    const next = `${head}/…/${[rest[i], ...tail].join('/')}`;
    if (next.length > max) break;
    tail.unshift(rest[i]!);
  }
  if (tail.length === rest.length) return p;
  return `${head}/…/${tail.join('/')}`;
}

/** shortPath split for display: `head` (everything before the last "/") may be cut further by the layout, `tail`
 *  ("/" + the folder's own name) never is. Shown as two spans so a narrow card ellipsizes the head and keeps the name. */
export function pathParts(path: string, home?: string | null, max = 40): { head: string; tail: string } {
  const p = shortPath(path, home, max);
  const cut = p.lastIndexOf('/');
  // the "/" goes with the name, so a cut head reads "…/todo-api", not "…todo-api"
  return cut <= 0 || cut === p.length - 1 ? { head: '', tail: p } : { head: p.slice(0, cut), tail: p.slice(cut) };
}
