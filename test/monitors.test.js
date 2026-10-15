import { FakeMonitors } from '../extension/monitors.js'

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`)
    failures++
  }
}

// layoutManager + backend monitor-manager stand-ins. emit() runs shell's
// _updateMonitors and re-enters our monitors-changed handler, mirroring
// the real signal flow.
function harness(realMons, workAreas) {
  const lm = {
    monitors: realMons,
    primaryIndex: 0,
    connectCalls: 0,
    connectedId: 0,
    disconnectedId: 0,
    updateRegionsCalls: 0,
    updateMonitorsCalls: 0,
    emits: [],
    _handler: null,
    _workAreas: workAreas,
    connect_after(_sig, cb) {
      this.connectCalls++
      this._handler = cb
      this.connectedId = 7
      return 7
    },
    disconnect(id) {
      this.disconnectedId = id
    },
    getWorkAreaForMonitor(i) {
      return this._workAreas[i] ?? this._workAreas[0]
    },
    _updateRegions() {
      this.updateRegionsCalls++
    },
    _updateMonitors() {
      this.updateMonitorsCalls++
    },
    emit(sig) {
      this.emits.push(sig)
      this._updateMonitors()
      this._handler?.()
    },
  }
  const mm = {
    emits: [],
    emit(sig) {
      this.emits.push(sig)
      lm._updateMonitors()
      lm._handler?.()
    },
  }
  return { lm, mm, deps: { layoutManager: lm, getMonitorManager: () => mm } }
}

const real1 = [{ x: 0, y: 0, width: 1920, height: 1080, geometry_scale: 2 }]
const fakeRects = [
  { x: 0, y: 0, width: 960, height: 1080 },
  { x: 960, y: 0, width: 960, height: 1080 },
]
const area1 = [{ x: 0, y: 0, width: 1920, height: 1048 }]

// apply with 1 real monitor: fakes installed, real stashed
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  assert(fm.active, 'apply: active')
  assert(h.lm.monitors.length === 2, 'apply: 2 fake monitors')
  assert(h.lm.monitors[1].x === 960 && h.lm.monitors[1].index === 1, 'apply: right region geometry')
  assert(h.lm.monitors[0].geometry_scale === 2, 'apply: inherits real geometry_scale')
  assert(h.lm.monitors[0].inFullscreen === false, 'apply: inFullscreen false')
  assert(h.lm.updateRegionsCalls === 1, 'apply: _updateRegions once')
  assert(h.mm.emits.includes('monitors-changed'), 'apply: backend emit')
  assert(h.lm.emits.includes('monitors-changed'), 'apply: layoutManager emit')
  // shell's _updateMonitors would overwrite fakes; skipped during backend emit
  assert(h.lm.updateMonitorsCalls === 1, 'apply: _updateMonitors runs only on lm emit')
  assert(fm.realMonitor(0) === real1[0], 'apply: real stashed')
  assert(fm.realWorkArea(0).height === 1048, 'apply: real workarea stashed')
}

// spike guard: 2 real monitors -> no-op
{
  const two = [
    { x: 0, y: 0, width: 1920, height: 1080, geometry_scale: 1 },
    { x: 1920, y: 0, width: 1080, height: 1920, geometry_scale: 1 },
  ]
  const h = harness(two, [
    { x: 0, y: 0, width: 1920, height: 1048 },
    { x: 1920, y: 0, width: 1080, height: 1900 },
  ])
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  assert(!fm.active, 'spike guard: != 1 monitor -> inactive')
  assert(h.lm.monitors === two, 'spike guard: monitors untouched')
  assert(h.lm.connectCalls === 0, 'spike guard: no connect')
}

// empty rects -> no-op
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => [], h.deps)
  fm.apply()
  assert(!fm.active && h.lm.monitors.length === 1, 'empty rects: no-op')
}

// realWorkArea while inactive: delegates to live workarea
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  assert(fm.realWorkArea(0).height === 1048, 'realWorkArea inactive: delegates')
}

// apply twice: fakes must not be re-stashed as reals
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  fm.apply()
  assert(h.lm.connectCalls === 1, 'apply twice: connect once')
  assert(fm.realMonitor(0) === real1[0], 'apply twice: reals preserved')
}

// release when inactive: no-op
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.release()
  assert(
    !fm.active && h.lm.disconnectedId === 0 && h.mm.emits.length === 0,
    'release inactive: no-op',
  )
}

// release while active: reals restored, disconnected, emits
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  h.mm.emits.length = 0
  fm.release()
  assert(!fm.active, 'release: inactive')
  assert(h.lm.monitors === real1, 'release: real monitors restored')
  assert(h.lm.disconnectedId === 7, 'release: disconnected')
  assert(h.mm.emits.includes('monitors-changed'), 'release: emits')
}

// self-emit: re-entrant monitors-changed during our emit is ignored
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  assert(fm.active && h.lm.monitors.length === 2, 'emitting guard: fakes survive self-emit')
}

// hardware change, still 1 monitor: re-stash + recompute
{
  const h = harness(real1, area1)
  let calls = 0
  const fm = new FakeMonitors(() => {
    calls++
    return calls === 1
      ? fakeRects
      : [
          { x: 0, y: 0, width: 1280, height: 1080 },
          { x: 1280, y: 0, width: 1280, height: 1080 },
        ]
  }, h.deps)
  fm.apply()
  const newReal = [{ x: 0, y: 0, width: 2560, height: 1080, geometry_scale: 1 }]
  h.lm.monitors = newReal
  h.lm._workAreas = [{ x: 0, y: 0, width: 2560, height: 1048 }]
  h.lm._handler()
  assert(fm.active, 'hw change: still active')
  assert(fm.realMonitor(0) === newReal[0], 'hw change: new real stashed')
  assert(
    h.lm.monitors[0].width === 1280 && h.lm.monitors[1].x === 1280,
    'hw change: fakes recomputed',
  )
  assert(fm.realWorkArea(0).width === 2560, 'hw change: workarea re-stashed')
}

// hardware change to 2 monitors: auto-release
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  const twoReal = [
    { x: 0, y: 0, width: 1920, height: 1080, geometry_scale: 1 },
    { x: 1920, y: 0, width: 1080, height: 1920, geometry_scale: 1 },
  ]
  h.lm.monitors = twoReal
  h.lm._handler()
  assert(!fm.active, 'hw change to 2: auto-release')
  assert(h.lm.monitors === twoReal, 'auto-release: reals restored')
}

// unchanged rects while fakes installed: skip re-apply and emits
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  h.lm.updateRegionsCalls = 0
  h.mm.emits.length = 0
  h.lm.emits.length = 0
  fm.apply()
  assert(h.lm.updateRegionsCalls === 0, 'unchanged rects: no _updateRegions')
  assert(h.mm.emits.length === 0, 'unchanged rects: no backend emit')
  assert(h.lm.emits.length === 0, 'unchanged rects: no layoutManager emit')
}

// shell overwrote .monitors with reals: re-apply even with same rects
{
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => fakeRects, h.deps)
  fm.apply()
  h.lm.monitors = real1 // shell _updateMonitors rewrote (real hardware path)
  h.mm.emits.length = 0
  fm.apply()
  assert(
    h.lm.monitors.length === 2 && h.lm.monitors[0].width === 960,
    'reals overwrote: fakes re-applied',
  )
  assert(h.mm.emits.includes('monitors-changed'), 'reals overwrote: emits')
}

// changed rects: re-apply
{
  let rects = fakeRects
  const h = harness(real1, area1)
  const fm = new FakeMonitors(() => rects, h.deps)
  fm.apply()
  rects = [
    { x: 0, y: 0, width: 1280, height: 1080 },
    { x: 1280, y: 0, width: 640, height: 1080 },
  ]
  fm.apply()
  assert(h.lm.monitors[1].x === 1280 && h.lm.monitors[1].width === 640, 'changed rects: re-applied')
}

if (failures) {
  console.error(`${failures} failures`)
  if (globalThis.process?.exit) process.exit(1)
  imports.system.exit(1)
}
console.log('monitors tests OK')
