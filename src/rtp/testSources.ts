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

/** Spielt empfangene Frames mit Verzögerung zurück: belegt Audio in beide Richtungen. */
export class EchoHandler implements AudioHandler {
  private queue: Int16Array[] = [];
  private readonly delayFrames: number;
  constructor(delayMs = 1000) {
    this.delayFrames = Math.round(delayMs / 20);
  }
  onRemoteAudio(pcm: Int16Array): void {
    this.queue.push(pcm);
    if (this.queue.length > this.delayFrames * 4) this.queue.splice(0, this.queue.length - this.delayFrames);
  }
  nextFrame(): Int16Array | undefined {
    return this.queue.length > this.delayFrames ? this.queue.shift() : undefined;
  }
  close(): void {
    this.queue = [];
  }
}
