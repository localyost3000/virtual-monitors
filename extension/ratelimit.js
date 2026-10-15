// Pure rate limiter: >4 hits within 2s blocks `key` in `blockSet`
// (sticky until caller clears). logMap: key -> {scope: [timestamps]}.
// No GNOME imports: unit-testable under gjs/node.
// Returns {blocked, overLimit}: overLimit = this hit crossed the limit
// (caller logs); blocked = currently blocked.
export function rateLimit(logMap, blockSet, key, scope, now) {
  const logs = logMap.get(key) ?? {}
  const rec = (logs[scope] ?? []).filter((t) => now - t < 2000)
  rec.push(now)
  logs[scope] = rec
  logMap.set(key, logs)
  const overLimit = rec.length > 4
  if (overLimit) {
    blockSet.add(key)
  }
  return { blocked: blockSet.has(key), overLimit }
}
