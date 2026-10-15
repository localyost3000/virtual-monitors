// Region math. Fractions of monitor width (horizontal column splits),
// resolution-agnostic. No GNOME imports: unit-testable under gjs/node.
//
// F2 model: regions are the in-order leaves of a binary tiling tree.
// Leaves carry the column width fractions (the flat-sequence semantics of
// v1 — rect output stays byte-identical); internal h-nodes carry structure
// only: sibling identity, region order, the shape split/close operate on.
// `kind` is reserved for future vertical splits ('v').

export const LAYOUTS = {
  single: [1],
  dynamic: [1], // seed for user splits: the hotkey starts/resets to one region
  dual: [1 / 2, 1 / 2],
  theater: [1 / 4, 1 / 2, 1 / 4],
  thirds: [1 / 3, 1 / 3, 1 / 3],
  mainside: [0.7, 0.3],
}

export function fractionsFor(name) {
  return (LAYOUTS[name] ?? LAYOUTS.single).slice()
}

// fractions: column width fractions -> pixel rects in global coords.
// Last region eats the rounding remainder: no gaps/overlaps at any width.
export function regionRects(fractions, geom) {
  let x = geom.x
  return fractions.map((fw, i) => {
    const width = i === fractions.length - 1 ? geom.x + geom.width - x : Math.round(fw * geom.width)
    const r = { x, y: geom.y, width, height: geom.height }
    x += width
    return r
  })
}

// Move the boundary adjacent to region `idx` by `delta` (fraction of total
// width). Positive grows region idx. Clamps: every region keeps >= 10%.
export function nudgeFractions(fractions, idx, delta) {
  const n = fractions.length
  if (n < 2) {
    return fractions.slice()
  }
  const j = Math.min(idx, n - 2) // boundary between j and j+1
  const d = idx < n - 1 ? delta : -delta // last region: grow moves its left edge
  const a = fractions[j] + d
  const b = fractions[j + 1] - d
  if (a < 0.1 || b < 0.1) {
    return fractions.slice()
  }
  const f = fractions.slice()
  f[j] = a
  f[j + 1] = b
  return f
}

