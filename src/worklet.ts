/// <reference lib="webworker" />
// Realtime edge of SmartNet. It accumulates exact 10 ms model hops and sends
// them directly to the inference Worker. Model failures open passthrough at
// once; ordinary Worker scheduling jitter is absorbed by a small buffer.
import { JitterBuffer } from './dsp-core'
import { SMARTNET_HOP } from './dsp'

const NODE_NAME = 'tarnveil-smartnet'
const STARTUP_TIMEOUT_BLOCKS = 75
const STARTUP_BUFFER_BLOCKS = 2

type RuntimeFailureReason = 'overrun' | 'inference' | 'startup-timeout' | 'unknown'

declare function registerProcessor(name: string, ctor: unknown): void
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

class SmartNetProcessor extends AudioWorkletProcessor {
  private readonly pending = new Float32Array(SMARTNET_HOP)
  private pendingFill = 0
  private readonly jitter = new JitterBuffer(STARTUP_BUFFER_BLOCKS, 4)
  private audioPort: MessagePort | null = null
  private receivedProcessedAudio = false
  private receivedBlocks = 0
  private sentBlocks = 0
  private bypass = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; port?: MessagePort }
      if (data?.type === 'connect' && data.port) {
        this.audioPort?.close()
        this.audioPort = data.port
        this.audioPort.onmessage = (message) => this.handleWorkerMessage(message)
        this.audioPort.start()
        this.port.postMessage({ type: 'channel-ready' })
      } else if (data?.type === 'RESET') {
        this.reset()
        this.audioPort?.postMessage({ type: 'reset' })
      }
    }
    this.port.postMessage({ type: 'ready' })
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const data = event.data as { type?: string; samples?: Float32Array; reason?: RuntimeFailureReason }
    if (data?.type === 'block' && data.samples && !this.bypass) {
      this.jitter.push(data.samples)
      this.receivedBlocks++
      this.receivedProcessedAudio = this.receivedBlocks >= STARTUP_BUFFER_BLOCKS
    } else if (data?.type === 'runtime-failure') {
      this.failOpen(data.reason ?? 'unknown')
    }
  }

  private reset(): void {
    this.jitter.reset()
    this.pendingFill = 0
    this.receivedProcessedAudio = false
    this.receivedBlocks = 0
    this.sentBlocks = 0
    this.bypass = false
  }

  private failOpen(reason: RuntimeFailureReason): void {
    if (this.bypass) return
    this.bypass = true
    this.jitter.reset()
    this.port.postMessage({ type: 'runtime-failure', reason })
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (!output) return true
    if (!input) {
      output.fill(0)
      return true
    }
    if (!this.audioPort || this.bypass) {
      output.set(input)
      return true
    }

    for (let i = 0; i < input.length; i++) {
      this.pending[this.pendingFill++] = input[i]
      if (this.pendingFill === SMARTNET_HOP) {
        const block = new Float32Array(this.pending)
        this.audioPort.postMessage({ type: 'block', samples: block }, [block.buffer])
        this.pendingFill = 0
        this.sentBlocks++
      }
    }

    if (!this.receivedProcessedAudio) {
      output.set(input)
      if (this.sentBlocks >= STARTUP_TIMEOUT_BLOCKS) this.failOpen('startup-timeout')
      return true
    }
    if (!this.jitter.read(output)) {
      // A single late Worker delivery is not a model failure. JitterBuffer
      // increases its target automatically; keep the microphone live while it
      // refills instead of disabling SmartNet for the rest of the session.
      output.set(input)
    }
    return true
  }
}

registerProcessor(NODE_NAME, SmartNetProcessor)

export {}
