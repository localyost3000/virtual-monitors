// Headless integration run for per-desktop regions (F1), dynamic
// splits (F2), the workspace-switch animation and desktop-icons
// adoption.
// Booted by scripts/headless-repro.sh inside a scratch headless
// gnome-shell 50; see that script for the environment details.
//
// Drives the extension the way the keybindings do: set a layout on the
// active desktop, switch to a neighbor desktop and back (neighbor +
// activate(), same as mutter's switch-to-workspace handler), assert the
// per-desktop invariants, then exercise the dynamic layout (select, split,
// close) end to end:
//   - a configured desktop survives switching away (nothing prunes it)
//   - its layout is re-presented on arrival, unused desktops keep defaults
//   - two configured desktops keep their own layouts side by side
//   - select/split/close no-op outside the dynamic layout
//   - split/close reshape the regions and re-present the fake monitors
//   - a layout switch clears the selection highlight
//   - a window is cloned into the animation region it overlaps
//   - desktop-icons windows recreated mid-switch end up adopted
//
// Prints REPRO dumps, REPRO CHECK lines, and a final
// "REPRO RESULT: PASS|FAIL (n/m checks)" that the shell script gates on.
// Not part of `npm test`: it boots a compositor.
//
// A FAIL at or after "back on A" is the desktop-pruning regression:
// transient desktop-icons windows on the active desktop made the shell's
// dynamic-workspace cleanup delete the empty desktop just left — and the
// stored layout with it.

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

const UUID = 'virtual-monitors@localyost3000'
const DING = 'ding@rastersoft.com'
const DTP = 'dash-to-panel@jderose9.github.com'
const mgr = global.workspace_manager
const tagged = new Map()

const sleep = (ms) => new Promise((r) => GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ms, r))

// stable per-desktop labels for dumps (A, B, ...); survives workspace churn
function tag(ws) {
  if (!tagged.has(ws)) tagged.set(ws, String.fromCharCode(65 + tagged.size))
  return tagged.get(ws)
}

function alive(ws) {
  for (let i = 0; i < mgr.get_n_workspaces(); i++)
    if (mgr.get_workspace_by_index(i) === ws) return true
  return false
}

function wsLine() {
  const parts = []
  for (let i = 0; i < mgr.get_n_workspaces(); i++) {
    const ws = mgr.get_workspace_by_index(i)
    parts.push(`${i}=${tag(ws)}${i === mgr.get_active_workspace_index() ? '*' : ''}`)
  }
  return parts.join(' ')
}

function layoutsLine(so) {
  const parts = []
  if (so?._layouts) {
    for (const [mon, byWs] of so._layouts) {
      for (const [ws, st] of byWs)
        parts.push(`m${mon}:${tag(ws)}${alive(ws) ? '' : '(DEAD)'}=${st.name}`)
    }
  }
  return parts.join(' ') || '-'
}

function monLine() {
  return Main.layoutManager.monitors
    .map((m) => `${Math.round(m.width)}x${Math.round(m.height)}+${m.x}`)
    .join(' ')
}

function strutLine() {
  const parts = []
  for (const data of Main.layoutManager._trackedActors ?? []) {
    if (!data.affectsStruts || !data.actor.visible) continue
    const [w, h] = data.actor.get_transformed_size()
    parts.push(`${data.actor.constructor?.name ?? 'actor'}(${Math.round(w)}x${Math.round(h)})`)
  }
  return parts.join(' ') || '-'
}

function winLine() {
  const parts = []
  for (const a of global.get_window_actors()) {
    const w = a.get_meta_window()
    if (!w) continue
    parts.push(
      `${w.get_window_type()}${w.is_on_all_workspaces() ? '/sticky' : `/ws${w.get_workspace()?.index()}`}:${w.get_title() ?? '?'}`,
    )
  }
  return parts.join(' ; ') || '-'
}

function trackerLine() {
  const t = Main.wm?._workspaceTracker
  if (!t) return 'no-tracker'
  const parts = []
  t._workspaces.forEach((shWs, i) => {
    const lr = shWs._lastRemovedWindow
    parts.push(
      `#${i}:keep=${shWs._keepAliveId ?? '-'} lastRemoved=${lr ? `${lr.get_window_type()}:${lr.get_title() ?? '?'}` : '-'}`,
    )
  })
  return parts.join(' | ')
}

