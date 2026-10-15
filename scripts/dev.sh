#!/bin/sh
# Launch nested dev shell.
#
# - clean schema env (snap-packaged terminals can export a stale
#   GSETTINGS_SCHEMA_DIR + polluted XDG_DATA_DIRS)
# - scoped settings via keyfile backend (real dconf untouched):
#   xwayland-allow-grabs=false so X11 apps (VS Code/Chrome) cannot swallow
#   compositor keybindings; enabled-extensions + favorite-apps copied from
#   dconf so the nested session looks like the real one
# - nested-only switch-workspace keys (Super+Alt+Page_Up/Page_Down): the
#   host session grabs the default Ctrl+Alt+arrows before the nested shell
#   ever sees them
# - full XDG_DATA_DIRS incl. flatpak + snap exports so all apps appear

CONF="$(mktemp -d)"
mkdir -p "$CONF/glib-2.0/settings"

env -u GSETTINGS_SCHEMA_DIR python3 - "$CONF/glib-2.0/settings/keyfile" <<'PY'
import subprocess, sys

def get(key):
    out = subprocess.check_output(
        ['gsettings', 'get', 'org.gnome.shell', key], text=True).strip()
    if out.startswith('@as '):
        out = out[4:]
    return eval(out)

exts = get('enabled-extensions')
if 'virtual-monitors@localyost3000' not in exts:
    exts.append('virtual-monitors@localyost3000')
favs = get('favorite-apps')

with open(sys.argv[1], 'w') as f:
    f.write('[org/gnome/shell]\n')
    f.write(f'enabled-extensions={exts}\n')
    f.write(f'favorite-apps={favs}\n\n')
    f.write('[org/gnome/mutter]\n')
    # workspaces span monitors (multi-monitor desktop session, pref false);
    # the schema default (true) animates the primary monitor only
    f.write('workspaces-only-on-primary=false\n\n')
    f.write('[org/gnome/mutter/wayland]\n')
    f.write('xwayland-allow-grabs=false\n\n')
    # host grabs the default switch-workspace combos (Ctrl+Alt+arrows)
    # before the nested shell can; bind nested-only pass-through keys
    # so the devkit can switch desktops (per-desktop-regions validation)
    f.write('[org/gnome/desktop/wm/keybindings]\n')
    f.write("switch-to-workspace-left=['<Super><Alt>Page_Up']\n")
    f.write("switch-to-workspace-right=['<Super><Alt>Page_Down']\n")
    f.write('\n[org/gnome/shell/extensions/virtual-monitors]\n')
    f.write('debug=true\n')
    f.write('fake-monitors=true\n')
    f.write('\n[org/gnome/shell/extensions/dash-to-panel]\n')
    f.write('multi-monitors=true\n')
PY

# never run stale code: kill previous devkit + recompile keybinding schema
pkill -f 'gnome-shell --devkit' 2>/dev/null && sleep 1
glib-compile-schemas "$HOME/.local/share/gnome-shell/extensions/virtual-monitors@localyost3000/schemas"

exec env -u GSETTINGS_SCHEMA_DIR \
    GSETTINGS_BACKEND=keyfile \
    XDG_CONFIG_HOME="$CONF" \
    XDG_DATA_DIRS="$HOME/.local/share:$HOME/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share:/var/lib/snapd/desktop" \
    dbus-run-session -- gnome-shell --devkit
