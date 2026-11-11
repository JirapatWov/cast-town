#!/bin/bash
# Puts a new CAST.app in place of the one in use once that one has quit, then opens it. The menu-bar app
# (CASTMenu/Updater.swift) copies this file out of the app, starts it and quits: an app can't replace itself while it
# runs. The new app already sits next to the old one (same folder, so the swap is two renames). The old app is kept
# until the new one has opened; when a step fails it goes back where it was and is opened again. Either way one line
# goes to the result file ("installed <version>" or "failed <why>"), written before the app that reads it on its start
# is opened; the steps go to update.log beside it.
#
#   cast-install-update.sh <pid of the app> <CAST.app in use> <new CAST.app> <version> <result file>
#
# CAST_UPDATE_WAIT_SECONDS: how long to wait for the app to quit (default 60: it first stops its server, up to 13 s).
set -u

[ $# -eq 5 ] || { echo "usage: cast-install-update.sh <pid> <current app> <new app> <version> <result file>" >&2; exit 2; }
pid=$1
current=${2%/}
new=${3%/}
version=$4
result=$5
wait_seconds=${CAST_UPDATE_WAIT_SECONDS:-60}
logs=$(dirname "$result")
mkdir -p "$logs" 2>/dev/null || true

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$logs/update.log" 2>/dev/null || true
}
# The result line, whole or not at all (the app may read it the moment it starts).
report() {
  log "$1"
  printf '%s\n' "$1" >"$result.$$" 2>/dev/null && mv -f "$result.$$" "$result" 2>/dev/null || log "could not write $result"
}
reopen() {
  open "$current" >/dev/null 2>>"$logs/update.log" || log "could not open $current"
}

# Only an app next to the one in use, both named *.app: nothing else on the disk is ever moved or removed.
problem=
case "$current" in *.app) ;; *) problem="the app in use is not an .app ($current)" ;; esac
case "$new" in *.app) ;; *) [ -n "$problem" ] || problem="the new app is not an .app ($new)" ;; esac
if [ -z "$problem" ] && [ "$(dirname "$current")" != "$(dirname "$new")" ]; then problem="the new app is not next to the one in use"; fi
if [ -z "$problem" ] && [ ! -d "$new/Contents" ]; then problem="the new CAST.app is missing or empty"; fi
log "installing CAST $version: $new → $current"

ticks=$((wait_seconds * 5))
while kill -0 "$pid" 2>/dev/null; do
  ticks=$((ticks - 1))
  if [ "$ticks" -le 0 ]; then # it still runs: leave it as it is
    [ -n "$problem" ] || rm -rf "$new"
    report "failed CAST did not quit within $wait_seconds seconds"
    exit 1
  fi
  sleep 0.2
done

if [ -n "$problem" ]; then
  report "failed $problem"
  reopen
  exit 1
fi

old="${current%.app}.previous-$$.app"
if ! mv "$current" "$old" 2>>"$logs/update.log"; then
  rm -rf "$new"
  report "failed the old CAST.app could not be moved aside (no permission to change $(dirname "$current")?)"
  reopen
  exit 1
fi
if ! mv "$new" "$current" 2>>"$logs/update.log"; then
  rm -rf "$new"
  if mv "$old" "$current" 2>>"$logs/update.log"; then
    report "failed the new CAST.app could not be put in place"
    reopen
  else
    report "failed the new CAST.app could not be put in place, and the previous one is at $old: move it back to $current"
  fi
  exit 1
fi

report "installed $version"
if open "$current" >/dev/null 2>>"$logs/update.log"; then
  rm -rf "$old" || log "could not remove $old"
  exit 0
fi

# The new app doesn't open: the previous one goes back.
broken="${current%.app}.failed-$$.app"
if mv "$current" "$broken" 2>>"$logs/update.log" && mv "$old" "$current" 2>>"$logs/update.log"; then
  rm -rf "$broken"
  report "failed the new CAST did not open, so the previous one is back"
  reopen
else
  report "failed the new CAST did not open, and the previous one could not be put back: it is at $old"
fi
exit 1
