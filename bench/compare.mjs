// Self-contained benchmark: the TarnVeil model vs DeepFilterNet3 on the same
// clicks-over-speech / clicks-in-pauses task, on frozen fixtures anyone reproduces.
//
// The model runs through the package's own DSP (bench/model_run.ts -> src/); DFN3
// runs the exact wasm the app ships (bench/dfn3_process.mjs). Both are scored the
// same way: enhance the clean speech, enhance the speech with the click, subtract,
// and read the click residual left in each window. Median and worst-tenth per
// processor, split by whether the click landed in a pause or on top of speech.
//
//   node bench/compare.mjs
//
// Assets (model .onnx, DFN3 wasm + model) are fetched by bench/fetch-assets.mjs
// into bench/assets/, or pointed at with BENCH_MODEL / BENCH_DFN_WASM / BENCH_DFN_MODEL.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const BENCH = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(BENCH)
const FIX = join(BENCH, 'fixtures')
const assets = join(BENCH, 'assets')
const MODEL = process.env.BENCH_MODEL || join(assets, 'smartnet-v54-psa.onnx')
const DFN_WASM = process.env.BENCH_DFN_WASM || join(assets, 'df_bg.wasm')
const DFN_MODEL = process.env.BENCH_DFN_MODEL || join(assets, 'DeepFilterNet3_onnx.tar.gz')
const ATTEN = Number(process.env.BENCH_DFN_ATTEN || 95)

const meta = JSON.parse(readFileSync(join(FIX, 'fixtures.json'), 'utf8'))
const SR = meta.sample_rate

function readF32(path) {
  const b = readFileSync(path)
  const a = new Float32Array(b.byteLength / 4)
  Buffer.from(a.buffer).set(b)
  return a
}
function writeF32(path, a) {
  writeFileSync(path, Buffer.from(a.buffer, a.byteOffset, a.length * 4))
}
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12))
function peak(a, lo, hi) { let m = 0; for (let i = lo; i < hi; i++) { const v = Math.abs(a[i]); if (v > m) m = v } return m }
function rms(a, lo, hi) { let s = 0; for (let i = lo; i < hi; i++) s += a[i] * a[i]; return Math.sqrt(s / (hi - lo)) }
function quantile(vals, q) {
  const s = [...vals].sort((x, y) => x - y)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

// Coarse cross-correlation: the delay is a property of the processor, so a small
// lag search on the first second is enough. Peak lag lines the output up with input.
function measureDelay(ref, produced, maxLag = 1400, win = 24000) {
  const n = Math.min(win, ref.length, produced.length - maxLag)
  let best = 0, bestScore = -Infinity
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i < n; i += 2) s += ref[i] * produced[i + lag]
    if (s > bestScore) { bestScore = s; best = lag }
  }
  return best
}

const speech = readF32(join(FIX, 'speech.f32'))

