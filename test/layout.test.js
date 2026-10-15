import {
  LAYOUTS,
  canSplit,
  closeLeaf,
  filterRectsForFakes,
  fractionsFor,
  leafCount,
  leaves,
  nudgeFractions,
  nudgeLeaf,
  posOf,
  regionIndexAt,
  regionRects,
  regionRectsTree,
  splitLeaf,
  treeFromColumns,
  treeFromLayout,
} from '../extension/layout.js'

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`)
    failures++
  }
}
const nearSum1 = (f) => Math.abs(f.reduce((a, b) => a + b, 0) - 1) < 1e-9

// every layout: fractions sum to 1
for (const [name, f] of Object.entries(LAYOUTS))
  assert(nearSum1(f) && f.every((x) => x > 0), `layout ${name} fractions sane`)
assert(Object.keys(LAYOUTS).length === 6, 'six layouts defined')

// ultrawide dual
let r = regionRects(fractionsFor('dual'), { x: 0, y: 0, width: 5120, height: 1440 })
assert(r.length === 2, 'dual has 2 regions')
assert(r[0].x === 0 && r[0].width === 2560 && r[0].height === 1440, 'ultrawide left half')
assert(r[1].x === 2560 && r[1].width === 2560, 'ultrawide right half')
assert(regionIndexAt(r, 100, 100) === 0, 'point in left')
assert(regionIndexAt(r, 4000, 100) === 1, 'point in right')

// edge case: maximized window center lands exactly on dividing line -> left
assert(regionIndexAt(r, 2560, 720) === 0, 'boundary point rounds left')
assert(regionIndexAt(r, 5120, 720) === 1, 'right edge still in right region')

// 1080p dual: same fractions
r = regionRects(fractionsFor('dual'), { x: 0, y: 0, width: 1920, height: 1080 })
assert(r[0].width === 960 && r[1].x === 960 && r[1].width === 960, '1080p halves')

// offset monitor (second display)
r = regionRects(fractionsFor('dual'), { x: 5120, y: 200, width: 1920, height: 1080 })
assert(r[1].x === 6080 && r[1].y === 200, 'offset right region')
assert(regionIndexAt(r, 5220, 300) === 0, 'offset point left')

// single / unknown
r = regionRects(fractionsFor('single'), { x: 0, y: 0, width: 5120, height: 1440 })
assert(r.length === 1 && r[0].width === 5120, 'single full')
r = regionRects(fractionsFor('bogus'), { x: 0, y: 0, width: 5120, height: 1440 })
assert(r.length === 1, 'unknown layout = single')

// odd width: last region eats remainder, no gap/overlap
r = regionRects(fractionsFor('thirds'), { x: 0, y: 0, width: 1919, height: 1080 })
assert(r[2].x + r[2].width === 1919, 'odd width: right edge flush')
assert(r[1].x === r[0].width && r[2].x === r[0].width + r[1].width, 'no gaps')

// theater / mainside on ultrawide
r = regionRects(fractionsFor('theater'), { x: 0, y: 0, width: 5120, height: 1440 })
assert(r.length === 3 && r[1].width === 2560 && r[0].width === 1280, 'theater center 50%')
r = regionRects(fractionsFor('mainside'), { x: 0, y: 0, width: 5120, height: 1440 })
assert(r[0].width === 3584 && r[1].width === 1536, 'mainside 70/30')

// nudge: grow/shrink moves boundary, clamps at 10%
let f = fractionsFor('dual')
f = nudgeFractions(f, 0, 0.05) // -> [0.55, 0.45]
assert(Math.abs(f[0] - 0.55) < 1e-9 && nearSum1(f), 'grow left region')
f = nudgeFractions(f, 0, -0.05) // -> [0.5, 0.5]
assert(Math.abs(f[0] - 0.5) < 1e-9, 'shrink back')
f = nudgeFractions(f, 1, 0.05) // last region grows: its left edge moves -> [0.45, 0.55]
assert(Math.abs(f[1] - 0.55) < 1e-9 && nearSum1(f), 'grow last region moves its left edge')
// clamp: shrinking region to <10% is refused
f = [0.12, 0.88]
const f2 = nudgeFractions(f, 0, -0.05)
assert(f2[0] === 0.12 && f2[1] === 0.88, 'nudge clamps at 10%')
// single region: no-op
assert(nudgeFractions([1], 0, 0.05)[0] === 1, 'single region nudge no-op')
// theater: middle region grow eats right wing
f = nudgeFractions(fractionsFor('theater'), 1, 0.05)
assert(Math.abs(f[1] - 0.55) < 1e-9 && Math.abs(f[2] - 0.2) < 1e-9, 'theater middle grows right')

// nudge: shrink last region clamps at 10%
f = [0.88, 0.12]
assert(nudgeFractions(f, 1, -0.05)[1] === 0.12, 'shrink last region clamps at 10%')
// nudge: just above 10% allowed (exact 10% unreachable: 0.15-0.05 < 0.1 in float)
f = nudgeFractions([0.15, 0.85], 0, -0.04)
assert(f[0] > 0.1 && f[0] < 0.12, 'nudge allows just above 10%')
// nudge: grow last region
f = nudgeFractions([0.9, 0.1], 1, 0.05)
assert(Math.abs(f[0] - 0.85) < 1e-9 && Math.abs(f[1] - 0.15) < 1e-9, 'grow last region')

// fractionsFor returns a copy
const fr = fractionsFor('theater')
fr[0] = 9
assert(LAYOUTS.theater[0] === 0.25, 'fractionsFor returns copy')

// regionIndexAt: outside monitor -> -1
r = regionRects(fractionsFor('dual'), { x: 0, y: 0, width: 1920, height: 1080 })
assert(regionIndexAt(r, -1, 100) === -1, 'left of monitor')
assert(regionIndexAt(r, 100, -1) === -1, 'above monitor')
assert(regionIndexAt(r, 100, 1081) === -1, 'below monitor')
assert(regionIndexAt(r, 1921, 100) === -1, 'right of monitor')
assert(regionIndexAt(r, 100, 1080) === 0, 'bottom edge inclusive')
assert(regionIndexAt([], 100, 100) === -1, 'no regions')

// --- F2: tiling tree -----------------------------------------------------

const GEOMS = [
  { x: 0, y: 0, width: 5120, height: 1440 },
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 0, y: 0, width: 1001, height: 777 }, // odd
  { x: 320, y: 200, width: 3440, height: 1440 }, // offset second display
]
const rectsEqual = (a, b) =>
  a.length === b.length &&
  a.every(
    (r, i) =>
      r.x === b[i].x && r.y === b[i].y && r.width === b[i].width && r.height === b[i].height,
  )

// layout parity: tree output is byte-identical to the v1 flat output, all
// templates, all widths (odd included)
for (const name of Object.keys(LAYOUTS)) {
  for (const g of GEOMS) {
    const flat = regionRects(fractionsFor(name), g)
    assert(
      rectsEqual(regionRectsTree(treeFromLayout(name), g), flat),
      `tree parity ${name} @${g.width}x${g.height}`,
    )
  }
}

// tree shape: in-order leaves, ids = template index, fracs = fractions
for (const [name, f] of Object.entries(LAYOUTS)) {
  const ls = leaves(treeFromLayout(name))
  assert(
    ls.length === f.length && leafCount(treeFromLayout(name)) === f.length,
    `leaf count ${name}`,
  )
  assert(
    ls.every((l, i) => l.id === i && Math.abs(l.frac - f[i]) < 1e-12),
    `leaf fracs/ids ${name}`,
  )
}
assert(posOf(treeFromLayout('theater'), 2) === 2, 'posOf in-order')
assert(posOf(treeFromLayout('theater'), 9) === -1, 'posOf missing id')
assert(leafCount(treeFromLayout('dynamic')) === 1, 'dynamic starts as one region')
assert(leafCount(treeFromLayout('bogus')) === 1, 'unknown layout falls back to single tree')

// split: source leaf keeps identity/windows, becomes the left half
const st = treeFromLayout('theater') // [1/4, 1/2, 1/4]
const sr = splitLeaf(st, 1)
assert(sr.newId === 3 && leafCount(sr.tree) === 4, 'split adds a leaf with a fresh id')
const sl = leaves(sr.tree)
assert(
  sl.map((l) => l.id).join() === '0,1,3,2' &&
    Math.abs(sl[1].frac - 0.25) < 1e-12 &&
    Math.abs(sl[2].frac - 0.25) < 1e-12,
  'split keeps order + halves the source in place',
)
assert(posOf(sr.tree, 2) === 3, 'untouched right leaf keeps its id, shifts position')
assert(Math.abs(leaves(st)[1].frac - 0.5) < 1e-12, 'input tree unmodified (pure)')
// split with an unknown id is refused: same tree back, no new id
const srBad = splitLeaf(st, 99)
assert(srBad.newId === null && srBad.tree === st, 'split unknown id refused')

// split -> close round trip restores exact rects, either half, odd widths
for (const g of GEOMS) {
  for (const name of Object.keys(LAYOUTS)) {
    const t0 = treeFromLayout(name)
    const base = regionRectsTree(t0, g)
    for (const leafNode of leaves(t0)) {
      const s = splitLeaf(t0, leafNode.id)
      const expected = leaves(t0).flatMap((l) =>
        l.id === leafNode.id ? [l.frac / 2, l.frac / 2] : [l.frac],
      )
      assert(
        rectsEqual(regionRectsTree(s.tree, g), regionRects(expected, g)),
        `split rects ${name} #${leafNode.id} @${g.width}`,
      )
      const c1 = closeLeaf(s.tree, s.newId) // close the new half
      assert(
        c1.removed && rectsEqual(regionRectsTree(c1.tree, g), base),
        `round trip new ${name} #${leafNode.id} @${g.width}`,
      )
      // closing the ORIGINAL half leaves the same geometry (fresh id)
      const c2 = closeLeaf(s.tree, leafNode.id)
      assert(
        c2.removed && rectsEqual(regionRectsTree(c2.tree, g), base),
        `round trip original ${name} #${leafNode.id} @${g.width}`,
      )
    }
  }
}

