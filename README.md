# virtual-monitors

A GNOME Shell extension that subdivides one physical display into virtual
monitor regions. Fullscreen apps confine to their region (Hyprland
`fakefullscreen` style). Layouts are fractions of monitor geometry: any
resolution, per-display. Requires GNOME Shell 50.

Install from [extensions.gnome.org](https://extensions.gnome.org/) (search
for "Virtual Monitors"); GNOME's Extensions app delivers updates. To run the
version from this repository instead, see [Development](#development).

## Usage

### Features

- Six layouts: single, dual (50/50), theater (25/50/25), thirds, main+side
  (70/30), dynamic; column widths are fractions of monitor geometry, so any
  resolution works and displays are independent
- Dynamic layout: start from one full region and build custom splits with
  hotkeys — select any region (highlight), split it in half, or close it
  (sibling takes over); horizontal splits only, runtime-only
- Per-desktop regions: each desktop keeps its own layout (and nudged splits)
  for the session, so switching desktops switches the region set; configured
  desktops are kept alive, so GNOME's dynamic-workspace cleanup cannot drop
  them while empty
- Layout switch assigns regions only; it never moves existing windows
- Adjustable splits: grow/shrink the focused window's region by 5% steps
  (runtime only, resets at restart)
- Swap regions: exchange focused window with the window in the neighbor
  region
- Maximize button toggles: fill region ↔ restore floating rect
- New windows auto-fit the region under their center; dialogs stay floating
- Drag-drop assigns region (floating stays put; filled re-fills)
- Move hotkeys: filled windows stay filled, floating windows center in
  region
- Fullscreen intercept: in split mode, fullscreen requests confine to the
  region and cover the panel (kept above the panel)
- Subtle region indication: divider lines flash 2.5s on switch/move/drop
- Settings UI (prefs): default layout, region panels toggle, panel minimum
  width, keybinding editor, layout reference, debug toggle
- Failsafe suspend/resume hotkey + external panic key

### Hotkeys

All bindings are editable in the settings window. Defaults:

| Key | Action |
|---|---|
| `Super+Alt+0` | **Failsafe: suspend/resume extension behavior** |
| `Super+Alt+1/2/3/4/5/6` | single / dual / theater / thirds / mainside / dynamic layout (focused monitor) |
| `Ctrl+Super+Alt+Left/Right` | move focused window between regions |
| `Shift+Ctrl+Super+Alt+Left/Right` | swap focused window with neighbor region's window |
| `Super+Alt+,` / `Super+Alt+.` | grow / shrink focused window's region (5% steps) |
| `Super+Alt+[` / `Super+Alt+]` | select previous / next region (dynamic layout) |
| `Super+Alt+/` | split selected region in half (dynamic layout) |
| `Super+Alt+x` | close/delete selected region (dynamic layout) |

Layout hotkeys act on the workspace you are currently on; each desktop
remembers its own layout for the session (see Known behavior). The dynamic
select/split/close hotkeys no-op in every other layout.

### Settings

The settings window (Extensions app → Virtual Monitors → gear icon, or
`gnome-extensions prefs virtual-monitors@localyost3000`) offers:

- **Default layout** — used until a workspace is switched by hotkey
- **Region panels via fake monitors** — dash-to-panel renders one panel per
  region (experimental; one physical display only)
- **Minimum region width for a panel** — narrower regions get no panel
  (default 25% of monitor width; 0 = every region)
- **Layouts** — read-only reference of each layout's column fractions
- **Keybindings** — one row per action; click a binding and press the new
  keys, Esc cancels
- **Debug logging** — verbose per-window events in the shell log

### Known behavior

Design records for the internals live in `.plans/`.

- Maximize button toggles: floating → fill region; filled → restore the
  saved floating rect. Resize-based: there is no true maximized state in
  split mode, and the header button always shows the "maximize" icon. To
  float a window without the button: edge-resize, or `Super+Alt+1`.
- Layouts are per workspace: switching desktops presents that desktop's
  region set (panels included, with region panels on) and refits only
  filled / fake-fullscreen windows on arrival; floating windows stay as
  placed. Desktops never switched use the default layout. Runtime-only: a
  shell restart resets every desktop. Configured desktops are kept alive so
  GNOME's dynamic-workspace cleanup cannot remove them while empty;
  desktops you never configured follow GNOME's normal cleanup
  (`.plans/2026-10-16_00_per_desktop_regions.md`).
- Region panels: switching between desktops that share the same layout does
  not reflow dash-to-panel; different layouts reflow the panels (inherent to
  per-region panels). Regions narrower than the panel minimum width get no
  panel; if no region qualifies (e.g. thirds with a 35% minimum), the fake
  monitors are released and the stock full-width panel returns — logged
  once.
- The workspace-switch slide animates every region (each region gets its
  own wallpaper slice; `animation-patch=yes` in the enable log, a logged
  no-op if the private API drifts). A switch that changes the layout still
  shows the wallpaper's solid primary colour for 1-2 frames; same-layout
  switches are clean
  (`.plans/2026-10-16_03_workspace_switch_animation.md`).
- Desktop icons (`ding@rastersoft.com`): it recreates its per-region
  windows on every layout change, and one recreated while a desktop switch
  is in flight can miss Desktop Icons' own setup — it then floats above
  your windows as a taskbar entry until the next switch. The extension
  re-runs that setup for the misses, so they adopt within half a second
  (`.plans/2026-10-17_00_ding_desktop_window_adoption.md`).
- Split hotkey assigns regions only; it never moves/fills existing windows.
- Grow/shrink nudges are runtime-only: splits reset to the layout template
  at shell restart. Windows keep their geometry on nudge; they re-fill on
  the next maximize toggle or move.
- Dynamic layout (`Super+Alt+6`): starts as one full region. `select`
  highlights a region — the first press starts from the focused window's
  region (or the first region without one), then moves and clamps; `split`
  halves the highlighted region (the source keeps its identity and its
  windows as the left half; the new right half starts empty); `close`
  removes it and the sibling takes over the space (the closed region's
  filled windows re-map by frame center into the survivor). Every region
  keeps >= 10% width, so a region can only be split while >= 20%. The
  highlight is cleared by focus changes, desktop switches, layout hotkeys
  and suspend — the highlight→act pattern never grabs the keyboard.
  Runtime-only: a restart resets the desktop to one region
  (`.plans/2026-10-16_01_dynamic_splits.md`).
- New windows in split mode open filling the region under their center;
  transient dialogs (file pickers etc.) stay floating.
- Drag-drop: assigns region only. Floating windows stay where dropped;
  filled windows re-fill in the new region (no auto-fill).
- `Ctrl+Super+Alt+Left/Right`: filled windows move and stay filled; floating
  windows keep their size, centered in the target region; fake-fullscreen
  games move and keep covering the panel.
- Fullscreen IS confined (games, F11 videos). Fake-fullscreen windows are
  re-parented to where the shell paints real-fullscreen windows (above all
  shell chrome), so the top bar and dash-to-panel stay covered exactly where
  the game covers them, and keep working in uncovered regions. X11/Proton
  clients that self-configure after the intercept get re-asserted to the
  full region rect on a bounded schedule. If a game still lands offset
  (stubborn self-centering), tap `Ctrl+Super+Alt+Right` then `Left` to force
  a fresh re-assert.
- Windows that fight confinement (instant self-re-maximize loops) are
  rate-limited per path: >4 confines in 2s blocks that path for the window
  until layout toggle or close; logged as `fights max/fs confinement`.

### Failsafe

Two levels, weakest first:

1. **Suspend hotkey `Super+Alt+0`**: unpins all fake-fullscreen windows and
   stops all interception. Press again to resume. Works only while the
   extension itself is still functioning.

2. **Panic key**: `Ctrl+Super+Escape` disables the whole extension. Works
   even if the extension misbehaves, as long as the shell responds. To set
   it up:

   ```sh
   gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings \
       "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vm-panic/']"
   gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vm-panic/ \
       name 'Virtual Monitors panic'
   gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vm-panic/ \
       command 'gnome-extensions disable virtual-monitors@localyost3000'
   gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vm-panic/ \
       binding '<Primary><Super>Escape'
   ```

   Warning: the first command overwrites your custom-keybindings list. If
   you already have custom keybindings, read the current value with
   `gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings`
   and append the vm-panic path to the existing list instead.

   To remove the panic key:

   ```sh
   gsettings reset org.gnome.settings-daemon.plugins.media-keys custom-keybindings
   ```

3. **Shell fully hung:** switch to a TTY (`Ctrl+Alt+F3`), log in, then:

   ```sh
   export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
   gnome-extensions disable virtual-monitors@localyost3000
   ```

   Switch back (`Ctrl+Alt+F2` typically). Log out/in if the shell did not
   recover.

## Development

For working on the extension itself; normal installs don't need any of this.

### Local install

```sh
./scripts/install.sh
```

`install.sh` symlinks this repo's `extension/` directory into
`~/.local/share/gnome-shell/extensions/virtual-monitors@localyost3000/` and
compiles the GSettings schema. Symlinks mean edits in this repo take effect
directly. It `rm -rf`s that path first, so move a released copy aside before
running it (see below).

**Discovery caveat (Wayland):** GNOME Shell scans extension dirs only at
startup. A manually copied/symlinked extension is invisible to the running
shell: `gnome-extensions enable virtual-monitors@localyost3000` fails with
"does not exist" until the shell restarts. Workaround: enable via gsettings
directly; any freshly started shell (devkit, or next login) loads it
automatically:

```sh
python3 -c "
import subprocess
cur = eval(subprocess.check_output(['gsettings','get','org.gnome.shell','enabled-extensions'], text=True).strip())
if 'virtual-monitors@localyost3000' not in cur:
    cur.append('virtual-monitors@localyost3000')
subprocess.run(['gsettings','set','org.gnome.shell','enabled-extensions',str(cur)], check=True)
"
```

(Default layout is `single` = inert until hotkey, so enabling is safe.)

**Real session:** log out and back in. The extension loads automatically
(enabled via gsettings above, inert until hotkeys). Read
[Failsafe](#failsafe) first.

### Dev copy vs. the extensions.gnome.org copy

Both installs use the same UUID and directory, so only one can be present at
a time. `install.sh` replaces whatever is there with a symlink into this
repo; a site install replaces the symlink with the released copy (a regular
directory). Check which one is active:

```sh
readlink ~/.local/share/gnome-shell/extensions/virtual-monitors@localyost3000
```

- prints a path into this repo → development copy
- prints nothing (exit 1: it is a real directory) → extensions.gnome.org
  copy

**Never run a site install/update while the dev symlink is in place.** The
installer removes the existing directory recursively — with a symlink there
it followed the link and deleted this repo's `extension/` files in testing —
then extracts the released copy in its place. Switch copies cleanly instead,
parking the released copy outside the scanned extension dir:

```sh
EXT=~/.local/share/gnome-shell/extensions/virtual-monitors@localyost3000
BAK=~/.local/share/gnome-shell/virtual-monitors-released

mv "$EXT" "$BAK"       # park the released copy
./scripts/install.sh   # install the dev symlink

rm "$EXT"              # to go back: remove the dev symlink,
mv "$BAK" "$EXT"       # restore the parked copy
```

(Or, instead of restoring the parked copy: remove the symlink and install
from the site again. If `$BAK` already exists from an earlier switch,
restore or remove it first — otherwise `mv` nests inside it.) Log out and
back in after any switch.

### Nested shell (devkit)

```sh
./scripts/dev.sh
```

Launches a nested GNOME Shell (mutter `--devkit`, needs the `mutter-dev-bin`
package) with the extension loaded, keyfile-based settings mirroring your
enabled extensions, stale devkits killed, and the keybinding schema
recompiled every launch. AppArmor may block the binary; run
`sudo aa-complain /usr/bin/mutter-devkit` once before the first launch.

Workspace switching inside the devkit is `Super+Alt+Page_Up/Page_Down`
(nested-only binding): the host session grabs the default `Ctrl+Alt+arrows`
before the nested shell ever sees them.

### Headless end-to-end

```sh
./scripts/headless-repro.sh          # all: devkit replica (host extensions)
./scripts/headless-repro.sh min      # only virtual-monitors, hermetic
```

Boots a scratch headless shell 50 (virtual monitor, keyfile settings under
a temp dir — your session is never touched), sets per-desktop layouts,
switches desktops like the keybinding does, asserts the per-desktop
invariants, drives the dynamic layout (select/split/close) end to end, and
exercises the region-aware switch animation and the desktop-icons adoption
heal (`.plans/2026-10-16_02_headless_repro_harness.md`,
`.plans/2026-10-17_00_ding_desktop_window_adoption.md`). Prints `REPRO ...`
dumps and a final `REPRO RESULT: PASS`/FAIL; the exit code follows it. Modes
`all|min|ding|dtp` pick which extensions load; `all` (default) is the full
devkit replica and includes the desktop-icons case that used to prune
configured desktops. Needs the extension installed at the standard path
(see Local install).

### Tests

```sh
node test/layout.test.js    # or: gjs -m test/layout.test.js
npm test                    # both engines, via test/run.js
npm run lint                # syntax check + eslint
npm run schema:compile      # strict schema compile (same as CI)
```

CI additionally packs the zip and runs shexli — the static analyzer the
extensions.gnome.org upload review uses — against it, failing on any finding.
Reproduce locally before uploading (the tree-sitter pin matters; 0.26.0
segfaults shexli):

```sh
pip install "shexli==0.2.1" "tree-sitter!=0.26.0"
shexli dist/*.zip --format text
```

### Repo layout

```
extension/    the shipped payload; this dir is what gets installed
              (extension.js, geometry.js, layout.js, monitors.js, prefs.js,
              ratelimit.js, workspace-animation.js, metadata.json, schemas/)
scripts/      install.sh, uninstall.sh, dev.sh, headless-repro.sh
test/         layout unit tests (node + gjs)
.plans/       design notes and development history
```

### Update and uninstall

```sh
git pull
glib-compile-schemas extension/schemas    # only if schemas/ changed
```

Files are symlinked, so updates are live at the next shell restart (Wayland
shells cannot restart in place — log out/in). Copies installed from
extensions.gnome.org update through the Extensions app instead. To remove
the dev copy:

```sh
./scripts/uninstall.sh
```

or manually:

```sh
gnome-extensions disable virtual-monitors@localyost3000
rm -rf ~/.local/share/gnome-shell/extensions/virtual-monitors@localyost3000
```

### Build and release

```sh
cp LICENSE extension/
cd extension
gnome-extensions pack --force --out-dir=../dist \
    --extra-source=geometry.js --extra-source=layout.js \
    --extra-source=monitors.js --extra-source=prefs.js \
    --extra-source=ratelimit.js --extra-source=workspace-animation.js \
    --extra-source=LICENSE
```

`pack` bundles only `extension.js`, `prefs.js`, `metadata.json` and
`schemas/` by default — every other module must be listed as an
`--extra-source` (a zip missing them installs but cannot load). CI
(`.github/workflows/ci.yml`) runs syntax checks, layout tests (node + gjs),
a strict schema compile, packs the zip, and verifies every module is inside
it, on every push. Publishing a GitHub release attaches the packed zip
automatically. The zip is extensions.gnome.org-ready: schema XML included,
no `gschemas.compiled`, minimal logging (most per-window logs are behind the
`debug` setting).

### Roadmap

See `.plans/`: vertical splits for the dynamic layout, fraction editor UI,
persisted per-monitor splits, true-state region maximize (mutter ≥51),
Hyprland evaluation.

## License

MIT (see `LICENSE`).
