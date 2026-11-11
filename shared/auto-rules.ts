// Auto mode's rules, as data: the server checks every step an agent wants to take against them
// (server/agents/auto-review.ts) and the permission menu lists them, so what the UI promises is exactly what runs.
// Auto is a best-effort pattern check, not a sandbox: a step no rule recognises as risky goes through without asking.

/** Why Auto stopped for a step that isn't a shell/code pattern below (shown on the approval card). */
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
  openServer: 'opens a server to every network — bind it to 127.0.0.1 or the Tailscale address',
} as const;

/** Shell patterns that always go to the user, with the reason shown on the card. */
export const SHELL_RULES: [RegExp, string][] = [
  [/(^|[\s;&|(])(sudo|doas|su)\s/, 'runs a command as another user (sudo)'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'runs a script downloaded from the internet'],
  [/\bgit\s+push\b/, 'pushes to a git remote'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+(--\s|\.(\s|$))|restore\s+(\S+\s+)*\.(\s|$)|stash\s+(drop|clear)|branch\s+-D|filter-branch|update-ref|rebase)\b/, 'can throw away work in git'],
  [/\b(curl|wget|http|httpie)\b[^;&|]*(\s(-d|--data[\w-]*|-F|--form|-T|--upload-file)\b|\s-X\s*(POST|PUT|PATCH|DELETE)\b)/i, 'sends data to the internet'],
  [/(^|[\s;&|(])(ssh|scp|sftp|ftp|rsync\s[^;&|]*\S+:|nc|ncat|socat|telnet)\s/, 'connects to another machine'],
  [/0\.0\.0\.0|(--host|--bind|-b|--listen)[=\s]+(::|\*)(\s|$)|\bhttp\.server\b(?![^;&|]*--bind)/, 'opens a server to every network — bind it to 127.0.0.1 or the Tailscale address'],
  [/\b(apt|apt-get|yum|dnf|pacman|apk|snap|brew)\s+(install|remove|purge|upgrade|uninstall)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove)\s[^;&|]*(-g|--global)\b|\bpip3?\s+install\b(?![^;&|]*(-r\s|--user|-e\s|\.venv|venv\/))/, 'installs or removes software for the whole machine'],
  [/(^|[\s;&|(])(systemctl|service|shutdown|reboot|halt|poweroff|crontab|iptables|nft|ufw|tailscale|mount|umount|mkfs(\.\w+)?|fdisk|parted|useradd|userdel|passwd|visudo|pkill|killall)\s/, 'changes the system or stops other programs'],
  [/(^|[\s;&|(])dd\s[^;&|]*\bof=/, 'writes raw data to a device or file'],
  [/\bdocker\s+(rm|rmi|kill|stop|system|volume|network|compose\s+down)\b|\bkubectl\s+(delete|apply|scale)\b/, 'changes containers or clusters'],
  [/\bchmod\s+(-\w*R|[0-7]*7{2,}\b)|\bchown\b/, 'changes file permissions or owners'],
];

export const PY_RULES: [RegExp, string][] = [
  [/\b(subprocess|os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|pty\.spawn)\b/, 'runs shell commands from code'],
  [/\b(shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)|\.unlink\(|\.rmdir\()/, 'deletes files from code'],
  [/\b(requests|httpx)\.(post|put|patch|delete)\b|urlopen\([^)]*data\s*=|\b(smtplib|ftplib|paramiko|socket\.socket)\b/, 'sends data over the network from code'],
];

export const JS_RULES: [RegExp, string][] = [
  [/\bchild_process\b|\b(exec|execSync|spawn|spawnSync|execFile)\(|\bBun\.(spawn|spawnSync|\$)|\bDeno\.Command\b/, 'runs shell commands from code'],
  [/\bfs(\.promises)?\.(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b|\bBun\.file\([^)]*\)\.delete\b/, 'deletes files from code'],
  [/\bfetch\([^)]*method:\s*['"`](POST|PUT|PATCH|DELETE)/i, 'sends data over the network from code'],
];

/** Everything Auto asks about, in plain words, for the permission menu ("What Auto checks"). */
export function autoAsksAbout(): string[] {
  const all = [...SHELL_RULES, ...PY_RULES, ...JS_RULES].map(([, reason]) => reason.replace(/ — .*$/, ''));
  for (const reason of Object.values(ASK)) all.push(reason.replace(/ — .*$/, ''));
  return [...new Set(all)];
}
