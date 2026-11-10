// Audio-Handler für Tests ohne KI: Piepton und Echo. Arbeiten in PCM16 mit der Abtastrate des Gesprächs.
import { samplesPerFrame } from './session.js';
import type { AudioHandler } from '../callManager.js';

/** 440-Hz-Piepton, 0,5 s an / 0,5 s aus. Empfangenes Audio wird ignoriert. */
export class ToneHandler implements AudioHandler {
  private n = 0;
  private rate = 8000;
  constructor(private freq = 440) {}
  onConnected(sampleRate: number): void {
    this.rate = sampleRate;
  }
  onRemoteAudio(): void {}
  nextFrame(): Int16Array {
    const pcm = new Int16Array(samplesPerFrame(this.rate));
    for (let i = 0; i < pcm.length; i++, this.n++) {
      const on = this.n % this.rate < this.rate / 2;
      pcm[i] = on ? Math.round(Math.sin((2 * Math.PI * this.freq * this.n) / this.rate) * 8000) : 0;
    }
    return pcm;
  }
  close(): void {}
}

/**
 * Spielt das empfangene Audio mit Verzögerung zurück: belegt Audio in beide Richtungen.
 * Gerechnet wird in Samples, nicht in Paketen: Die FRITZ!Box schickt bei HD 10-ms-Pakete,
 * gesendet wird aber ein 20-ms-Frame je Takt.
 */
export class EchoHandler implements AudioHandler {
  private chunks: Int16Array[] = [];
  private buffered = 0;
  private rate = 8000;
  constructor(private readonly delayMs = 1000) {}
  onConnected(sampleRate: number): void {
    this.rate = sampleRate;
  }
  onRemoteAudio(pcm: Int16Array): void {
    this.chunks.push(pcm);
    this.buffered += pcm.length;
    // Läuft der Puffer voll (Gegenstelle sendet schneller, als wir abspielen), auf die Verzögerung kürzen
    const delay = (this.rate * this.delayMs) / 1000;
    if (this.buffered > delay * 4) this.take(this.buffered - delay);
  }
  nextFrame(): Int16Array | undefined {
    const frame = samplesPerFrame(this.rate);
    return this.buffered >= (this.rate * this.delayMs) / 1000 + frame ? this.take(frame) : undefined;
  }
  close(): void {
    this.chunks = [];
    this.buffered = 0;
  }

  /** Nimmt die ältesten n Samples aus dem Puffer */
  private take(n: number): Int16Array {
    const out = new Int16Array(n);
    let filled = 0;
    while (filled < n && this.chunks.length > 0) {
      const head = this.chunks[0];
      const part = Math.min(head.length, n - filled);
      out.set(head.subarray(0, part), filled);
      filled += part;
      if (part === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(part);
    }
    this.buffered -= filled;
    return out;
  }
}
