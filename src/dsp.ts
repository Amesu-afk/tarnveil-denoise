import { Fft } from './dsp-core'

// Streaming STFT wrapper for the TarnVeil denoiser.
//
// The model was trained at 48 kHz with torch.stft(center=false), a 1024-point
// FFT, a periodic 960-sample Hann window and a 480-sample (10 ms) hop. Keep
// those values here as part of the model contract: changing any one of them
// makes a valid ONNX model sound wrong even though inference still succeeds.

export const SMARTNET_RATE = 48_000
export const SMARTNET_FRAME = 1024
export const SMARTNET_WINDOW = 960
export const SMARTNET_HOP = 480
export const SMARTNET_BINS = SMARTNET_FRAME / 2 + 1

export function smartnetWindow(): Float32Array {
  const window = new Float32Array(SMARTNET_FRAME)
  const pad = (SMARTNET_FRAME - SMARTNET_WINDOW) / 2
  for (let i = 0; i < SMARTNET_WINDOW; i++) {
    // torch.hann_window is periodic by default, so the divisor is N, not N - 1.
    window[pad + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SMARTNET_WINDOW)
  }
  return window
}

// The framer is causal: every call appends one 10 ms hop, analyzes the latest
// 1024 samples and returns one normalized overlap-add hop. Its fixed algorithmic
// delay is SMARTNET_FRAME - SMARTNET_HOP samples (11.3 ms at 48 kHz).
export class SmartNetStft {
  private readonly window = smartnetWindow()
  private readonly fft = new Fft(SMARTNET_FRAME)
  private readonly input = new Float32Array(SMARTNET_FRAME)
  private readonly overlap = new Float32Array(SMARTNET_FRAME)
  private readonly denominator = new Float32Array(SMARTNET_FRAME)
  private readonly re = new Float32Array(SMARTNET_FRAME)
  private readonly im = new Float32Array(SMARTNET_FRAME)

  reset(): void {
    this.input.fill(0)
    this.overlap.fill(0)
    this.denominator.fill(0)
    this.re.fill(0)
    this.im.fill(0)
  }

  analyze(samples: Float32Array, spectrum: Float32Array): void {
    if (samples.length !== SMARTNET_HOP || spectrum.length !== SMARTNET_BINS * 2) {
      throw new Error('SmartNet STFT shape mismatch')
    }
    this.input.copyWithin(0, SMARTNET_HOP)
    this.input.set(samples, SMARTNET_FRAME - SMARTNET_HOP)
    for (let i = 0; i < SMARTNET_FRAME; i++) {
      this.re[i] = this.input[i] * this.window[i]
      this.im[i] = 0
    }
    this.fft.transform(this.re, this.im)
    for (let bin = 0; bin < SMARTNET_BINS; bin++) {
      spectrum[bin * 2] = this.re[bin]
      spectrum[bin * 2 + 1] = this.im[bin]
    }
  }

  synthesize(spectrum: Float32Array, output: Float32Array): void {
    if (spectrum.length !== SMARTNET_BINS * 2 || output.length !== SMARTNET_HOP) {
      throw new Error('SmartNet inverse STFT shape mismatch')
    }
    for (let bin = 0; bin < SMARTNET_BINS; bin++) {
      this.re[bin] = spectrum[bin * 2]
      this.im[bin] = spectrum[bin * 2 + 1]
      if (bin > 0 && bin < SMARTNET_BINS - 1) {
        this.re[SMARTNET_FRAME - bin] = spectrum[bin * 2]
        this.im[SMARTNET_FRAME - bin] = -spectrum[bin * 2 + 1]
      }
    }
    this.fft.transform(this.re, this.im, true)
    for (let i = 0; i < SMARTNET_FRAME; i++) {
      const window = this.window[i]
      this.overlap[i] += (this.re[i] / SMARTNET_FRAME) * window
      this.denominator[i] += window * window
    }
    for (let i = 0; i < SMARTNET_HOP; i++) {
      const weight = this.denominator[i]
      output[i] = weight > 1e-6 ? this.overlap[i] / weight : 0
    }
    this.overlap.copyWithin(0, SMARTNET_HOP)
    this.overlap.fill(0, SMARTNET_FRAME - SMARTNET_HOP)
    this.denominator.copyWithin(0, SMARTNET_HOP)
    this.denominator.fill(0, SMARTNET_FRAME - SMARTNET_HOP)
  }
}

// --- Sub-frame model (v54 and later) ------------------------------------------
//
// It LOOKS at the same long window but ANSWERS on a short grid inside it: a
// 512-point transform, a periodic 480-sample window, a 240-sample hop. Two short
// frames fit inside the same 1024-sample buffer the long analysis already holds,
// so the second STFT costs neither delay nor memory — only arithmetic.
//
// These numbers are part of the weights' contract exactly as the long ones above
// are. They cannot drift silently: the shape of `fine_spectrum` in the graph is
// checked on the very first call.
export const SMARTNET_SUBFRAMES = 2
export const SMARTNET_FINE_FRAME = 512
export const SMARTNET_FINE_WINDOW = 480
export const SMARTNET_FINE_HOP = 240
export const SMARTNET_FINE_BINS = SMARTNET_FINE_FRAME / 2 + 1

