# TarnVeil Denoise

English · [Русский](README.ru.md)

Neural microphone noise suppression for the browser. A Web Audio node backed by a
streaming 48 kHz model: put it in your capture chain and the other side stops hearing
the fan, your breathing, your keyboard and your mouse.

The model was trained from scratch for [TarnVeil](https://github.com/Amesu-afk/TarnVeil)
and extracted from it. Everything runs in the browser — no audio leaves the machine, and
your server does not need to do anything.

## Status

Running in production for one small deployment. In practice that means:

- **the numbers below were measured on real recordings, not on synthetic scenes** —
  they are reproducible;
- **keyboard clicks under speech are the weakest case** — better since the sub-frame
  model, still the weakest, see "What it cannot do";
- untested on phones: 33 MB of weights and half the CPU;
- the API is not frozen.

## What it buys you, measured

Real recordings with a clean reference beside them. Every figure is against the
untreated signal:

| | effect |
| --- | --- |
| Breathing into the microphone | **+13.3 dB** |
| Key click in a pause between words | **+20…27 dB** |
| Key click **under speech** | **+3 dB** |
| Steady background (fan, hum) | removed along with the pauses |
| The voice itself | **+0.01 dB** — untouched |

That last row matters more than the rest: the model gains nothing at the expense of the
voice. For comparison, DeepFilterNet 3 on the same recordings removes more in pauses
(+14.6 dB against our +8.9) but pays **−1.37 dB of voice** for it and tears speech apart
under a click.

Those figures were measured on the weights of the first release. What the current
`smartnet-v54-psa` moves is the click under speech; the numbers for it are in the
section below.

## What it cannot do

**A key click that lands on speech is the weakest case.** In a pause it is knocked down
by 20–27 dB; under speech, by a few. The reason is structural: the mask works on a 20 ms
frame, the click lasts 2.8 ms, and inside that frame a vowel sits on top of it. A
spectral mask cannot remove one without touching the other.

We tried eight approaches against it — 20 ms lookahead, detector hints, deep filtering in
two compositions, a shorter window, a targeted loss term, per-sample repair, more data,
longer training. Seven failed outright; the eighth bought 0.7 dB.

The ninth is what `smartnet-v54-psa` is: multi-resolution. It still LOOKS at the 20 ms
window but answers on a 5 ms grid inside it, and the mask borrows from the next short
frame wherever that one was pushed down harder. Measured over eight click sources in
TarnVeil's own capture chain — which puts a click suppressor in front of the model, so
this is not the package on its own — the median over speech went from 4.5 dB to 6.2,
winning on all eight sources, devices the model never saw among them. And the worst tenth
of key presses stopped being negative (−0.3 → +0.4 dB): the previous weights sometimes
made a click LOUDER than it arrived. It is paid for with 0.5 dB of SI-SDR on clean speech.

It is still the weakest case. If this is exactly what you need, measure before you lean
on it.

It also does not: run at any rate other than 48 kHz, separate speakers, or cancel echo
(the browser's AEC does that before us).

## Cost

Measured on the same wasm build that runs in the browser, not extrapolated from native
timings — those are off by a factor of two:

- **3.9 ms per frame**, 4.5 ms at the 95th percentile, against a 10 ms budget. Timed on
  the first release's weights; natively the sub-frame model costs the same within noise
  (1.84 ms per frame against 1.82), but it has not been re-timed in wasm;
- 33 MB of weights, downloaded once and cached;
- adds no latency of its own: the model is causal, 20 ms window, 10 ms hop. The sub-frame
  path synthesizes 240 samples earlier and spends exactly those on the mask lookahead, so
  the total delay stays the same 544 samples — checked by a test, not by arithmetic.

## Install

```bash
npm install onnxruntime-web
```

Copy `src/` into your project (there is no npm package yet) and place beside it:

- the model `smartnet-v54-psa.onnx` from
  [releases](https://github.com/Amesu-afk/tarnveil-denoise/releases);
- the runtime `ort-wasm-simd-threaded.wasm` and `.mjs` from `onnxruntime-web/dist`.

## Usage

```ts
import { createDenoiseNode } from './denoise/src'
import workletUrl from './denoise/src/worklet.ts?worker&url'

const ctx = new AudioContext({ sampleRate: 48000 })  // exactly 48 kHz, or it returns null
const mic = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
})

const denoise = await createDenoiseNode(ctx, {
  modelUrl: '/models/smartnet-v54-psa.onnx',
  ortBase: '/ort/',
  workletUrl,
  workerUrl: new URL('./denoise/src/worker.ts', import.meta.url).href,
})

if (denoise) {
  ctx.createMediaStreamSource(mic).connect(denoise.node)
  denoise.node.connect(destination)     // on to WebRTC, or wherever you need it
  denoise.onFailure((reason) => console.warn('denoiser dropped out:', reason))
} else {
  // Did not come up — wrong sample rate, no AudioWorklet, weights failed to load.
  // Turn the browser's own suppression back on: no suppression at all is worse.
}
```

**Ask the browser for `noiseSuppression: false`.** The browser's suppressor sits before
us and hands the model an already-reshaped spectrum, while the model was trained on raw
noise: you get a metallic tinge and clipped word tails. If our node fails to start, put
the browser's back.

## How it works

```
microphone → AudioWorklet ──(480-sample frames)──> Worker
                          <──(processed frames)──   onnxruntime-web + model
```

Inference lives in a Worker, not in the worklet: a worklet must finish within 128 samples
(2.7 ms) and one model frame takes 3.9 ms, so computing it inline would guarantee dropouts.
Between them sits a bounded queue; on overflow the node reports `overrun` and opens a
passthrough instead of stuttering silently.

| file | what is inside |
| --- | --- |
| `src/index.ts` | public API, node and worker lifecycle |
| `src/worklet.ts` | AudioWorklet: framing and reassembly |
| `src/worker.ts` | onnxruntime-web, streaming model state |
| `src/dsp.ts` | STFT with exactly the parameters the model was trained on |
| `src/dsp-core.ts` | FFT and the frame queue |

The model contract is 48 kHz, 1024-point FFT, a periodic 960-sample Hann window, 480-sample
hop. Change any of those numbers and the ONNX will still run — it will simply sound wrong.

## Training

The training code is not published yet. Open an issue if you want it and we will put it
together. In short: 8.5M parameters, a complex mask, training on a scene generator with
realistic speech-to-noise ratios, held-out validation **split by file rather than inside a
file**, and acceptance judged only on live recordings. That last rule turned out to matter
more than the architecture: the generator's own metric keeps improving while the model
overfits to the generator, and nothing in that metric shows it happening.

## License

Apache-2.0 — see [LICENSE](LICENSE). The weights are released under the same terms.
