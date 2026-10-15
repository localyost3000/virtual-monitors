// Pure rect math: float-restore rects, strut insets. No GNOME imports:
// unit-testable under gjs/node.

// Positive-area overlap between two {x, y, width, height} rects. Mirrors
// Meta.Rectangle.intersect semantics for our use: touching edges do not
// count (used to test windows against region rects).
export function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

// Monitor whose wallpaper a fake region should slice: the monitorRects
// entry containing the region's origin. Returns null when region is exactly
// a monitor rect (stock per-monitor behavior is already right) or is
// contained by none; else {index, rect} of the containing monitor.
// monitorRects: [{x, y, width, height}, ...].
export function monitorForRegion(region, monitorRects) {
  let containing = null
  for (let i = 0; i < monitorRects.length; i++) {
    const m = monitorRects[i]
    if (
      m.x === region.x &&
      m.y === region.y &&
      m.width === region.width &&
      m.height === region.height
    ) {
      return null
    }
    if (
      !containing &&
      region.x >= m.x &&
      region.x < m.x + m.width &&
      region.y >= m.y &&
      region.y < m.y + m.height
    ) {
      containing = { index: i, rect: { x: m.x, y: m.y, width: m.width, height: m.height } }
    }
  }
  return containing
}

// Floating restore rect: saved pre-fill geometry, else 70% centered.
// Reject saved rects that are really the region fill (async restore race
// on Wayland): falling back to 70% beats restoring the fill.
export function floatRect(saved, region) {
  if (
    saved &&
    (Math.abs(saved.x - region.x) > 4 ||
      Math.abs(saved.y - region.y) > 4 ||
      Math.abs(saved.width - region.width) > 4 ||
      Math.abs(saved.height - region.height) > 4)
  ) {
    return saved
  }
  const width = Math.round(region.width * 0.7)
  const height = Math.round(region.height * 0.7)
  return {
    x: region.x + Math.round((region.width - width) / 2),
    y: region.y + Math.round((region.height - height) / 2),
    width,
    height,
  }
}

// rect minus chrome struts overlapping it (same side rules as shell
// _updateRegions, but per fake rect). Handles dtp per-region panels,
// stock top bar, dock, live as actors move/resize.
// struts: [{x, y, width, height}] global coords, already filtered for
// visible + affectsStruts.
export function insetByStruts(rect, struts) {
  let nx = rect.x,
    ny = rect.y
  let nx2 = rect.x + rect.width,
    ny2 = rect.y + rect.height
  for (const s of struts) {
    let ax = Math.round(s.x)
    const ay = Math.round(s.y)
    const ax2 = Math.round(ax + s.width)
    const ay2 = Math.round(ay + s.height)
    if (ax2 <= nx || ax >= nx2 || ay2 <= ny || ay >= ny2) {
      continue
    } // no overlap with this region
    // same side rules as shell _updateRegions
    if (ax <= rect.x && ax2 >= nx2) {
      if (ay <= rect.y) {
        ny = Math.max(ny, ay2)
      } // TOP
      else if (ay2 >= ny2) {
        ny2 = Math.min(ny2, ay)
      } // BOTTOM
    } else if (ay <= rect.y && ay2 >= ny2) {
      if (ax <= rect.x) {
        nx = Math.max(nx, ax2)
      } // LEFT
      else if (ax2 >= nx2) {
        nx2 = Math.min(nx2, ax)
      } // RIGHT
    } else if (ax <= rect.x) {
      nx = Math.max(nx, ax2)
    } else if (ay <= rect.y) {
      ny = Math.max(ny, ay2)
    } else if (ax2 >= nx2) {
      nx2 = Math.min(nx2, ax)
    } else if (ay2 >= ny2) {
      ny2 = Math.min(ny2, ay)
    }
  }
  return { x: nx, y: ny, width: nx2 - nx, height: ny2 - ny }
}
