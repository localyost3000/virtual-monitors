#!/bin/sh
# Symlink extension dir into GNOME Shell extensions dir + compile schemas.
# Whole-dir symlink: new files (prefs.js, ...) take effect immediately.
set -e
UUID=virtual-monitors@localyost3000
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC="$(cd "$(dirname "$0")/.." && pwd)/extension"

# DEST holds only symlinks from earlier installs (targets live in the repo),
# so rm -rf is safe here.
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
glib-compile-schemas "$DEST/schemas"

echo "Installed $DEST -> $SRC"
echo "Shell discovers extensions only at startup; a running shell needs the"
echo "gsettings workaround (see README) or a log out/in."
