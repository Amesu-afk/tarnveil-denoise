import { createDenoiseNode, type DenoiseNode } from 'tarnveil-denoise'

const startButton = document.querySelector<HTMLButtonElement>('#start')!
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!
const fileInput = document.querySelector<HTMLInputElement>('#file')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
const result = document.querySelector<HTMLElement>('#result')!
const player = document.querySelector<HTMLAudioElement>('#audio')!
const download = document.querySelector<HTMLAnchorElement>('#download')!
let context: AudioContext | null = null
let stream: MediaStream | null = null
let denoise: DenoiseNode | null = null
let source: AudioNode | null = null
let recorder: MediaRecorder | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let resultUrl: string | null = null
let failures: string[] = []
let stopping = false
let busy = false

function controls(active: boolean) {
  busy = active
  startButton.disabled = active
  fileInput.disabled = active
  stopButton.disabled = !active || !recorder
}
async function cleanup() {
  if (timer) clearTimeout(timer)
  timer = null
  source?.disconnect()
  source = null
  denoise?.dispose()
  denoise = null
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  if (context && context.state !== 'closed') await context.close()
  context = null
}
async function stop() {
  if (stopping) return
  stopping = true
  if (recorder?.state === 'recording') {
    const active = recorder
    await new Promise<void>(resolve => {
      active.addEventListener('stop', () => resolve(), { once: true })
      active.stop()
    })
  }
  recorder = null
  await cleanup()
  controls(false)
  stopping = false
}
async function prepare() {
  failures = []
  status.textContent = 'Loading model and runtime…'
  context = new AudioContext({ sampleRate: 48000 })
  await context.resume()
  denoise = await createDenoiseNode(context, {
    modelUrl: '/denoise/smartnet-v54-psa.onnx',
    ortBase: new URL('/denoise/ort/', location.href).href,
    workerUrl: '/denoise/worker.js',
    workletUrl: '/denoise/worklet.js',
  })
  if (!denoise) throw new Error('Denoiser did not start. Check browser support and public/denoise assets.')
  denoise.onFailure(reason => {
    failures.push(reason)
    status.textContent = `Denoiser failed (${reason}); stopping. Try a faster browser/device.`
    void stop()
  })
  return context
}
function record(input: AudioNode, ctx: AudioContext) {
  source = input
  const destination = ctx.createMediaStreamDestination()
  input.connect(denoise!.node)
  denoise!.node.connect(destination)
  const chunks: Blob[] = []
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find(type => MediaRecorder.isTypeSupported(type))
  recorder = new MediaRecorder(destination.stream, mime ? { mimeType: mime } : undefined)
  const active = recorder
  active.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
  active.onstop = () => {
    if (failures.length) { result.hidden = true; return }
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    resultUrl = URL.createObjectURL(new Blob(chunks, { type: active.mimeType }))
    player.src = resultUrl
    download.href = resultUrl
    download.download = `tarnveil-denoise.${active.mimeType.includes('mp4') ? 'm4a' : active.mimeType.includes('ogg') ? 'ogg' : 'webm'}`
    result.hidden = false
    status.textContent = 'Finished. Processed at 48000 Hz; no runtime failure reported. Listen below.'
  }
  active.start()
  controls(true)
}
async function attempt(action: () => Promise<void>) {
  if (busy) return
  controls(true)
  result.hidden = true
  try { await action() } catch (error) {
    await stop()
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}
startButton.addEventListener('click', () => void attempt(async () => {
  const ctx = await prepare()
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
  })
  record(ctx.createMediaStreamSource(stream), ctx)
  status.textContent = 'Recording with smartnet-v54-psa. Stop when done (60-second maximum).'
  timer = setTimeout(() => void stop(), 60000)
}))
stopButton.addEventListener('click', () => void stop())
fileInput.addEventListener('change', () => void attempt(async () => {
  const file = fileInput.files?.[0]
  if (!file) { controls(false); return }
  if (file.size > 32 * 1024 * 1024) throw new Error('Choose an audio file smaller than 32 MiB.')
  const ctx = await prepare()
  const audio = await ctx.decodeAudioData(await file.arrayBuffer())
  if (audio.duration > 60) throw new Error('Choose a recording no longer than 60 seconds.')
  const input = ctx.createBufferSource()
  input.buffer = audio
  record(input, ctx)
  status.textContent = `Processing ${audio.duration.toFixed(1)} seconds with smartnet-v54-psa…`
  input.onended = () => { timer = setTimeout(() => void stop(), 200) }
  input.start()
  fileInput.value = ''
}))
window.addEventListener('pagehide', () => {
  stream?.getTracks().forEach(track => track.stop())
  denoise?.dispose()
  void context?.close()
  if (resultUrl) URL.revokeObjectURL(resultUrl)
})