// region index containing point (px, py); -1 if none.
// Inclusive right/bottom edges + first-match: a point exactly on a dividing
// line (e.g. maximized window centered on the split) goes to the left/top
// region.
export function regionIndexAt(rects, px, py) {
  return rects.findIndex(
    (r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height,
  )
}

// --- tiling tree (F2) ----------------------------------------------------
//
// Leaf: { leaf: true, id, frac }   frac = width fraction of the monitor.
// Node: { kind: 'h', a, b }        in-order leaves = region order.
//
// Rendering routes through regionRects() over the leaf frac sequence, so
// the flat v1 output (round each frac; the last region eats the rounding
// remainder) is preserved exactly. The draft plan rounded per split instead
// (left = round(ratio * width)); double rounding diverges from v1 by +/-1px
// at odd widths, so the fracs are the canonical quantities and the tree
// carries only structure. All ops are pure: they rebuild the nodes on the
// path they touch and keep every untouched node identical.

export function treeFromColumns(fractions) {
  let node = null
  for (let i = fractions.length - 1; i >= 0; i--) {
    const leaf = { leaf: true, id: i, frac: fractions[i] }
    node = node ? { kind: 'h', a: leaf, b: node } : leaf
  }
  return node
}

export function treeFromLayout(name) {
  return treeFromColumns(fractionsFor(name))
}

// In-order leaves (region order).
export function leaves(tree) {
  const out = []
  const walk = (n) => {
    if (n.leaf) {
      out.push(n)
    } else {
      walk(n.a)
      walk(n.b)
    }
  }
  walk(tree)
  return out
}

export function leafCount(tree) {
  return leaves(tree).length
}

// In-order position of leaf `id`; -1 if the id is not in the tree.
export function posOf(tree, id) {
  return leaves(tree).findIndex((l) => l.id === id)
}

// All leaves' rects, in order. Exact v1 parity by construction.
export function regionRectsTree(tree, geom) {
  return regionRects(
    leaves(tree).map((l) => l.frac),
    geom,
  )
}

function totalFrac(node) {
  return node.leaf ? node.frac : totalFrac(node.a) + totalFrac(node.b)
}

function leftmostId(node) {
  let n = node
  while (!n.leaf) {
    n = n.a
  }
  return n.id
}

function scaleFracs(node, k) {
  if (node.leaf) {
    return { ...node, frac: node.frac * k }
  }
  return { ...node, a: scaleFracs(node.a, k), b: scaleFracs(node.b, k) }
}

function splitRec(node, id, newId) {
  if (node.leaf) {
    if (node.id !== id) {
      return null
    }
    const half = node.frac / 2
    // original leaf keeps identity/windows/selection; it becomes the left half
    return { kind: 'h', a: { ...node, frac: half }, b: { leaf: true, id: newId, frac: half } }
  }
  const a = splitRec(node.a, id, newId)
  if (a) {
    return { ...node, a }
  }
  const b = splitRec(node.b, id, newId)
  return b ? { ...node, b } : null
}

// Split leaf `id` into two halves. Returns the new tree and the fresh
// leaf's id (null if `id` is missing). Callers gate on canSplit().
export function splitLeaf(tree, id) {
  const newId = leaves(tree).reduce((m, l) => Math.max(m, l.id), -1) + 1
  const next = splitRec(tree, id, newId)
  return next ? { tree: next, newId } : { tree, newId: null }
}

function closeRec(node, id) {
  if (node.leaf) {
    return node.id === id ? { gone: true } : { gone: false, node }
  }
  const a = closeRec(node.a, id)
  if (a.gone) {
    // sibling subtree inherits the parent's full width
    return {
      gone: false,
      node: scaleFracs(node.b, totalFrac(node) / totalFrac(node.b)),
      siblingId: leftmostId(node.b),
    }
  }
  const b = closeRec(node.b, id)
  if (b.gone) {
    return {
      gone: false,
      node: scaleFracs(node.a, totalFrac(node) / totalFrac(node.a)),
      siblingId: leftmostId(node.a),
    }
  }
  if (a.node === node.a && b.node === node.b) {
    return { gone: false, node }
  }
  return {
    gone: false,
    node: { ...node, a: a.node, b: b.node },
    siblingId: a.siblingId ?? b.siblingId,
  }
}

// Close leaf `id`: its sibling subtree takes over the parent's space. The
// root leaf is a no-op (a tree never has zero regions). Returns the
// sibling's first leaf id for selection hand-off.
export function closeLeaf(tree, id) {
  if (tree.leaf) {
    return { tree, removed: false, siblingId: null }
  }
  const r = closeRec(tree, id)
  if (r.node === tree) {
    return { tree, removed: false, siblingId: null }
  }
  return { tree: r.node, removed: true, siblingId: r.siblingId ?? null }
}

// Grow/shrink leaf `id` by `delta` (fraction of monitor width): exact v1
// nudgeFractions semantics over the leaf frac sequence (adjacent boundary;
// the last leaf moves its left edge; both sides clamp at 10%). Returns the
// same tree object when the move is refused.
export function nudgeLeaf(tree, id, delta) {
  const ls = leaves(tree)
  const pos = ls.findIndex((l) => l.id === id)
  if (pos < 0) {
    return tree
  }
  const next = nudgeFractions(
    ls.map((l) => l.frac),
    pos,
    delta,
  )
  if (next.every((f, i) => f === ls[i].frac)) {
    return tree
  }
  const fracById = new Map(ls.map((l, i) => [l.id, next[i]]))
  const rebuild = (n) => {
    if (n.leaf) {
      const f = fracById.get(n.id)
      return f === n.frac ? n : { ...n, frac: f }
    }
    const a = rebuild(n.a)
    const b = rebuild(n.b)
    return a === n.a && b === n.b ? n : { ...n, a, b }
  }
  return rebuild(tree)
}

// Splitting must keep both halves >= minFrac of monitor width.
export function canSplit(tree, id, minFrac = 0.1) {
  const l = leaves(tree).find((x) => x.id === id)
  return !!l && l.frac / 2 >= minFrac - 1e-9
}

// Fake monitors (dash-to-panel panels) only for regions wide enough:
// width >= minFrac * monitorWidth (inclusive); minFrac 0 = every region.
export function filterRectsForFakes(rects, minFrac, monitorWidth) {
  if (!(minFrac > 0)) {
    return rects.slice()
  }
  return rects.filter((r) => r.width >= minFrac * monitorWidth)
}
