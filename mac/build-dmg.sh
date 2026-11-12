#!/bin/bash
# Builds CAST.app and CAST-<version>-arm64.dmg on an Apple Silicon Mac, from the unpacked cast-mac-kit folder.
#
#   ./build-dmg.sh             build the app, run its self-check, make the dmg
#   ./build-dmg.sh --run       build the app, run its self-check, open it (no dmg)
#   ./build-dmg.sh --no-check  skip the self-check (with or without --run)
#
# Needs macOS 13 or newer on Apple Silicon and Apple's Command Line Tools (xcode-select --install). Uses only what
# ships with macOS and the Command Line Tools: no Xcode project, no Homebrew. The app is signed ad hoc (no Apple
# Developer account), so the first time it is opened macOS asks you to confirm: right-click CAST, then Open.
#
# Optional release signing: CAST_SIGN_IDENTITY selects an installed Developer ID Application certificate.
# CAST_SIGN_ENTITLEMENTS must then point to the Bun runtime entitlements (agent/scripts/macos-entitlements.plist
# in a checkout). CAST_SIGN_KEYCHAIN names the keychain that holds it, so codesign finds it even when HOME points
# elsewhere (the release workflow runs this with a throwaway HOME). The workflow notarizes the dmg separately.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() {
  printf '\nERROR: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}

RUN=0
CHECK=1
while [ "$#" -gt 0 ]; do # (not `for arg in "$@"`: macOS's bash 3.2 can treat an empty "$@" as unset under set -u)
  case "$1" in
    --run) RUN=1 ;;
    --no-check) CHECK=0 ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1" "Use --run, --no-check or --help." ;;
  esac
  shift
done

# ---- Where things are -------------------------------------------------------------------------------------------
HERE=$(cd "$(dirname "$0")" && pwd -P)
if [ -d "$HERE/mac/CASTMenu" ]; then
  KIT=$HERE # the unpacked kit: build-dmg.sh sits next to mac/, cast-server, cast-agent and web/dist
elif [ -d "$HERE/CASTMenu" ]; then
  KIT=$(cd "$HERE/.." && pwd -P) # mac/build-dmg.sh inside a CAST checkout that holds the kit's files
else
  die "Can't find the app's source code (mac/CASTMenu) next to this script." \
    "Run build-dmg.sh from the unpacked cast-mac-kit folder."
fi
MAC=$KIT/mac
SERVER=$KIT/cast-server
AGENT=$KIT/cast-agent
WEB=$KIT/web/dist
OUT=$KIT/build
APP=$OUT/CAST.app

# ---- This Mac -----------------------------------------------------------------------------------------------------
say "Checking this Mac"
[ "$(uname -s)" = Darwin ] ||
  die "This script runs on a Mac." "On Linux, build the kit with scripts/mac/build-kit.sh and copy it to the Mac."

arch=$(uname -m)
if [ "$arch" != arm64 ]; then
  if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    info "This Terminal runs under Rosetta; building for Apple Silicon anyway."
  else
    die "CAST for Mac needs Apple Silicon (an M1 chip or newer). This Mac reports: $arch."
  fi
fi

os=$(sw_vers -productVersion)
major=${os%%.*}
case "$major" in
  '' | *[!0-9]*) die "Can't read the macOS version (sw_vers said: $os)." ;;
esac
[ "$major" -ge 13 ] || die "CAST needs macOS 13 Ventura or newer. This Mac runs macOS $os."
info "macOS $os on Apple Silicon"

if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then
  die "Apple's Command Line Tools are not installed (they include the Swift compiler)." \
    "Install them with:  xcode-select --install" \
    "then run this script again."
fi
SWIFTC=$(xcrun --find swiftc)
SDK=$(xcrun --sdk macosx --show-sdk-path)
sdk_version=$(xcrun --sdk macosx --show-sdk-version)
sdk_major=${sdk_version%%.*}
case "$sdk_major" in
  '' | *[!0-9]*) die "Can't read the macOS SDK version (xcrun said: $sdk_version)." ;;
esac
[ "$sdk_major" -ge 13 ] ||
  die "The Command Line Tools are too old (macOS SDK $sdk_version; CAST needs 13 or newer)." \
    "Update them in System Settings > General > Software Update, or run: xcode-select --install"
# The app needs Swift 5.9 or newer (MainActor.assumeIsolated): Command Line Tools 15 or newer.
swift_version=$("$SWIFTC" --version 2>&1 | sed -n 's/.*Swift version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1 || true)
case "$swift_version" in
  [0-9]*.[0-9]*)
    swift_major=${swift_version%%.*}
    swift_minor=${swift_version#*.}
    if [ "$swift_major" -lt 5 ] || { [ "$swift_major" -eq 5 ] && [ "$swift_minor" -lt 9 ]; }; then
      die "The Command Line Tools are too old (Swift $swift_version; CAST needs Swift 5.9 or newer)." \
        "Update them in System Settings > General > Software Update, or run: xcode-select --install"
    fi
    ;;
  *) info "(could not read the Swift version; trying anyway)" ;;
