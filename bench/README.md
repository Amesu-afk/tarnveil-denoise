# Fixed-fixture benchmark

Compares smartnet-v54-psa with DeepFilterNet3 on two frozen mixtures. These are separately recorded speech and keyboard/mouse clicks, not a live microphone session or a call. Results apply to these inputs and the stated settings.

## Reproduce

Node >=24 is required for native TypeScript execution and module.registerHooks.

```sh
npm ci
npm run bench:assets
npm run bench
npm run demo:render
```

The v54 download is checked against the release SHA-256. The benchmark uses the package DSP with onnxruntime-node 1.29.0 and the vendored DeepFilterNet3 WASM with attenuation 95. The runtime is different from the browser worker; this does not measure browser inference speed or microphone-to-speaker latency.

## Method

For each marked onset, use a window from 5 ms before to 95 ms after it. Measure the peak of `enhance(speech + clicks) - enhance(speech)` relative to the original click peak. Classify windows by clean-speech RMS above/below -50 dBFS; report median and tenth percentile. Nonlinear speech changes caused by the clicks can enter the residual, so it is an estimate of unwanted change, not an isolated source recovered from the output.

There are 54 onset windows per fixture. Legacy fixture metadata also has a `clicks` count (52 keyboard / 98 mouse); the benchmark now reports the actual number of scored onset windows rather than equating those fields. No fixture audio or placements were changed.

Align outputs to the clean input before scoring: measured model delay 544 samples, DFN3 delay 1133 samples. This removes processor delay for comparison; it does not mean zero latency.

## Reproduced results

Median / tenth percentile suppression, dB; reproduced 2026-10-05:

| Source | v54 pauses | v54 over speech | DFN3 pauses | DFN3 over speech |
| --- | --- | --- | --- | --- |
| Keyboard | 48.3 / 19.2 | 10.4 / 0.0 | 45.5 / 36.0 | -3.2 / -10.2 |
| Mouse | 49.3 / 38.9 | 10.4 / 1.7 | 37.5 / 28.1 | 0.0 / -5.8 |

On clean speech alone, output-level change / waveform-error level relative to input:

| Processor | Level change | Waveform error |
| --- | --- | --- |
| v54 | -0.03 dB | -19.9 dB |
| DFN3 | 0.0 dB | +1.6 dB |

Equal level does not prove unchanged speech. This waveform metric is sensitive to phase/processing and is not a perceptual quality score. v54 does better on over-speech median here; DFN3 has the higher tenth percentile in keyboard pauses. These two clips do not establish a general ranking.

The app's separate transient-suppressor pipeline and historical v33 measurements use other harnesses and are not directly comparable.

## Fixture credits

48 kHz mono float32, 12 seconds. Russian reading from the open M-AILABS ru_RU corpus (hajdurova / strashnaya_minuta); clicks from an own desktop-microphone recording. Click level: -14.2 dB relative to speech peak; seed 20260821. Audio is fixed in fixtures/, with onset positions in fixtures.json.

results.json contains model/fixture hashes, measured delays and scores. demo:render verifies those hashes and exports PCM16 WAVs with the 544-sample delay removed, without loudness normalization. It flushes the model tail, preserves all 12 seconds and writes keyboard-v54-metadata.json. This is a native offline rendering of the package model/DSP, not browser live inference.
