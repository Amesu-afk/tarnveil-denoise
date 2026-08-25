/// <reference lib="webworker" />
// SmartNet inference runs in a dedicated Worker because onnxruntime-web cannot
// execute inside AudioWorkletGlobalScope. Audio blocks travel directly between
// this worker and the worklet over MessageChannel; React and the main thread do
// not sit in the realtime path.
import * as ort from 'onnxruntime-web/wasm'
import {
  SMARTNET_BINS,
  SMARTNET_FINE_BINS,
  SMARTNET_HOP,
  SMARTNET_SUBFRAMES,
  SmartNetMultiresStft,
  SmartNetStft,
} from './dsp'
import { SmartNetMaskLookahead } from './mask-lookahead'

// The recurrent width is read from the model rather than written here: a larger
// checkpoint carries a wider state, and a hardcoded size would not fail, it
// would quietly feed the network a truncated state and return plausible noise.
const DEFAULT_HIDDEN_SIZE = 256
let hiddenSize = DEFAULT_HIDDEN_SIZE
let HIDDEN_DIMS = [1, 1, hiddenSize]
const PREVIOUS_DIMS = [1, SMARTNET_BINS]

let session: ort.InferenceSession | null = null
let hidden: Float32Array<ArrayBufferLike> = new Float32Array(hiddenSize)
let previousLogMagnitude: Float32Array<ArrayBufferLike> = new Float32Array(SMARTNET_BINS)
const spectrum = new Float32Array(SMARTNET_BINS * 2)
const framer = new SmartNetStft()

// The sub-frame model does not answer on the grid it looks at: it wants a second,
// SHORT spectrum as input and returns two short frames instead of one long one.
// The branch turns itself on from the presence of a `fine_spectrum` input in the
// graph itself, not from a file name or a sidecar: the graph is the only source
// that cannot drift away from the weights. An ordinary model creates none of this
// and takes the previous path.
const FINE_LENGTH = SMARTNET_SUBFRAMES * SMARTNET_FINE_BINS * 2
let multires: SmartNetMultiresStft | null = null
let lookahead: SmartNetMaskLookahead | null = null
let fineSpectrum: Float32Array = new Float32Array(0)
let fineOutput: Float32Array = new Float32Array(0)

function configureGrid(active: ort.InferenceSession): void {
  if (!active.inputNames.includes('fine_spectrum')) {
    multires = null
    lookahead = null
    return
  }
  multires = new SmartNetMultiresStft()
  lookahead = new SmartNetMaskLookahead()
  fineSpectrum = new Float32Array(FINE_LENGTH)
  fineOutput = new Float32Array(FINE_LENGTH)
}

let busy = false
let audioPort: MessagePort | null = null
let runtimeFailed = false

function resetState(): void {
  hidden = new Float32Array(hiddenSize)
  previousLogMagnitude = new Float32Array(SMARTNET_BINS)
  framer.reset()
  multires?.reset()
  lookahead?.reset()
}

function readHiddenSize(active: ort.InferenceSession): number {
  const index = active.inputNames.indexOf('hidden')
  const meta = index >= 0 ? active.inputMetadata?.[index] : undefined
  const shape = meta && 'shape' in meta ? meta.shape : undefined
  const last = shape?.[shape.length - 1]
  return typeof last === 'number' && last > 0 ? last : DEFAULT_HIDDEN_SIZE
}

function reportRuntimeFailure(reason: 'overrun' | 'inference'): void {
  if (runtimeFailed) return
  runtimeFailed = true
  audioPort?.postMessage({ type: 'runtime-failure', reason })
  self.postMessage({ type: 'runtime-failure', reason })
}

async function initialize(modelUrl: string, ortBase: string): Promise<void> {
  ort.env.wasm.wasmPaths = ortBase
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'error'
  session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  hiddenSize = readHiddenSize(session)
  HIDDEN_DIMS = [1, 1, hiddenSize]
  configureGrid(session)
  resetState()
}

async function processBlock(input: Float32Array): Promise<Float32Array | null> {
  const active = session
  if (!active || input.length !== SMARTNET_HOP) return null
  const grid = multires
  if (grid) grid.analyze(input, spectrum, fineSpectrum)
  else framer.analyze(input, spectrum)
  const feed: Record<string, ort.Tensor> = {
    spectrum: new ort.Tensor('float32', spectrum, [1, 1, SMARTNET_BINS, 2]),
    hidden: new ort.Tensor('float32', hidden, HIDDEN_DIMS),
    previous_log_magnitude: new ort.Tensor('float32', previousLogMagnitude, PREVIOUS_DIMS),
  }
  if (grid) {
    feed.fine_spectrum = new ort.Tensor(
      'float32', fineSpectrum, [1, 1, SMARTNET_SUBFRAMES, SMARTNET_FINE_BINS, 2])
  }
  const outputs = await active.run(feed)
  hidden = outputs.hidden_out.data as Float32Array<ArrayBufferLike>
  previousLogMagnitude = outputs.log_magnitude_out.data as Float32Array<ArrayBufferLike>
  const output = new Float32Array(SMARTNET_HOP)
  const enhanced = outputs.enhanced.data as Float32Array
  if (grid) {
    // Borrowing the mask from the right-hand neighbour costs one short frame of
    // delay (240 samples, 5 ms) and nothing else - see mask-lookahead.
    lookahead!.process(enhanced, fineSpectrum, fineOutput)
    grid.synthesize(fineOutput, output)
  } else {
    framer.synthesize(enhanced, output)
  }
  return output
}

async function handleAudioMessage(event: MessageEvent): Promise<void> {
  const data = event.data as { type?: string; samples?: Float32Array }
  if (data?.type === 'reset') {
    resetState()
    runtimeFailed = false
    return
  }
  if (data?.type !== 'block' || !data.samples || runtimeFailed) return
  if (busy) {
    reportRuntimeFailure('overrun')
    return
  }
  busy = true
  try {
    const output = await processBlock(data.samples)
    if (output) audioPort?.postMessage({ type: 'block', samples: output }, [output.buffer])
  } catch {
    reportRuntimeFailure('inference')
  } finally {
    busy = false
  }
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data as {
    type?: string
    modelUrl?: string
    ortBase?: string
    port?: MessagePort
  }
  if (data?.type === 'init') {
    try {
      await initialize(data.modelUrl ?? '', data.ortBase ?? '')
      self.postMessage({ type: 'ready' })
    } catch (error) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (data?.type === 'connect' && data.port) {
    audioPort?.close()
    audioPort = data.port
    audioPort.onmessage = (message) => { void handleAudioMessage(message) }
    audioPort.start()
    self.postMessage({ type: 'channel-ready' })
    return
  }
  if (data?.type === 'reset') {
    resetState()
    runtimeFailed = false
  }
}

export {}
