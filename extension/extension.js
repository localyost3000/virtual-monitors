import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import St from 'gi://St'
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

import { floatRect, insetByStruts } from './geometry.js'
import {
  canSplit,
  closeLeaf,
  filterRectsForFakes,
  leafCount,
  leaves,
  nudgeLeaf,
  posOf,
  regionIndexAt,
  regionRectsTree,
  splitLeaf,
  treeFromLayout,
} from './layout.js'
import { FakeMonitors } from './monitors.js'
import { rateLimit } from './ratelimit.js'
import {
  install as installAnimationPatch,
  uninstall as uninstallAnimationPatch,
} from './workspace-animation.js'

const BUILD = '2026-10-17T16:07' // bump every edit round; logged at enable
const DEBUG = false // hard flip for dev; soft toggle: 'debug' settings key
// Configured desktops are marked in-use in the shell's dynamic-workspace
// check for this long (re-armed on layout edits and desktop switches).
const KEEP_ALIVE_MS = 24 * 60 * 60 * 1000
const BINDING_NAMES = [
  'toggle-active',
  'layout-single',
  'layout-dual',
  'layout-theater',
  'layout-thirds',
  'layout-mainside',
  'layout-dynamic',
  'window-left',
  'window-right',
  'swap-left',
  'swap-right',
  'grow-region',
  'shrink-region',
  'select-prev',
  'select-next',
  'split-region',
  'close-region',
]

export default class VirtualMonitorsExtension extends Extension {
  enable() {
    this._settings = this.getSettings()
    this._active = true
    this._layouts = new Map() // monitor index -> Map(workspace -> {name, tree})
    this._regions = new Map() // Meta.Window -> region leaf id
    this._fakeFs = new Set() // windows we un-fullscreened + pinned
    this._winSignals = new Map() // Meta.Window -> [signal ids]
    this._unmaking = null // re-entry guard for unmake_fullscreen
    this._unmaxing = null // re-entry guard for unmaximize echo
    this._retiling = false // re-entry guard for maximize confinement
    this._overlays = new Map() // monitor index -> St.Widget divider lines
    this._confineLog = new Map() // Meta.Window -> {scope: [timestamps]}
    this._confineBlock = { max: new Set(), fs: new Set() }
    this._lastConfine = new Map() // Meta.Window -> ts, notify debounce
    this._regionMaxed = new Set() // windows currently region-filled
    this._floatRects = new Map() // Meta.Window -> saved floating rect
    this._lastFsWatch = new Map() // Meta.Window -> ts, fs-watch debounce
    this._fsBudget = new Map() // Meta.Window -> re-asserts used
    this._fsWatched = new Set() // windows with fs geometry watcher
    this._sel = null // {monitor, ws, leafId} | null (dynamic-layout selection)
    this._selOverlay = null // St.Widget highlight for the selection
    this._fakeZeroLogged = false // "no region meets min width" logged once
    this._sources = new Set() // pending GLib source ids; all removed in disable()

    this._fakeMonitors = new FakeMonitors(
      () => this._fakeRects(),
      {
        layoutManager: Main.layoutManager,
        getMonitorManager: () => global.backend?.get_monitor_manager(),
      },
      (...a) => this._dbg(...a),
    )
    this._fakeMonitorsId = this._settings.connect('changed::fake-monitors', () =>
      this._syncFakeMonitors(),
    )
    // enable can run before monitors exist (devkit); sync when they land
    this._fakeSyncId = Main.layoutManager.connect('monitors-changed', () => {
      if (this._settings?.get_boolean('fake-monitors') && !this._fakeMonitors.active) {
        this._syncFakeMonitors()
      }
    })
    this._syncFakeMonitors()

    this._wsActiveId = global.workspace_manager.connect('active-workspace-changed', () =>
      this._onWorkspaceChanged(),
    )
    this._wsRemovedId = global.workspace_manager.connect('workspace-removed', () =>
      this._onWorkspaceRemoved(),
    )

    // selection is per focused context; any focus change invalidates it
    this._focusId = global.display.connect('notify::focus-window', () => this._clearSelection())

    this._createdId = global.display.connect('window-created', (_d, w) => this._onCreated(w))
    this._grabEndId = global.display.connect('grab-op-end', (_d, w, op) => {
      if (!this._active || !this._winSignals.has(w)) {
        return
      }
      if (op !== Meta.GrabOp.MOVING) {
        // manual edge-resize = user wants floating: drop fill mark
        this._regionMaxed.delete(w)
        return
      }
      // snap windows into region on drag end
      if (leafCount(this._treeFor(w.get_monitor(), this._wsOf(w))) === 1) {
        return
      }
      this._idle(() => {
        if (!this._winSignals?.has(w)) {
          return GLib.SOURCE_REMOVE
        }
        this._assignByCenter(w)
        // filled windows re-fill in new region; floating stay put
        if (this._regionMaxed.has(w)) {
          this._applyRegion(w)
        }
        this._updateOverlay(w.get_monitor())
        return GLib.SOURCE_REMOVE
      })
    })

    const handlers = {
      'toggle-active': () => this._toggleActive(),
      'layout-single': () => this._setLayout(this._focusedMonitor(), 'single'),
      'layout-dual': () => this._setLayout(this._focusedMonitor(), 'dual'),
      'layout-theater': () => this._setLayout(this._focusedMonitor(), 'theater'),
      'layout-thirds': () => this._setLayout(this._focusedMonitor(), 'thirds'),
      'layout-mainside': () => this._setLayout(this._focusedMonitor(), 'mainside'),
      'layout-dynamic': () => this._setLayout(this._focusedMonitor(), 'dynamic'),
      'window-left': () => this._moveWindow(-1),
      'window-right': () => this._moveWindow(1),
      'swap-left': () => this._swapWindow(-1),
      'swap-right': () => this._swapWindow(1),
      'grow-region': () => this._nudge(1),
      'shrink-region': () => this._nudge(-1),
      'select-prev': () => this._selectMove(-1),
      'select-next': () => this._selectMove(1),
      'split-region': () => this._splitRegion(),
      'close-region': () => this._closeRegion(),
    }
    for (const name of BINDING_NAMES) {
      Main.wm.addKeybinding(
        name,
        this._settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        handlers[name],
      )
    }

    for (const actor of global.get_window_actors()) {
      this._onCreated(actor.meta_window)
    }

    // mutter >=51 introspects ExternalConstraintInfo.set_rect: enables a
    // true-state region-maximize path (fixes maximize icon). 50.1: no.
    this._canConstrain = typeof Meta.ExternalConstraintInfo?.prototype?.set_rect === 'function'
    this._animPatch = installAnimationPatch()
    log(
      `[virtual-monitors] enabled, build ${BUILD}, constraint-write=${this._canConstrain}, animation-patch=${this._animPatch}`,
    )
  }

