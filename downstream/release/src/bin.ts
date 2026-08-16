/** Command-line entry for the DSH-GUI release-ledger gate. */

import { resolve } from 'node:path'
import { verifyDesktopRelease } from './verify.ts'

const root = resolve(import.meta.dirname, '../../..')
const unknown = process.argv.slice(2).filter(argument => argument !== '--signed')
if (unknown.length > 0) throw new Error(`desktop release verify: unknown argument ${unknown[0]}`)
const signed = process.argv.includes('--signed')
const state = verifyDesktopRelease(root, { requireSignedReady: signed })
const blockers = state.baseline.releaseReadiness.blockers.length
console.log(
  signed
    ? 'desktop release verify: signed-build records are ready'
    : `desktop release verify: 6 ledgers valid; stable release blocked by ${String(blockers)} external input(s)`,
)
