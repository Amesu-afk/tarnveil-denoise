import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const npm = process.env.npm_execpath
const tarball = process.argv[2] && resolve(process.argv[2])
const localModel = process.argv[3] && resolve(process.argv[3])
if (!npm || !tarball) throw new Error('Usage: npm run check:node -- <package.tgz> [verified-model.onnx]')
const scratch = process.env.DENOISE_CHECK_DIR || tmpdir()
mkdirSync(scratch, { recursive: true })
const consumer = mkdtempSync(join(scratch, 'denoise-node-'))
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
function run(args) {
  return execFileSync(process.execPath, [npm, ...args], { cwd: consumer, encoding: 'utf8' })
}
console.log(run(['install', '--engine-strict', '--no-audit', '--no-fund', tarball]))
execFileSync(process.execPath, ['--input-type=module', '-e',
  "import { strict as assert } from 'node:assert'; import { createDenoiseNode } from 'tarnveil-denoise'; assert.equal(typeof createDenoiseNode, 'function')"], { cwd: consumer })
console.log(run(['exec', '--', 'tarnveil-denoise-assets', 'assets', ...(localModel ? ['--model', localModel] : [])]))
const installed = join(consumer, 'node_modules/tarnveil-denoise')
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
for (const name of ['worker.js', 'worker.js.LEGAL.txt', 'worklet.js',
  'ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.mjs', 'ort/LICENSE.txt']) {
  assert.equal(hash(join(consumer, 'assets', name)), hash(join(installed, 'dist', name)), `Copied asset differs: ${name}`)
}
assert.equal(hash(join(consumer, 'assets/smartnet-v54-psa.onnx')),
  '37009b8639e3e1eb65d065b4b93e4053bf59485e8baed4e5afe50b4b8cdff5ce')
console.log(`Node ${process.versions.node}: strict installation, ESM import and verified assets passed. Consumer: ${consumer}`)
