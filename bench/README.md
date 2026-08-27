# Benchmark: TarnVeil model vs DeepFilterNet3 on keyboard clicks over speech

A keyboard click is a short burst with most of its energy in 2–8 kHz — exactly
where `/s/`, `/t/` and other consonants live. A spectral mask cannot cut that band
without eating speech, so a click that lands **on top of the voice** is the hard
case. This benchmark measures that case, on frozen inputs anyone reproduces, against
DeepFilterNet3 — a strong general-purpose suppressor, and the "strong" mode in the
TarnVeil app.

## Run it

Needs **Node ≥ 24** — the model runner imports the package's own `.ts` DSP directly,
using `module.registerHooks` and native TypeScript execution.

```sh
npm install            # dev dep: onnxruntime-node
npm run bench:assets   # fetches the model + DeepFilterNet3 into bench/assets/ (git-ignored)
npm run bench          # prints the table, writes bench/results.json
```

Both processors run **out of the box, headless**: the model through this package's
own DSP (`bench/model_run.ts` reuses `src/dsp.ts` + `src/mask-lookahead.ts` on
`onnxruntime-node`), DeepFilterNet3 through the exact wasm the app ships
(`bench/dfn3_process.mjs`). No training code, no torch.

## How a number is made

For every click, the residual is what the processor did to the click alone:

```
enhance(speech),  enhance(speech + click),  subtract  →  click residual
suppression (dB) = 20·log10( peak|click| / peak|residual| )
```

Enhancing the clean speech and subtracting it removes the voice the processor would
have produced anyway, so what is scored is the click, not the louder voice on top of
it. Peaking a whole frame instead would measure the voice and hand every processor a
flattering ~0 dB. Each click is labelled **pause** or **over speech** by the speech
RMS in its window (−50 dBFS), because suppression in those two cases differs by an
order of magnitude. Reported per processor: median and worst-tenth.

DeepFilterNet3's algorithmic delay is measured against the clean pass and removed
before scoring; the model's is 544 samples.

## Result

`smartnet-v54-psa` vs DeepFilterNet3 (attenuation 95, the app's default), median /
worst-tenth in dB:

| source | model, pause | model, **over speech** | DFN3, pause | DFN3, **over speech** |
| --- | --- | --- | --- | --- |
| keyboard | 48.3 / 19.2 | **10.4** / 0.0 | 45.5 / 36.0 | **−3.2** / −10.2 |
| mouse | 49.3 / 38.9 | **10.4** / 1.7 | 37.5 / 28.1 | **0.0** / −5.8 |

**Voice cost**, on the same speech with no click — output level and how much of the
speech was rewritten (residual after subtracting the original, dB relative to it):

| | level change | speech rewritten |
| --- | --- | --- |
| model | −0.03 dB | −19.9 dB (left alone) |
| DFN3 | 0.0 dB | +1.6 dB (rewritten) |

Two honest readings:

- **Over speech the model wins**: it suppresses the click (10.4 dB), DeepFilterNet3
  does not (−3.2 to 0.0 — it leaves the click as loud or louder), and it does so
  while leaving the voice essentially untouched. That is the case this model was
  built for.
- **In a pause it is a trade**: the model's median is higher, but DeepFilterNet3's
  worst-tenth is tighter — in silence the model occasionally lets a single click
  through, DFN3 suppresses more evenly. DFN3 is a general denoiser and never claimed
  to leave a voice untouched; that is what the voice-cost row is for.

## What this is and is not

This measures **the model alone** — which is what this package is. The TarnVeil app
puts a separate transient suppressor in front of the model, and measured through
that full chain over eight sources it reports ~6.2 dB over speech (see the app and
the `mask-lookahead.ts` note in `src/`). These are different, non-comparable
harnesses; this one is the model on a fixed clip, the reproducible number for the
weights this repo ships.

## Fixtures

`fixtures/` holds frozen 48 kHz mono float32: clean speech, and speech with clicks
placed in pauses and over the voice at a measured −14.2 dB below the speech peak.
Speech is a Russian public-domain reading (M-AILABS ru_RU, hajdurova), clicks are an
own desktop-microphone recording. Regenerate with the same speech, placement and
seed to change nothing.