let step = 0
function dump(label) {
  step++
  const ext = Main.extensionManager.lookup(UUID)
  const so = ext?.stateObj
  const ding = Main.extensionManager.lookup(DING)
  const dtp = Main.extensionManager.lookup(DTP)
  const fakes = so?._fakeMonitors?._fakeRects ?? []
  printerr(
    `REPRO[${step}] ${label} :: ext=${ext?.state}${ext?.error ? ` (err: ${ext.error})` : ''} ` +
      `ding=${ding?.state ?? '-'} dtp=${dtp?.state ?? '-'}${dtp?.error ? ` (err: ${dtp.error})` : ''} ` +
      `active=${so?._active} ws[${wsLine()}] monitors=${Main.layoutManager.monitors.length} ` +
      `[${monLine()}] fakeRects=${fakes.length} stored=[${layoutsLine(so)}] struts=[${strutLine()}]`,
  )
  printerr(`REPRO   windows=[${winLine()}]`)
  printerr(`REPRO   tracker=[${trackerLine()}]`)
}

// switch like mutter's keybinding handler: neighbor or no-op
function switchNeighbor(dir) {
  const n = mgr.get_n_workspaces()
  const t = mgr.get_active_workspace_index() + dir
  if (t < 0 || t >= n) {
    printerr(`REPRO switch ${dir > 0 ? '+1' : '-1'} out of range (n=${n}), keybinding would no-op`)
    return false
  }
  mgr.get_workspace_by_index(t).activate(global.get_current_time())
  return true
}

