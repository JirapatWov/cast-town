// Auto mode's rules, as data: the server checks every step an agent wants to take against them
// (server/agents/auto-review.ts) and the permission menu lists them, so what the UI promises is exactly what runs.
// Auto is a best-effort pattern check, not a sandbox: a step no rule recognises as risky goes through without asking.
// Every rule has a stable id: a card Auto stopped carries it (ApprovalRequest.autoRule), and a house can always allow
// a rule (Project.autoAllow, like Claude Code's autoMode.allow) — except the ones in NEVER_ALLOW.

/** Why Auto stopped, by rule id, for the steps that aren't a shell pattern below (shown on the approval card). */
export const ASK = {
  outside: 'changes a file outside the project folder',
  secretsFile: 'changes a secrets file',
  gitInternals: 'changes git internals',
  credentials: 'touches credentials or system accounts',
  writesOutside: 'writes outside the project folder',
  wildcard: 'deletes everything matching a wildcard',
  deletesOutside: 'deletes files outside the project folder',
  deletesFolder: 'deletes a folder and everything in it',
  movesOutside: 'moves files from outside the project folder',
  permissions: 'changes permissions outside the project or makes files writable by everyone',
  openServer: 'opens a server to every network — bind it to 127.0.0.1 or the Tailscale address',
  gitDiscard: 'can throw away work in git (reset --hard, clean, checkout or restore of the whole tree, stash drop)',
  gitForcePush: 'force-pushes, deletes or mirrors on a git remote',
  gitPushDeploy: 'pushes to a deploy branch or a release tag (production, gh-pages, release…, a version tag)',
  gitPushUrl: 'pushes to a git address that isn’t one of the project’s remotes',
  sendsData: 'sends data to the internet',
  codeCommand: 'runs a command its code puts together while running, so Auto can’t read it',
  codeDeletes: 'deletes files from code at a path worked out while running',
  unreadable: 'is too long or too unclear to check',
  storage: 'writes to storage outside the project (ssh://, cfg://, vault://, mcp:// …)',
  typesInto: 'types into a program that is running (proc://)',
  githubPr: 'opens a pull request on GitHub (other people see it)',
  computer: 'controls the screen, mouse or keyboard',
  autonomousAgent: 'starts an agent of its own outside CAST',
  debugAttach: 'attaches a debugger to a program that is already running',
  cloudScan: 'sends the code to a cloud security scan',
} as const;

export interface ShellRule {
  id: string;
  reason: string;
  /** Matched against each command of a command line (quoted text with spaces hidden), or the whole line (`whole`). */
  re?: RegExp;
  /** Programs that fire the rule when they are the command run (not when they are only an argument). */
  bins?: readonly string[];
  whole?: boolean;
}

/** Shell patterns that go to the user, with the reason shown on the card. git, chmod/chown, rm, mv and redirections
 *  are looked at word by word in auto-review.ts (reasons in ASK). */
export const SHELL_RULES: ShellRule[] = [
  { id: 'sudo', reason: 'runs a command as another user (sudo)', bins: ['sudo', 'doas', 'su', 'pkexec', 'run0'] },
  {
    id: 'pipeToShell',
    reason: 'runs a script downloaded from the internet',
    whole: true,
    re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(ba|z|da)?sh\s+<\(\s*(curl|wget)\b/,
  },
  // requests to this machine itself (localhost, 127.x, [::1]) are local testing: auto-review.ts lets those through
  {
    id: 'sendsData',
    reason: ASK.sendsData,
    re: /\b(curl|wget|http|https|httpie|xh)\b.*(\s(-d|--data[\w-]*|--json|--post-data|--post-file|--body-data|--body-file|-F|--form[\w-]*|-T|--upload-file)(?=[\s=]|$)|\s(-X|--request|--method)[\s=]*['"]?(POST|PUT|PATCH|DELETE)\b|^\s*(http|https|httpie|xh)\s+(POST|PUT|PATCH|DELETE)\b)/i,
  },
  { id: 'remote', reason: 'connects to another machine', bins: ['ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'socat', 'telnet', 'mosh'], re: /(^|\s)rsync\s.*\s\S+:/ },
  { id: 'openServer', reason: ASK.openServer, re: /0\.0\.0\.0|(--host|--bind|-b|--listen)[=\s]+(::|\*)(\s|$)|\bhttp\.server\b(?!.*--bind)/ },
  {
    id: 'installs',
    reason: 'installs or removes software for the whole machine',
    re: /\b(apt|apt-get|yum|dnf|pacman|apk|snap|brew)\s+(install|remove|purge|upgrade|uninstall)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove)\s.*(-g|--global)\b|\bpip3?\s+install\b(?!.*(-r\s|--user|-e\s|\.venv|venv\/))/,
  },
  // read-only forms (systemctl status, service X status, tailscale status, crontab -l, plain mount) don't ask
  {
    id: 'system',
    reason: 'changes the system or stops other programs',
    bins: ['systemctl', 'service', 'shutdown', 'reboot', 'halt', 'poweroff', 'crontab', 'iptables', 'nft', 'ufw', 'tailscale', 'mount', 'umount', 'mkfs', 'fdisk', 'parted', 'useradd', 'userdel', 'passwd', 'visudo', 'pkill', 'killall'],
  },
  { id: 'rawWrite', reason: 'writes raw data to a device or file', re: /(^|[\s;&|(])dd\s.*\bof=/ },
  { id: 'containers', reason: 'changes containers or clusters', re: /\bdocker\s+(rm|rmi|kill|stop|system|volume|network|compose\s+down)\b|\bkubectl\s+(delete|apply|scale)\b/ },
];

/** Rules a house can never always-allow: credentials and secrets, running a downloaded script, deleting outside the
 *  project, raw writes to devices — and steps Auto couldn't read at all (allowing those would allow anything). */
export const NEVER_ALLOW: Readonly<Record<string, true>> = { credentials: true, secretsFile: true, pipeToShell: true, deletesOutside: true, rawWrite: true, unreadable: true, codeCommand: true, codeDeletes: true };

/** A tool Auto has no rule for (an MCP server's, a plugin's) stops as `tool:<name>`: allowing it allows that tool only. */
const TOOL_RULE = /^tool:[\w.:-]{1,160}$/;

const strip = (reason: string) => reason.replace(/ — .*$/, '');

/** True for an id Auto can stop with. */
export function isAutoRuleId(id: string): boolean {
  return Object.hasOwn(ASK, id) || SHELL_RULES.some((r) => r.id === id) || TOOL_RULE.test(id);
}

/** Can a house always allow this rule (the card's "Always allow in <house>")? */
export function autoRuleAllowable(id: string): boolean {
  return isAutoRuleId(id) && !Object.hasOwn(NEVER_ALLOW, id);
}

/** A rule in plain words, for the list of a house's standing allows. */
export function autoRuleLabel(id: string): string {
  if (Object.hasOwn(ASK, id)) return strip(ASK[id as keyof typeof ASK]);
  const shell = SHELL_RULES.find((r) => r.id === id);
  if (shell) return strip(shell.reason);
  return TOOL_RULE.test(id) ? `uses the “${id.slice('tool:'.length)}” tool` : id;
}

/** Everything Auto asks about, in plain words, for the permission menu ("What Auto checks"). */
export function autoAsksAbout(): string[] {
  const all = SHELL_RULES.map((r) => strip(r.reason));
  for (const reason of Object.values(ASK)) all.push(strip(reason));
  all.push('uses a tool Auto has no rule for (an MCP server’s tools, for example)');
  return [...new Set(all)];
}
