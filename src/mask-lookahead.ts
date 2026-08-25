import {
  SMARTNET_FINE_BINS,
  SMARTNET_FINE_HOP,
  SMARTNET_RATE,
  SMARTNET_SUBFRAMES,
} from './dsp'

// Lets the mask look one short frame ahead.
//
// The model is causal: it closes a frame without knowing the future, while a
// click enters the analysis window gradually. A measurement showed the ATTACK
// suffers more than the tail from this — the mask arrives once the click has
// already been heard. Here the output is held back by one short frame, and
// wherever the NEXT frame was pushed down harder, the current one follows:
//
//   g(f) = |E(f)| / |X(f)|                    - how far the model attenuated the bin
//   Ẽ(f) = E(f) · min(1, g_next(f) / g(f))^strength
//
// This costs no extra inference at all — only delay.
//
// Measured over eight click sources on v54 (medians, full production chain with
// the application's click suppressor in front):
//
//   strength  over speech  wins vs shipping  in pauses  SI-SDR of clean speech
//   --------  -----------  ----------------  ---------  ----------------------
//   none              6.2               8/8       38.9                    17.8
//   0.5               6.2               8/8       42.8                    17.7
//   1.0               6.2               7/8       42.9                    17.5
//
// 0.5 it is: almost all of the gain in pauses that full strength buys, at 0.1 dB
// of transparency instead of 0.3, and one win more. The previous model, for
// comparison: 4.5 / 41.2 / 18.2.
//
// TRIED AND DROPPED: borrowing only where the neighbour is pushed down markedly
// harder (thresholds 0.5 / 0.25 / 0.1). Transparency holds, but nearly the whole
// gain over speech goes with it — 2 wins out of 8 against 5. The trick works on
// the whole signal, not on the click, and its cost cannot be separated from its
// benefit.
export const MASK_LOOKAHEAD_STRENGTH = 0.5
export const MASK_LOOKAHEAD_DELAY_SAMPLES = SMARTNET_FINE_HOP
export const MASK_LOOKAHEAD_DELAY_MS = (SMARTNET_FINE_HOP / SMARTNET_RATE) * 1000

// Bins where the model let nearly everything through give a ratio of two near
// zeros. The floor is set on the input: where there is no input, there is
// nothing to borrow from.
const FLOOR = 1e-7

export class SmartNetMaskLookahead {
  private readonly pending = new Float32Array(SMARTNET_FINE_BINS * 2)
  private readonly pendingGain = new Float32Array(SMARTNET_FINE_BINS)
  private readonly gain = new Float32Array(SMARTNET_SUBFRAMES * SMARTNET_FINE_BINS)

  constructor(private readonly strength: number = MASK_LOOKAHEAD_STRENGTH) {}

  reset(): void {
    this.pending.fill(0)
    this.pendingGain.fill(0)
    this.gain.fill(0)
  }

  /**
   * Takes the model's output and its input on the short grid, returns that same
   * output delayed by exactly one short frame and pushed down by its right-hand
   * neighbour. All three arrays are [subframes * bins * 2].
   */
  process(enhanced: Float32Array, input: Float32Array, output: Float32Array): void {
    const stride = SMARTNET_FINE_BINS * 2
    if (
      enhanced.length !== SMARTNET_SUBFRAMES * stride ||
      input.length !== SMARTNET_SUBFRAMES * stride ||
      output.length !== SMARTNET_SUBFRAMES * stride
    ) {
      throw new Error('SmartNet mask lookahead shape mismatch')
    }
    for (let sub = 0; sub < SMARTNET_SUBFRAMES; sub++) {
      const base = sub * stride
      for (let bin = 0; bin < SMARTNET_FINE_BINS; bin++) {
        const outgoing = Math.hypot(enhanced[base + bin * 2], enhanced[base + bin * 2 + 1])
        const incoming = Math.hypot(input[base + bin * 2], input[base + bin * 2 + 1])
        this.gain[sub * SMARTNET_FINE_BINS + bin] = outgoing / Math.max(incoming, FLOOR)
      }
    }
    // The frame held back from the previous call borrows from the FIRST of the new
    // ones; the first new one from the second; the second goes into the delay and
    // waits for the next call.
    this.emit(this.pending, this.pendingGain, 0, this.gain, 0, output, 0)
    for (let sub = 0; sub + 1 < SMARTNET_SUBFRAMES; sub++) {
      this.emit(enhanced, this.gain, sub, this.gain, sub + 1, output, sub + 1)
    }
    const last = SMARTNET_SUBFRAMES - 1
    this.pending.set(enhanced.subarray(last * stride, (last + 1) * stride))
    this.pendingGain.set(
      this.gain.subarray(last * SMARTNET_FINE_BINS, (last + 1) * SMARTNET_FINE_BINS))
  }

  private emit(
    source: Float32Array,
    ownGain: Float32Array,
    ownIndex: number,
    nextGain: Float32Array,
    nextIndex: number,
    output: Float32Array,
    outputIndex: number,
  ): void {
    const stride = SMARTNET_FINE_BINS * 2
    // `pending` holds a single frame, so its offset is zero, not ownIndex.
    const from = source.length === stride ? 0 : ownIndex * stride
    const ownBase = ownGain.length === SMARTNET_FINE_BINS ? 0 : ownIndex * SMARTNET_FINE_BINS
    const nextBase = nextIndex * SMARTNET_FINE_BINS
    const to = outputIndex * stride
    for (let bin = 0; bin < SMARTNET_FINE_BINS; bin++) {
      const own = ownGain[ownBase + bin]
      const ahead = nextGain[nextBase + bin]
      let ratio = own > FLOOR ? ahead / own : 1
      if (ratio > 1) ratio = 1
      if (ratio < 0) ratio = 0
      const scale = this.strength === 1 ? ratio : Math.pow(ratio, this.strength)
      output[to + bin * 2] = source[from + bin * 2] * scale
      output[to + bin * 2 + 1] = source[from + bin * 2 + 1] * scale
    }
  }
}
