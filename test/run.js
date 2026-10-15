// Run every unit-test file in one process (node + gjs both fine).
// A file exiting nonzero stops the run, so failures fail fast.
import './geometry.test.js'
import './layout.test.js'
import './monitors.test.js'
import './ratelimit.test.js'
