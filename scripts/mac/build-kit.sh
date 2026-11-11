#!/usr/bin/env bash
# Build the kit a Mac turns into CAST.app and a .dmg (README "Mac app"). Runs on Linux (or a Mac) with Bun; no Xcode,
# no Apple account. The Mac side is mac/build-dmg.sh, shipped inside the kit.
#
#   scripts/mac/build-kit.sh <out-dir>                                  # builds the agent (cast-agent) for Apple Silicon
#   AGENT_DARWIN_BIN=/path/to/cast-agent-darwin-arm64 scripts/mac/build-kit.sh <out-dir>   # ship a prebuilt one
#   AGENT_LINUX_BIN=/path/to/cast-agent scripts/mac/build-kit.sh --target linux-x64 <out-dir>   # stand-in to test on Linux
#
# Options:
#   --target darwin-arm64   (default) Apple Silicon Macs, macOS 13 or newer
#   --target linux-x64      the same layout for Linux, to smoke-test the server binary where there is no Mac
#   --skip-web              use web/dist as it is instead of running the web build first
#
# Environment:
#   AGENT_DARWIN_BIN  optional for darwin-arm64: a standalone cast-agent for Apple Silicon (natives inside). Unset:
#                     bash agent/cast/build.sh --binary darwin-arm64 → agent/packages/coding-agent/dist/cast-agent-darwin-arm64
#   AGENT_LINUX_BIN   optional for linux-x64: a cast-agent for this machine (a launcher script is linked, not copied).
#                     Unset: bash agent/cast/build.sh --binary linux-x64 → agent/packages/coding-agent/dist/cast-agent-linux-x64
#
# Result:
#   <out-dir>/cast-mac-kit/                      cast-server, cast-agent, agent-LICENSE, agent-THIRD-PARTY-NOTICES.txt,
#                                                web/dist/, mac/, build-dmg.sh, VERSION, BUILD-INFO, UPDATE-REPOSITORY,
#                                                LICENSE, THIRD-PARTY-NOTICES.md, SHA256SUMS
#   <out-dir>/cast-mac-kit-<version>.tar.gz      (…-<version>-linux-x64.tar.gz for the stand-in)
# On the Mac: tar xzf cast-mac-kit-<version>.tar.gz && cd cast-mac-kit && ./build-dmg.sh
set -euo pipefail

die() { echo "build-kit: $*" >&2; exit 1; }
note() { echo "build-kit: $*"; }

target=darwin-arm64
skip_web=0
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || die "--target needs a value (darwin-arm64 or linux-x64)"; target="$2"; shift 2 ;;
    --target=*) target="${1#--target=}"; shift ;;
    --skip-web) skip_web=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$out" ] || die "one output folder only"; out="$1"; shift ;;
  esac
done
[ -n "$out" ] || die "usage: scripts/mac/build-kit.sh [--target darwin-arm64|linux-x64] [--skip-web] <out-dir>"

case "$target" in
  darwin-arm64) bun_target=bun-darwin-arm64; agent_src="${AGENT_DARWIN_BIN:-}"; agent_var=AGENT_DARWIN_BIN; suffix="" ;;
  linux-x64) bun_target=bun-linux-x64; agent_src="${AGENT_LINUX_BIN:-}"; agent_var=AGENT_LINUX_BIN; suffix="-linux-x64" ;;
  *) die "unknown target '$target' (darwin-arm64 or linux-x64)" ;;
esac
[ -z "$agent_src" ] || [ -f "$agent_src" ] || die "$agent_var=$agent_src is not a file"
command -v bun >/dev/null || die "bun is not on PATH"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
case "$out" in /|"$root"|"$HOME") die "pick an output folder of its own, not $out" ;; esac
kit="$out/cast-mac-kit"
cd "$root"
# The agent's licence and third-party notices travel with every copy of it (agent/FORK.md).
for doc in LICENSE THIRD-PARTY-NOTICES.txt; do
  [ -f "agent/$doc" ] || die "agent/$doc is missing: the kit must ship the agent's (cast-agent's) $doc"
done

version="$(bun --print 'require("./package.json").version')"
[ -n "$version" ] || die "could not read the version from package.json"

# First bytes of a file as hex ("cffaedfe0c000001" = Mach-O 64-bit arm64, "7f454c46…" = ELF, "2321…" = #!).
magic() { od -An -tx1 -N8 "$1" | tr -d ' \n'; }
check_binary() { # <file> <what>
  local m
  m="$(magic "$1")"
  case "$target" in
    darwin-arm64) [ "$m" = "cffaedfe0c000001" ] || die "$2 is not a Mach-O arm64 binary ($1)" ;;
    linux-x64) case "$m" in 7f454c46*|2321*) ;; *) die "$2 is not a Linux program ($1)" ;; esac ;;
  esac
}

