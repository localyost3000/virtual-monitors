import { rateLimit } from '../extension/ratelimit.js'

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`)
    failures++
  }
}

// --- rateLimit: >4 hits in 2s blocks, sticky ---
const logMap = new Map()
const maxSet = new Set()
const hit = (t) => rateLimit(logMap, maxSet, 'w', 'max', t)

let res = hit(0)
assert(!res.blocked && !res.overLimit, 'hit 1: not blocked')
res = hit(100)
assert(!res.blocked && !res.overLimit, 'hit 2: not blocked')
res = hit(200)
assert(!res.blocked && !res.overLimit, 'hit 3: not blocked')
res = hit(300)
assert(!res.blocked && !res.overLimit, 'hit 4: not blocked')
res = hit(400)
assert(res.blocked && res.overLimit, 'hit 5 in 2s: blocked')

// sticky: window prunes, block persists
res = hit(10000)
assert(res.blocked && !res.overLimit, 'block sticky after window prunes')

// window expiry: hits >2s apart never block
const log2 = new Map()
const set2 = new Set()
const hit2 = (t) => rateLimit(log2, set2, 'w2', 'max', t)
assert(
  !hit2(0).blocked && !hit2(1000).blocked && !hit2(2000).blocked && !hit2(3000).blocked,
  'hits >2s apart: never blocked',
)

// boundary: hit exactly 2s old is pruned
const log3 = new Map()
const set3 = new Set()
const hit3 = (t) => rateLimit(log3, set3, 'w3', 'max', t)
for (const t of [0, 500, 1000, 1500]) {
  hit3(t)
}
assert(!hit3(2000).blocked, 'hit exactly 2s old is pruned (4 live)')
assert(hit3(2001).blocked, '5th live hit blocks')

// scope isolation: max block does not block fs (caller passes separate sets)
const log4 = new Map()
const maxSet4 = new Set()
const fsSet4 = new Set()
for (let i = 0; i < 5; i++) {
  rateLimit(log4, maxSet4, 'w4', 'max', i * 100)
}
res = rateLimit(log4, fsSet4, 'w4', 'fs', 500)
assert(!res.blocked, 'scopes isolated: max block does not block fs')
assert(log4.get('w4').max.length === 5 && log4.get('w4').fs.length === 1, 'log per scope')

if (failures) {
  console.error(`${failures} failures`)
  if (globalThis.process?.exit) process.exit(1)
  imports.system.exit(1)
}
console.log('ratelimit tests OK')
