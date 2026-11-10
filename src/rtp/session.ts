// RTP-Sitzung (RFC 3550) für G.711 (8 oder 16 kHz): sendet im 20-ms-Takt, empfängt Audio-Frames.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { silenceByte } from './g711.js';
import type { Codec } from '../sip/sdp.js';
import { log } from '../log.js';

const FRAME_MS = 20;

/** Samples je 20-ms-Frame bei der gegebenen Abtastrate */
export const samplesPerFrame = (sampleRate: number): number => (sampleRate * FRAME_MS) / 1000;

/** Liefert den nächsten kodierten 20-ms-Frame oder undefined für Stille. */
export type FrameSource = () => Buffer | undefined;

/**
 * Events:
 *  'frame' (payload: Buffer) für jedes empfangene Audio-Paket im ausgehandelten Codec,
 *  'sent'  (payload: Buffer) für jeden gesendeten Frame (auch Stille) – Taktgeber fürs Mithören.
 */
export class RtpSession extends EventEmitter {
  packetsSent = 0;
  packetsReceived = 0;
  /** Takt-Diagnose: wie oft mussten mehrere Frames auf einmal gesendet werden */
  bursts = 0;
  maxBurst = 0;
  maxTickGapMs = 0;
  private socket = dgram.createSocket('udp4');
  private remote?: { ip: string; port: number };
  private source?: FrameSource;
  private timer?: NodeJS.Timeout;
  private seq = randomInt(0xffff);
  private timestamp = randomInt(0xffffffff);
  private readonly ssrc = randomInt(0xffffffff);
  private silence: Buffer;
  readonly payloadType: number;
  readonly samplesPerFrame: number;
  // Paketierung: standardmäßig ein 20-ms-Frame je Paket, Zeitstempel = Samples; wird an die Gegenstelle angepasst
  private packetBytes: number;
  private tsPerByte = 1;
  private peerKnown = false;
  private lastRecv?: { ts: number; bytes: number };

  constructor(private localPort: number, readonly codec: Codec) {
    super();
    this.payloadType = codec.payloadType;
    this.samplesPerFrame = samplesPerFrame(codec.sampleRate);
    this.packetBytes = this.samplesPerFrame;
    this.silence = Buffer.alloc(this.samplesPerFrame, silenceByte(codec.law));
  }

  async start(remoteIp: string, remotePort: number): Promise<void> {
    this.remote = { ip: remoteIp, port: remotePort };
    await new Promise<void>((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.localPort, () => resolve());
    });
    this.socket.on('message', (buf) => this.onPacket(buf));
    this.socket.on('error', (err) => log.error('RTP-Socket:', err.message));

    // Der Takt orientiert sich an der Uhr, nicht an der Timer-Genauigkeit:
    // Windows-Timer sind grob, deshalb wird bei Verzug nachgeholt.
    const t0 = performance.now();
    let frames = 0;
    let lastTick = t0;
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - lastTick > this.maxTickGapMs) this.maxTickGapMs = now - lastTick;
      lastTick = now;
      const due = Math.floor((now - t0) / FRAME_MS);
      // Nach langen Hängern nicht hunderte Frames auf einmal senden
      if (due - frames > 10) frames = due - 10;
      const burst = due - frames;
      if (burst > 1) {
        this.bursts++;
        if (burst > this.maxBurst) this.maxBurst = burst;
      }
      while (frames < due) {
        this.sendFrame(frames === 0);
        frames++;
      }
    }, 5);
    log.info(`RTP: lokal :${this.localPort} -> ${remoteIp}:${remotePort}, PT ${this.payloadType} (${this.codec.law}/${this.codec.sampleRate})`);
  }

  setSource(source: FrameSource | undefined): void {
    this.source = source;
  }

  stop(): void {
    clearInterval(this.timer);
    try {
      this.socket.close();
    } catch {
      // bereits geschlossen
    }
  }

  private sendFrame(marker: boolean): void {
    const payload = this.source?.() ?? this.silence;
    // In Paketen der Größe, die auch die Gegenstelle nutzt (z. B. 10 ms bei HD), mit ihrem Zeitstempel-Takt
    for (let off = 0; off < payload.length; off += this.packetBytes) {
      const chunk = payload.subarray(off, Math.min(off + this.packetBytes, payload.length));
      const header = Buffer.alloc(12);
      header[0] = 0x80; // Version 2
      header[1] = (marker && off === 0 ? 0x80 : 0) | this.payloadType;
      header.writeUInt16BE(this.seq, 2);
      header.writeUInt32BE(this.timestamp >>> 0, 4);
      header.writeUInt32BE(this.ssrc, 8);
      this.seq = (this.seq + 1) & 0xffff;
      this.timestamp = (this.timestamp + Math.round(chunk.length * this.tsPerByte)) >>> 0;
      this.socket.send(Buffer.concat([header, chunk]), this.remote!.port, this.remote!.ip);
      this.packetsSent++;
    }
    this.emit('sent', payload);
  }

  private onPacket(buf: Buffer): void {
    if (buf.length < 12 || buf[0] >> 6 !== 2) return;
    const csrcCount = buf[0] & 0x0f;
    const hasExtension = (buf[0] & 0x10) !== 0;
    const payloadType = buf[1] & 0x7f;
    let offset = 12 + csrcCount * 4;
    if (hasExtension && buf.length >= offset + 4) offset += 4 + buf.readUInt16BE(offset + 2) * 4;
    let end = buf.length;
    if (buf[0] & 0x20) end -= buf[end - 1]; // Padding
    if (payloadType !== this.payloadType) return; // DTMF, Comfort Noise, anderer Codec: ignorieren
    this.packetsReceived++;
    this.learnPeer(buf.readUInt32BE(4), end - offset);
    this.emit('frame', buf.subarray(offset, end));
  }

  /**
   * Paketgröße und Zeitstempel-Takt der Gegenstelle aus den ersten Paketen ablesen und übernehmen.
   * Die FRITZ!Box schickt bei 16 kHz z. B. 10-ms-Pakete; weicht unser Takt ab, spielt sie abgehackt.
   */
  private learnPeer(ts: number, bytes: number): void {
    if (this.peerKnown) return;
    const last = this.lastRecv;
    this.lastRecv = { ts, bytes };
    if (!last || last.bytes !== bytes || bytes === 0) return;
    const step = (ts - last.ts) >>> 0;
    if (step === 0 || step > 8 * this.samplesPerFrame) return; // Dubletten, Sprünge: nächstes Paar abwarten
    this.peerKnown = true;
    this.tsPerByte = step / bytes;
    const frameBytes = this.samplesPerFrame;
    if (bytes < frameBytes && frameBytes % bytes === 0) this.packetBytes = bytes;
    log.info(`RTP: Gegenstelle sendet ${bytes} Byte je Paket, Zeitstempel +${step}; wir senden ${this.packetBytes} Byte je Paket, Zeitstempel +${Math.round(this.packetBytes * this.tsPerByte)}`);
  }
}
