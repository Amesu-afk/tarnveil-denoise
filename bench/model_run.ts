// Headless runner for the TarnVeil model, reusing the package's own DSP so the
// benchmark measures the exact code that ships in the browser — only the runtime
// (onnxruntime-node instead of onnxruntime-web) and the audio source differ. This
// mirrors worker.ts::processBlock frame for frame.
//
//   node --experimental-transform-types bench/model_run.ts --model m.onnx --in a.f32 --out b.f32
//
// I/O is raw little-endian float32, mono @48 kHz.
import { readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import * as ort from 'onnxruntime-node'

// The package's src uses extensionless relative imports (a bundler convention).
// Node's native TS resolver needs the .ts extension, so add it for relative
// specifiers — this lets the benchmark import the shipped DSP untouched.
registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(specifier + '.ts', context) } catch { /* fall through */ }
    }
    return nextResolve(specifier, context)
  },
})

const {
  SMARTNET_BINS,
  SMARTNET_FINE_BINS,
  SMARTNET_HOP,
  SMARTNET_SUBFRAMES,
  SmartNetMultiresStft,
  SmartNetStft,
} = await import('../src/dsp.ts')
const { SmartNetMaskLookahead } = await import('../src/mask-lookahead.ts')

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : (def as string)
}

const MODEL = arg('model')
const IN = arg('in')
const OUT = arg('out')

const session = await ort.InferenceSession.create(MODEL, {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
})

// Recurrent width from the graph, as worker.ts does.
const hiddenIdx = session.inputNames.indexOf('hidden')
const hiddenMeta = hiddenIdx >= 0 ? (session.inputMetadata as any)?.[hiddenIdx] : undefined
const hiddenShape = hiddenMeta && 'shape' in hiddenMeta ? hiddenMeta.shape : undefined
const last = hiddenShape?.[hiddenShape.length - 1]
const hiddenSize = typeof last === 'number' && last > 0 ? last : 256

const subframe = session.inputNames.includes('fine_spectrum')
const framer = new SmartNetStft()
const multires = subframe ? new SmartNetMultiresStft() : null
const lookahead = subframe ? new SmartNetMaskLookahead() : null
const spectrum = new Float32Array(SMARTNET_BINS * 2)
const FINE_LENGTH = SMARTNET_SUBFRAMES * SMARTNET_FINE_BINS * 2
let fineSpectrum = new Float32Array(subframe ? FINE_LENGTH : 0)
const fineOutput = new Float32Array(subframe ? FINE_LENGTH : 0)
let hidden = new Float32Array(hiddenSize)
let previous = new Float32Array(SMARTNET_BINS)

async function processBlock(input: Float32Array): Promise<Float32Array> {
  if (multires) multires.analyze(input, spectrum, fineSpectrum)
  else framer.analyze(input, spectrum)
  const feed: Record<string, ort.Tensor> = {
    spectrum: new ort.Tensor('float32', spectrum, [1, 1, SMARTNET_BINS, 2]),
    hidden: new ort.Tensor('float32', hidden, [1, 1, hiddenSize]),
    previous_log_magnitude: new ort.Tensor('float32', previous, [1, SMARTNET_BINS]),
  }
  if (multires) {
    feed.fine_spectrum = new ort.Tensor(
      'float32', fineSpectrum, [1, 1, SMARTNET_SUBFRAMES, SMARTNET_FINE_BINS, 2])
  }
  const out = await session.run(feed)
  hidden = out.hidden_out.data as Float32Array
  previous = out.log_magnitude_out.data as Float32Array
  const output = new Float32Array(SMARTNET_HOP)
  const enhanced = out.enhanced.data as Float32Array
  if (multires) {
    lookahead!.process(enhanced, fineSpectrum, fineOutput)
    multires.synthesize(fineOutput, output)
  } else {
    framer.synthesize(enhanced, output)
  }
  return output
}

const inBuf = readFileSync(IN)
const input = new Float32Array(inBuf.buffer, inBuf.byteOffset, Math.floor(inBuf.byteLength / 4))
const frames = Math.ceil(input.length / SMARTNET_HOP)
const out = new Float32Array(frames * SMARTNET_HOP)
const block = new Float32Array(SMARTNET_HOP)
for (let f = 0; f < frames; f++) {
  const base = f * SMARTNET_HOP
  for (let i = 0; i < SMARTNET_HOP; i++) {
    const j = base + i
    block[i] = j < input.length ? input[j] : 0
  }
  const produced = await processBlock(block)
  out.set(produced, base)
}
writeFileSync(OUT, Buffer.from(out.buffer, 0, out.length * 4))
process.stderr.write(`model: subframe=${subframe} hidden=${hiddenSize} in=${input.length} out=${out.length}\n`)
