// Шумоподавление TarnVeil для браузера: узел Web Audio, за которым стоит
// потоковая нейросеть на 48 кГц.
//
// Пакет ничего не знает о приложении: адрес модели, адрес рантайма onnxruntime и
// адрес модуля воркета передаются вызывающим. Регистрацию воркета тоже делает он —
// у каждого сборщика свой способ отдать URL модуля, и зашивать сюда чей-то один
// значило бы навязать пользователю Vite.
import { SMARTNET_RATE } from './dsp'

// Имя процессора, под которым воркет регистрируется в AudioWorkletGlobalScope.
// Совпадает со строкой в worklet.ts — их менять только вместе.
const NODE_NAME = 'tarnveil-smartnet'

export interface DenoiseOptions {
  /** Адрес файла .onnx. Модель лежит в релизе репозитория, в git её нет. */
  modelUrl: string
  /** Каталог с onnxruntime-web (ort-wasm-simd-threaded.wasm и .mjs). */
  ortBase: string
  /** URL модуля воркета, уже зарегистрированного в ctx.audioWorklet. */
  workletUrl: string
  /** URL модуля воркера (new Worker(url, { type: 'module' })). */
  workerUrl: string
}

// Воркет сообщает о готовности одним сообщением. Ждём именно его, а не таймер:
// addModule резолвится раньше, чем процессор создан.
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
let idleWorkerTimer: ReturnType<typeof setTimeout> | null = null

function dropIdleWorker(): void {
  if (idleWorkerTimer) clearTimeout(idleWorkerTimer)
  idleWorkerTimer = null
  idleWorker?.terminate()
  idleWorker = null
}

function parkWorker(worker: Worker): void {
  worker.onmessage = null
  if (idleWorker) {
    worker.terminate()
    return
  }
  idleWorker = worker
  idleWorkerTimer = setTimeout(dropIdleWorker, IDLE_WORKER_TTL_MS)
}

function takeIdleWorker(): Worker | null {
  const worker = idleWorker
  if (!worker) return null
  idleWorker = null
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

    worker = takeIdleWorker()
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
        disposed = true
        failureListeners.clear()
        node.port.onmessage = null
        node.disconnect()
        parkWorker(activeWorker)
      },
    }
  } catch {
    worker?.terminate()
    return null
  }
}
