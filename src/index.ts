// TarnVeil noise suppression for the browser: a Web Audio node backed by a
// streaming 48 kHz neural network.
//
// The package knows nothing about the host application: the model URL, the
// onnxruntime base and the worklet module URL are all supplied by the caller,
// and this function registers the worklet. Every bundler has its own way of
// handing out a module URL, so hardcoding one here would force that bundler —
// Vite — on everyone.
import { SMARTNET_RATE } from './dsp'

// Processor name the worklet registers under in AudioWorkletGlobalScope.
// It matches the string in worklet.ts; the two only ever change together.
const NODE_NAME = 'tarnveil-smartnet'

export interface DenoiseOptions {
  /** URL of the .onnx file. The model ships in a repository release, not in git. */
  modelUrl: string
  /** Directory holding onnxruntime-web (ort-wasm-simd-threaded.wasm and .mjs). */
  ortBase: string
  /** URL of the worklet module; createDenoiseNode registers it. */
  workletUrl: string
  /** URL of the worker module (new Worker(url, { type: 'module' })). */
  workerUrl: string
}

// The worklet announces readiness with a single message. Wait for that message
// rather than a timer: addModule resolves before the processor is constructed.
function waitForWorkletReady(node: AudioWorkletNode, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    node.port.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'ready') {
        clearTimeout(timer)
        node.port.onmessage = null
        resolve(true)
      }
    }
    node.port.start?.()
  })
}

const READY_TIMEOUT_MS = 20_000
const CHANNEL_TIMEOUT_MS = 5_000
const IDLE_WORKER_TTL_MS = 60_000
const registered = new WeakSet<BaseAudioContext>()

let idleWorker: Worker | null = null
let idleWorkerKey: string | null = null
let idleWorkerTimer: ReturnType<typeof setTimeout> | null = null

function dropIdleWorker(): void {
  if (idleWorkerTimer) clearTimeout(idleWorkerTimer)
  idleWorkerTimer = null
  idleWorker?.terminate()
  idleWorker = null
  idleWorkerKey = null
}

function parkWorker(worker: Worker, key: string): void {
  worker.onmessage = null
  if (idleWorker) {
    worker.terminate()
    return
  }
  idleWorker = worker
  idleWorkerKey = key
  idleWorkerTimer = setTimeout(dropIdleWorker, IDLE_WORKER_TTL_MS)
}

function takeIdleWorker(key: string): Worker | null {
  if (idleWorkerKey !== key) dropIdleWorker()
  const worker = idleWorker
  if (!worker) return null
  idleWorker = null
  idleWorkerKey = null
  if (idleWorkerTimer) clearTimeout(idleWorkerTimer)
  idleWorkerTimer = null
  worker.postMessage({ type: 'reset' })
  return worker
}

export interface DenoiseNode {
  node: AudioWorkletNode
  onFailure(listener: (reason: DenoiseFailureReason) => void): () => void
  dispose(): void
}

export type DenoiseFailureReason =
  | 'overrun'
  | 'inference'
  | 'startup-timeout'
  | 'unknown'

function runtimeFailureReason(value: unknown): DenoiseFailureReason {
  return value === 'overrun' || value === 'inference' || value === 'startup-timeout'
    ? value
    : 'unknown'
}

export async function createDenoiseNode(
  ctx: BaseAudioContext,
  options: DenoiseOptions,
): Promise<DenoiseNode | null> {
  if (ctx.sampleRate !== SMARTNET_RATE || typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet) {
    return null
  }
  let worker: Worker | null = null
  const workerKey = JSON.stringify([options.workerUrl, options.modelUrl, options.ortBase])
  try {
    if (!registered.has(ctx)) {
      await ctx.audioWorklet.addModule(options.workletUrl)
      registered.add(ctx)
    }
    const node = new AudioWorkletNode(ctx, NODE_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    if (!await waitForWorkletReady(node)) {
      node.disconnect()
      return null
    }

    worker = takeIdleWorker(workerKey)
    if (!worker) {
      worker = new Worker(options.workerUrl, { type: 'module' })
      const modelReady = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS)
        worker!.onmessage = (event: MessageEvent) => {
          const data = event.data as { type?: string }
          if (data?.type === 'ready') {
            clearTimeout(timer)
            resolve(true)
          } else if (data?.type === 'error') {
            clearTimeout(timer)
            resolve(false)
          }
        }
      })
      worker.postMessage({ type: 'init', modelUrl: options.modelUrl, ortBase: options.ortBase })
      if (!await modelReady) {
        worker.terminate()
        node.disconnect()
        return null
      }
    }

    const activeWorker = worker
    const failureListeners = new Set<(reason: DenoiseFailureReason) => void>()
    let runtimeFailed = false
    let failureReason: DenoiseFailureReason = 'unknown'
    let disposed = false
    const notifyFailure = (reason: unknown) => {
      if (runtimeFailed || disposed) return
      runtimeFailed = true
      failureReason = runtimeFailureReason(reason)
      for (const listener of failureListeners) listener(failureReason)
    }

    const channel = new MessageChannel()
    let workletConnected = false
    let workerConnected = false
    let finishChannel: ((ready: boolean) => void) | null = null
    const channelReady = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        finishChannel = null
        resolve(false)
      }, CHANNEL_TIMEOUT_MS)
      finishChannel = (ready) => {
        clearTimeout(timer)
        finishChannel = null
        resolve(ready)
      }
    })
    const confirmChannel = () => {
      if (workletConnected && workerConnected) finishChannel?.(true)
    }
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; reason?: unknown }
      if (data?.type === 'channel-ready') {
        workletConnected = true
        confirmChannel()
      } else if (data?.type === 'runtime-failure') notifyFailure(data.reason)
    }
    activeWorker.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; reason?: unknown }
      if (data?.type === 'channel-ready') {
        workerConnected = true
        confirmChannel()
      } else if (data?.type === 'runtime-failure') notifyFailure(data.reason)
    }
    activeWorker.postMessage({ type: 'connect', port: channel.port1 }, [channel.port1])
    node.port.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2])
    if (!await channelReady) {
      node.port.onmessage = null
      activeWorker.onmessage = null
      activeWorker.terminate()
      node.disconnect()
      return null
    }

    return {
      node,
      onFailure(listener) {
        failureListeners.add(listener)
        if (runtimeFailed) queueMicrotask(() => listener(failureReason))
        return () => failureListeners.delete(listener)
      },
      dispose() {
        if (disposed) return
        disposed = true
        failureListeners.clear()
        node.port.onmessage = null
        node.disconnect()
        if (runtimeFailed) activeWorker.terminate()
        else parkWorker(activeWorker, workerKey)
      },
    }
  } catch {
    worker?.terminate()
    return null
  }
}