esac
info "Swift compiler: $SWIFTC (Swift ${swift_version:-?}, macOS SDK $sdk_version)"

for tool in codesign hdiutil sips iconutil plutil ditto xattr file shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "The macOS tool '$tool' is missing. Is this a standard macOS install?"
done

# ---- The kit ------------------------------------------------------------------------------------------------------
say "Checking the kit in $KIT"
VERSION=
if [ -f "$KIT/VERSION" ]; then
  VERSION=$(tr -d ' \t\r\n' <"$KIT/VERSION")
elif [ -f "$KIT/package.json" ]; then
  VERSION=$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$KIT/package.json")
fi
case "$VERSION" in
  '' | *[!0-9A-Za-z.+-]*) die "Can't read CAST's version from $KIT/VERSION." ;;
esac
BUILD=${VERSION%%[-+]*}
info "CAST $VERSION"

SIGN_IDENTITY=${CAST_SIGN_IDENTITY:-}
ENTITLEMENTS=${CAST_SIGN_ENTITLEMENTS:-}
SIGN_KEYCHAIN=${CAST_SIGN_KEYCHAIN:-}
if [ -n "$SIGN_IDENTITY" ]; then
  [ -f "$ENTITLEMENTS" ] ||
    die "CAST_SIGN_ENTITLEMENTS must name the Bun runtime entitlements when CAST_SIGN_IDENTITY is set."
  plutil -lint "$ENTITLEMENTS" >/dev/null || die "CAST_SIGN_ENTITLEMENTS is not a valid plist."
  if [ -n "$SIGN_KEYCHAIN" ] && [ ! -f "$SIGN_KEYCHAIN" ]; then
    die "CAST_SIGN_KEYCHAIN names a keychain that does not exist: $SIGN_KEYCHAIN"
  fi
fi

missing() {
  die "$1 is missing from the kit ($KIT)." \
    "Build the kit on the server with scripts/mac/build-kit.sh, copy cast-mac-kit-<version>.tar.gz to this Mac," \
    "unpack it (tar xzf cast-mac-kit-*.tar.gz) and run ./build-dmg.sh inside the cast-mac-kit folder."
}
[ -f "$SERVER" ] || missing "cast-server"
[ -f "$AGENT" ] || missing "cast-agent"
[ -f "$WEB/index.html" ] || missing "web/dist/index.html"
[ -f "$WEB/icon-512.png" ] || missing "web/dist/icon-512.png"
[ -f "$MAC/Info.plist" ] || missing "mac/Info.plist"
[ -f "$MAC/cast-install-update.sh" ] || missing "mac/cast-install-update.sh"
# The agent's licence and third-party notices travel with every copy of it (agent/FORK.md): the kit's copies, or the
# originals in agent/ when this runs inside a CAST checkout.
agent_doc() { # <name in the kit> <path in a checkout>
  if [ -f "$KIT/$1" ]; then AGENT_DOC=$KIT/$1; elif [ -f "$KIT/$2" ]; then AGENT_DOC=$KIT/$2; else missing "$1"; fi
}
agent_doc agent-LICENSE agent/LICENSE
AGENT_LICENSE=$AGENT_DOC
agent_doc agent-THIRD-PARTY-NOTICES.txt agent/THIRD-PARTY-NOTICES.txt
AGENT_NOTICES=$AGENT_DOC

# Where Check for Updates looks for releases: the GitHub repository package.json names (build-kit.sh writes it to
# UPDATE-REPOSITORY). No file, or the CHANGE-ME placeholder, leaves updates "not set up" (the app asks for it then).
UPDATE_REPOSITORY=
if [ -f "$KIT/UPDATE-REPOSITORY" ]; then
  UPDATE_REPOSITORY=$(head -n 1 "$KIT/UPDATE-REPOSITORY" | tr -d ' \t\r\n')
fi
case "$UPDATE_REPOSITORY" in
  *[!A-Za-z0-9:/._+@~-]*) die "UPDATE-REPOSITORY in the kit is not a plain repository address: $UPDATE_REPOSITORY" ;;