if [ -z "$agent_src" ]; then
  [ -f agent/cast/build.sh ] || die "agent/cast/build.sh is missing: set $agent_var to a prebuilt cast-agent instead"
  note "agent: bash agent/cast/build.sh --binary $target (set $agent_var to skip)"
  bash "$root/agent/cast/build.sh" --binary "$target" >&2 || die "the agent (cast-agent) build failed"
  agent_src="$root/agent/packages/coding-agent/dist/cast-agent-$target"
  agent_var="agent/packages/coding-agent/dist/cast-agent-$target"
  [ -f "$agent_src" ] || die "the agent build did not produce $agent_src"
fi
check_binary "$agent_src" "$agent_var"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

note "CAST $version for $target → $kit"
rm -rf "$kit"
mkdir -p "$kit/web"

if [ "$skip_web" = 1 ]; then
  [ -f web/dist/index.html ] || die "--skip-web: web/dist/index.html is missing (run bun run build:web)"
  note "web app: using web/dist as it is"
else
  note "web app: bun run build:web"
  bun run build:web >/dev/null
fi
cp -R web/dist "$kit/web/dist"

note "server: bun build --compile --target=$bun_target"
bun build --compile --target="$bun_target" \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  server/index.ts --outfile "$kit/cast-server" >/dev/null
check_binary "$kit/cast-server" "the compiled server"

if [ "$(magic "$agent_src" | cut -c1-4)" = "2321" ]; then
  # A launcher script (cast-agent run from a checkout) only works where it is: link it. Stand-in kits only.
  ln -s "$(cd "$(dirname "$agent_src")" && pwd)/$(basename "$agent_src")" "$kit/cast-agent"
  note "cast-agent: $agent_var is a script, linked (this kit only works on this machine)"
else
  cp "$agent_src" "$kit/cast-agent"
  chmod 755 "$kit/cast-agent"
fi
cp agent/LICENSE "$kit/agent-LICENSE"
cp agent/THIRD-PARTY-NOTICES.txt "$kit/agent-THIRD-PARTY-NOTICES.txt"

if [ -d mac ]; then
  # the menu-bar app's sources, without anything a Mac build left behind
  tar -C "$root" --exclude='mac/build' --exclude='mac/.build' --exclude='*.app' --exclude='*.dmg' --exclude='.DS_Store' -cf - mac | tar -C "$kit" -xf -
  if [ -f mac/build-dmg.sh ]; then
    cp mac/build-dmg.sh "$kit/build-dmg.sh"
  else
    note "WARNING: mac/build-dmg.sh is missing — the kit cannot build a dmg"
  fi
else
  note "WARNING: this checkout has no mac/ folder — the kit has no menu-bar app sources and no build-dmg.sh"
fi

cp LICENSE THIRD-PARTY-NOTICES.md "$kit/"
printf '%s\n' "$version" > "$kit/VERSION"
# Check for Updates in CAST.app installs the releases of this repository (build-dmg.sh puts it in Info.plist; the
# CHANGE-ME placeholder means "not set up" there).
bun --print '(require("./package.json").repository?.url ?? "").replace(/^git\+/, "")' > "$kit/UPDATE-REPOSITORY"
commit="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$commit" != unknown ] && [ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ]; then commit="$commit+changes"; fi
{
  echo "version=$version"
  echo "target=$target"
  echo "commit=$commit"
  echo "bun=$(bun --version)"
  echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$kit/BUILD-INFO"

# Readable by every account on the Mac (the folder was made under this shell's umask), programs executable.
chmod -R u+rwX,go+rX,go-w "$kit"
chmod 755 "$kit/cast-server"
[ -L "$kit/cast-agent" ] || chmod 755 "$kit/cast-agent"
[ ! -f "$kit/build-dmg.sh" ] || chmod 755 "$kit/build-dmg.sh"
find "$kit" -name '*.sh' -type f -exec chmod 755 {} +

(cd "$kit" && find . \( -type f -o -type l \) ! -name SHA256SUMS -print | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do sha256 "$f"; done > SHA256SUMS)
chmod 644 "$kit/SHA256SUMS"

tarball="$out/cast-mac-kit-$version$suffix.tar.gz"
rm -f "$tarball"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar -C "$out" --owner=0 --group=0 --numeric-owner -czf "$tarball" cast-mac-kit
else
  tar -C "$out" --uid 0 --gid 0 -czf "$tarball" cast-mac-kit
fi

chmod 644 "$tarball"

size() { du -sh "$1" | cut -f1; }
note "done: $tarball ($(size "$tarball")); cast-server $(size "$kit/cast-server"), web/dist $(size "$kit/web/dist")"