// close: sibling inherits the parent's space; refusals; sibling reporting
const ct = closeLeaf(treeFromLayout('thirds'), 1)
assert(ct.removed && ct.siblingId === 2 && leafCount(ct.tree) === 2, 'close removes one leaf')
const cr = regionRectsTree(ct.tree, { x: 0, y: 0, width: 3000, height: 1000 })
assert(cr[0].width === 1000 && cr[1].width === 2000, 'close: sibling takes over the space')
assert(closeLeaf(treeFromLayout('single'), 0).removed === false, 'close root leaf refused')
const dualTree = treeFromLayout('dual')
const cBad = closeLeaf(dualTree, 99)
assert(!cBad.removed && cBad.tree === dualTree, 'close unknown id refused, same tree back')
const c3 = closeLeaf(splitLeaf(treeFromLayout('dual'), 1).tree, 1)
assert(c3.removed && c3.siblingId === 2, 'close left side reports right sibling first leaf')

// nudge equivalence: every template x region x direction vs v1 nudgeFractions
for (const [name, f0] of Object.entries(LAYOUTS)) {
  for (let i = 0; i < f0.length; i++) {
    for (const d of [0.05, -0.05]) {
      const ref = nudgeFractions(f0, i, d)
      const got = leaves(nudgeLeaf(treeFromLayout(name), i, d)).map((l) => l.frac)
      assert(
        got.length === ref.length && got.every((x, k) => x === ref[k]),
        `nudge parity ${name} #${i} ${d}`,
      )
    }
  }
}
// clamp parity: refused nudges return the same tree object
const clampedTree = treeFromColumns([0.12, 0.88])
assert(nudgeLeaf(clampedTree, 0, -0.05) === clampedTree, 'refused nudge returns same tree')
assert(nudgeLeaf(clampedTree, 9, 0.05) === clampedTree, 'unknown id nudge returned unchanged')
// nudge on a split tree matches nudgeFractions on its frac sequence
const nt = splitLeaf(treeFromLayout('thirds'), 1).tree // [1/3, 1/6, 1/6, 1/3]
const fBefore = leaves(nt).map((l) => l.frac)
const nref = nudgeFractions(fBefore, 2, 0.05)
const ngot = leaves(nudgeLeaf(nt, leaves(nt)[2].id, 0.05)).map((l) => l.frac)
assert(
  ngot.every((x, k) => x === nref[k]),
  'nudge parity on a split tree',
)

