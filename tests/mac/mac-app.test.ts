// CAST for Mac (mac/): the parts that can be checked without a Mac. Swift and Apple's tools don't run here, so:
//  - mac/build-dmg.sh is checked like a linter would (bash -n, set -euo pipefail, no GNU-only flags or bash 4
//    features: macOS has BSD tools and bash 3.2), and run end to end against stub macOS tools in a fake kit
//    (what it builds, in which order it signs, that the self-check runs before the dmg, and its failure messages);
//  - mac/Info.plist is parsed as XML and must carry the keys the app relies on;
//  - the Swift sources may import only AppKit, Foundation, ServiceManagement and UserNotifications, their brackets
//    balance, they implement the app/server contract's names, and they avoid APIs newer than macOS 13.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const macDir = join(repo, 'mac');
const scriptPath = join(macDir, 'build-dmg.sh');
const script = readFileSync(scriptPath, 'utf8');
const helperPath = join(macDir, 'cast-install-update.sh');
const swiftDir = join(macDir, 'CASTMenu');
const swiftFiles = readdirSync(swiftDir).filter((f) => f.endsWith('.swift')).sort();
const swift = Object.fromEntries(swiftFiles.map((f) => [f, readFileSync(join(swiftDir, f), 'utf8')]));
const allSwift = Object.values(swift).join('\n');

const tmp = mkdtempSync(join(tmpdir(), 'cast-test-mac-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The script without comments (whole-line and trailing `# …` outside quotes), for the flag checks. */
function codeLines(text: string): string[] {
  return text.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return '';
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && quote === '"') i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  });
}

