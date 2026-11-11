#!/usr/bin/env bash
# Export what CAST publishes as ONE fresh git commit with no history.
#
#   scripts/release/snapshot.sh <out-dir>        (or: bun run release:snapshot -- <out-dir>)
#
# <out-dir> must not exist yet, or be empty, and must be outside this folder. It gets exactly the files `.gitignore`
# allows (the same list tests/repo/hygiene.test.ts checks), copied as they are, and a new repository on branch `main`
# with a single commit "CAST <version>". Push that branch; never the development history, which still names the
# owner's machine and e-mail address (RELEASE-CHECKLIST.md).
#
# The script reads this folder through a throwaway git dir, so it works the same in a checkout and in a plain copy,
# and it never writes into this folder. It refuses to run, writing nothing, when the file list holds runtime state or
# private notes: a data folder, a pairing token, NEXT.md / JOBS.md / GRAPHICS.md, build output, node_modules.
set -euo pipefail

die() { printf 'snapshot: %s\n' "$*" >&2; exit 1; }

[ $# -eq 1 ] && [ -n "$1" ] || die "usage: scripts/release/snapshot.sh <out-dir>"
command -v git >/dev/null || die "git is required"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# The absolute, symlink-free path of <out-dir>, which may not exist yet: resolve its nearest existing ancestor.
case "$1" in
  /*) abs="$1" ;;
  *) abs="$PWD/$1" ;;
esac
while [ "${abs%/}" != "$abs" ]; do abs="${abs%/}"; done
[ -n "$abs" ] || die "<out-dir> must not be the root folder"
head="$abs"
tail=""
while [ ! -d "$head" ]; do
  tail="/$(basename "$head")$tail"
  head="$(dirname "$head")"
done
case "$tail/" in
  */../* | */./*) die "<out-dir> has a . or .. component under a folder that does not exist: $1" ;;
esac
headreal="$(cd "$head" && pwd -P)"
[ "$headreal" = / ] && headreal=""
out="$headreal$tail"

case "$out/" in
  "$root"/*) die "<out-dir> must be outside the repository ($root)" ;;
esac
if [ -e "$out" ]; then
  [ -d "$out" ] || die "$out exists and is not a folder"
  [ -z "$(ls -A -- "$out")" ] || die "$out is not empty"
fi

version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/package.json" | sed -n 1p)"
[ -n "$version" ] || die "no version in package.json"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/cast-snapshot.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
list="$scratch/files"

# An empty index in a throwaway git dir: ls-files then names every file .gitignore allows.
env -u GIT_DIR -u GIT_WORK_TREE git init --quiet --bare "$scratch/git"
env -u GIT_DIR -u GIT_WORK_TREE git --git-dir="$scratch/git" --work-tree="$root" \
  ls-files -z --others --exclude-standard > "$list"

# Paths that must never be published, the ones hygiene.test.ts also checks.
forbidden='^(data|\.dev|screenshots|node_modules|web/dist|dist)(/|$)|(^|/)(token|devices\.json|cities\.json|instance-id|listen\.json)$|^(NEXT|JOBS|GRAPHICS)\.md$'
bad="$(tr '\0' '\n' < "$list" | grep -E "$forbidden" || true)"
if [ -n "$bad" ]; then
  printf 'snapshot: refusing to export, these files would be published:\n%s\n' "$bad" >&2
  die "fix .gitignore first"
fi

count="$(tr -cd '\0' < "$list" | wc -c | tr -d ' ')"
[ "$count" -gt 0 ] || die "the file list is empty"

mkdir -p "$out"
(cd "$root" && tar --null --no-recursion -T "$list" -cf -) | tar -xf - -C "$out"

cd "$out"
env -u GIT_DIR -u GIT_WORK_TREE git init --quiet
git symbolic-ref HEAD refs/heads/main
env -u GIT_DIR -u GIT_WORK_TREE git add -A
env -u GIT_DIR -u GIT_WORK_TREE git \
  -c user.name=CAST -c user.email=noreply@users.noreply.github.com -c commit.gpgsign=false \
  commit --quiet --no-verify -m "CAST $version"

tracked="$(git ls-files | wc -l | tr -d ' ')"
[ "$tracked" = "$count" ] || die "committed $tracked files but listed $count: .gitignore inside the export dropped some"
[ "$(git rev-list --count HEAD)" = 1 ] || die "the export has more than one commit"

printf 'snapshot: %s files in one commit "CAST %s" on branch main: %s\n' "$count" "$version" "$out"