// canSplit: both halves must keep >= 10%
assert(canSplit(treeFromColumns([0.2, 0.8]), 0), 'canSplit at exactly 20%')
assert(!canSplit(treeFromColumns([0.195, 0.805]), 0), 'canSplit refuses below 20%')
assert(canSplit(treeFromLayout('dynamic'), 0), 'dynamic seed region splittable')
assert(!canSplit(treeFromLayout('dynamic'), 9), 'unknown id not splittable')
let deep = treeFromLayout('dynamic')
while (canSplit(deep, leaves(deep)[0].id)) {
  deep = splitLeaf(deep, leaves(deep)[0].id).tree
}
assert(Math.abs(leaves(deep)[0].frac - 0.125) < 1e-12, 'split chain bottoms out at 12.5%')
assert(!canSplit(deep, leaves(deep)[0].id), 'cannot split at the 10% floor')

// filterRectsForFakes: inclusive minimum width fraction
const frects = [{ width: 100 }, { width: 240 }, { width: 300 }, { width: 500 }]
assert(filterRectsForFakes(frects, 0.25, 1000).length === 2, 'filter 0.25: only >= 250px regions')
assert(filterRectsForFakes(frects, 0.24, 1000).length === 3, 'filter: boundary inclusive')
assert(filterRectsForFakes(frects, 0.51, 1000).length === 0, 'filter: none qualify')
assert(filterRectsForFakes(frects, 0, 1000).length === 4, 'filter 0 = every region')
assert(filterRectsForFakes(frects, -1, 1000).length === 4, 'filter negative = every region')
assert(filterRectsForFakes(frects, 0.25, 1000) !== frects, 'filter returns a copy')