let checks = 0
let failures = 0
function check(label, ok) {
  checks++
  if (!ok) failures++
  printerr(`REPRO CHECK ${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

// the prune handler must drop desktops the shell removed
function layoutsHealthy(so) {
  if (!so?._layouts) return true
  for (const byWs of so._layouts.values())
    for (const ws of byWs.keys()) if (!alive(ws)) return false
  return true
}

// region count of a stored/template tree (F2 model: in-order leaves)
function regions(so, mon, ws) {
  const t = so._treeFor(mon, ws)
  let n = 0
  const walk = (x) => (x.leaf ? n++ : (walk(x.a), walk(x.b)))
  walk(t)
  return n
}

// in-order leaf ids of a stored/template tree
function leafIds(so, mon, ws) {
  const out = []
  const walk = (x) => (x.leaf ? out.push(x.id) : (walk(x.a), walk(x.b)))
  walk(so._treeFor(mon, ws))
  return out
}

// region widths from the fullscreen rects (no strut insets: exact geometry)
function fsWidths(so, mon, ws) {
  return so
    ._fsRectsFor(mon, ws)
    .map((r) => r.width)
    .join()
}

async function main() {
  let so = null
  for (let i = 0; i < 60 && !so; i++) {
    so = Main.extensionManager.lookup(UUID)?.stateObj ?? null
    if (!so) await sleep(250)
  }
  await sleep(700)

  check('extension enabled', !!so && typeof so._setLayout === 'function')
  check('animation patch installed', so?._animPatch === true)
  dump('boot')
  if (!so || typeof so._setLayout !== 'function') return

  const wsA = mgr.get_active_workspace()
  check('boot: single default (1 region)', Main.layoutManager.monitors.length === 1)
  check('boot: desktop A has default layout', regions(so, 0, wsA) === 1)

  so._setLayout(0, 'dual')
  await sleep(400)
  dump('A: set dual')
  check('A: dual applied (2 regions)', Main.layoutManager.monitors.length === 2)
  check('A: dual stored on active desktop', regions(so, 0, wsA) === 2)

  switchNeighbor(+1)
  await sleep(900)
  const wsB = mgr.get_active_workspace()
  dump('switch +1 -> B')
  check('B: unused desktop uses default (1 region)', Main.layoutManager.monitors.length === 1)
  check('A: survived switching away', alive(wsA))
  check('A: kept its layout while away', regions(so, 0, wsA) === 2)

  switchNeighbor(-1)
  await sleep(900)
  dump('switch -1 -> A (want dual)')
  check('back on A', mgr.get_active_workspace() === wsA)
  check('A: layout re-presented (2 regions)', Main.layoutManager.monitors.length === 2)
  check('A: still stored after round trip', regions(so, 0, wsA) === 2)

  switchNeighbor(+1)
  await sleep(900)
  dump('switch +1 -> B')
  check('B again', mgr.get_active_workspace() === wsB)
  so._setLayout(0, 'thirds')
  await sleep(400)
  dump('B: set thirds')
  check('B: thirds applied (3 regions)', Main.layoutManager.monitors.length === 3)

  switchNeighbor(-1)
  await sleep(900)
  dump('switch -1 -> A (want dual)')
  check(
    'A: dual re-presented',
    mgr.get_active_workspace() === wsA && Main.layoutManager.monitors.length === 2,
  )

  switchNeighbor(+1)
  await sleep(900)
  dump('switch +1 -> B (want thirds)')
  check(
    'B: thirds re-presented',
    mgr.get_active_workspace() === wsB && Main.layoutManager.monitors.length === 3,
  )

  check('both configured desktops alive', alive(wsA) && alive(wsB))
  check('layouts: no dead desktops stored', layoutsHealthy(so))

  // Animation probe first: it exercises the current desktop's layout
  // before the F2 churn reshapes it repeatedly (see _03). It spawns its
  // own window, so it does not depend on desktop-icons windows existing.
  await animationProbe()

  // F2: dynamic layout select/split/close end to end (see _01)
  await dynamicProbe(so, mgr.get_active_workspace())

  // Desktop-icons adoption: nothing may be left floating over the user's
  // windows after layout-changing switches and splits (see _00 of 10-17)
  await dingProbe(so)
}

// F2 dynamic hotkeys driven the way the bindings do (method calls: the
// automation script cannot synthesize keybindings). Selections are made
// and acted on in the same JS turn where the outcome depends on them:
// every reflow makes ding recreate its per-region windows, and the focus
// changes that follow clear the selection (by design: "clears on focus
// change"), which must not be mistaken for a bug.
async function dynamicProbe(so, ws) {
  // gate: outside the dynamic layout all three ops no-op
  so._setLayout(0, 'dual')
  await sleep(400)
  so._selectMove(1)
  so._splitRegion()
  so._closeRegion()
  await sleep(400)
  dump('F2: gate in dual')
  check(
    'F2 gate: ops no-op outside dynamic',
    so._sel === null &&
      !so._selOverlay &&
      regions(so, 0, ws) === 2 &&
      Main.layoutManager.monitors.length === 2,
  )

  // dynamic starts as one region; split -> 2, select, split -> 3, close -> 2
  so._setLayout(0, 'dynamic')
  await sleep(400)
  dump('F2: dynamic seed')
  check(
    'F2: dynamic starts as one region',
    regions(so, 0, ws) === 1 && Main.layoutManager.monitors.length === 1,
  )

  // windowless modes (min/dtp) have no focused window: the selection is
  // how empty regions are reached, so select the seed region and split it
  so._setSelection({ monitor: 0, ws, leafId: leafIds(so, 0, ws)[0] })
  so._splitRegion()
  await sleep(400)
  dump('F2: split seed')
  check(
    'F2: split -> two regions',
    regions(so, 0, ws) === 2 &&
      Main.layoutManager.monitors.length === 2 &&
      fsWidths(so, 0, ws) === '640,640',
  )

  // move the highlight: with no selection it is created at the focused
  // window's region (none: first leaf), then moved — from either start it
  // lands on the second leaf, and the highlight renders immediately
  so._selectMove(1)
  check(
    'F2: select-next renders the highlight',
    !!so._sel && so._sel.leafId === leafIds(so, 0, ws)[1] && !!so._selOverlay,
  )

  // split the highlighted region: [0.5, 0.25, 0.25] proves the op acted
  // on the selection (a focused-window fallback would often split region 0)
  so._splitRegion() // same turn: the selection cannot be cleared in between
  await sleep(400)
  dump('F2: split selected')
  check(
    'F2: split selected -> three regions',
    regions(so, 0, ws) === 3 &&
      Main.layoutManager.monitors.length === 3 &&
      fsWidths(so, 0, ws) === '640,320,320',
  )

  // close the highlighted region; its sibling takes over and the selection
  // moves to the sibling's first (only) leaf
  so._setSelection({ monitor: 0, ws, leafId: leafIds(so, 0, ws)[1] })
  so._closeRegion() // same turn, same reason as the split
  const selAfter = so._sel
  const overlayAfter = !!so._selOverlay
  await sleep(400)
  dump('F2: close selected')
  const rects = so._tileRectsFor(0, ws)
  check(
    'F2: close selected -> two regions, selection moves to sibling',
    regions(so, 0, ws) === 2 &&
      Main.layoutManager.monitors.length === 2 &&
      fsWidths(so, 0, ws) === '640,640' &&
      selAfter?.monitor === 0 &&
      selAfter?.ws === ws &&
      selAfter?.leafId === leafIds(so, 0, ws)[1] &&
      overlayAfter &&
      rects.length === 2 &&
      rects[0].x + rects[0].width === rects[1].x,
  )

  so._setLayout(0, 'dual') // any layout hotkey drops the selection
  await sleep(300)
  dump('F2: layout hotkey')
  check('F2: layout switch clears the selection', so._sel === null && !so._selOverlay)
}

// desktop-icons windows are hidden from get_window_actors by ding itself,
// so enumerate the display's full window list; titles are "Desktop Icons
// <n>" at creation and "@!x,y;BDHF" once positioned.
function dingWindows() {
  return (global.display.list_all_windows?.() ?? []).filter((w) => {
    const t = w.get_title() ?? ''
    return t.startsWith('Desktop Icons ') || /^@!-?\d+,-?\d+;/.test(t)
  })
}

// a desktop-icons window that missed ding's adoption: still a normal,
// non-sticky, taskbar-visible window floating above the user's windows.
function dingOrphans() {
  return dingWindows().filter(
    (w) =>
      w.get_window_type() !== Meta.WindowType.DESKTOP ||
      !w.is_on_all_workspaces() ||
      !w.skip_taskbar,
  )
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

// ---------------- animation probe ----------------
//
// The shell builds one animation group per layoutManager.monitors entry, so
// with fake monitors the group boxes already follow the regions. Which
// windows each group shows is decided by BaseWorkspaceGroup
// ._windowIsOnThisMonitor, which mutter answers with real-monitor geometry
// only: a window on a fake region (index >= 1) gets no clone and the region
// swaps instantly while region 0 slides (see _03). The probe parks a normal
// window in the last region to exercise that predicate — ding's own desktop
// windows are desktop type and hidden from the very window list the
// animation clones from, so they cannot play this part.
async function spawnProbeWindow() {
  let proc
  try {
    proc = Gio.Subprocess.new(
      ['/usr/bin/zenity', '--info', '--title=repro-anim', '--text=animation probe', '--no-wrap'],
      Gio.SubprocessFlags.NONE,
    )
  } catch {
    return { proc: null, win: null }
  }
  let win = null
  for (let i = 0; i < 40 && !win; i++) {
    win =
      (global.display.list_all_windows?.() ?? []).find((w) => w.get_title() === 'repro-anim') ??
      null
    if (!win) await sleep(200)
  }
  if (!win) return { proc, win: null }
  // Park it in the last region. The extension fits new windows on map and
  // the maximize/unmaximize round that follows restores the pre-fit
  // position, so let that settle, then move until the position sticks.
  await sleep(700)
  const monitors = Main.layoutManager.monitors
  const last = monitors[monitors.length - 1]
  for (let i = 0; i < 10; i++) {
    win.move_frame(true, last.x + 20, last.y + 20)
    await sleep(250)
    const r = win.get_frame_rect()
    if (r.x >= last.x && r.x < last.x + last.width) break
  }
  return { proc, win }
}

async function animationProbe() {
  if (Main.layoutManager.monitors.length < 2) {
    printerr('REPRO CHECK skip animation (single region)')
    return
  }
  const { proc, win } = await spawnProbeWindow()
  if (!win) {
    printerr('REPRO CHECK skip animation (probe window did not appear)')
    proc?.force_exit()
    return
  }
  switchNeighbor(mgr.get_active_workspace_index() > 0 ? -1 : +1)

  let data = null
  for (let i = 0; i < 100 && !data; i++) {
    data = Main.wm?._workspaceAnimation?._switchData ?? null
    if (!data) await sleep(10)
  }
  if (!data) {
    check('animation: switch groups appeared', false)
    proc.force_exit()
    return
  }
  const rect = win.get_frame_rect()
  const groups = data.monitors.map((g) => ({
    index: g.index,
    overlap: overlaps(rect, g._monitor),
    clones: g._workspaceGroups.reduce(
      (n, wg) =>
        n + wg._windowRecords.filter((r) => r.windowActor.get_meta_window() === win).length,
      0,
    ),
  }))
  printerr(
    `REPRO   animation rect=${rect.x},${rect.y} ${rect.width}x${rect.height} ` +
      `groups=[${groups.map((g) => `m${g.index}:${g.clones}${g.overlap ? '!' : ''}`).join(' ')}]`,
  )
  check('animation: one group per region', groups.length === Main.layoutManager.monitors.length)
  check(
    'animation: window clones land only in the regions it overlaps',
    groups.every((g) => (g.overlap ? g.clones > 0 : g.clones === 0)),
  )
  check(
    'animation: fake region clones its window',
    groups.some((g) => g.index > 0 && g.overlap && g.clones > 0),
  )

  // Sliding wallpaper actors must have real geometry: the stock path asks
  // background.js for the fake monitor's index, which mutter's background
  // content resolves against its real monitor table only — index >= 1 gets
  // uninitialized geometry (zero-width allocations, garbage paint): the
  // region flashes the animation box colour, or white on GL stacks.
  await sleep(50)
  const wallpapers = data.monitors.flatMap((g) =>
    g._workspaceGroups.map((wg) => wg._background?._bgManager?.backgroundActor ?? null),
  )
  printerr(
    `REPRO   animation wallpaper actors=[${wallpapers
      .map((a) => (a ? `${Math.round(a.width)}x${Math.round(a.height)}` : '-'))
      .join(' ')}]`,
  )
  check(
    'animation: every region has wallpaper geometry',
    wallpapers.length > 0 &&
      wallpapers.every(
        (a) =>
          a &&
          a.width > 0 &&
          a.height > 0 &&
          a.width <= global.stage.width &&
          a.height <= global.stage.height,
      ),
  )

  // let the switch finish before taking the probe window down
  for (let i = 0; i < 100 && Main.wm?._workspaceAnimation?._switchData; i++) await sleep(10)
  await sleep(150)
  proc.force_exit()
  await sleep(200)
}

// ---------------- desktop-icons adoption probe ----------------
//
// ding recreates its per-region desktop windows whenever the region count
// changes — every switch to a desktop with a different layout. A recreation
// that lands while the switch is in flight misses ding's own adoption (it
// runs off the window-manager 'map' signal, which mutter never emits for
// such windows) and used to stay a normal, floating window: the duplicated
// "Desktop Icons" windows reported over the user's apps. The extension
// re-runs ding's adoption for the windows it missed (see _00 of 10-17);
// nothing may be left floating.
async function dingProbe(so) {
  const ding = Main.extensionManager.lookup(DING)
  if (ding?.state !== 1) {
    printerr('REPRO CHECK skip desktop-icons adoption (no ding in this mode)')
    return
  }
  let waited = 0
  while (!dingWindows().length && waited < 10000) {
    await sleep(250)
    waited += 250
  }
  if (!dingWindows().length) {
    printerr('REPRO CHECK skip desktop-icons adoption (no ding windows appeared)')
    return
  }
  const report = (label) => {
    printerr(
      `REPRO   ${label} desktop-icons=[${dingWindows()
        .map(
          (w) =>
            `${w.get_window_type() === Meta.WindowType.DESKTOP ? 'desktop' : 'FLOATING'}` +
            `${w.is_on_all_workspaces() ? '/sticky' : '/loose'}` +
            `${w.skip_taskbar ? '/hidden' : '/LISTED'}:${w.get_title()}`,
        )
        .join(' ')}]`,
    )
    const floating = dingOrphans()
    check(`desktop icons: ${label}`, floating.length === 0)
  }

  // this desktop: two regions, the neighbor gets one; every switch between
  // them changes the count, so arrivals recreate the desktop windows
  so._setLayout(0, 'dual')
  await sleep(400)
  if (!switchNeighbor(+1) && !switchNeighbor(-1)) {
    printerr('REPRO CHECK skip desktop-icons adoption (no neighbor desktop)')
    return
  }
  await sleep(900)
  so._setLayout(0, 'single')
  await sleep(400)
  switchNeighbor(-1)
  await sleep(1600) // switch + recreate + adoption settle
  report('adopted after layout-changing round trip')

  // the reported path: dynamic-split on the other desktop, then return
  switchNeighbor(+1)
  await sleep(900)
  so._setLayout(0, 'dynamic')
  await sleep(300)
  const ws = mgr.get_active_workspace()
  so._setSelection({ monitor: 0, ws, leafId: leafIds(so, 0, ws)[0] })
  so._splitRegion()
  await sleep(600)
  report('adopted after dynamic split')
  switchNeighbor(-1)
  await sleep(1600)
  report('adopted after split-and-return')
}

export function init() {
  main()
    .catch((e) => {
      printerr(`REPRO EXCEPTION ${e?.stack ?? e}`)
      checks++
      failures++
    })
    .finally(() => {
      printerr(
        `REPRO RESULT: ${failures ? 'FAIL' : 'PASS'} (${checks - failures}/${checks} checks)`,
      )
      printerr('REPRO DONE')
      global.context.terminate()
    })
}

// the automation harness awaits run(); never resolve it — the shell stays
// up while init()'s sequence drives the session, then terminates it
export async function run() {
  await new Promise(() => {})
}