function runModel(inPath, outPath) {
  execFileSync('node', ['--experimental-transform-types', join(BENCH, 'model_run.ts'),
    '--model', MODEL, '--in', inPath, '--out', outPath], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
  return readF32(outPath)
}
function runDfn(pairs) {
  const scratch = mkdtempSync(join(tmpdir(), 'dfnbench-'))
  const manifest = pairs.map((p, i) => ({ input: p.in, output: join(scratch, `${i}.out`) }))
  const listing = join(scratch, 'manifest.json')
  writeFileSync(listing, JSON.stringify(manifest))
  execFileSync('node', [join(BENCH, 'dfn3_process.mjs'), DFN_WASM, DFN_MODEL, listing, String(ATTEN)],
    { stdio: ['ignore', 'ignore', 'inherit'] })
  const out = manifest.map((m) => readF32(m.output))
  rmSync(scratch, { recursive: true, force: true })
  return out
}

// References (clean speech through each processor) are shared across sources.
const scratch = mkdtempSync(join(tmpdir(), 'bench-'))
const speechIn = join(scratch, 'speech.f32'); writeF32(speechIn, speech)
const modelRef = runModel(speechIn, join(scratch, 'speech.model.f32'))
const modelRefDelay = measureDelay(speech, modelRef)
const [dfnRef] = runDfn([{ in: speechIn }])
const dfnRefDelay = measureDelay(speech, dfnRef)

function voiceCost(ref, delay) {
  const usable = Math.min(speech.length - delay, ref.length - delay)
  let sRef = 0, sErr = 0, sSpe = 0
  for (let i = 0; i < usable; i++) {
    const a = ref[i + delay], s = speech[i]
    sRef += a * a; sSpe += s * s; sErr += (a - s) * (a - s)
  }
  return { gain_db: +(db(Math.sqrt(sRef / usable)) - db(Math.sqrt(sSpe / usable))).toFixed(2),
           error_db: +(db(Math.sqrt(sErr / usable)) - db(Math.sqrt(sSpe / usable))).toFixed(2) }
}

const results = []
for (const [name, info] of Object.entries(meta.sources)) {
  const mixed = readF32(join(FIX, `mixed-${name}.f32`))
  const mixedIn = join(scratch, `mixed-${name}.f32`); writeF32(mixedIn, mixed)
  const modelAfter = runModel(mixedIn, join(scratch, `mixed-${name}.model.f32`))
  const [dfnAfter] = runDfn([{ in: mixedIn }])

  const row = { source: name, clicks: info.clicks }
  for (const [label, ref, after, delay] of [
    ['model', modelRef, modelAfter, modelRefDelay],
    ['dfn3', dfnRef, dfnAfter, dfnRefDelay],
  ]) {
    const usable = Math.min(speech.length, after.length - delay, ref.length - delay)
    const drops = { pause: [], speech: [] }
    for (const onset of info.onsets) {
      const lo = Math.max(0, onset - 240), hi = Math.min(usable, onset + 4560)
      if (hi - lo < 960) continue
      let was = 0, now = 0
      for (let i = lo; i < hi; i++) {
        const b = Math.abs(mixed[i] - speech[i]); if (b > was) was = b
        const a = Math.abs(after[i + delay] - ref[i + delay]); if (a > now) now = a
      }
      const loud = rms(speech, lo, hi) > Math.pow(10, -50 / 20)
      drops[loud ? 'speech' : 'pause'].push(db(was) - db(now))
    }
    row[label] = {
      pause_median: +quantile(drops.pause, 0.5).toFixed(1),
      pause_worst10: +quantile(drops.pause, 0.1).toFixed(1),
      speech_median: +quantile(drops.speech, 0.5).toFixed(1),
      speech_worst10: +quantile(drops.speech, 0.1).toFixed(1),
    }
  }
  results.push(row)
  console.log(`${name}: done`)
}

rmSync(scratch, { recursive: true, force: true })

const artifact = {
  methodology: 'Residual model(speech+clicks)-model(speech), peak per click window; median and worst-tenth over clicks; pause/speech split by speech RMS in window (-50 dBFS). Same speech, placement and seed for both processors. The model is measured alone (the package is the model); the app adds a click suppressor in front.',
  model: MODEL.split(/[\\/]/).pop(),
  deepfilternet3: `vendored app wasm, attenuation=${ATTEN}`,
  speech_credit: meta.speech_credit,
  seed: meta.seed,
  voice_cost: { model: voiceCost(modelRef, modelRefDelay), dfn3: voiceCost(dfnRef, dfnRefDelay) },
  sources: results,
}
writeFileSync(join(BENCH, 'results.json'), JSON.stringify(artifact, null, 2) + '\n')

console.log(`\nmodel delay ${modelRefDelay} samp, dfn3 delay ${dfnRefDelay} samp`)
const H = 'source        clicks   model(pause/speech med·w10)   dfn3(pause/speech med·w10)'
console.log('\n' + H); console.log('-'.repeat(H.length))
for (const r of results) {
  const m = r.model, d = r.dfn3
  console.log(`${r.source.padEnd(13)}${String(r.clicks).padStart(6)}   `
    + `${String(m.pause_median).padStart(5)}/${String(m.pause_worst10).padStart(5)}  `
    + `${String(m.speech_median).padStart(5)}/${String(m.speech_worst10).padStart(5)}   `
    + `${String(d.pause_median).padStart(5)}/${String(d.pause_worst10).padStart(5)}  `
    + `${String(d.speech_median).padStart(5)}/${String(d.speech_worst10).padStart(5)}`)
}
console.log(`\nvoice cost (gain/error dB): model ${JSON.stringify(artifact.voice_cost.model)}  dfn3 ${JSON.stringify(artifact.voice_cost.dfn3)}`)
console.log(`\nartifact: bench/results.json`)