esac
UPDATE_REPOSITORY_SED=$(printf '%s' "$UPDATE_REPOSITORY" | sed 's/[\/&]/\\&/g')
for program in "$SERVER" "$AGENT"; do
  kind=$(file -b "$program")
  case "$kind" in
    *Mach-O*arm64*) ;;
    *) die "$(basename "$program") is not a macOS program for Apple Silicon (it is: $kind)." \
      "The kit must be built with bun build --compile --target=bun-darwin-arm64." ;;
  esac
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cast-build.XXXXXX")
CHECK_DIR=$WORK/check

# A server the self-check started is stopped by the self-check itself. If CAST --check crashed or was interrupted
# (Ctrl+C) before that, the server would keep running (on port 4860, with its data folder deleted): stop it here.
# Only the one whose listen.json is in this run's throwaway folder, and only if it really is a cast-server.
stop_check_server() {
  listen=$CHECK_DIR/data/listen.json
  [ -f "$listen" ] || return 0
  pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$listen" | head -n 1)
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  case "$(ps -p "$pid" -o comm= 2>/dev/null)" in
    *cast-server*) ;;
    *) return 0 ;;
  esac
  printf 'Stopping the CAST server the self-check left running (pid %s)\n' "$pid" >&2
  kill -TERM "$pid" 2>/dev/null || return 0
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
}
cleanup() {
  stop_check_server || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM # (so that cleanup runs on Ctrl+C too)

if [ -f "$KIT/SHA256SUMS" ]; then
  if (cd "$KIT" && shasum -a 256 -c SHA256SUMS) >"$WORK/sums.txt" 2>&1; then
    info "Every file matches SHA256SUMS"
  else
    grep -v ': OK$' "$WORK/sums.txt" | head -n 20 >&2 || true
    die "Some files of the kit don't match SHA256SUMS: the copy is incomplete or was changed." \
      "Copy cast-mac-kit-$VERSION.tar.gz to this Mac again and unpack it into an empty folder."
  fi
fi

# ---- Compile ------------------------------------------------------------------------------------------------------
say "Compiling the menu-bar app"
set -- "$MAC"/CASTMenu/*.swift
[ -f "$1" ] || die "No Swift files in $MAC/CASTMenu."
if ! "$SWIFTC" -O -swift-version 5 -target arm64-apple-macos13.0 -sdk "$SDK" -module-name CAST \
  -o "$WORK/CAST" "$@"; then
  die "The Swift compiler failed (its messages are above)." \
    "Make sure the Command Line Tools are up to date (System Settings > General > Software Update)."
fi
info "Compiled $# Swift files"

# ---- Assemble CAST.app ---------------------------------------------------------------------------------------------
say "Assembling CAST.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp "$WORK/CAST" "$APP/Contents/MacOS/CAST"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" -e "s/__UPDATE_REPOSITORY__/$UPDATE_REPOSITORY_SED/g" \
  "$MAC/Info.plist" >"$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null || die "The generated Info.plist is not valid."
printf 'APPL????' >"$APP/Contents/PkgInfo"
cp "$SERVER" "$APP/Contents/Resources/cast-server"
cp "$AGENT" "$APP/Contents/Resources/cast-agent"
chmod 755 "$APP/Contents/MacOS/CAST" "$APP/Contents/Resources/cast-server" "$APP/Contents/Resources/cast-agent"
ditto "$WEB" "$APP/Contents/Resources/web/dist"
cp "$MAC/cast-install-update.sh" "$APP/Contents/Resources/cast-install-update.sh" # Check for Updates' installer
chmod 755 "$APP/Contents/Resources/cast-install-update.sh"
for doc in LICENSE THIRD-PARTY-NOTICES.md; do
  if [ -f "$KIT/$doc" ]; then cp "$KIT/$doc" "$APP/Contents/Resources/$doc"; fi
done
cp "$AGENT_LICENSE" "$APP/Contents/Resources/agent-LICENSE"
cp "$AGENT_NOTICES" "$APP/Contents/Resources/agent-THIRD-PARTY-NOTICES.txt"

info "Making the app icon"
ICONSET=$WORK/AppIcon.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$WEB/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null ||
    die "sips could not resize web/dist/icon-512.png."
  sips -z "$double" "$double" "$WEB/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null ||
    die "sips could not resize web/dist/icon-512.png."
done
iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$ICONSET" || die "iconutil could not make AppIcon.icns."

# ---- Sign, inside out -----------------------------------------------------------------------------------------------
# Ad hoc builds don't enable the hardened runtime. Developer ID builds give Bun the JIT/native-loading
# entitlements before enabling it, and the self-check below runs under the final signature.
if [ -n "$SIGN_IDENTITY" ]; then
  say "Signing CAST.app (Developer ID)"
else
  say "Signing CAST.app (ad hoc: no Apple Developer account needed)"
fi
# codesign refuses files that carry Finder info or a resource fork. (A protected attribute such as com.apple.provenance
# may refuse to go; that one does not matter to codesign, which says so itself if something else is left.)
xattr -cr "$APP" 2>/dev/null || info "Some extended attributes could not be removed; codesign will tell if that matters."
for program in "$APP/Contents/Resources/cast-server" "$APP/Contents/Resources/cast-agent"; do
  if [ -n "$SIGN_IDENTITY" ]; then
    codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} --sign "$SIGN_IDENTITY" "$program" ||
      die "codesign could not sign $(basename "$program") with the Developer ID certificate."
  else
    codesign --force -s - "$program" || die "codesign could not sign $(basename "$program")."
  fi
done
if [ -n "$SIGN_IDENTITY" ]; then
  codesign --force --timestamp --options runtime ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} --sign "$SIGN_IDENTITY" "$APP" ||
    die "codesign could not sign CAST.app with the Developer ID certificate."
else
  codesign --force -s - "$APP" || die "codesign could not sign CAST.app."
fi
if ! codesign --verify --strict --verbose=2 "$APP" >"$WORK/verify.txt" 2>&1; then
  cat "$WORK/verify.txt" >&2
  die "The signature of CAST.app does not verify."
fi
# The bundle's seal only hashes these two (they sit in Resources); their own signatures are what macOS checks when
# CAST starts them, and an arm64 program with a broken one is killed on the spot.
for program in "$APP/Contents/Resources/cast-server" "$APP/Contents/Resources/cast-agent"; do
  if ! codesign --verify --strict --verbose=2 "$program" >"$WORK/verify.txt" 2>&1; then
    cat "$WORK/verify.txt" >&2
    die "The signature of $(basename "$program") does not verify."
  fi
done
xattr -cr "$APP" 2>/dev/null || true
info "Signed and verified"

# ---- Self-check -----------------------------------------------------------------------------------------------------
if [ "$CHECK" = 1 ]; then
  say "Self-check: starting CAST in a throwaway folder, signing in, then stopping it"
  mkdir -p "$CHECK_DIR/data" "$CHECK_DIR/workspace"
  chmod 700 "$CHECK_DIR/data"
  if ! CAST_DATA_DIR="$CHECK_DIR/data" CAST_WORKSPACE="$CHECK_DIR/workspace" "$APP/Contents/MacOS/CAST" --check; then
    if [ -f "$CHECK_DIR/data/logs/server.log" ]; then
      printf '\nLast lines of the server log:\n' >&2
      tail -n 40 "$CHECK_DIR/data/logs/server.log" >&2 || true
    fi
    stop_check_server || true
    die "The self-check failed (see above)." \
      "To build anyway (not recommended): ./build-dmg.sh --no-check"
  fi
else
  info "Skipping the self-check (--no-check)"
fi

if [ "$RUN" = 1 ]; then
  say "Opening CAST.app"
  if pgrep -x CAST >/dev/null 2>&1; then
    info "A CAST app is already running (its building is in the menu bar): macOS may bring that one forward instead"
    info "of starting this build. Quit it from its menu first if you want to try this build."
  fi
  open "$APP"
  info "Look for the CAST icon (a small building) in the menu bar."
  info "The app is at $APP"
  exit 0
fi

# ---- Disk image -----------------------------------------------------------------------------------------------------
say "Making the disk image"
STAGE=$WORK/dmg
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/CAST.app"
ln -s /Applications "$STAGE/Applications"
DMG=$KIT/CAST-$VERSION-arm64.dmg
rm -f "$DMG"
made=0
for attempt in 1 2 3; do # hdiutil sometimes reports "Resource busy" while Spotlight looks at the new files
  if hdiutil create -volname "CAST $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >"$WORK/hdiutil.txt" 2>&1; then
    made=1
    break
  fi
  info "hdiutil failed (attempt $attempt of 3); trying again"
  sleep 2
done
if [ "$made" != 1 ]; then
  cat "$WORK/hdiutil.txt" >&2
  die "hdiutil could not create the disk image."
fi
hdiutil verify "$DMG" >/dev/null 2>&1 || die "The new disk image does not verify."

size=$(du -h "$DMG" | awk '{ print $1 }')
say "Done: $DMG ($size)"
info "To install: open the dmg and drag CAST onto Applications."
if [ -n "$SIGN_IDENTITY" ]; then
  info "Signed with Developer ID. Notarize and staple the dmg before publishing it."
else
  info "On this Mac it opens like any app. On a Mac that downloaded the dmg, macOS asks once (it is signed ad hoc,"
  info "not by Apple): on macOS 13 and 14, right-click CAST in Applications and choose Open; on macOS 15 and newer,"
  info "open it once, then click Open Anyway in System Settings > Privacy & Security."
fi
