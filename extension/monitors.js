// SPDX-License-Identifier: MIT
//
// Fake monitors (spike): present the display's layout regions as monitors
// to GNOME Shell's JS side (layoutManager.monitors) so per-monitor chrome
// (dash-to-panel: launcher, clock, system menus, per-region element
// config) renders once per region. The mutter C side (input, real
// geometry, real fullscreen, barriers) still sees one physical display.
//
// Spike scope: exactly one physical monitor; skipped otherwise.
// No GNOME imports: deps injected (layoutManager, monitor manager emitter)
// so the state machine is unit-testable under gjs/node.

export class FakeMonitors {
  // getRects: () => [{x, y, width, height}] global coords, one per fake
  // monitor, FULL monitor height. Recomputed on real hardware change.
  // deps: {layoutManager, getMonitorManager} — real Main.layoutManager and
  // () => global.backend?.get_monitor_manager() from the caller.
  // dbg: optional debug logger.
  constructor(getRects, deps, dbg) {
    this._getRects = getRects
    this._lm = deps.layoutManager
    this._getMonitorManager = deps.getMonitorManager
    this._dbg = dbg ?? (() => {})
    this._active = false
    this._emitting = false // skip our own monitors-changed emits
    this._realMonitors = null // shell Monitor objects before faking
    this._realWorkAreas = null // workareas captured before faking
    this._fakeRects = null // last applied fake rects
    this._installedFakes = null // fake array currently in layoutManager.monitors
    this._monitorsChangedId = 0
  }

  get active() {
    return this._active
  }

  // Real-monitor accessors for our own tiling math, bypassing fakes.
  realMonitor(i) {
    const mons = this._realMonitors ?? this._lm.monitors
    return mons[i] ?? mons[this._lm.primaryIndex]
  }

  // ponytail: workareas frozen at apply time; a dtp panel resize after
  // that goes unnoticed until re-apply. Upgrade path: recompute on the
  // real 'workareas-changed' (needs a real/fake emit distinguisher).
  realWorkArea(i) {
    if (!this._active) {
      return this._lm.getWorkAreaForMonitor(i)
    }
    return this._realWorkAreas[i] ?? this._realWorkAreas[0]
  }

  // rects: [{x, y, width, height}] global coords, one per fake monitor,
  // FULL monitor height: dtp panel struts shrink each fake workarea.
  apply() {
    const rects = this._getRects()
    if (!rects?.length) {
      return
    }
    if (!this._active) {
      if (this._lm.monitors.length !== 1) {
        return
      } // spike scope guard
      this._realMonitors = this._lm.monitors
      this._realWorkAreas = this._realMonitors.map((m, i) => this._lm.getWorkAreaForMonitor(i))
      this._monitorsChangedId = this._lm.connect_after('monitors-changed', () =>
        this._onMonitorsChanged(),
      )
      this._active = true
    } else if (this._installedFakes === this._lm.monitors && sameRects(rects, this._fakeRects)) {
      // nothing changed and our fakes are still installed: skip the
      // shell-wide monitors-changed storm (workspace switches between
      // desktops with the same layout land here)
      this._dbg('fakes unchanged, skip')
      return
    }
    this._fakeRects = rects
    this._applyFakes()
  }

  release() {
    if (!this._active) {
      return
    }
    this._active = false
    if (this._monitorsChangedId) {
      this._lm.disconnect(this._monitorsChangedId)
      this._monitorsChangedId = 0
    }
    this._lm.monitors = this._realMonitors
    this._lm._updateRegions?.()
    this._emitChanged()
    this._realMonitors = this._realWorkAreas = this._fakeRects = null
    this._installedFakes = null
  }

  _applyFakes() {
    const scale = this._realMonitors[0]?.geometry_scale ?? 1
    const r0 = this._realMonitors[0]
    this._dbg(
      `fakes apply: real=${r0.width}x${r0.height}+${r0.x}+${r0.y}@${scale} rects=${JSON.stringify(this._fakeRects)}`,
    )
    this._lm.monitors = this._fakeRects.map((r, i) => ({
      index: i,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      geometry_scale: scale,
      inFullscreen: false,
    }))
    this._installedFakes = this._lm.monitors
    // rebuild workareas + hot corners for fakes, then let shell
    // modules and dtp re-read .monitors (dtp resets its panels)
    this._lm._updateRegions?.()
    this._emitChanged()
  }

  // dtp listens 'monitors-changed' on the BACKEND monitor manager, not
  // layoutManager. Emit there so dtp resets. Shell's own
  // _updateMonitors reacts to the same signal by rewriting .monitors with
  // real entries; skip it for this emit or dtp would reset onto reals.
  _emitChanged() {
    const mm = this._getMonitorManager()
    if (!mm) {
      return
    }
    this._emitting = true
    const lm = this._lm
    const orig = lm._updateMonitors
    if (orig) {
      lm._updateMonitors = () => {}
    }
    mm.emit('monitors-changed')
    if (orig) {
      lm._updateMonitors = orig
    }
    // backgroundManager / desktop icons / overview key off
    // layoutManager's own signal; fire it too so they rebuild for
    // the fakes
    lm.emit('monitors-changed')
    this._emitting = false
  }

  // Real hardware change: shell re-wrote .monitors with real entries.
  // Re-stash reals, then re-assert fakes on top.
  _onMonitorsChanged() {
    if (this._emitting || !this._active) {
      return
    }
    this._realMonitors = this._lm.monitors
    if (this._realMonitors.length !== 1) {
      this.release()
      return
    }
    const r0 = this._realMonitors[0]
    this._dbg(`fakes re-stash: real=${r0.width}x${r0.height}+${r0.x}+${r0.y}`)
    this._realWorkAreas = this._realMonitors.map((m, i) => this._lm.getWorkAreaForMonitor(i))
    const rects = this._getRects() // recompute for new geometry
    if (rects?.length) {
      this._fakeRects = rects
    }
    this._applyFakes()
  }
}

// rect lists compare by value: lets apply() skip a no-op re-present
function sameRects(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false
  }
  return a.every(
    (r, i) =>
      r.x === b[i].x && r.y === b[i].y && r.width === b[i].width && r.height === b[i].height,
  )
}
