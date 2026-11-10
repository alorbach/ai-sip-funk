// Rationaler Resampler (L/M) mit Polyphase-FIR (Fenster-Sinc), streamingfähig: Zustand bleibt über
// Frame-Grenzen erhalten. Gebraucht zwischen Telefon (8/16 kHz) und OpenAI (24 kHz PCM16).

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export class Resampler {
  readonly up: number; // L
  readonly down: number; // M
  private readonly taps: number; // Koeffizienten je Phase
  private readonly coef: Float64Array; // Länge taps * up, phasenweise sortiert
  private hist: Float64Array; // letzte Eingangs-Samples (neuestes zuletzt)
  private histLen = 0;
  private inCount = 0; // insgesamt gesehene Eingangs-Samples
  private outCount = 0; // insgesamt erzeugte Ausgangs-Samples

  constructor(readonly inRate: number, readonly outRate: number, tapsPerPhase = 32) {
    const g = gcd(inRate, outRate);
    this.up = outRate / g;
    this.down = inRate / g;
    this.taps = tapsPerPhase;
    const n = this.taps * this.up;
    // Tiefpass bei 45 % der niedrigeren Rate, bezogen auf die hochgetastete Rate inRate*up
    const cutoff = (0.45 * Math.min(inRate, outRate)) / (inRate * this.up);
    const center = (n - 1) / 2;
    const h = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - center;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1)); // Blackman
      h[i] = sinc * w;
      sum += h[i];
    }
    // Verstärkung L, weil die Nullen des Hochtastens Energie kosten
    for (let i = 0; i < n; i++) h[i] *= this.up / sum;
    // Phasenweise umsortieren: coef[p * taps + k] = h[p + k * up]
    this.coef = new Float64Array(n);
    for (let p = 0; p < this.up; p++) for (let k = 0; k < this.taps; k++) this.coef[p * this.taps + k] = h[p + k * this.up];
    this.hist = new Float64Array(this.taps + 4096);
  }

  /** Verarbeitet einen Block und liefert alle fertigen Ausgangs-Samples. */
  process(input: Int16Array): Int16Array {
    // Eingang an den Verlauf anhängen (Verlauf hält mindestens taps Samples zurück)
    if (this.histLen + input.length > this.hist.length) {
      const bigger = new Float64Array(this.histLen + input.length + 4096);
      bigger.set(this.hist.subarray(0, this.histLen));
      this.hist = bigger;
    }
    for (let i = 0; i < input.length; i++) this.hist[this.histLen + i] = input[i];
    this.histLen += input.length;
    const firstIndex = this.inCount - (this.histLen - input.length); // globaler Index von hist[0]
    this.inCount += input.length;

    const out: number[] = [];
    for (;;) {
      const pos = this.outCount * this.down; // Position im hochgetasteten Signal
      const n0 = Math.floor(pos / this.up); // jüngstes benötigtes Eingangs-Sample
      if (n0 >= this.inCount) break;
      const phase = pos - n0 * this.up;
      const base = n0 - firstIndex; // Index in hist
      let acc = 0;
      const c = phase * this.taps;
      for (let k = 0; k < this.taps; k++) {
        const idx = base - k;
        if (idx < 0) break; // vor dem Start: Stille
        acc += this.coef[c + k] * this.hist[idx];
      }
      out.push(acc);
      this.outCount++;
    }

    // Verlauf kürzen: nur die letzten taps Samples behalten
    if (this.histLen > this.taps) {
      this.hist.copyWithin(0, this.histLen - this.taps, this.histLen);
      this.histLen = this.taps;
    }

    const result = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const v = Math.round(out[i]);
      result[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return result;
  }
}
