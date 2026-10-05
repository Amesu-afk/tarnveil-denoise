import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createDenoiseNode } from '../dist/index.js'

// Model inference is tested by the benchmark/browser. These fakes exercise the
// public startup/lifecycle contract without audio hardware or network access.
const nativeTimeout = globalThis.setTimeout
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = nativeTimeout(callback, delay, ...args)
  if (delay === 60000) timer.unref()
  return timer
}
class Port {
  onmessage = null
  start() {}
  postMessage(message) {
    if (message.type === 'connect') queueMicrotask(() => this.onmessage?.({ data: { type: 'channel-ready' } }))
  }
}
class Node {
  port = new Port()
  disconnected = false
  constructor() { queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready' } })) }
  disconnect() { this.disconnected = true }
}
class Worker {
  static instances = []
  onmessage = null
  terminated = false
  messages = []
  constructor(url) { this.url = url; Worker.instances.push(this) }
  terminate() { this.terminated = true }
  postMessage(message) {
    this.messages.push(message)
    const type = message.type === 'init' ? 'ready' : message.type === 'connect' ? 'channel-ready' : null
    if (type) queueMicrotask(() => this.onmessage?.({ data: { type } }))
  }
}
globalThis.AudioWorkletNode = Node
globalThis.Worker = Worker
globalThis.MessageChannel = class { port1 = new Port(); port2 = new Port() }
const ctx = { sampleRate: 48000, audioWorklet: { async addModule() {} } }
const options = { modelUrl: '/model-a.onnx', ortBase: '/ort-a/', workletUrl: '/worklet.js', workerUrl: '/worker-a.js' }

test('unsupported sample rate returns null before creating a worker', async () => {
  const before = Worker.instances.length
  assert.equal(await createDenoiseNode({ ...ctx, sampleRate: 44100 }, options), null)
  assert.equal(Worker.instances.length, before)
})
test('same configuration reuses a healthy worker, and repeated dispose is harmless', async () => {
  const first = await createDenoiseNode(ctx, options)
  assert(first)
  const worker = Worker.instances.at(-1)
  first.dispose()
  first.dispose()
  assert.equal(worker.terminated, false)
  const count = Worker.instances.length
  const second = await createDenoiseNode(ctx, options)
  assert(second)
  assert.equal(Worker.instances.length, count)
  assert(worker.messages.some(message => message.type === 'reset'))
  second.dispose()
})
for (const field of ['modelUrl', 'ortBase', 'workerUrl']) {
  test(`changing ${field} discards the cached worker`, async () => {
    const first = await createDenoiseNode(ctx, options)
    const worker = Worker.instances.at(-1)
    first.dispose()
    const count = Worker.instances.length
    const second = await createDenoiseNode(ctx, { ...options, [field]: `${options[field]}-different` })
    assert(second)
    assert.equal(worker.terminated, true)
    assert.equal(Worker.instances.length, count + 1)
    second.dispose()
  })
}
test('a failed worker is terminated rather than cached', async () => {
  const first = await createDenoiseNode(ctx, options)
  const worker = Worker.instances.at(-1)
  let reason
  first.onFailure(value => { reason = value })
  worker.onmessage({ data: { type: 'runtime-failure', reason: 'inference' } })
  assert.equal(reason, 'inference')
  first.dispose()
  assert.equal(worker.terminated, true)
  const count = Worker.instances.length
  const second = await createDenoiseNode(ctx, options)
  assert(second)
  assert.equal(Worker.instances.length, count + 1)
  second.dispose()
})
