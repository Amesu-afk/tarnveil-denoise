/// <reference lib="webworker" />
// SmartNet inference runs in a dedicated Worker because onnxruntime-web cannot
// execute inside AudioWorkletGlobalScope. Audio blocks travel directly between
// this worker and the worklet over MessageChannel; React and the main thread do
// not sit in the realtime path.
import * as ort from 'onnxruntime-web/wasm'
import {
  SMARTNET_BINS,
  SMARTNET_HOP,
  SmartNetStft,
} from './dsp'

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

let busy = false
let audioPort: MessagePort | null = null
let runtimeFailed = false

function resetState(): void {
  hidden = new Float32Array(hiddenSize)
  previousLogMagnitude = new Float32Array(SMARTNET_BINS)
  framer.reset()
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
  resetState()
}

async function processBlock(input: Float32Array): Promise<Float32Array | null> {
  const active = session
  if (!active || input.length !== SMARTNET_HOP) return null
  framer.analyze(input, spectrum)
  const outputs = await active.run({
    spectrum: new ort.Tensor('float32', spectrum, [1, 1, SMARTNET_BINS, 2]),
    hidden: new ort.Tensor('float32', hidden, HIDDEN_DIMS),
    previous_log_magnitude: new ort.Tensor('float32', previousLogMagnitude, PREVIOUS_DIMS),
  })
  hidden = outputs.hidden_out.data as Float32Array<ArrayBufferLike>
  previousLogMagnitude = outputs.log_magnitude_out.data as Float32Array<ArrayBufferLike>
  const output = new Float32Array(SMARTNET_HOP)
  framer.synthesize(outputs.enhanced.data as Float32Array, output)
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