// randomized property sweep: split/nudge/close never break the invariants
// (fracs sum to 1, every leaf >= 10%, no gaps/overlaps, ids unique)
let seed = 12345
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
for (let round = 0; round < 150; round++) {
  let t = treeFromLayout('dynamic')
  for (let step = 0; step < 12; step++) {
    const ls = leaves(t)
    const pick = ls[Math.floor(rand() * ls.length)]
    const roll = rand()
    if (roll < 0.45 && canSplit(t, pick.id)) {
      t = splitLeaf(t, pick.id).tree
    } else if (roll < 0.75) {
      t = nudgeLeaf(t, pick.id, (rand() < 0.5 ? -1 : 1) * 0.05)
    } else if (ls.length > 1) {
      t = closeLeaf(t, pick.id).tree
    }
    const g = { x: 0, y: 0, width: 5120, height: 1440 }
    const rects = regionRectsTree(t, g)
    const ls2 = leaves(t)
    assert(rects.length === ls2.length, 'sweep: rect/leaf parity')
    assert(rects[0].x === 0, 'sweep: flush left')
    assert(
      rects[rects.length - 1].x + rects[rects.length - 1].width === g.width,
      'sweep: flush right',
    )
    for (let i = 1; i < rects.length; i++) {
      assert(rects[i].x === rects[i - 1].x + rects[i - 1].width, 'sweep: no gaps/overlaps')
    }
    assert(new Set(ls2.map((l) => l.id)).size === ls2.length, 'sweep: ids unique')
    assert(!ls2.some((l) => l.frac < 0.1 - 1e-9), 'sweep: min width held')
  }
}

if (failures) {
  console.error(`${failures} failures`)
  if (globalThis.process?.exit) process.exit(1)
  imports.system.exit(1)
}
console.log('layout tests OK')
