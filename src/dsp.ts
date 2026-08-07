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