export function smartnetFineWindow(): Float32Array {
  const window = new Float32Array(SMARTNET_FINE_FRAME)
  const pad = (SMARTNET_FINE_FRAME - SMARTNET_FINE_WINDOW) / 2
  for (let i = 0; i < SMARTNET_FINE_WINDOW; i++) {
    window[pad + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SMARTNET_FINE_WINDOW)
  }
  return window
}

// Analysis on both grids at once, synthesis on the short one.
//
// Deliberately a separate class rather than a mode on SmartNetStft: that one
// carries the shipping model and every silent divergence this project has had
// came from two chains sharing code until one of them quietly stopped matching.
export class SmartNetMultiresStft {
  private readonly window = smartnetWindow()
  private readonly fineWindow = smartnetFineWindow()
  private readonly fft = new Fft(SMARTNET_FRAME)
  private readonly fineFft = new Fft(SMARTNET_FINE_FRAME)
  private readonly input = new Float32Array(SMARTNET_FRAME)
  private readonly re = new Float32Array(SMARTNET_FRAME)
  private readonly im = new Float32Array(SMARTNET_FRAME)
  private readonly fineRe = new Float32Array(SMARTNET_FINE_FRAME)
  private readonly fineIm = new Float32Array(SMARTNET_FINE_FRAME)
  private readonly overlap = new Float32Array(SMARTNET_FINE_FRAME)
  private readonly denominator = new Float32Array(SMARTNET_FINE_FRAME)

  reset(): void {
    this.input.fill(0)
    this.overlap.fill(0)
    this.denominator.fill(0)
  }

  analyze(samples: Float32Array, spectrum: Float32Array, fine: Float32Array): void {
    if (
      samples.length !== SMARTNET_HOP ||
      spectrum.length !== SMARTNET_BINS * 2 ||
      fine.length !== SMARTNET_SUBFRAMES * SMARTNET_FINE_BINS * 2
    ) {
      throw new Error('SmartNet multires STFT shape mismatch')
    }
    this.input.copyWithin(0, SMARTNET_HOP)
    this.input.set(samples, SMARTNET_FRAME - SMARTNET_HOP)
    for (let i = 0; i < SMARTNET_FRAME; i++) {
      this.re[i] = this.input[i] * this.window[i]
      this.im[i] = 0
    }
    this.fft.transform(this.re, this.im)
    for (let bin = 0; bin < SMARTNET_BINS; bin++) {
      spectrum[bin * 2] = this.re[bin]
      spectrum[bin * 2 + 1] = this.im[bin]
    }
    // Short frame s starts at (s + 1) * 240 from the start of the buffer: frame 0
    // sits half a hop inside the long window, frame 1 a whole one. Both end inside
    // the same 1024 samples.
    for (let sub = 0; sub < SMARTNET_SUBFRAMES; sub++) {
      const at = (sub + 1) * SMARTNET_FINE_HOP
      for (let i = 0; i < SMARTNET_FINE_FRAME; i++) {
        this.fineRe[i] = this.input[at + i] * this.fineWindow[i]
        this.fineIm[i] = 0
      }
      this.fineFft.transform(this.fineRe, this.fineIm)
      const base = sub * SMARTNET_FINE_BINS * 2
      for (let bin = 0; bin < SMARTNET_FINE_BINS; bin++) {
        fine[base + bin * 2] = this.fineRe[bin]
        fine[base + bin * 2 + 1] = this.fineIm[bin]
      }
    }
  }

  synthesize(fine: Float32Array, output: Float32Array): void {
    if (
      fine.length !== SMARTNET_SUBFRAMES * SMARTNET_FINE_BINS * 2 ||
      output.length !== SMARTNET_HOP
    ) {
      throw new Error('SmartNet multires inverse STFT shape mismatch')
    }
    for (let sub = 0; sub < SMARTNET_SUBFRAMES; sub++) {
      const base = sub * SMARTNET_FINE_BINS * 2
      for (let bin = 0; bin < SMARTNET_FINE_BINS; bin++) {
        this.fineRe[bin] = fine[base + bin * 2]
        this.fineIm[bin] = fine[base + bin * 2 + 1]
        if (bin > 0 && bin < SMARTNET_FINE_BINS - 1) {
          this.fineRe[SMARTNET_FINE_FRAME - bin] = fine[base + bin * 2]
          this.fineIm[SMARTNET_FINE_FRAME - bin] = -fine[base + bin * 2 + 1]
        }
      }
      this.fineFft.transform(this.fineRe, this.fineIm, true)
      for (let i = 0; i < SMARTNET_FINE_FRAME; i++) {
        const window = this.fineWindow[i]
        this.overlap[i] += (this.fineRe[i] / SMARTNET_FINE_FRAME) * window
        this.denominator[i] += window * window
      }
      for (let i = 0; i < SMARTNET_FINE_HOP; i++) {
        const weight = this.denominator[i]
        output[sub * SMARTNET_FINE_HOP + i] = weight > 1e-6 ? this.overlap[i] / weight : 0
      }
      this.overlap.copyWithin(0, SMARTNET_FINE_HOP)
      this.overlap.fill(0, SMARTNET_FINE_FRAME - SMARTNET_FINE_HOP)
      this.denominator.copyWithin(0, SMARTNET_FINE_HOP)
      this.denominator.fill(0, SMARTNET_FINE_FRAME - SMARTNET_FINE_HOP)
    }
  }
}
