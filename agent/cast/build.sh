#!/usr/bin/env bash
# Build cast-agent (CAST's fork of omp) without a Rust toolchain.
#
#   cast/build.sh                 # deps + prebuilt natives (host) + CLI bundle  → bin/cast-agent works
#   cast/build.sh --binary [tag]  # additionally compile a standalone executable with the
#                                 # natives embedded (upstream's `bun run build`):
#                                 # packages/coding-agent/dist/cast-agent, or with a tag such as
#                                 # darwin-arm64 → packages/coding-agent/dist/cast-agent-darwin-arm64
#
# Steps mirror upstream's release flow: `bun install --frozen-lockfile` (its `prepare` hook
# runs gen:tool-views), then coding-agent `gen:bundle` (scripts/bundle-dist.ts → dist/cli.js).
# The only deviation: instead of `bun run build:native` (Rust/bazel) we install the addons
# upstream published to npm for the same version (cast/fetch-natives.ts, sha512-pinned).
# Needs bun and tar only: the agent lives in CAST's repository (or a copy of it without git).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need="1.3.14"
have="$(bun --version)"
if [ "$(bun -e "console.log(Bun.semver.satisfies('$have', '>=$need'))")" != "true" ]; then
	echo "cast/build.sh: bun >= $need required (have $have)" >&2; exit 1
fi

echo "==> bun install --frozen-lockfile"
bun install --frozen-lockfile

echo "==> prebuilt natives (npm @oh-my-pi/pi-natives-<platform>, pinned in cast/natives.lock.json)"
bun cast/fetch-natives.ts

echo "==> bundle CLI (upstream gen:bundle)"
(cd packages/coding-agent && bun scripts/bundle-dist.ts)

if [ "${1:-}" = "--binary" ]; then
	tag="${2:-}"
	dist=packages/coding-agent/dist
	if [ -n "$tag" ] && [ "$tag" != "$(bun -e 'console.log(`${process.platform}-${process.arch}`)')" ]; then
		bun cast/fetch-natives.ts "$tag"
		echo "==> standalone binary for $tag (CROSS_TARGET)"
		(cd packages/coding-agent && CROSS_TARGET="$tag" bun scripts/build-binary.ts)
		built="$dist/omp-$tag"
	else
		echo "==> standalone binary for host"
		(cd packages/coding-agent && bun scripts/build-binary.ts)
		built="$dist/omp"
	fi
	# upstream's build-binary.ts (and the install tests, Nix, Docker and metaharness that use its output) keeps the
	# name omp; what CAST ships is cast-agent, with the tag whenever one was asked for, so callers need not know
	# whether it matched this machine
	ext=""
	if [ -f "$built.exe" ]; then ext=".exe"; fi
	mv -f "$built$ext" "$dist/cast-agent${tag:+-$tag}$ext"
	echo "binary: $dist/cast-agent${tag:+-$tag}$ext"
fi

# The agent is a folder of CAST's repository, so git (when there is one) describes CAST's commit, not upstream's.
commit="unknown"
dirty="null"
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
	if [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no -- . 2>/dev/null)" ]; then dirty=false; else dirty=true; fi
fi
json() { bun -e "console.log(require('$1').$2)"; }
cat > packages/coding-agent/dist/CAST-BUILD.json <<EOF
{
  "agent": "cast-agent (CAST's fork of omp, oh-my-pi)",
  "version": "$(json ./packages/coding-agent/package.json version)",
  "castCommit": "$commit",
  "dirty": $dirty,
  "nativesVersion": "$(json ./cast/natives.lock.json version)",
  "bun": "$have",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "==> smoke"
smoke_dir="$(mktemp -d)"
echo "bin/cast-agent --version: $(PI_CODING_AGENT_DIR="$smoke_dir" "$ROOT/bin/cast-agent" --version)"
rm -rf "$smoke_dir"
echo "build info: packages/coding-agent/dist/CAST-BUILD.json"