  disable() {
    for (const id of this._sources) {
      GLib.source_remove(id)
    }
    this._sources.clear()

    for (const name of BINDING_NAMES) {
      Main.wm.removeKeybinding(name)
    }

    global.display.disconnect(this._createdId)
    global.display.disconnect(this._grabEndId)

    for (const [w, ids] of this._winSignals) {
      for (const id of ids) {
        w.disconnect(id)
      }
    }

    for (const w of this._fakeFs) {
      this._actorLower(w)
      w.unmake_above()
    }

    for (const group of this._overlays.values()) {
      group.destroy()
    }
    this._overlays.clear()

    this._settings.disconnect(this._fakeMonitorsId)
    Main.layoutManager.disconnect(this._fakeSyncId)
    global.workspace_manager.disconnect(this._wsActiveId)
    global.workspace_manager.disconnect(this._wsRemovedId)
    global.display.disconnect(this._focusId)
    this._selOverlay?.destroy()
    this._selOverlay = null
    this._sel = null
    this._fakeMonitors.release()
    this._fakeMonitors = null
    uninstallAnimationPatch()
    this._settings = null
    this._layouts = this._regions = this._fakeFs = this._winSignals = null
    this._confineLog = this._confineBlock = this._overlays = null
    this._lastConfine = this._regionMaxed = this._floatRects = null
    this._lastFsWatch = this._fsBudget = this._fsWatched = null
    this._sources = null
  }

  _manageable(w) {
    return w.get_window_type() === Meta.WindowType.NORMAL && !w.is_override_redirect()
  }

  _dbg(msg) {
    if (DEBUG || this._settings?.get_boolean('debug')) {
      log(`[virtual-monitors] ${msg}`)
    }
  }

