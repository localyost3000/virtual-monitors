#!/bin/sh
set -e
UUID=virtual-monitors@localyost3000
gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "Uninstalled $UUID"
echo "If you added the panic keybinding, remove it: see README (Failsafe section)"
