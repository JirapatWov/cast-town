#!/bin/bash
# Turn a linux-x64 kit (scripts/mac/build-kit.sh --target linux-x64, with a real standalone cast-agent) into the
# Linux download: <out-dir>/cast-<version>-linux-x64.tar.gz, unpacking to cast-<version>-linux-x64/ with cast-server,
# cast-agent, web/dist, the licences and notices and a SHA256SUMS over them. Mac-only parts of the kit (mac/,
# build-dmg.sh, …) are left out. ./cast-server starts CAST from that folder without Bun.
#
# Usage: scripts/release/linux-tarball.sh <kit-dir> <out-dir>
#   <kit-dir>  the unpacked kit folder (…/cast-mac-kit) or the folder build-kit.sh wrote it into
# Bash 3.2 and BSD tools are enough (no GNU-only flags).
set -euo pipefail

die() { printf 'linux-tarball: %s\n' "$*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: scripts/release/linux-tarball.sh <kit-dir> <out-dir>"
kit="$1"
out="$2"
[ -f "$kit/cast-server" ] || [ ! -d "$kit/cast-mac-kit" ] || kit="$kit/cast-mac-kit"
[ -f "$kit/cast-server" ] || die "$kit has no cast-server (is it a kit folder?)"
grep -qx 'target=linux-x64' "$kit/BUILD-INFO" 2>/dev/null || die "$kit is not a linux-x64 kit (BUILD-INFO target)"
version="$(cat "$kit/VERSION")"
[ -n "$version" ] || die "$kit/VERSION is empty"

elf() { [ "$(od -An -tx1 -N4 "$1" | tr -d ' \n')" = 7f454c46 ]; }
elf "$kit/cast-server" || die "cast-server is not a Linux program"
# The kit's stand-in links a launcher script; the download needs the real standalone program.
[ ! -L "$kit/cast-agent" ] && [ -f "$kit/cast-agent" ] && elf "$kit/cast-agent" \
  || die "cast-agent is not a standalone Linux program (build the kit without AGENT_LINUX_BIN)"
[ -f "$kit/web/dist/index.html" ] || die "web/dist/index.html is missing"
command -v shasum >/dev/null || die "shasum is needed for SHA256SUMS"

name="cast-$version-linux-x64"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/cast-linux-tarball.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
trap 'exit 130' INT TERM
dir="$stage/$name"
mkdir -p "$dir/web"

cp "$kit/cast-server" "$kit/cast-agent" "$dir/"
cp -R "$kit/web/dist" "$dir/web/dist"
for doc in LICENSE THIRD-PARTY-NOTICES.md agent-LICENSE agent-THIRD-PARTY-NOTICES.txt; do
  [ -f "$kit/$doc" ] || die "$doc is missing from the kit"
  cp "$kit/$doc" "$dir/$doc"
done

chmod -R u+rwX,go+rX,go-w "$dir"
chmod 755 "$dir/cast-server" "$dir/cast-agent"
(cd "$dir" && find . -type f ! -name SHA256SUMS -print | sed 's|^\./||' | LC_ALL=C sort \
  | while IFS= read -r f; do shasum -a 256 "$f"; done > SHA256SUMS)
chmod 644 "$dir/SHA256SUMS"

tarball="$out/$name.tar.gz"
rm -f "$tarball"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$tarball" "$name"
else
  tar -C "$stage" --uid 0 --gid 0 -czf "$tarball" "$name"
fi
chmod 644 "$tarball"
printf 'linux-tarball: %s\n' "$tarball"
