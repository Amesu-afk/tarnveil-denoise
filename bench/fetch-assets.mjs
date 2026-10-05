// Downloads the assets the benchmark needs into bench/assets/ (git-ignored):
//   - the model weights, from the repository release the package documents;
//   - the DeepFilterNet3 wasm + model, from the same public CDN the app uses.
// None of these are committed: the model is ~33 MB and the DFN3 bundle ~24 MB, and
// both carry their own upstream licence (DeepFilterNet is MIT/Apache-2.0).
//
//   node bench/fetch-assets.mjs
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getModel, MODEL } from '../scripts/model.mjs'

const BENCH = dirname(fileURLToPath(import.meta.url))
const assets = join(BENCH, 'assets')

// The model that ships in release v0.3.0 (sha256 in the release's SHA256SUMS.txt).
const MODEL_URL =
  'https://github.com/Amesu-afk/tarnveil-denoise/releases/download/v0.3.0/smartnet-v54-psa.onnx'
// DeepFilterNet3, same source the app's fetch-dfn3-assets.mjs uses. MIT/Apache-2.0.
const DFN = 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3'

const FILES = [
  { url: MODEL_URL, path: 'smartnet-v54-psa.onnx' },
  { url: `${DFN}/v3/pkg/df_bg.wasm`, path: 'df_bg.wasm' },
  { url: `${DFN}/v3/models/DeepFilterNet3_onnx.tar.gz`, path: 'DeepFilterNet3_onnx.tar.gz' },
]

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

await mkdir(assets, { recursive: true })
for (const { url, path } of FILES) {
  const dest = join(assets, path)
  if (path === MODEL.name) {
    await getModel(dest)
    console.log(`= ${path} (SHA-256 verified)`)
    continue
  }
  try {
    const existing = await stat(dest)
    console.log(`= ${path} (${mb(existing.size)}, already present)`)
    continue
  } catch { /* not there yet */ }
  process.stdout.write(`+ ${path} … `)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} from ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(dest, bytes)
  console.log(mb(bytes.length))
}
console.log(`\nAssets in ${assets}. Now: node bench/compare.mjs`)
