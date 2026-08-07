// Радикс-2 БПФ для действительного сигнала. Вынесен из TarnVeil как есть:
// таблицы синусов и косинусов считаются один раз на размер окна.

export class Fft {
  private readonly cos: Float32Array
  private readonly sin: Float32Array
  private readonly reverse: Uint32Array

  constructor(private readonly size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('Размер БПФ должен быть степенью двойки')
    this.cos = new Float32Array(size / 2)
    this.sin = new Float32Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size)
    }
    // Таблица перестановки бит: считаем один раз, дальше только читаем.
    const bits = Math.log2(size)
    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let value = 0
      for (let bit = 0; bit < bits; bit++) if (i & (1 << bit)) value |= 1 << (bits - 1 - bit)
      this.reverse[i] = value
    }
  }

  // inverse=true считает обратное преобразование БЕЗ деления на N — делит вызывающий.
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
    // Потолок очереди: если основной поток надолго встал, а потом отдал всё разом,
    // копить эту гору нельзя — она превратится в постоянную задержку.
    private readonly capacity = 12,
  ) {
    this.target = minBlocks
  }

  // Сколько блоков буфер сейчас держит перед выдачей — та самая задержка, в блоках.
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
    // Переполнение — роняем самое старое: свежий звук важнее полного.
    while (this.queue.length > this.capacity) this.queue.shift()
    if (!this.playing && this.queue.length >= this.target) this.playing = true
  }

  // Заполняет output готовым звуком. Пока буфер не набрался — тишина: выдавать обрывки
  // хуже, чем промолчать. Возвращает false, если в этот раз выдать было нечего.
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
        // Опустели посреди выдачи — это и есть разрыв, который слышно. Ждём, пока
        // наберётся заново, и в следующий раз держим на блок больше.
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
