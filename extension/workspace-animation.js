// Make the workspace-switch animation region-aware (see
// .plans/2026-10-16_03_workspace_switch_animation.md).
//
// Two patches, installed/uninstalled as a pair:
//
// 1. BaseWorkspaceGroup._windowIsOnThisMonitor
//    The shell builds one animation group per Main.layoutManager.monitors
//    entry, so with fake monitors the group boxes already follow the
//    regions (their MonitorConstraint reads layoutManager.monitors). But
//    BaseWorkspaceGroup decides which windows appear in each group via
//    global.display.get_monitor_geometry(), which mutter only defines for
//    real monitors: fake regions >= 1 never match, render no clones, and
//    swap instantly while region 0 slides. Every group is constructed with
//    the layoutManager monitor it represents, so we shadow the predicate to
//    test against that rect. On real setups the two rects are identical,
//    so behavior there is unchanged.
//
// 2. WorkspaceBackground._createBackground
//    The sliding wallpaper of each group is a background.js actor built
//    with monitorIndex = the fake monitor's index. mutter's background
//    content resolves its geometry (preferred size, texture crop) from its
//    real monitor table only, so an index >= 1 reads uninitialized memory:
//    the actor degenerates (zero-width allocation, garbage paint) and the
//    region showed the animation box colour mid-slide — or flashed white,
//    depending on the GL stack. For regions that are not a real monitor's
//    rect, build the wallpaper from the real monitor containing the region
//    and offset it so the region shows its own wallpaper slice.
//
// Both are private API: guard for drift, no-op (and log) if gone.

import Meta from 'gi://Meta'
import * as Background from 'resource:///org/gnome/shell/ui/background.js'
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js'

import { monitorForRegion, rectsOverlap } from './geometry.js'

let original = null
let ours = null
let backgroundOriginal = null
let backgroundOurs = null

// real monitor containing a fake region (one whose rect differs from every
// real monitor rect), as the wallpaper slice source; null when stock applies
function sourceMonitorFor(region) {
  const rects = []
  for (let i = 0; i < global.display.get_n_monitors(); i++) {
    rects.push(global.display.get_monitor_geometry(i))
  }
  return monitorForRegion(region, rects)
}

// returns true when this call installed at least one patch (idempotent)
export function install() {
  let installed = false

  const proto = WorkspaceAnimation.BaseWorkspaceGroup?.prototype
  if (!ours && typeof proto?._windowIsOnThisMonitor === 'function') {
    original = proto._windowIsOnThisMonitor
    ours = function (metawindow) {
      if (!this._monitor) {
        return original.call(this, metawindow)
      }
      return rectsOverlap(metawindow.get_frame_rect(), this._monitor)
    }
    proto._windowIsOnThisMonitor = ours
    installed = true
  }

  const backgroundProto = WorkspaceAnimation.WorkspaceBackground?.prototype
  if (!backgroundOurs && typeof backgroundProto?._createBackground === 'function') {
    backgroundOriginal = backgroundProto._createBackground
    backgroundOurs = function () {
      const region = this._monitor
      const source = region ? sourceMonitorFor(region) : null
      if (!source) {
        backgroundOriginal.call(this)
        return
      }
      // fake region: paint the containing real monitor's wallpaper
      // composition and offset it so the region shows its slice
      const container = new Meta.BackgroundGroup()
      this.add_child(container)
      this._bgManager = new Background.BackgroundManager({
        container,
        monitorIndex: source.index,
        controlPosition: false,
      })
      this._bgManager.backgroundActor?.set_position(
        source.rect.x - region.x,
        source.rect.y - region.y,
      )
    }
    backgroundProto._createBackground = backgroundOurs
    installed = true
  }

  return installed
}

export function uninstall() {
  const proto = WorkspaceAnimation.BaseWorkspaceGroup?.prototype
  if (ours && proto?._windowIsOnThisMonitor === ours) {
    proto._windowIsOnThisMonitor = original
  }
  const backgroundProto = WorkspaceAnimation.WorkspaceBackground?.prototype
  if (backgroundOurs && backgroundProto?._createBackground === backgroundOurs) {
    backgroundProto._createBackground = backgroundOriginal
  }
  ours = original = null
  backgroundOurs = backgroundOriginal = null
}
