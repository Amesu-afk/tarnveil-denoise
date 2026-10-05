import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtime = join(root, 'node_modules/onnxruntime-web')
const version = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version
if (version !== '1.29.0') throw new Error(`Expected onnxruntime-web 1.29.0, got ${version}`)
await mkdir(join(root, 'dist/ort'), { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts', 'src/worker.ts', 'src/worklet.ts'],
  outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'linked',
})
for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await copyFile(join(runtime, 'dist', name), join(root, 'dist/ort', name))
}
await copyFile(join(root, 'third_party/onnxruntime-LICENSE.txt'), join(root, 'dist/ort/LICENSE.txt'))
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' })
console.log('Built ESM, Worker, AudioWorklet, declarations and matching ONNX Runtime assets.')
