// Radix-2 FFT for a real-valued signal. Lifted from TarnVeil unchanged: the sine
// and cosine tables are computed once per window size.

export class Fft {
  private readonly cos: Float32Array
  private readonly sin: Float32Array
  private readonly reverse: Uint32Array

  constructor(private readonly size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two')
    this.cos = new Float32Array(size / 2)
    this.sin = new Float32Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size)
    }
    // Bit-reversal table: computed once, read-only from then on.
    const bits = Math.log2(size)
    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let value = 0
      for (let bit = 0; bit < bits; bit++) if (i & (1 << bit)) value |= 1 << (bits - 1 - bit)
      this.reverse[i] = value
    }
  }

  // inverse=true computes the inverse transform WITHOUT dividing by N — the caller divides.
  transform(re: Float32Array, im: Float32Array, inverse = false): void {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i]
      if (j > i) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp
        tmp = im[i]; im[i] = im[j]; im[j] = tmp
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const step = n / len
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const twiddle = k * step
          const wr = this.cos[twiddle]
          const wi = inverse ? -this.sin[twiddle] : this.sin[twiddle]
          const a = i + k
          const b = a + len / 2
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

export class JitterBuffer {
  private readonly queue: Float32Array[] = []
  private current: Float32Array | null = null
  private currentRead = 0
  private playing = false
  private target: number

  constructor(
    private readonly minBlocks = 1,
    private readonly maxBlocks = 4,
    // Queue ceiling: when the main thread stalls for a while and then delivers
    // everything at once, that backlog must not be kept — it would turn into
    // permanent latency.
    private readonly capacity = 12,
  ) {
    this.target = minBlocks
  }

  // How many blocks the buffer currently holds before playing out — the latency, in blocks.
  get targetBlocks(): number {
    return this.target
  }

  reset(): void {
    this.queue.length = 0
    this.current = null
    this.currentRead = 0
    this.playing = false
    this.target = this.minBlocks
  }

  push(block: Float32Array): void {
    this.queue.push(block)
    // On overflow drop the oldest: recent audio matters more than complete audio.
    while (this.queue.length > this.capacity) this.queue.shift()
    if (!this.playing && this.queue.length >= this.target) this.playing = true
  }

  // Fills output with processed audio. Until the buffer has filled up it emits silence:
  // handing out fragments sounds worse than saying nothing. Returns false when there
  // was nothing to play out this time.
  read(output: Float32Array): boolean {
    if (!this.playing) {
      output.fill(0)
      return false
    }
    for (let i = 0; i < output.length; i++) {
      if (!this.current || this.currentRead >= this.current.length) {
        this.current = this.queue.shift() ?? null
        this.currentRead = 0
      }
      if (!this.current) {
        // Ran dry mid-playout — this is the dropout you actually hear. Wait for the
        // buffer to refill and hold one block more next time.
        this.playing = false
        if (this.target < this.maxBlocks) this.target++
        output.fill(0, i)
        return false
      }
      output[i] = this.current[this.currentRead++]
    }
    return true
  }
}
