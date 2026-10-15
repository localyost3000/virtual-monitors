#!/bin/sh
# Headless integration run for per-desktop regions (F1).
#
# Boots a scratch gnome-shell 50 (headless, virtual monitor, keyfile
# settings — the real session's dconf is never touched) and drives
# scripts/headless-repro.js via the automation-script harness: sets
# per-desktop layouts, switches desktops the way the keybinding does, then
# asserts the per-desktop invariants. "REPRO ..." progress lines and state
# dumps are printed; the final REPRO RESULT becomes this script's exit
# status.
#
# Usage: ./scripts/headless-repro.sh [all|min|ding|dtp]
#   all (default) host enabled-extensions list + dash-to-panel: full
#        devkit replica; catches the desktop-icons pruning regression
#   min  only virtual-monitors: hermetic baseline
#   ding only virtual-monitors + desktop icons
#   dtp  only virtual-monitors + dash-to-panel
#
# Requires gnome-shell >= 50, dbus-run-session, python3, and the extension
# installed the usual way (scripts/install.sh symlink). Scratch dirs are
# removed on exit; keep them for debugging with VM_REPRO_KEEP=1.
# Full output is also saved to ${TMPDIR:-/tmp}/vm-headless-repro.log.

set -u

MODE="${1:-all}"
HERE=$(cd "$(dirname "$0")" && pwd)
EXT="$HOME/.local/share/gnome-shell/extensions/virtual-monitors@localyost3000"
LOG="${TMPDIR:-/tmp}/vm-headless-repro.log"

case "$MODE" in
all | min | ding | dtp) ;;
*)
    echo "error: unknown mode '$MODE' (use all|min|ding|dtp)" >&2
    exit 1
    ;;
esac

if [ ! -e "$EXT/metadata.json" ]; then
    echo "error: extension not installed at $EXT" >&2
    echo "       run scripts/install.sh (symlink to this repo) first" >&2
    exit 1
fi
if [ "$(readlink -f "$EXT")" != "$(readlink -f "$HERE/../extension")" ]; then
    echo "warning: $EXT does not resolve to this repo's extension/ — testing the installed copy" >&2
fi

CONF=$(mktemp -d)
DATA=$(mktemp -d)
CACHE=$(mktemp -d)
cleanup() {
    [ "${VM_REPRO_KEEP:-0}" = 1 ] || rm -rf "$CONF" "$DATA" "$CACHE"
}
trap cleanup EXIT
mkdir -p "$CONF/glib-2.0/settings"

MODE="$MODE" env -u GSETTINGS_SCHEMA_DIR python3 - "$CONF/glib-2.0/settings/keyfile" <<'PY'
import os, subprocess, sys

mode = os.environ['MODE']

def get(key):
    out = subprocess.check_output(
        ['gsettings', 'get', 'org.gnome.shell', key], text=True).strip()
    if out.startswith('@as '):
        out = out[4:]
    return eval(out)

exts = {
    'min': ['virtual-monitors@localyost3000'],
    'ding': ['virtual-monitors@localyost3000', 'ding@rastersoft.com'],
    'dtp': ['virtual-monitors@localyost3000', 'dash-to-panel@jderose9.github.com'],
}.get(mode)
if exts is None:  # all: replica of the devkit session
    exts = get('enabled-extensions')
    if 'virtual-monitors@localyost3000' not in exts:
        exts.append('virtual-monitors@localyost3000')
favs = get('favorite-apps')

with open(sys.argv[1], 'w') as f:
    f.write('[org/gnome/shell]\n')
    f.write(f'enabled-extensions={exts}\n')
    f.write(f'favorite-apps={favs}\n\n')
    f.write('[org/gnome/mutter]\n')
    f.write('workspaces-only-on-primary=false\n\n')
    f.write('[org/gnome/mutter/wayland]\n')
    f.write('xwayland-allow-grabs=false\n\n')
    f.write('[org/gnome/shell/extensions/virtual-monitors]\n')
    f.write('debug=true\n')
    f.write('fake-monitors=true\n\n')
    f.write('[org/gnome/shell/extensions/dash-to-panel]\n')
    f.write('multi-monitors=true\n')
PY

glib-compile-schemas "$EXT/schemas" || exit 1

gnome-shell --version | grep -q 'GNOME Shell 5' ||
    echo "warning: developed against GNOME Shell 50; found $(gnome-shell --version)" >&2

echo "headless repro ($MODE) — log: $LOG"
env -u GSETTINGS_SCHEMA_DIR \
    GSETTINGS_BACKEND=keyfile \
    XDG_CONFIG_HOME="$CONF" \
    XDG_DATA_HOME="$DATA" \
    XDG_CACHE_HOME="$CACHE" \
    XDG_DATA_DIRS="$HOME/.local/share:/usr/local/share:/usr/share" \
    GNOME_SHELL_BUILDDIR=/usr/libexec \
    timeout 120 dbus-run-session -- gnome-shell --headless --no-x11 \
    --virtual-monitor 1280x720 --wayland-display "vm-repro-$$" \
    --automation-script "$HERE/headless-repro.js" 2>&1 | tee "$LOG"

if grep -q 'REPRO RESULT: PASS' "$LOG"; then
    echo "headless repro: PASS"
    exit 0
fi
echo "headless repro: FAIL or no result — see $LOG" >&2
exit 1
