import { floatRect, insetByStruts, monitorForRegion, rectsOverlap } from '../extension/geometry.js'

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`)
    failures++
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// --- floatRect: saved rect accepted when clearly different from region ---
let r = floatRect(
  { x: 10, y: 20, width: 300, height: 200 },
  { x: 100, y: 200, width: 1000, height: 800 },
)
assert(eq(r, { x: 10, y: 20, width: 300, height: 200 }), 'saved rect kept when different')

// saved rect ~= region fill (async restore race) -> 70% centered fallback
r = floatRect(
  { x: 102, y: 201, width: 998, height: 800 },
  { x: 100, y: 200, width: 1000, height: 800 },
)
assert(
  eq(r, { x: 250, y: 320, width: 700, height: 560 }),
  'fill-like saved rect rejected -> 70% centered',
)

// no saved rect -> 70% centered
r = floatRect(null, { x: 100, y: 200, width: 1000, height: 800 })
assert(eq(r, { x: 250, y: 320, width: 700, height: 560 }), 'no saved rect -> 70% centered')

// tolerance: 4px diff = fill (rejected), 5px diff = real float (kept)
r = floatRect(
  { x: 104, y: 200, width: 1000, height: 800 },
  { x: 100, y: 200, width: 1000, height: 800 },
)
assert(eq(r, { x: 250, y: 320, width: 700, height: 560 }), '4px diff = fill, rejected')
r = floatRect(
  { x: 105, y: 200, width: 1000, height: 800 },
  { x: 100, y: 200, width: 1000, height: 800 },
)
assert(eq(r, { x: 105, y: 200, width: 1000, height: 800 }), '5px diff = real float, kept')

// odd sizes: rounding
r = floatRect(null, { x: 0, y: 0, width: 999, height: 501 })
assert(eq(r, { x: 150, y: 75, width: 699, height: 351 }), 'odd size fallback rounds')

// --- insetByStruts ---
const region = { x: 0, y: 0, width: 1920, height: 1080 }

// no struts: unchanged
assert(eq(insetByStruts(region, []), region), 'no struts: unchanged')

// full-width top panel
assert(
  eq(insetByStruts(region, [{ x: 0, y: 0, width: 1920, height: 32 }]), {
    x: 0,
    y: 32,
    width: 1920,
    height: 1048,
  }),
  'top panel insets top',
)

// full-width bottom panel
assert(
  eq(insetByStruts(region, [{ x: 0, y: 1048, width: 1920, height: 32 }]), {
    x: 0,
    y: 0,
    width: 1920,
    height: 1048,
  }),
  'bottom panel insets bottom',
)

// full-height left dock
assert(
  eq(insetByStruts(region, [{ x: 0, y: 0, width: 48, height: 1080 }]), {
    x: 48,
    y: 0,
    width: 1872,
    height: 1080,
  }),
  'left dock insets left',
)

// full-height right dock
assert(
  eq(insetByStruts(region, [{ x: 1872, y: 0, width: 48, height: 1080 }]), {
    x: 0,
    y: 0,
    width: 1872,
    height: 1080,
  }),
  'right dock insets right',
)

// panel covering only the left region: right region untouched
assert(
  eq(
    insetByStruts({ x: 960, y: 0, width: 960, height: 1080 }, [
      { x: 0, y: 0, width: 960, height: 32 },
    ]),
    {
      x: 960,
      y: 0,
      width: 960,
      height: 1080,
    },
  ),
  'left-region panel does not inset right region',
)

// full-width top bar insets every region
assert(
  eq(
    insetByStruts({ x: 960, y: 0, width: 960, height: 1080 }, [
      { x: 0, y: 0, width: 1920, height: 32 },
    ]),
    {
      x: 960,
      y: 32,
      width: 960,
      height: 1048,
    },
  ),
  'full-width top bar insets right region too',
)

// corner panel (no full span): treated as left inset, shell _updateRegions parity
assert(
  eq(insetByStruts(region, [{ x: 0, y: 0, width: 480, height: 32 }]), {
    x: 480,
    y: 0,
    width: 1440,
    height: 1080,
  }),
  'corner panel insets left',
)

// combined: top bar + left dock
assert(
  eq(
    insetByStruts(region, [
      { x: 0, y: 0, width: 1920, height: 32 },
      { x: 0, y: 0, width: 48, height: 1080 },
    ]),
    { x: 48, y: 32, width: 1872, height: 1048 },
  ),
  'top bar + left dock combine',
)

// fractional actor coords round before side tests
assert(
  eq(insetByStruts(region, [{ x: 0.4, y: 0.4, width: 1920, height: 31.6 }]), {
    x: 0,
    y: 32,
    width: 1920,
    height: 1048,
  }),
  'fractional strut coords round',
)

// --- rectsOverlap: positive-area overlap; touching edges do not count ---
const win = { x: 0, y: 0, width: 100, height: 100 }
assert(rectsOverlap(win, { x: 50, y: 50, width: 100, height: 100 }), 'partial overlap')
assert(rectsOverlap(win, { x: -50, y: -50, width: 500, height: 500 }), 'window inside rect')
assert(rectsOverlap(win, { x: 20, y: 20, width: 10, height: 10 }), 'rect inside window')
assert(!rectsOverlap(win, { x: 100, y: 0, width: 100, height: 100 }), 'edge-touching = no overlap')
assert(
  !rectsOverlap(win, { x: -100, y: 0, width: 100, height: 100 }),
  'edge-touching left = no overlap',
)
assert(!rectsOverlap(win, { x: 200, y: 0, width: 10, height: 10 }), 'disjoint = no overlap')

// --- monitorForRegion: fake regions slice the containing real monitor ---
const one = [{ x: 0, y: 0, width: 1280, height: 720 }]
assert(
  eq(monitorForRegion({ x: 0, y: 0, width: 640, height: 720 }, one), {
    index: 0,
    rect: { x: 0, y: 0, width: 1280, height: 720 },
  }),
  'left fake region slices real monitor 0',
)
assert(
  eq(monitorForRegion({ x: 640, y: 0, width: 640, height: 720 }, one), {
    index: 0,
    rect: { x: 0, y: 0, width: 1280, height: 720 },
  }),
  'right fake region slices real monitor 0',
)
// region identical to a real monitor: stock behavior already right
assert(
  monitorForRegion({ x: 0, y: 0, width: 1280, height: 720 }, one) === null,
  'region equal to real monitor = stock',
)

const dual = [
  { x: 0, y: 0, width: 960, height: 1080 },
  { x: 960, y: 0, width: 960, height: 1080 },
]
assert(
  eq(monitorForRegion({ x: 960, y: 32, width: 960, height: 1048 }, dual)?.index, 1),
  'region in second real monitor',
)
assert(
  eq(monitorForRegion({ x: 480, y: 32, width: 480, height: 1048 }, dual)?.index, 0),
  'region in first real monitor',
)
// exact match wins over an earlier containing monitor
assert(
  monitorForRegion({ x: 960, y: 0, width: 960, height: 1080 }, dual) === null,
  'exact match wins over containing',
)
// contained by none: no wallpaper slice source
assert(
  monitorForRegion({ x: 1920, y: 0, width: 100, height: 100 }, dual) === null,
  'uncontained region = null',
)

if (failures) {
  console.error(`${failures} failures`)
  if (globalThis.process?.exit) process.exit(1)
  imports.system.exit(1)
}
console.log('geometry tests OK')