  // Main-loop sources are tracked so disable() can always remove every
  // pending one (review guideline: no GLib source may outlive the extension).
  _idle(fn) {
    const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => this._onSourceDone(id, fn))
    this._sources.add(id)
    return id
  }

  _timeout(ms, fn) {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => this._onSourceDone(id, fn))
    this._sources.add(id)
    return id
  }

  _onSourceDone(id, fn) {
    const res = fn()
    if (res === GLib.SOURCE_REMOVE) {
      this._sources?.delete(id)
    }
    return res
  }

  _onCreated(w) {
    if (!this._manageable(w) || this._winSignals.has(w)) {
      return
    }
    this._winSignals.set(w, [
      w.connect('notify::fullscreen', () => this._onFullscreen(w)),
      w.connect('notify::maximized-horizontally', () => this._onMaximize(w)),
      w.connect('notify::maximized-vertically', () => this._onMaximize(w)),
      w.connect('workspace-changed', () => this._onWindowWorkspace(w)),
      w.connect('unmanaged', () => this._cleanup(w)),
    ])
    // geometry not final at window-created; assign region on idle.
    // Split layout: new windows auto-fit into the region under their
    // center, so each region stacks windows like its own monitor.
    this._idle(() => {
      if (!this._winSignals.has(w)) {
        return GLib.SOURCE_REMOVE
      }
      this._assignByCenter(w)
      // skip fullscreen-at-map windows: fs path owns them (games
      // self-configure on map; resizing them here starts a war).
      // skip transients: dialogs/pickers keep app-requested geometry.
      if (
        this._active &&
        !w.is_fullscreen() &&
        !w.get_transient_for() &&
        leafCount(this._treeFor(w.get_monitor(), this._wsOf(w))) !== 1
      ) {
        this._dbg(`fit: "${w.get_title()}"`)
        this._applyRegion(w)
      }
      return GLib.SOURCE_REMOVE
    })
  }

  _cleanup(w) {
    for (const id of this._winSignals.get(w) ?? []) {
      w.disconnect(id)
    }
    this._winSignals.delete(w)
    this._regions.delete(w)
    this._confineLog.delete(w)
    this._confineBlock.max.delete(w)
    this._confineBlock.fs.delete(w)
    this._lastConfine.delete(w)
    this._regionMaxed.delete(w)
    this._floatRects.delete(w)
    this._fakeFs.delete(w)
    this._lastFsWatch.delete(w)
    this._fsBudget.delete(w)
    this._fsWatched.delete(w)
  }
  // them -> infinite ping-pong. Rate-limit per path: >4 confines in 2s
  // blocks the window (that path) until layout toggle or close.
  _confineBlocked(w, scope) {
    const { blocked, overLimit } = rateLimit(
      this._confineLog,
      this._confineBlock[scope],
      w,
      scope,
      Date.now(),
    )
    if (overLimit) {
      log(`[virtual-monitors] window fights ${scope} confinement, giving up: "${w.get_title()}"`)
    }
    return blocked
  }

  _ws() {
    return (
      global.workspace_manager.get_active_workspace() ??
      global.workspace_manager.get_workspace_by_index(0)
    )
  }

  // workspace of a window; sticky windows belong to the active workspace
  _wsOf(w) {
    return w.on_all_workspaces ? this._ws() : (w.get_workspace() ?? this._ws())
  }

  // Layouts are per (monitor, workspace): each desktop keeps its own region
  // set for the session (runtime-only; restarts fall back to default-layout).
  _layoutFor(monitor, ws) {
    return this._layouts.get(monitor)?.get(ws)?.name ?? this._settings.get_string('default-layout')
  }

  // per-workspace region tree: the stored (possibly custom) tree, else the
  // template the layout name resolves to
  _treeFor(monitor, ws) {
    return this._layouts.get(monitor)?.get(ws)?.tree ?? treeFromLayout(this._layoutFor(monitor, ws))
  }

  _layoutSet(monitor, ws, state) {
    let byWs = this._layouts.get(monitor)
    if (!byWs) {
      byWs = new Map()
      this._layouts.set(monitor, byWs)
    }
    byWs.set(ws, state)
    // a desktop the user configured must not be pruned by the shell's
    // dynamic-workspace cleanup while it is empty (see _keepAlive)
    this._keepAlive(ws)
  }

  // Keep a configured desktop alive. GNOME's dynamic-workspace check removes
  // empty desktops; transient windows landing on the active desktop
  // (desktop-icons re-creates one window per fake monitor on every layout
  // change) make "the empty desktop you just left" eligible. keepWorkspaceAlive
  // marks the desktop as in-use so the check skips it; it is re-armed on
  // layout edits and whenever the desktop is entered. Runtime state only: if
  // the desktop does get removed anyway, _onWorkspaceRemoved prunes its layout.
  _keepAlive(ws) {
    Main.wm?.keepWorkspaceAlive?.(ws, KEEP_ALIVE_MS)
  }

  _hasLayout(ws) {
    for (const byWs of this._layouts.values()) {
      if (byWs.has(ws)) {
        return true
      }
    }
    return false
  }

  // Region leaf id for a window, validated against the window's current
  // tree: workspace/layout changes can stale an assignment; a leaf that no
  // longer exists falls back to the first leaf.
  _leafId(w) {
    const tree = this._treeFor(w.get_monitor(), this._wsOf(w))
    const id = this._regions.get(w)
    return id !== undefined && posOf(tree, id) >= 0 ? id : leaves(tree)[0].id
  }

  // In-order position of the window's region leaf (index into rect lists).
  _posOf(w) {
    const tree = this._treeFor(w.get_monitor(), this._wsOf(w))
    return Math.max(0, posOf(tree, this._leafId(w)))
  }

  // The id-based region state needs a valid leaf in the window's current
  // tree: give `w` one (by frame center) when its id is missing or stale
  // (workspace/layout changes can orphan it). Used by every op that anchors
  // on the assignment.
  _ensureRegion(w) {
    const tree = this._treeFor(w.get_monitor(), this._wsOf(w))
    const id = this._regions.get(w)
    if (id === undefined || posOf(tree, id) < 0) {
      this._assignByCenter(w)
    }
  }

  // Real physical geometry, bypassing fake monitors (our tiling math
  // must not see the fakes we feed dash-to-panel).
  _geom(monitor) {
    return (
      this._fakeMonitors?.realMonitor(monitor) ??
      Main.layoutManager.monitors[monitor] ??
      Main.layoutManager.monitors[Main.layoutManager.primaryIndex]
    )
  }

  // Tile rects: work area (panel excluded); normal windows keep
  // titlebars/controls clear of the panel. `ws` picks the desktop's region
  // set; the active desktop's fakes are the live chrome.
  _tileRectsFor(monitor, ws) {
    if (this._fakeMonitors?.active) {
      // ALL leaves from the tree, never layoutManager.monitors: the fakes
      // are width-filtered, and a skipped region must still get its rect
      // (rect/leaf count parity is what the id-based _regions relies on).
      // Strut insets already localize each panel to its own region rect;
      // a skipped region has no panel and gets no inset.
      return regionRectsTree(this._treeFor(monitor, ws), this._geom(monitor)).map((r) =>
        this._insetByStruts(r),
      )
    }
    return regionRectsTree(
      this._treeFor(monitor, ws),
      this._fakeMonitors?.realWorkArea(monitor) ??
        Main.layoutManager.getWorkAreaForMonitor(monitor),
    )
  }

  // rect minus chrome struts overlapping it (same side rules as shell
  // _updateRegions, but per fake rect). Handles dtp per-region panels,
  // stock top bar, dock, live as actors move/resize.
  _insetByStruts(rect) {
    const struts = []
    for (const data of Main.layoutManager._trackedActors) {
      if (!data.affectsStruts || !data.actor.visible) {
        continue
      }
      const [x, y] = data.actor.get_transformed_position()
      const [width, height] = data.actor.get_transformed_size()
      struts.push({ x, y, width, height })
    }
    return insetByStruts(rect, struts)
  }

  // Fullscreen rects: full geometry; fake-fullscreen windows cover panel.
  _fsRectsFor(monitor, ws) {
    return regionRectsTree(this._treeFor(monitor, ws), this._geom(monitor))
  }

  // Fake-monitor rects for the active desktop's tree, filtered by the
  // configured minimum width fraction (0 = every region gets a panel).
  _fakeRects() {
    const m = this._fakeMonitors.realMonitor(0) // spike: 1 monitor
    if (!m) {
      return null
    } // monitors not up yet; monitors-changed re-syncs
    this._dbg(`sync fakes: real=${m.width}x${m.height}+${m.x}+${m.y}`)
    const rects = regionRectsTree(this._treeFor(0, this._ws()), {
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
    })
    const minFrac = this._settings?.get_double('fake-min-region-fraction') ?? 0
    const kept = filterRectsForFakes(rects, minFrac, m.width)
    this._dbg(`fakes: ${kept.length}/${rects.length} regions >= ${minFrac} width`)
    return kept
  }

  // Fake monitors: present current regions as monitors so dash-to-panel
  // renders one panel per region. Fake rects span FULL monitor height;
  // dtp struts shrink each fake's workarea on their own.
  _syncFakeMonitors() {
    if (!this._settings?.get_boolean('fake-monitors')) {
      this._fakeMonitors?.release()
      return
    }
    if (!this._active) {
      return
    }
    const rects = this._fakeRects()
    if (rects?.length === 0) {
      // no region meets the minimum width: release the fakes so the stock
      // full-width panel returns (deliberate fallback; log once)
      if (this._fakeMonitors.active) {
        this._fakeMonitors.release()
        if (!this._fakeZeroLogged) {
          this._fakeZeroLogged = true
          log('[virtual-monitors] no region meets the panel min width; fakes released')
        }
      }
      return
    }
    if (rects?.length) {
      this._fakeZeroLogged = false
    }
    this._fakeMonitors.apply()
  }

  // Fake-fullscreen stacking: shell inserts all addChrome() panels BELOW
  // global.top_window_group (layout.js), so moving fake-fs actors there
  // covers top bar and dash-to-panel exactly where the game covers them.
  // Per-window: no global chrome state, restore cannot race.
  // ponytail: mutter may re-parent actors on restack; the fs re-assert
  // schedule re-raises. Upgrade path: watch 'notify::parent' if needed.
  _actorRaise(w) {
    const a = w.get_compositor_private()
    if (!a || a.get_parent() === global.top_window_group) {
      return
    }
    a.get_parent()?.remove_child(a)
    global.top_window_group.add_child(a)
    this._dbg(`actor raised: "${w.get_title()}"`)
  }

  _actorLower(w) {
    const a = w.get_compositor_private()
    if (!a || a.get_parent() === global.window_group) {
      return
    }
    a.get_parent()?.remove_child(a)
    global.window_group.add_child(a)
    this._dbg(`actor lowered: "${w.get_title()}"`)
  }

  // Failsafe: suspend/resume all behavior.
  _toggleActive() {
    this._active = !this._active
    this._clearSelection()
    for (const monitor of this._layouts.keys()) {
      this._updateOverlay(monitor)
    }
    if (this._active) {
      this._syncFakeMonitors()
      return
    }
    this._fakeMonitors.release()
    for (const w of this._fakeFs) {
      this._actorLower(w)
      w.unmake_above()
    }
    this._fakeFs.clear()
  }

  _assignByCenter(w) {
    const m = w.get_monitor()
    const ws = this._wsOf(w)
    const tree = this._treeFor(m, ws)
    const rects = this._tileRectsFor(m, ws)
    const frame = w.get_frame_rect()
    const idx = regionIndexAt(rects, frame.x + frame.width / 2, frame.y + frame.height / 2)
    this._regions.set(w, leaves(tree)[Math.max(0, idx)].id)
  }

  _setLayout(monitor, name) {
    if (!this._active) {
      return
    }
    const ws = this._ws()
    log(`[virtual-monitors] layout ${name} on monitor ${monitor} ws ${ws.index()}`)
    const tree = treeFromLayout(name)
    this._layoutSet(monitor, ws, { name, tree })
    this._clearSelection() // selection was tree-scoped; the tree just reset
    this._confineBlock.max.clear()
    this._confineBlock.fs.clear()
    this._confineLog.clear()
    // single-region layouts (single, or dynamic before any split) are
    // exempt from confinement: real fullscreen / maximize are allowed
    const single = leafCount(tree) === 1
    if (single) {
      for (const w of this._fakeFs) {
        if (this._wsOf(w) !== ws) {
          continue
        }
        this._actorLower(w)
        w.unmake_above()
      }
    }
    // update fakes BEFORE reflow: _tileRects reads them
    this._syncFakeMonitors()
    // assign regions, then re-fit windows we own (filled, fake-fs) on the
    // ACTIVE workspace only. Floating windows untouched: a switch never
    // force-fills (bug 1). A single region is a region too: filled windows
    // fill the full workarea, so the region-maxed mark must survive
    // single <-> multi switches.
    for (const w of this._winSignals.keys()) {
      if (w.get_monitor() !== monitor || this._wsOf(w) !== ws) {
        continue
      }
      this._assignByCenter(w)
      if (single) {
        this._fakeFs.delete(w)
      }
      this._refitWindow(w)
    }
    this._updateOverlay(monitor)
  }

  // Workspace switch: fakes must re-present the incoming layout's regions
  // (dash-to-panel reflows), dividers must match, and windows we own are
  // refit (bug-1 rule: floating windows stay put).
  _onWorkspaceChanged() {
    if (!this._active) {
      return
    }
    const ws = this._ws()
    this._dbg(`workspace -> ${ws.index()}`)
    this._clearSelection() // selection was scoped to the old desktop's tree
    if (this._hasLayout(ws)) {
      this._keepAlive(ws) // re-arm: configured desktops must survive
    }
    // fakes BEFORE any rect read: _tileRects reads the tree + fakes
    this._syncFakeMonitors()
    for (const monitor of this._layouts.keys()) {
      this._updateOverlay(monitor)
    }
    for (const w of this._winSignals.keys()) {
      if (this._wsOf(w) !== ws) {
        continue
      }
      this._ensureRegion(w)
      if (this._regionMaxed.has(w)) {
        this._applyRegion(w)
      } else if (this._fakeFs.has(w)) {
        const r = this._fsRectsFor(w.get_monitor(), ws)[this._posOf(w)]
        w.move_resize_frame(true, r.x, r.y, r.width, r.height)
      }
    }
  }

  _onWorkspaceRemoved() {
    // the signal carries the PRE-removal index and fires after the workspace
    // is gone, so the dead object can't be resolved from it; prune state for
    // workspaces that no longer resolve to a live desktop
    const mgr = global.workspace_manager
    const alive = new Set()
    for (let i = 0; i < mgr.get_n_workspaces(); i++) {
      alive.add(mgr.get_workspace_by_index(i))
    }
    for (const byWs of this._layouts.values()) {
      for (const ws of byWs.keys()) {
        if (!alive.has(ws)) {
          byWs.delete(ws)
        }
      }
    }
  }

  // A window can cross workspaces (hotkey, overview drag, workspace
  // removal relocation): re-assign if its region leaf is not in the target
  // layout; if it lands on the active workspace, refit states we own on idle.
  _onWindowWorkspace(w) {
    if (!this._active || !this._winSignals?.has(w)) {
      return
    }
    const ws = this._wsOf(w)
    this._ensureRegion(w)
    if (ws !== this._ws() || (!this._regionMaxed.has(w) && !this._fakeFs.has(w))) {
      return
    }
    this._idle(() => {
      if (!this._winSignals?.has(w)) {
        return GLib.SOURCE_REMOVE
      }
      if (this._regionMaxed.has(w)) {
        this._applyRegion(w)
      } else {
        const r = this._fsRectsFor(w.get_monitor(), this._wsOf(w))[this._posOf(w)]
        w.move_resize_frame(true, r.x, r.y, r.width, r.height)
      }
      return GLib.SOURCE_REMOVE
    })
  }

  // Region indication: one divider line per internal boundary, flashes
  // 2.5s on layout switch / window move / drop.
  _updateOverlay(monitor) {
    this._overlays.get(monitor)?.destroy()
    this._overlays.delete(monitor)
    const rects = this._tileRectsFor(monitor, this._ws())
    if (rects.length < 2 || !this._active) {
      return
    }
    const group = new St.Widget({ reactive: false, track_hover: false })
    for (let i = 1; i < rects.length; i++) {
      const line = new St.Widget({
        style: 'background-color: rgba(120, 170, 255, 0.85);',
      })
      line.set_position(rects[i].x - 1, rects[i].y)
      line.set_size(2, rects[i].height)
      group.add_child(line)
    }
    Main.uiGroup.add_child(group)
    this._overlays.set(monitor, group)
    this._timeout(2500, () => {
      if (this._overlays?.get(monitor) === group) {
        group.destroy()
        this._overlays.delete(monitor)
      }
      return GLib.SOURCE_REMOVE
    })
  }

  // Fit window into its assigned region (resize-based) and mark filled.
  _applyRegion(w) {
    const m = w.get_monitor()
    const r = this._tileRectsFor(m, this._wsOf(w))[this._posOf(w)]
    if (w.is_maximized()) {
      // unmaximize is async (Wayland); its notify echo looks like a
      // user-unmax and would trigger float-restore. Swallow via grace
      // window, same pattern as _unmaking for fullscreen.
      this._unmaxing = w
      w.unmaximize()
      this._timeout(1000, () => {
        if (this._unmaxing === w) {
          this._unmaxing = null
        }
        return GLib.SOURCE_REMOVE
      })
      // mutter may drop a resize issued while still maximized;
      // re-assert once unmaximize has settled
      for (const ms of [100, 400]) {
        this._timeout(ms, () => {
          if (!this._regionMaxed?.has(w) || w.is_maximized()) {
            return GLib.SOURCE_REMOVE
          }
          const rr = this._tileRectsFor(w.get_monitor(), this._wsOf(w))[this._posOf(w)]
          w.move_resize_frame(true, rr.x, rr.y, rr.width, rr.height)
          return GLib.SOURCE_REMOVE
        })
      }
    }
    w.move_resize_frame(true, r.x, r.y, r.width, r.height)
    this._regionMaxed.add(w)
  }

  // Floating restore rect: saved pre-fill geometry, else 70% centered.
  _floatRect(w) {
    const r = this._tileRectsFor(w.get_monitor(), this._wsOf(w))[this._posOf(w)]
    return floatRect(this._floatRects.get(w), r)
  }

  // Maximize button toggles: floating -> fill region; filled -> restore
  // floating. Resize-based: window never holds maximized state in split
  // mode, so no mutter state desync. Icon stays "maximize" (cosmetic).
  _onMaximize(w) {
    if (!this._active || this._retiling) {
      return
    }
    if (this._fakeFs.has(w)) {
      return
    } // fake-fullscreen games: fs path owns geometry
    if (leafCount(this._treeFor(w.get_monitor(), this._wsOf(w))) === 1) {
      return
    }
    if (!w.is_maximized()) {
      return
    } // only half-maximized or unmaximize echo
    // maximized-horizontally + -vertically fire per action; debounce
    const last = this._lastConfine.get(w) ?? 0
    if (Date.now() - last < 150) {
      return
    }
    this._lastConfine.set(w, Date.now())
    if (this._confineBlocked(w, 'max')) {
      return
    }
    this._retiling = true
    w.unmaximize() // mutter restores pre-maximize rect on its own
    this._idle(() => {
      this._retiling = false
      if (!this._winSignals?.has(w)) {
        return GLib.SOURCE_REMOVE
      }
      if (w === this._unmaxing) {
        return GLib.SOURCE_REMOVE
      } // our own unmaximize echo
      if (this._regionMaxed.delete(w)) {
        this._dbg(`region-unmaximize: "${w.get_title()}"`)
        const f = this._floatRect(w)
        w.move_resize_frame(true, f.x, f.y, f.width, f.height)
      } else {
        this._dbg(`confine maximize: "${w.get_title()}"`)
        this._floatRects.set(w, w.get_frame_rect()) // float rect
        this._ensureRegion(w)
        this._applyRegion(w)
      }
      return GLib.SOURCE_REMOVE
    })
  }

  // Re-apply a window's state at its current region: fake-fs covers panel,
  // filled refills, floating keeps size + centers.
  _applyState(w) {
    const m = w.get_monitor()
    const ws = this._wsOf(w)
    const idx = this._posOf(w)
    if (this._fakeFs.has(w)) {
      const r = this._fsRectsFor(m, ws)[idx]
      w.move_resize_frame(true, r.x, r.y, r.width, r.height)
    } else if (this._regionMaxed.has(w)) {
      this._applyRegion(w)
    } else {
      const r = this._tileRectsFor(m, ws)[idx]
      const f = w.get_frame_rect()
      const x = Math.max(r.x, r.x + Math.round((r.width - f.width) / 2))
      const y = Math.max(r.y, r.y + Math.round((r.height - f.height) / 2))
      w.move_resize_frame(true, x, y, f.width, f.height)
    }
  }

  _moveWindow(dir) {
    if (!this._active) {
      return
    }
    const w = global.display.focus_window
    if (!w || !this._winSignals.has(w)) {
      return
    }
    const m = w.get_monitor()
    const ws = this._wsOf(w)
    const tree = this._treeFor(m, ws)
    const ls = leaves(tree)
    this._ensureRegion(w)
    const from = this._posOf(w)
    const to = (from + dir + ls.length) % ls.length
    this._regions.set(w, ls[to].id)
    this._applyState(w)
    this._updateOverlay(m)
  }

  // Swap focused window's region with the most-recently-used window in the
  // neighbor region. Empty neighbor region degrades to a plain move.
  _swapWindow(dir) {
    if (!this._active) {
      return
    }
    const w = global.display.focus_window
    if (!w || !this._winSignals.has(w)) {
      return
    }
    const m = w.get_monitor()
    const ws = this._wsOf(w)
    const tree = this._treeFor(m, ws)
    const ls = leaves(tree)
    if (ls.length < 2) {
      return
    }
    this._ensureRegion(w)
    const from = this._posOf(w)
    const to = (from + dir + ls.length) % ls.length
    const fromId = ls[from].id
    const toId = ls[to].id
    let best = null,
      bestTime = -1
    for (const [win, id] of this._regions) {
      if (win === w || id !== toId || win.get_monitor() !== m || this._wsOf(win) !== ws) {
        continue
      }
      const t = win.get_user_time()
      if (t > bestTime) {
        best = win
        bestTime = t
      }
    }
    if (best) {
      this._regions.set(best, fromId)
      this._applyState(best)
    }
    this._regions.set(w, toId)
    this._applyState(w)
    this._updateOverlay(m)
  }

  // Re-fit one window we own at its region: filled refills; fake-fs covers
  // the panel again. Real-maximized counts as filled: in single-region
  // layouts maximize is a plain maximize (exempt from confinement), so
  // entering a split layout must claim + confine it, else it stays
  // maximized forever with no float rect to restore (stuck bug). Floating
  // windows stay put (bug 1).
  _refitWindow(w) {
    if (this._regionMaxed.has(w) || w.is_maximized()) {
      this._applyRegion(w)
    } else if (this._fakeFs.has(w)) {
      const r = this._fsRectsFor(w.get_monitor(), this._wsOf(w))[this._posOf(w)]
      w.move_resize_frame(true, r.x, r.y, r.width, r.height)
    }
  }

  // Re-fit owned windows of (monitor, ws) after a region edit.
  _refitWindows(monitor, ws) {
    for (const win of this._winSignals.keys()) {
      if (win.get_monitor() !== monitor || this._wsOf(win) !== ws) {
        continue
      }
      this._refitWindow(win)
    }
  }

  // Store an edited tree for (monitor, ws) under `name` and re-present
  // everything that reads it: fakes first (the reflow below reads them),
  // then owned windows, divider flash, selection highlight.
  _applyTreeEdit(monitor, ws, name, tree) {
    this._layoutSet(monitor, ws, { name, tree })
    this._syncFakeMonitors()
    this._refitWindows(monitor, ws)
    this._updateOverlay(monitor)
    this._updateHighlight()
  }

  // Grow/shrink focused window's region by 5% of monitor width. Runtime
  // only (resets at restart). ponytail: persist trees in gsettings when
  // users ask. Filled/fake-fs windows re-fit; floating stay (bug 1).
  _nudge(dir) {
    if (!this._active) {
      return
    }
    const w = global.display.focus_window
    if (!w || !this._winSignals.has(w)) {
      return
    }
    const m = w.get_monitor()
    const ws = this._wsOf(w)
    const tree = this._treeFor(m, ws)
    if (leaves(tree).length < 2) {
      return
    }
    this._ensureRegion(w)
    const next = nudgeLeaf(tree, this._leafId(w), dir * 0.05)
    if (next === tree) {
      return
    } // refused (clamp): nothing changed
    this._applyTreeEdit(m, ws, this._layoutFor(m, ws), next)
  }

  // --- selection + dynamic-layout editing (F2) ---------------------------

  // Focused context for gate + selection ops: the focused window's
  // (monitor, ws); without one, active workspace + primary monitor.
  _ctx() {
    const w = global.display.focus_window
    if (w && this._winSignals.has(w)) {
      return { monitor: w.get_monitor(), ws: this._wsOf(w) }
    }
    return { monitor: Main.layoutManager.primaryIndex, ws: this._ws() }
  }

  // The highlight -> act pattern is Dynamic-layout-only: elsewhere these
  // hotkeys no-op with a debug log and no highlight is ever rendered.
  _dynamicCtx() {
    const ctx = this._ctx()
    const name = this._layoutFor(ctx.monitor, ctx.ws)
    if (name !== 'dynamic') {
      this._dbg(`dynamic-only hotkey ignored (layout is ${name})`)
      return null
    }
    return ctx
  }

  // Selection position within `ctx`'s tree; -1 = no selection there.
  _selPos(ctx, tree) {
    if (!this._sel || this._sel.monitor !== ctx.monitor || this._sel.ws !== ctx.ws) {
      return -1
    }
    return posOf(tree, this._sel.leafId)
  }

  // Region a dynamic op acts on: the highlighted region if set, else the
  // focused window's region; -1 if neither (empty regions are reachable
  // only via the highlight; focus cannot select them).
  _actionPos(ctx, tree) {
    const selPos = this._selPos(ctx, tree)
    if (selPos >= 0) {
      return selPos
    }
    const w = global.display.focus_window
    if (
      w &&
      this._winSignals.has(w) &&
      w.get_monitor() === ctx.monitor &&
      this._wsOf(w) === ctx.ws
    ) {
      return posOf(tree, this._leafId(w))
    }
    return -1
  }

  _setSelection(sel) {
    this._sel = sel
    this._updateHighlight()
  }

  _clearSelection() {
    if (!this._sel && !this._selOverlay) {
      return
    }
    this._sel = null
    this._updateHighlight()
  }

  // Persistent subtle rectangle on the selected region (divider-line
  // styling family). Redrawn whenever the selection or the rects change.
  _updateHighlight() {
    this._selOverlay?.destroy()
    this._selOverlay = null
    if (!this._active || !this._sel) {
      return
    }
    const { monitor, ws, leafId } = this._sel
    if (this._layoutFor(monitor, ws) !== 'dynamic' || ws !== this._ws()) {
      return // gate: dynamic only, and only the visible desktop
    }
    const pos = posOf(this._treeFor(monitor, ws), leafId)
    if (pos < 0) {
      return
    }
    const r = this._tileRectsFor(monitor, ws)[pos]
    const w = new St.Widget({
      reactive: false,
      track_hover: false,
      style:
        'border: 2px solid rgba(120, 170, 255, 0.85); background-color: rgba(120, 170, 255, 0.10);',
    })
    w.set_position(r.x, r.y)
    w.set_size(r.width, r.height)
    Main.uiGroup.add_child(w)
    this._selOverlay = w
  }

  // Move the highlight across regions in order (clamped, no wrap). With no
  // selection one is created at the focused window's region (else the
  // first leaf), then moved: the first press acts from focus.
  _selectMove(dir) {
    if (!this._active) {
      return
    }
    const ctx = this._dynamicCtx()
    if (!ctx) {
      return
    }
    const tree = this._treeFor(ctx.monitor, ctx.ws)
    const ls = leaves(tree)
    let pos = this._selPos(ctx, tree)
    if (pos < 0) {
      const w = global.display.focus_window
      pos = w && this._winSignals.has(w) ? Math.max(0, posOf(tree, this._leafId(w))) : 0
    }
    pos = Math.max(0, Math.min(pos + dir, ls.length - 1))
    this._setSelection({ monitor: ctx.monitor, ws: ctx.ws, leafId: ls[pos].id })
    this._dbg(`select region ${pos}`)
  }

  // Split the highlighted (else focused) region into two half-width
  // regions. The source leaf keeps its identity (windows, selection): it
  // becomes the left half; the right half starts empty.
  _splitRegion() {
    if (!this._active) {
      return
    }
    const ctx = this._dynamicCtx()
    if (!ctx) {
      return
    }
    const tree = this._treeFor(ctx.monitor, ctx.ws)
    const pos = this._actionPos(ctx, tree)
    if (pos < 0) {
      this._dbg('split ignored: no selection and no focused window')
      return
    }
    const id = leaves(tree)[pos].id
    if (!canSplit(tree, id)) {
      this._dbg(`split ignored: region ${pos} too narrow`)
      return
    }
    const r = splitLeaf(tree, id)
    this._applyTreeEdit(ctx.monitor, ctx.ws, 'dynamic', r.tree)
    this._dbg(`split region ${pos} (leaf ${id}) -> new leaf ${r.newId}`)
  }

  // Close the highlighted (else focused) region: its sibling takes over
  // the space. Windows of the closed leaf re-map by frame center into
  // whichever leaf of the enlarged sibling they land in; filled and
  // fake-fs windows refit there, floating stay. A selection on the closed
  // leaf moves to the sibling's first leaf.
  _closeRegion() {
    if (!this._active) {
      return
    }
    const ctx = this._dynamicCtx()
    if (!ctx) {
      return
    }
    const tree = this._treeFor(ctx.monitor, ctx.ws)
    const pos = this._actionPos(ctx, tree)
    if (pos < 0) {
      this._dbg('close ignored: no selection and no focused window')
      return
    }
    const id = leaves(tree)[pos].id
    const r = closeLeaf(tree, id)
    if (!r.removed) {
      this._dbg('close ignored: last region')
      return
    }
    this._layoutSet(ctx.monitor, ctx.ws, { name: 'dynamic', tree: r.tree })
    this._syncFakeMonitors() // before reflow: _tileRects reads the tree + fakes
    const rects = this._tileRectsFor(ctx.monitor, ctx.ws)
    const ls = leaves(r.tree)
    for (const win of this._winSignals.keys()) {
      if (win.get_monitor() !== ctx.monitor || this._wsOf(win) !== ctx.ws) {
        continue
      }
      if (this._regions.get(win) === id) {
        const f = win.get_frame_rect()
        const idx = regionIndexAt(rects, f.x + f.width / 2, f.y + f.height / 2)
        this._regions.set(win, ls[Math.max(0, idx)].id)
      }
    }
    this._refitWindows(ctx.monitor, ctx.ws)
    if (this._sel && this._sel.leafId === id) {
      this._sel = { ...this._sel, leafId: r.siblingId }
    }
    this._updateOverlay(ctx.monitor)
    this._updateHighlight()
    this._dbg(`close region ${pos} (leaf ${id}), sibling leaf ${r.siblingId}`)
  }

  _onFullscreen(w) {
    const m = w.get_monitor()
    const ws = this._wsOf(w)
    this._dbg(
      `fs change: "${w.get_title()}" fs=${w.is_fullscreen()} layout=${this._layoutFor(m, ws)}`,
    )
    if (!this._active) {
      return
    }
    if (w.is_fullscreen()) {
      if (leafCount(this._treeFor(m, ws)) === 1) {
        return
      } // real fullscreen allowed (single region)
      if (this._confineBlocked(w, 'fs')) {
        return
      }
      this._dbg(`intercept fullscreen: ${w.get_title()}`)
      // fs=false echo arrives ASYNC (Wayland configure round-trip,
      // seen 3ms later in the wild); swallow notifies in a grace
      // window instead of assuming sync delivery
      this._unmaking = w
      w.unmake_fullscreen()
      this._timeout(1000, () => {
        if (this._unmaking === w) {
          this._unmaking = null
        }
        return GLib.SOURCE_REMOVE
      })
      this._ensureRegion(w)
      const r = this._fsRectsFor(m, ws)[this._posOf(w)]
      w.move_resize_frame(true, r.x, r.y, r.width, r.height) // covers panel
      w.make_above()
      this._fakeFs.add(w)
      this._actorRaise(w)
      this._fsBudget.set(w, 0)
      // geometry watcher (once per window): catches clients that
      // self-configure long after the intercept
      if (!this._fsWatched.has(w)) {
        this._fsWatched.add(w)
        this._winSignals.get(w).push(
          w.connect('position-changed', () => this._fsWatch(w)),
          w.connect('size-changed', () => this._fsWatch(w)),
        )
      }
      // X11/Proton clients self-configure after un-fullscreen and win
      // the geometry race -> offset. Bounded re-asserts after settle;
      // no watcher (fought games' self-centering into rate blocks).
      for (const ms of [250, 1000, 2500]) {
        this._timeout(ms, () => {
          if (!this._fakeFs?.has(w)) {
            return GLib.SOURCE_REMOVE
          }
          const rr = this._fsRectsFor(w.get_monitor(), this._wsOf(w))[this._posOf(w)]
          w.move_resize_frame(true, rr.x, rr.y, rr.width, rr.height)
          this._actorRaise(w) // mutter may re-parent on restack
          return GLib.SOURCE_REMOVE
        })
      }
    } else if (w !== this._unmaking && this._fakeFs.delete(w)) {
      this._dbg(`fs exit: "${w.get_title()}"`)
      w.unmake_above()
      this._actorLower(w)
    }
  }

  // Fake-fs geometry drift police. Own budget (30) + debounce (250ms),
  // isolated from the shared rate limiter: bounded war against games that
  // self-center on every resize. Budget exhausted -> hotkey move
  // re-asserts manually.
  _fsWatch(w) {
    if (!this._fakeFs?.has(w) || this._retiling) {
      return
    }
    const r = this._fsRectsFor(w.get_monitor(), this._wsOf(w))[this._posOf(w)]
    const f = w.get_frame_rect()
    if (
      Math.abs(f.x - r.x) < 3 &&
      Math.abs(f.y - r.y) < 3 &&
      Math.abs(f.width - r.width) < 3 &&
      Math.abs(f.height - r.height) < 3
    ) {
      return
    } // in place
    const now = Date.now()
    if (now - (this._lastFsWatch.get(w) ?? 0) < 250) {
      return
    }
    const budget = (this._fsBudget.get(w) ?? 0) + 1
    this._fsBudget.set(w, budget)
    if (budget > 30) {
      this._dbg(`fs budget exhausted: "${w.get_title()}"`)
      return
    }
    this._lastFsWatch.set(w, now)
    this._dbg(`fs re-assert #${budget}: "${w.get_title()}"`)
    w.move_resize_frame(true, r.x, r.y, r.width, r.height)
  }

  _focusedMonitor() {
    const w = global.display.focus_window
    return w ? w.get_monitor() : Main.layoutManager.primaryIndex
  }
}
