# TarnVeil Denoise

English · [Русский](https://github.com/Amesu-afk/tarnveil-denoise/blob/main/docs/README.ru.md)

Microphone noise suppression for browser apps. Audio is processed on the device in a Worker. The output is a Web Audio node you can connect to a call or a recorder.

Built for voice calls in TarnVeil. The processing code and model weights are open so other apps can use them. The package does not upload audio.

[Try TarnVeil](https://tarnveil.ru/) · [Listen before and after](https://tarnveil.ru/en/remove-keyboard-noise.html)

The demo mixes separately recorded speech and keyboard clicks. It uses `smartnet-v54-psa` without an extra click suppressor. The original recording and clean speech are included for comparison.

## Try it

The Vite example needs Node **22.12 or newer**; the benchmark needs Node **24 or newer**. The browser needs AudioWorklet, WebAssembly SIMD and HTTPS or localhost.

```sh
git clone https://github.com/Amesu-afk/tarnveil-denoise.git
cd tarnveil-denoise
npm ci
cd examples/vite-recorder
npm install
npm run assets
npm run dev
```

Open the printed localhost URL. Record a microphone or process a WAV file, then listen to the result. No account is required. Use headphones. The example stores recordings in local Blobs and releases microphone tracks when stopped.

## Install in your application

Installing the compiled package and running the asset command requires Node **18 or newer**. Audio processing runs in the browser:

```sh
npm install tarnveil-denoise
npx tarnveil-denoise-assets public/denoise
```

For a development version, use `npm install github:Amesu-afk/tarnveil-denoise`.
You can also install the tarball produced by `npm pack`.

The package ships compiled ESM, TypeScript declarations, a bundled Worker, an AudioWorklet and matching ONNX Runtime **1.29.0** WASM/module files. There is no separate runtime dependency to configure. The asset command copies these files and downloads the **34,191,309-byte** model from [release v0.3.0](https://github.com/Amesu-afk/tarnveil-denoise/releases/tag/v0.3.0), verifying SHA-256 before writing. Weights are excluded from the npm tarball. Host these assets on your own origin. To reuse a verified local model:

```sh
npx tarnveil-denoise-assets public/denoise --model /path/to/smartnet-v54-psa.onnx
```

## Usage

```ts
import { createDenoiseNode } from 'tarnveil-denoise'

const ctx = new AudioContext({ sampleRate: 48000 })
await ctx.resume() // call from a user gesture
const mic = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
})
const source = ctx.createMediaStreamSource(mic)
const destination = ctx.createMediaStreamDestination()
const denoise = await createDenoiseNode(ctx, {
  modelUrl: '/denoise/smartnet-v54-psa.onnx',
  ortBase: new URL('/denoise/ort/', location.href).href,
  workletUrl: '/denoise/worklet.js',
  workerUrl: '/denoise/worker.js',
})
source.connect(denoise ? denoise.node : destination)
denoise?.node.connect(destination)
const restoreBrowserSuppression = () => {
  void mic.getAudioTracks()[0].applyConstraints({ noiseSuppression: true })
    .catch(console.warn)
}
if (!denoise) restoreBrowserSuppression()
denoise?.onFailure(reason => {
  console.warn('Denoiser switched to passthrough:', reason)
  restoreBrowserSuppression()
})

// Send destination.stream to WebRTC or MediaRecorder.
// When capture ends:
function stop() {
  source.disconnect()
  denoise?.dispose()
  mic.getTracks().forEach(track => track.stop())
  void ctx.close()
}
```

The function registers the worklet itself and returns `null` on unsupported sample rates or startup failure. Runtime failures open passthrough and notify `onFailure`; restore browser suppression in the host application. Keep browser noise suppression disabled while the model is active. Echo cancellation is separate.

The copied `.js` URLs work in Vite development and production. If bundling the source instead, use `?worker&url` for both modules: `new URL('./worker.ts', import.meta.url)` by itself can emit raw TypeScript as a static asset, which browsers cannot execute.

## Measurements and limits

This reproducible benchmark uses **mixed recordings**, not a live call: 12 seconds of speech with separately recorded keyboard/mouse clicks placed at −14.2 dB relative to the speech peak. Median / tenth percentile suppression in dB:

| Source | v54, pauses | v54, over speech | DeepFilterNet3, pauses | DeepFilterNet3, over speech |
| --- | --- | --- | --- | --- |
| Keyboard | 48.3 / 19.2 | 10.4 / 0.0 | 45.5 / 36.0 | −3.2 / −10.2 |
| Mouse | 49.3 / 38.9 | 10.4 / 1.7 | 37.5 / 28.1 | 0.0 / −5.8 |

These results describe **these fixtures and settings only** and do not establish general superiority over DeepFilterNet3. The residual is `enhance(speech + clicks) − enhance(speech)`; nonlinear speech changes can enter it. A negative result means the residual peak increased. See [methodology, credits and reproduction](https://github.com/Amesu-afk/tarnveil-denoise/blob/main/bench/README.md).

Clean-speech level changed by −0.03 dB on this clip, but waveform error was −19.9 dB relative to the original. Similar loudness does **not** mean untouched speech: consonants and timbre can change. Clicks overlapping speech remain the weakest case; some are barely reduced. Different microphones, rooms and speakers need separate testing. Mobile performance is unmeasured. The model does not separate speakers or cancel echo. The pre-1.0 API may change.

Historical first-release/v33 results and the app's separate transient-suppressor chain are different experiments; see [v0.3.0 release notes](https://github.com/Amesu-afk/tarnveil-denoise/releases/tag/v0.3.0). They are not results for this package's current demo.

## Latency and cost

- Model/DSP delay: **544 samples at 48 kHz = 11.33 ms**, measured by alignment.
- The AudioWorklet starts with a **two-block buffer (20 ms)** to absorb scheduling jitter. Audio hardware, browser queues and WebRTC add further delay.
- 10 ms input hops; inference must keep up with real time. Overflow reports failure and opens passthrough. Current CPU cost depends on device/browser and has not been established across devices. Old v33 timings do not certify v54.
- Weights: 32.6 MiB, plus runtime assets. Downloads and model loading add startup time. Serve and cache the files deliberately.

## Development

Use Node **24 or newer** for development and the full set of checks.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run check:package  # pack, isolated Vite consumer install, types/build
npm run bench:assets
npm run bench         # Node >=24
npm run demo:render   # aligned WAVs and hashes in bench/demo-output
```

Inference: `src/worker.ts`; framing and bounded queue: `src/worklet.ts`; lifecycle API: `src/index.ts`. Model contract: 1024-point FFT, periodic 960-sample window, 480-sample hop; v54 also uses a 512-point FFT, 480-sample window and 240-sample hop. Changing these parameters requires matching weights.

Inference code and weights: Apache-2.0. ONNX Runtime: MIT, included with the runtime assets. Training code is not published. See [contributing](https://github.com/Amesu-afk/tarnveil-denoise/blob/main/CONTRIBUTING.md), [security](https://github.com/Amesu-afk/tarnveil-denoise/blob/main/SECURITY.md), and [license](https://github.com/Amesu-afk/tarnveil-denoise/blob/main/LICENSE).
