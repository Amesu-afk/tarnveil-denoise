import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run through npm run check:package')
function run(args, cwd = root) {
  return execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8' })
}
const [packed] = JSON.parse(run(['pack', '--ignore-scripts', '--json']))
const names = new Set(packed.files.map(file => file.path))
for (const name of ['dist/index.js', 'dist/index.d.ts', 'dist/worker.js', 'dist/worklet.js',
  'dist/ort/ort-wasm-simd-threaded.wasm', 'dist/ort/ort-wasm-simd-threaded.mjs', 'scripts/copy-assets.mjs']) {
  assert(names.has(name), `Missing packaged asset: ${name}`)
}
assert(![...names].some(name => name.endsWith('.onnx') || name.startsWith('node_modules/') || name.includes('.env')))
const consumer = mkdtempSync(join(root, '.package-check-'))
assert(!relative(root, resolve(consumer)).startsWith('..'))
cpSync(join(root, 'examples/vite-recorder'), consumer, {
  recursive: true,
  filter: path => !/(?:^|[\\/])(?:node_modules|dist|public)(?:[\\/]|$)/.test(path),
})
const manifest = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'))
manifest.dependencies['tarnveil-denoise'] = `file:${join(root, packed.filename).replaceAll('\\', '/')}`
writeFileSync(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(run(['install', '--no-audit', '--no-fund'], consumer))
console.log(run(['run', 'build'], consumer))
console.log(JSON.stringify({ tarball: packed.filename, bytes: packed.size, unpacked: packed.unpackedSize, consumer }, null, 2))
// Keep the isolated consumer for browser inspection; it is ignored by Git.