describe('mac/build-dmg.sh, statically', () => {
  test('bash accepts it and the update helper, and both are executable', () => {
    for (const path of [scriptPath, helperPath]) {
      const r = Bun.spawnSync(['bash', '-n', path], { stderr: 'pipe' });
      expect(r.stderr.toString()).toBe('');
      expect(r.exitCode).toBe(0);
      expect(statSync(path).mode & 0o111).not.toBe(0);
    }
  });

  test('bash shebang and set -euo pipefail before any command', () => {
    const lines = script.split('\n');
    expect(lines[0]).toBe('#!/bin/bash');
    const first = lines.findIndex((l, i) => i > 0 && l.trim() && !l.trim().startsWith('#'));
    expect(lines[first]).toBe('set -euo pipefail');
  });

  test('no GNU-only tools or flags, nothing from Homebrew, and nothing bash 3.2 lacks (the update helper too)', () => {
    const banned: [RegExp, string][] = [
      [/\bsed\b[^|;]*\s-i\b/, 'sed -i (BSD sed needs an argument; write to a new file instead)'],
      [/\bsed\b[^|;]*\s-r\b/, 'sed -r (use -E)'],
      [/\breadlink\s+-f\b/, 'readlink -f'],
      [/\brealpath\b/, 'realpath'],
      [/\bgrep\b[^|;]*\s-[a-zA-Z]*P/, 'grep -P'],
      [/\bdate\b[^|;]*\s-d\b/, 'date -d'],
      [/\bstat\b[^|;]*\s-c\b/, 'stat -c'],
      [/\bfind\b[^|;]*-printf\b/, 'find -printf'],
      [/\bxargs\b[^|;]*\s-r\b/, 'xargs -r'],
      [/\b(sha256sum|md5sum|tac|nproc|numfmt|timeout|getopt)\b/, 'a GNU coreutils command'],
      [/\bbase64\b[^|;]*\s-w\b/, 'base64 -w'],
      [/\b(cp|mv|ln|mktemp|awk|du|install)\s[^|;]*\s--[a-z]/, 'a GNU long option'],
      [/\bln\s+-[a-zA-Z]*[Tr]/, 'ln -T / -r'],
      [/\bdu\b[^|;]*\s-b\b/, 'du -b'],
      [/\bsort\b[^|;]*\s-V\b/, 'sort -V'],
      [/\bhead\b[^|;]*-n\s*-\d/, 'head -n -N'],
      [/\becho\s+-e\b/, 'echo -e (use printf)'],
      [/(^|[|;&(]|\bthen|\bdo|\belse)\s*(jq|brew|wget|python3?|node|npm|bun|gsed|gawk)\b/, 'a tool a stock Mac does not have'],
      [/\b(declare|local|typeset)\s+-[a-zA-Z]*[An]\b/, 'associative arrays / namerefs (bash 4)'],
      [/\b(mapfile|readarray|coproc)\b/, 'a bash 4 builtin'],
      [/\$\{[A-Za-z_]+(,,|\^\^)/, 'case conversion ${x,,} (bash 4)'],
      [/\|&|;;&|;&\s*$/, 'bash 4 operators'],
      [/\[\[\s+-v\b/, '[[ -v (bash 4.2)'],
      [/\bshopt\s+-s\s+globstar\b/, 'globstar (bash 4)'],
      [/\bwait\s+-n\b/, 'wait -n (bash 4.3)'],
    ];
    const hits: string[] = [];
    const linuxTarball = readFileSync(join(import.meta.dir, '../../scripts/release/linux-tarball.sh'), 'utf8');
    for (const [name, text] of [['build-dmg.sh', script], ['cast-install-update.sh', readFileSync(helperPath, 'utf8')], ['linux-tarball.sh', linuxTarball]]) {
      codeLines(text).forEach((line, i) => {
        for (const [re, what] of banned) if (re.test(line)) hits.push(`${name} line ${i + 1}: ${what}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test('it does every step the release needs', () => {
    const code = codeLines(script).join('\n');
    expect(code).toContain('-target arm64-apple-macos13.0');
    expect(code).toContain('-swift-version 5');
    expect(code).toMatch(/xcode-select --install/);
    expect(code).toMatch(/"\$SWIFTC" --version/); // Swift 5.9+ (MainActor.assumeIsolated)
    expect(code).toMatch(/sw_vers -productVersion/);
    expect(code).toMatch(/uname -m/);
    expect(code).toMatch(/codesign --force -s - "\$program"/);
    expect(code).toMatch(/codesign --verify --strict/);
    expect(code).toMatch(/codesign --verify --strict --verbose=2 "\$program"/); // each program's own signature too
    expect(code).toMatch(/xattr -cr "\$APP"/);
    expect(code).toMatch(/trap 'exit 130' INT TERM/); // Ctrl+C still runs the cleanup
    expect(code).toMatch(/--check/);
    expect(code).toMatch(/-format UDZO/);
    expect(code).toMatch(/ln -s \/Applications/);
    expect(code).toMatch(/iconutil -c icns/);
    // order: sign the two programs, then the app; self-check before the dmg
    expect(code.indexOf('codesign --force -s - "$program"')).toBeLessThan(code.indexOf('codesign --force -s - "$APP"'));
    expect(code.indexOf('--check;')).toBeLessThan(code.indexOf('hdiutil create'));
  });
});

// ---- A fake Mac: stub tools on PATH, a fake kit, the real script ------------------------------------------------

const stubs = join(tmp, 'stubs');
mkdirSync(stubs);
const stub = (name: string, body: string) => {
  writeFileSync(join(stubs, name), `#!/bin/bash\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
};
stub('uname', 'case "$1" in -s) echo "${FAKE_UNAME_S:-Darwin}" ;; -m) echo "${FAKE_ARCH:-arm64}" ;; *) echo Darwin ;; esac');
stub('sysctl', 'echo "${FAKE_ARM64:-1}"');
stub('sw_vers', 'echo "${FAKE_OS:-14.6.1}"');
stub('xcode-select', '[ "${FAKE_NO_CLT:-0}" = 1 ] && { echo "xcode-select: error: unable to get active developer directory" >&2; exit 2; }; echo /Library/Developer/CommandLineTools');
stub('xcrun', `case "$*" in
  "--find swiftc") echo "${stubs}/swiftc" ;;
  *--show-sdk-path*) echo /fake/MacOSX.sdk ;;
  *--show-sdk-version*) echo "\${FAKE_SDK:-14.5}" ;;
  *) exit 1 ;;
esac`);
stub('swiftc', `if [ "$1" = --version ]; then
  echo "swift-driver version: 1.115 Apple Swift version \${FAKE_SWIFT:-6.0.3} (swiftlang-6.0.3.1.10 clang-1600.0.30.1)"
  echo "Target: arm64-apple-macosx14.0"; exit 0
fi
[ "\${FAKE_SWIFTC_FAIL:-0}" = 1 ] && { echo "main.swift:1:1: error: fake failure" >&2; exit 1; }
out=; prev=
for a in "$@"; do
  if [ "$prev" = -o ]; then out=$a; fi
  case "$a" in *.swift) [ -f "$a" ] || { echo "no such file $a" >&2; exit 1; } ;; esac
  prev=$a
done
cat > "$out" <<'EOF'
#!/bin/bash
printf '%s\\n' "CAST $* data=\${CAST_DATA_DIR:-} workspace=\${CAST_WORKSPACE:-}" >> "$STUB_LOG"
if [ "\${FAKE_CHECK_ORPHAN:-0}" = 1 ]; then
  # CAST --check "crashes" after starting its server: a process named cast-server, named in listen.json
  printf '#!/bin/bash\\nwhile :; do sleep 1; done\\n' > "$CAST_DATA_DIR/../cast-server"; chmod 755 "$CAST_DATA_DIR/../cast-server"
  "$CAST_DATA_DIR/../cast-server" </dev/null >/dev/null 2>&1 &
  printf '{"url":"http://127.0.0.1:4861/","pid":%s,"startedAt":1}\\n' "$!" > "$CAST_DATA_DIR/listen.json"
  echo "$!" > "$ORPHAN_PID_FILE"
  echo "FAIL  crashed"; exit 1
fi
if [ "\${FAKE_CHECK_FAIL:-0}" = 1 ]; then
  mkdir -p "$CAST_DATA_DIR/logs"; echo "the server said: boom" > "$CAST_DATA_DIR/logs/server.log"
  echo "FAIL  the server did not start"; exit 1
fi
echo "PASS  fake self-check"
EOF
chmod 755 "$out"`);
stub('codesign', 'exit 0');
stub('hdiutil', `if [ "$1" = create ]; then
  src=; prev=; for a in "$@"; do [ "$prev" = -srcfolder ] && src=$a; prev=$a; done
  ls -l "$src" | sed 's/^/  staged: /' >> "$STUB_LOG"
  for last in "$@"; do :; done; echo dmg > "$last"
fi`);
stub('sips', 'in=; out=; prev=; for a in "$@"; do [ "$prev" = --out ] && out=$a; case "$a" in *.png) [ -z "$in" ] && in=$a ;; esac; prev=$a; done; cp "$in" "$out"');
stub('iconutil', 'n=$(ls "${@: -1}" | wc -l); [ "$n" -eq 10 ] || { echo "iconset has $n files" >&2; exit 1; }; echo icns > "$4"');
stub('plutil', 'exit 0');
stub('ditto', 'cp -R "$1" "$2"');
stub('xattr', 'exit 0');
stub('file', 'echo "${FAKE_FILE_KIND:-Mach-O 64-bit executable arm64}"');
stub('shasum', 'shift 2; exec sha256sum "$@"');
stub('open', 'exit 0');

let kitCount = 0;
/** A fresh unpacked kit with the real mac/ sources and build-dmg.sh at its root. */
function makeKit(version = '0.1.0', parent = `kit${kitCount++}`): string {
  const kit = join(tmp, parent, 'cast-mac-kit');
  mkdirSync(join(kit, 'mac', 'CASTMenu'), { recursive: true });
  mkdirSync(join(kit, 'web', 'dist'), { recursive: true });
  copyFileSync(scriptPath, join(kit, 'build-dmg.sh'));
  chmodSync(join(kit, 'build-dmg.sh'), 0o755);
  copyFileSync(join(macDir, 'Info.plist'), join(kit, 'mac', 'Info.plist'));
  copyFileSync(join(macDir, 'cast-install-update.sh'), join(kit, 'mac', 'cast-install-update.sh'));
  for (const f of swiftFiles) copyFileSync(join(swiftDir, f), join(kit, 'mac', 'CASTMenu', f));
  writeFileSync(join(kit, 'UPDATE-REPOSITORY'), 'https://github.com/example/cast.git\n');
  writeFileSync(join(kit, 'cast-server'), 'server');
  writeFileSync(join(kit, 'cast-agent'), 'cast-agent');
  writeFileSync(join(kit, 'agent-LICENSE'), 'MIT License (the agent)');
  writeFileSync(join(kit, 'agent-THIRD-PARTY-NOTICES.txt'), 'OMP THIRD-PARTY NOTICES (the agent)');
  writeFileSync(join(kit, 'web', 'dist', 'index.html'), '<!doctype html>');
  copyFileSync(join(repo, 'web', 'public', 'icon-512.png'), join(kit, 'web', 'dist', 'icon-512.png'));
  writeFileSync(join(kit, 'VERSION'), `${version}\n`);
  return kit;
}

function runKit(kit: string, args: string[] = [], env: Record<string, string> = {}) {
  const log = join(kit, '..', 'calls.log');
  writeFileSync(log, '');
  const work = join(kit, '..', 'tmp');
  mkdirSync(work, { recursive: true });
  const r = Bun.spawnSync(['bash', join(kit, 'build-dmg.sh'), ...args], {
    cwd: kit,
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: join(kit, '..'), TMPDIR: work, STUB_LOG: log, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    leftovers: readdirSync(work),
  };
}

describe('mac/build-dmg.sh on a fake Mac', () => {
  test('builds, signs inside out, self-checks in a throwaway folder, then makes the dmg', () => {
    const kit = makeKit();
    const r = runKit(kit);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const app = join(kit, 'build', 'CAST.app', 'Contents');
    for (const f of ['MacOS/CAST', 'Info.plist', 'PkgInfo', 'Resources/cast-server', 'Resources/cast-agent', 'Resources/agent-LICENSE', 'Resources/agent-THIRD-PARTY-NOTICES.txt', 'Resources/web/dist/index.html', 'Resources/AppIcon.icns', 'Resources/cast-install-update.sh'])
      expect(existsSync(join(app, f))).toBe(true);
    expect(statSync(join(app, 'Resources', 'cast-server')).mode & 0o111).not.toBe(0);
    expect(statSync(join(app, 'Resources', 'cast-agent')).mode & 0o111).not.toBe(0);
    expect(statSync(join(app, 'Resources', 'cast-install-update.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(app, 'PkgInfo'), 'utf8')).toBe('APPL????');
    const plist = parsePlist(readFileSync(join(app, 'Info.plist'), 'utf8')) as Record<string, unknown>;
    expect(plist.CFBundleShortVersionString).toBe('0.1.0');
    expect(plist.CFBundleVersion).toBe('0.1.0');
    expect(plist.CASTUpdateRepository).toBe('https://github.com/example/cast.git'); // the kit's UPDATE-REPOSITORY

    const swiftc = r.calls.find((c) => c.startsWith('swiftc ') && c.includes(' -o '))!;
    expect(swiftc).toContain('-target arm64-apple-macos13.0');
    expect(swiftc).toContain('-O');
    for (const f of swiftFiles) expect(swiftc).toContain(`/mac/CASTMenu/${f}`);

    const at = (prefix: string) => r.calls.findIndex((c) => c.startsWith(prefix));
    const signServer = r.calls.findIndex((c) => c.startsWith('codesign --force -s -') && c.endsWith('Resources/cast-server'));
    const signAgent = r.calls.findIndex((c) => c.startsWith('codesign --force -s -') && c.endsWith('Resources/cast-agent'));
    const signApp = r.calls.findIndex((c) => c.startsWith('codesign --force -s -') && c.endsWith('CAST.app'));
    expect(at('xattr -cr')).toBeLessThan(signServer);
    expect(signServer).toBeGreaterThan(-1);
    expect(signServer).toBeLessThan(signApp);
    expect(signAgent).toBeGreaterThan(-1);
    expect(signAgent).toBeLessThan(signApp);
    expect(signApp).toBeLessThan(at('codesign --verify --strict'));
    expect(r.calls.filter((c) => c.startsWith('codesign ')).every((c) => !c.includes('--options runtime'))).toBe(true);

    const check = r.calls.find((c) => c.startsWith('CAST --check'))!;
    expect(check).toMatch(/data=\S*\/check\/data workspace=\S*\/check\/workspace/);
    expect(at('CAST --check')).toBeLessThan(at('hdiutil create'));
    const create = r.calls.find((c) => c.startsWith('hdiutil create'))!;
    expect(create).toContain('-format UDZO');
    expect(create.endsWith(join(kit, 'CAST-0.1.0-arm64.dmg'))).toBe(true);
    expect(r.calls.some((c) => /staged: .*Applications -> \/Applications/.test(c))).toBe(true);
    expect(r.calls.some((c) => /staged: .*CAST\.app/.test(c))).toBe(true);
    expect(existsSync(join(kit, 'CAST-0.1.0-arm64.dmg'))).toBe(true);
    expect(r.out).toContain('Done:');
    expect(r.out).toMatch(/right-click CAST/);
    expect(r.leftovers).toEqual([]); // its work folder is removed
  });

  test('Developer ID signing gives the Bun programs runtime entitlements before checking and packaging', () => {
    const kit = makeKit();
    const entitlements = join(kit, '..', 'bun-entitlements.plist');
    copyFileSync(join(repo, 'agent', 'scripts', 'macos-entitlements.plist'), entitlements);
    const identity = 'Developer ID Application: CAST Test (TESTTEAM)';
    const r = runKit(kit, [], { CAST_SIGN_IDENTITY: identity, CAST_SIGN_ENTITLEMENTS: entitlements });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const signs = r.calls.filter((c) => c.startsWith('codesign --force'));
    expect(signs).toHaveLength(3);
    for (const [i, name] of ['Resources/cast-server', 'Resources/cast-agent', 'CAST.app'].entries()) {
      expect(signs[i]).toContain(`--timestamp --options runtime`);
      expect(signs[i]).toContain(`--sign ${identity}`);
      expect(signs[i].endsWith(name)).toBe(true);
      expect(signs[i].includes(`--entitlements ${entitlements}`)).toBe(i < 2);
    }
    expect(r.calls.indexOf(signs[2])).toBeLessThan(r.calls.findIndex((c) => c.startsWith('CAST --check')));
    expect(r.calls.findIndex((c) => c.startsWith('CAST --check'))).toBeLessThan(r.calls.findIndex((c) => c.startsWith('hdiutil create')));
    expect(r.out).toContain('Notarize and staple');
    expect(r.leftovers).toEqual([]);
  });

  test('Developer ID without a readable entitlements file fails before compiling or packaging', () => {
    const kit = makeKit();
    for (const entitlements of ['', join(kit, 'missing.plist')]) {
      const r = runKit(kit, [], { CAST_SIGN_IDENTITY: 'Developer ID Application: CAST Test', CAST_SIGN_ENTITLEMENTS: entitlements });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('CAST_SIGN_ENTITLEMENTS must name the Bun runtime entitlements');
      expect(r.calls.some((c) => c.startsWith('swiftc ') && c.includes(' -o '))).toBe(false);
      expect(r.calls.some((c) => c.startsWith('codesign ') || c.startsWith('hdiutil '))).toBe(false);
    }
  });

  test('a pre-release version keeps a plain CFBundleVersion', () => {
    const kit = makeKit('0.2.0-beta.1');
    const r = runKit(kit, ['--no-check']);
    expect(r.code).toBe(0);
    const plist = parsePlist(readFileSync(join(kit, 'build', 'CAST.app', 'Contents', 'Info.plist'), 'utf8')) as Record<string, unknown>;
    expect(plist.CFBundleShortVersionString).toBe('0.2.0-beta.1');
    expect(plist.CFBundleVersion).toBe('0.2.0');
    expect(existsSync(join(kit, 'CAST-0.2.0-beta.1-arm64.dmg'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('CAST --check'))).toBe(false);
  });

  test('Check for Updates: no UPDATE-REPOSITORY in the kit leaves it not set up; an odd one is refused', () => {
    const bare = makeKit();
    rmSync(join(bare, 'UPDATE-REPOSITORY'));
    expect(runKit(bare, ['--no-check']).code).toBe(0);
    const plist = parsePlist(readFileSync(join(bare, 'build', 'CAST.app', 'Contents', 'Info.plist'), 'utf8')) as Record<string, unknown>;
    expect(plist.CASTUpdateRepository).toBe('');
    const odd = makeKit();
    writeFileSync(join(odd, 'UPDATE-REPOSITORY'), 'https://github.com/a/b?x=1&y="2"\n');
    const r = runKit(odd, ['--no-check']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('not a plain repository address');
  });

  test('--run opens the app instead of making a dmg', () => {
    const kit = makeKit();
    const r = runKit(kit, ['--run']);
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.startsWith('CAST --check'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('open ') && c.endsWith('build/CAST.app'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('hdiutil'))).toBe(false);
  });

  test('--help prints the usage; an unknown option is refused', () => {
    const kit = makeKit();
    const help = runKit(kit, ['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('./build-dmg.sh --run');
    const bad = runKit(kit, ['--bogus']);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('Unknown option: --bogus');
  });

  const failures: [string, Record<string, string>, RegExp][] = [
    ['not a Mac', { FAKE_UNAME_S: 'Linux' }, /runs on a Mac/],
    ['an Intel Mac', { FAKE_ARCH: 'x86_64', FAKE_ARM64: '0' }, /Apple Silicon/],
    ['macOS 12', { FAKE_OS: '12.7.4' }, /macOS 13 Ventura or newer\. This Mac runs macOS 12\.7\.4/],
    ['no Command Line Tools', { FAKE_NO_CLT: '1' }, /xcode-select --install/],
    ['an old SDK', { FAKE_SDK: '12.3' }, /too old/],
    ['Swift older than 5.9', { FAKE_SWIFT: '5.8.1' }, /Swift 5\.8; CAST needs Swift 5\.9 or newer/],
    ['a program built for Linux', { FAKE_FILE_KIND: 'ELF 64-bit LSB executable, x86-64' }, /not a macOS program for Apple Silicon/],
    ['a compile error', { FAKE_SWIFTC_FAIL: '1' }, /Swift compiler failed/],
  ];
  for (const [what, env, message] of failures) {
    test(`stops with a plain message: ${what}`, () => {
      const r = runKit(makeKit(), [], env);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(message);
      expect(r.calls.some((c) => c.startsWith('hdiutil create'))).toBe(false);
    });
  }

  test('a kit unpacked in a folder whose path has spaces', () => {
    const kit = makeKit('0.1.0', `My Kits ${kitCount++}`);
    const r = runKit(kit);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(kit, 'CAST-0.1.0-arm64.dmg'))).toBe(true);
    expect(existsSync(join(kit, 'build', 'CAST.app', 'Contents', 'Resources', 'AppIcon.icns'))).toBe(true);
  });

  test('Rosetta: an x86_64 Terminal on Apple Silicon still builds', () => {
    const r = runKit(makeKit(), ['--no-check'], { FAKE_ARCH: 'x86_64', FAKE_ARM64: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Rosetta');
  });

  test('a failed self-check shows the server log and makes no dmg', () => {
    const kit = makeKit();
    const r = runKit(kit, [], { FAKE_CHECK_FAIL: '1' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('FAIL  the server did not start');
    expect(r.err).toContain('the server said: boom');
    expect(r.err).toContain('--no-check');
    expect(existsSync(join(kit, 'CAST-0.1.0-arm64.dmg'))).toBe(false);
  });

  test('a self-check that dies before stopping its server: build-dmg.sh stops that server', () => {
    const kit = makeKit();
    const pidFile = join(kit, '..', 'orphan.pid');
    let pid = 0;
    try {
      const r = runKit(kit, [], { FAKE_CHECK_ORPHAN: '1', ORPHAN_PID_FILE: pidFile });
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(pid).toBeGreaterThan(1);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('Stopping the CAST server the self-check left running');
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      expect(r.leftovers).toEqual([]);
    } finally {
      if (pid > 1) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  test('a kit with a file missing or changed is refused', () => {
    const noAgent = makeKit();
    rmSync(join(noAgent, 'cast-agent'));
    const r1 = runKit(noAgent);
    expect(r1.code).not.toBe(0);
    expect(r1.err).toContain('cast-agent is missing from the kit');
    const noHelper = makeKit();
    rmSync(join(noHelper, 'mac', 'cast-install-update.sh'));
    const r0 = runKit(noHelper);
    expect(r0.code).not.toBe(0);
    expect(r0.err).toContain('mac/cast-install-update.sh is missing from the kit');
    for (const doc of ['agent-LICENSE', 'agent-THIRD-PARTY-NOTICES.txt']) {
      const noLegal = makeKit();
      rmSync(join(noLegal, doc));
      const r = runKit(noLegal);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(`${doc} is missing from the kit`);
    }

    const changed = makeKit();
    const sum = Bun.spawnSync(['sha256sum', 'cast-server', 'cast-agent'], { cwd: changed, stdout: 'pipe' }).stdout.toString();
    writeFileSync(join(changed, 'SHA256SUMS'), sum);
    expect(runKit(changed, ['--no-check']).code).toBe(0);
    writeFileSync(join(changed, 'cast-agent'), 'tampered');
    const r2 = runKit(changed, ['--no-check']);
    expect(r2.code).not.toBe(0);
    expect(r2.err).toContain("don't match SHA256SUMS");
  });

  test('the dmg holds the app and an Applications link (a real symlink in the staging folder)', () => {
    // covered through the hdiutil stub's listing above; here: the script makes a symlink, not a copy
    expect(codeLines(script).join('\n')).toMatch(/ln -s \/Applications "\$STAGE\/Applications"/);
    expect(lstatSync(scriptPath).isFile()).toBe(true);
  });
});

// ---- Info.plist ----------------------------------------------------------------------------------------------------

type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue };

/** A small strict parser for the plist subset Apple's tools write: throws on anything malformed. */
function parsePlist(xml: string): PlistValue {
  const body = xml
    .replace(/^﻿?<\?xml[^>]*\?>\s*/, '')
    .replace(/<!DOCTYPE[^>]*>/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  if (/&(?!(amp|lt|gt|quot|apos);)/.test(body)) throw new Error('unescaped &');
  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const skipSpace = () => {
    while (i < tokens.length && !tokens[i].startsWith('<') && !tokens[i].trim()) i++;
  };
  const text = (tag: string): string => {
    let t = '';
    if (!tokens[i]?.startsWith('<')) t = tokens[i++];
    if (tokens[i++] !== `</${tag}>`) throw new Error(`<${tag}> not closed`);
    return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };
  const value = (): PlistValue => {
    skipSpace();
    const tok = tokens[i++];
    if (tok === '<true/>') return true;
    if (tok === '<false/>') return false;
    if (tok === '<string>') return text('string');
    if (tok === '<string/>') return '';
    if (tok === '<integer>') return Number(text('integer'));
    if (tok === '<array>') {
      const out: PlistValue[] = [];
      for (skipSpace(); tokens[i] !== '</array>'; skipSpace()) out.push(value());
      i++;
      return out;
    }
    if (tok === '<dict>') {
      const out: Record<string, PlistValue> = {};
      for (skipSpace(); tokens[i] !== '</dict>'; skipSpace()) {
        if (tokens[i++] !== '<key>') throw new Error(`expected <key>, got ${tokens[i - 1]}`);
        const key = text('key');
        if (key in out) throw new Error(`duplicate key ${key}`);
        out[key] = value();
      }
      i++;
      return out;
    }
    throw new Error(`unexpected ${tok}`);
  };
  skipSpace();
  if (!/^<plist version="1\.0">$/.test(tokens[i++] ?? '')) throw new Error('no <plist version="1.0">');
  const root = value();
  skipSpace();
  if (tokens[i++] !== '</plist>') throw new Error('</plist> missing');
  skipSpace();
  if (i !== tokens.length) throw new Error('content after </plist>');
  return root;
}

describe('mac/Info.plist', () => {
  const raw = readFileSync(join(macDir, 'Info.plist'), 'utf8');

  test('the parser is strict', () => {
    expect(() => parsePlist('<plist version="1.0"><dict><key>a</key></dict></plist>')).toThrow();
    expect(() => parsePlist('<plist version="1.0"><dict><key>a</key><string>x</dict></plist>')).toThrow();
    expect(() => parsePlist('<plist version="1.0"><string>a & b</string></plist>')).toThrow();
  });

  test('is a valid plist with what the menu-bar app needs', () => {
    expect(raw.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const p = parsePlist(raw) as Record<string, PlistValue>;
    expect(p).toMatchObject({
      CFBundleIdentifier: 'dev.casttown.cast',
      CFBundleExecutable: 'CAST',
      CFBundleName: 'CAST',
      CFBundlePackageType: 'APPL',
      CFBundleIconFile: 'AppIcon',
      CFBundleShortVersionString: '__VERSION__',
      CFBundleVersion: '__BUILD__',
      CASTUpdateRepository: '__UPDATE_REPOSITORY__',
      LSMinimumSystemVersion: '13.0',
      LSUIElement: true,
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    });
  });

  test('says why, when macOS asks on behalf of the server, the agents or the terminal', () => {
    const p = parsePlist(raw) as Record<string, PlistValue>;
    for (const key of ['NSAppleEventsUsageDescription', 'NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription',
      'NSDownloadsFolderUsageDescription', 'NSLocalNetworkUsageDescription', 'NSNetworkVolumesUsageDescription', 'NSRemovableVolumesUsageDescription']) {
      expect({ key, ok: typeof p[key] === 'string' && (p[key] as string).length > 20 }).toEqual({ key, ok: true });
    }
  });

  test('the script fills exactly the placeholders the template has', () => {
    const placeholders = [...new Set(raw.match(/__[A-Z][A-Z_]*[A-Z]__/g))].sort();
    expect(placeholders).toEqual(['__BUILD__', '__UPDATE_REPOSITORY__', '__VERSION__']);
    for (const p of placeholders) expect(script).toContain(`s/${p}/`);
  });
});

// ---- Swift sources -------------------------------------------------------------------------------------------------

/** Code with comments and string literals blanked (interpolations kept as code), for bracket counting. */
function swiftCode(src: string): string {
  let out = '';
  const interp: number[] = []; // paren depth at which each open \( returns to its string
  let depth = 0;
  let mode: 'code' | 'string' | 'line' | 'block' = 'code';
  let blockDepth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      continue;
    }
    if (mode === 'block') {
      if (c === '/' && n === '*') { blockDepth++; i++; } else if (c === '*' && n === '/') { if (--blockDepth === 0) mode = 'code'; i++; }
      continue;
    }
    if (mode === 'string') {
      if (c === '\\' && n === '(') { interp.push(depth); depth++; mode = 'code'; out += '('; i++; } else if (c === '\\') i++;
      else if (c === '"') { mode = 'code'; out += '""'; }
      else if (c === '\n') throw new Error('unterminated string');
      continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; blockDepth = 1; i++; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) throw new Error('multi-line strings are not handled');
      mode = 'string';
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (interp.length && interp[interp.length - 1] === depth) { interp.pop(); mode = 'string'; out += ')'; continue; }
    }
    out += c;
  }
  return out;
}

describe('mac/CASTMenu Swift sources', () => {
  test('the expected files, one main.swift and no @main', () => {
    expect(swiftFiles).toEqual(['CastClient.swift', 'MenuBar.swift', 'Paths.swift', 'SelfCheck.swift', 'ServerController.swift', 'Updater.swift', 'main.swift']);
    expect(allSwift).not.toMatch(/^\s*@main\b/m);
  });

  test('only AppKit, Foundation, ServiceManagement and UserNotifications are imported', () => {
    const allowed = new Set(['AppKit', 'Foundation', 'ServiceManagement', 'UserNotifications']);
    for (const [file, src] of Object.entries(swift)) {
      const imports = [...src.matchAll(/^\s*(?:@\w+\s+)*import\s+(?:(?:struct|class|enum|func|var|let|protocol|typealias)\s+)?([\w.]+)/gm)].map((m) => m[1].split('.')[0]);
      expect(imports.length).toBeGreaterThan(0);
      expect({ file, bad: imports.filter((m) => !allowed.has(m)) }).toEqual({ file, bad: [] });
    }
  });

  test('brackets balance in every file (a cheap syntax check, since swiftc is not here)', () => {
    for (const [file, src] of Object.entries(swift)) {
      const code = swiftCode(src);
      const stack: string[] = [];
      const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
      let bad = '';
      code.split('').forEach((c, i) => {
        if ('([{'.includes(c)) stack.push(c);
        else if (c in pairs && stack.pop() !== pairs[c] && !bad) bad = `${file}: unbalanced ${c} at offset ${i}`;
      });
      expect(bad).toBe('');
      expect({ file, open: stack.join('') }).toEqual({ file, open: '' });
    }
  });

  test('the bracket check itself catches mistakes', () => {
    expect(swiftCode('let a = "x \\(f("y"))" // }\n')).toBe('let a = (f(""))"" \n');
    const unbalanced = swiftCode('func f() { if x { }');
    expect(unbalanced.split('{').length).not.toBe(unbalanced.split('}').length);
  });

  test('no APIs newer than macOS 13 or Swift 5.9, no SwiftUI, no strict-concurrency escapes', () => {
    const banned: [RegExp, string][] = [
      [/\.activate\(\)/, 'NSApplication.activate() (macOS 14; use activate(ignoringOtherApps:))'],
      [/@Observable|\bimport Observation\b|\bSettingsLink\b|\bMenuBarExtra\b|\.symbolEffect\b|#Preview\b/, 'macOS 14 / SwiftUI'],
      [/\bthrows\(/, 'typed throws (Swift 6)'],
      [/\bnonisolated\(unsafe\)|\bsending\s+\w|@retroactive\b|#isolation\b|\b(consuming|borrowing)\s+\w+\s*:/, 'Swift 5.10/6 only'],
      [/@preconcurrency|@unchecked Sendable|unsafeBitCast/, 'a concurrency escape hatch'],
      [/\bprint\(|\bNSLog\(|\bdebugPrint\(/, 'print/NSLog (the app logs through Paths.log only)'],
    ];
    const hits: string[] = [];
    for (const [file, src] of Object.entries(swift)) for (const [re, what] of banned) if (re.test(src)) hits.push(`${file}: ${what}`);
    expect(hits).toEqual([]);
  });

  test('a delayed restart never runs start() inside the task start() cancels', () => {
    // start() cancels pendingRestart; a restart task that called it without clearing pendingRestart first would run
    // the whole start in a cancelled task: every URLSession request and Task.sleep fails at once, so the new server
    // is never seen as ready and is killed after the start timeout.
    const code = swiftCode(swift['ServerController.swift']);
    const starts = [...code.matchAll(/pendingRestart = Task \{/g)].map((m) => m.index!);
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const at of starts) {
      let depth = 0;
      let end = at;
      for (let i = code.indexOf('{', at); i < code.length; i++) {
        if (code[i] === '{') depth++;
        if (code[i] === '}' && --depth === 0) { end = i; break; }
      }
      const body = code.slice(at, end);
      let from = 0;
      for (let call = body.indexOf('self.start(', from); call >= 0; call = body.indexOf('self.start(', from)) {
        const before = body.slice(0, call);
        expect(before.lastIndexOf('self.pendingRestart = nil')).toBeGreaterThan(-1);
        from = call + 1;
      }
    }
  });

  test('the server side details the app relies on', () => {
    const server = swift['ServerController.swift'];
    // server/startup.ts RESTART_EXIT_CODE: "Delete all CAST data" under the app exits 75 to be started again
    expect(server).toContain('restartExitCode: Int32 = 75');
    expect(server).toContain('status == Self.restartExitCode');
    // Quit never lets a Restart or a crash restart start a server after it
    expect(server).toContain('guard !quitting else { return }');
    expect(swift['MenuBar.swift']).toContain('server.stopForQuit()');
    // attention items: the server's stable id and its next path (shared/app-status.ts AttentionItem)
    expect(swift['CastClient.swift']).toContain('a["id"]');
    expect(swift['CastClient.swift']).toContain('a["next"]');
    // one pairing at a time (the first start's poll and Open CAST both need a session)
    expect(swift['CastClient.swift']).toContain('if let running = pairing');
  });

  test('Check for Updates: the app, its Info.plist, the build and the install helper agree', () => {
    const updater = swift['Updater.swift'];
    // the key build-dmg.sh fills, the helper's file name in the app, where the helper reports
    expect(updater).toContain('forInfoDictionaryKey: "CASTUpdateRepository"');
    expect(swift['Paths.swift']).toContain('resources.appendingPathComponent("cast-install-update.sh")');
    expect(script).toContain('"$APP/Contents/Resources/cast-install-update.sh"');
    expect(swift['Paths.swift']).toContain('logsDir.appendingPathComponent("update-result")');
    // cast-install-update.sh <pid> <current app> <new app> <version> <result file>
    expect(updater).toContain('[helper.path, String(getpid()), Bundle.main.bundleURL.path, staged.path, version, paths.updateResultFile.path]');
    expect(readFileSync(join(macDir, 'cast-install-update.sh'), 'utf8')).toContain('<pid> <current app> <new app> <version> <result file>');
    // the app quits (stopping its server) once the helper runs: the helper waits for that before it swaps
    const menu = swift['MenuBar.swift'];
    expect(menu).toContain('"Check for Updates…"');
    expect(menu.indexOf('NSApp.terminate(nil)')).toBeGreaterThan(menu.indexOf('updater.startSwap('));
  });

  test('agrees with the server side of the contract (once the server branch is in this tree)', () => {
    // The server constants live in server/startup.ts, server/auth.ts and shared/app-status.ts (mac-server branch).
    // Before that branch is merged they are absent and there is nothing to compare; after it, any drift fails here.
    const read = (f: string) => (existsSync(join(repo, f)) ? readFileSync(join(repo, f), 'utf8') : '');
    const exitCode = read('server/startup.ts').match(/RESTART_EXIT_CODE = (\d+)/)?.[1];
    if (exitCode) expect(swift['ServerController.swift']).toContain(`restartExitCode: Int32 = ${exitCode}`);
    const device = read('server/auth.ts').match(/MENU_BAR_DEVICE_NAME = '([^']+)'/)?.[1];
    if (device) expect(swift['CastClient.swift']).toContain(`deviceName = "${device}"`);
    const feature = read('shared/app-status.ts').match(/MAC_APP_FEATURE = '([^']+)'/)?.[1];
    if (feature) expect(swift['SelfCheck.swift']).toContain(`"${feature}"`);
    const maxAttention = read('shared/app-status.ts').match(/MAX_ATTENTION = (\d+)/)?.[1];
    if (maxAttention) expect(swift['CastClient.swift']).toContain(`items.prefix(${maxAttention})`);
  });

  test('secrets are never written to the log or the console', () => {
    const logged = [...allSwift.matchAll(/\b(?:log|say|check)\(([^\n]*)/g)].map((m) => m[1]);
    expect(logged.length).toBeGreaterThan(10);
    expect(logged.filter((l) => /\\\((?:token|cookie|value|link|url|saved)\b/.test(l))).toEqual([]);
    expect(swift['CastClient.swift']).toContain('httpShouldSetCookies = false');
    expect(swift['CastClient.swift']).toContain('URLSessionConfiguration.ephemeral');
  });

  test('implements the app/server contract', () => {
    for (const s of [
      '"CAST_WEB_DIST"', '"CAST_AGENT_BIN"', 'appendingPathComponent("cast-agent")', '"CAST_PORT"', '"CAST_LAUNCHED_BY": "mac-app"', '"CAST_DATA_DIR"',
      '"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"', '"en_US.UTF-8"',
      '"HOME"', '"USER"', '"SHELL"', 'getpwuid(getuid())',
      'firstPort = 4860', 'lastPort = 4879', 'restartDelays: [UInt64] = [1, 5, 30]',
      '"/api/version"', '"/api/pair"', '"/api/status"', '"/api/login-link"', '"CAST menu bar (Mac)"',
      '"menubar-session"', '"token"', '"listen.json"', '"instance-id"', '0o600',
      '"Library/Application Support/CAST"', '"Library/Logs/CAST"', '"server.log"', '"server.1.log"',
      'SIGTERM', 'SIGKILL', 'seconds: 10', 'Date().timeIntervalSince(last) < 60',
      'SMAppService.mainApp', 'UNUserNotificationCenter', 'orderFrontStandardAboutPanel', 'NSWorkspace.shared.open',
      '"/?settings=pair"', '"mac-app-v1"', '"--check"', '"CAST needs you"', '"Open CAST"', '"Pair a phone…"',
      '"Open at login"', '"Notify me"', '"Restart CAST"', '"Show logs"', '"About CAST"', '"Quit CAST"',
    ]) expect({ missing: allSwift.includes(s) ? '' : s }).toEqual({ missing: '' });
  });
});

describe('mac/README.md', () => {
  const readme = readFileSync(join(macDir, 'README.md'), 'utf8');
  test('tells people how to build, open, find their data and uninstall', () => {
    expect(readme).toContain('./build-dmg.sh');
    expect(readme).toContain('xcode-select --install');
    expect(readme).toMatch(/right-click[^\n]*\*\*Open\*\*/i);
    expect(readme).toContain('Open Anyway');
    expect(readme).toContain('~/Library/Application Support/CAST');
    expect(readme).toContain('~/Library/Logs/CAST');
    expect(readme).toMatch(/^## Uninstall$/m);
  });
});
