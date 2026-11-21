// Faxversand über ein eigenes IP-Telefon der FRITZ!Box: eigene SIP-Anmeldung, damit Faxe und KI-Anrufe sich
// nicht in die Quere kommen. Ein Fax nach dem anderen; Medien: T.30 über G.711 (8 kHz), T.38 wird abgelehnt (488).
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { log } from '../log.js';
import { checkDialTarget, normalizeTarget } from '../dialPolicy.js';
import { SipClient } from '../sip/client.js';
import { buildOffer, parseAnswer } from '../sip/sdp.js';
import { RtpSession } from '../rtp/session.js';
import { decodeG711, encodeG711 } from '../rtp/g711.js';
import { FAX_FRAME, FAX_FRAME_BYTES, FaxModem, faxPrerequisites, toFaxTiff, type FaxResult } from './modem.js';

export interface FaxServiceOptions {
  sipServer: string;
  user: string;
  password: string;
  sipLocalPort: number;
  rtpPort: number;
  localIp?: string;
  sipDebug?: boolean;
  /** Absenderkennung (TSI), z. B. die eigene Faxnummer */
  ident?: string;
  /** Kopfzeile auf jeder Seite */
  header?: string;
  maxBitRate?: number;
}

export type FaxJobState = 'queued' | 'converting' | 'dialing' | 'sending' | 'done' | 'failed';

export interface FaxJob {
  id: string;
  number: string;
  /** Dokumentname für die Anzeige */
  name: string;
  state: FaxJobState;
  created: string;
  finished?: string;
  pages?: number;
  /** Gegenstelle laut Faxprotokoll (CSI) */
  remoteIdent?: string;
  error?: string;
}

/** Gedrucktes Dokument, das auf die Zielnummer wartet */
export interface FaxDraft {
  id: string;
  name: string;
  pages?: number;
  created: string;
}

/** Höchstdauer eines Faxanrufs */
const MAX_CALL_MS = 15 * 60_000;
const KEEP_JOBS = 50;
const KEEP_DRAFTS = 10;

/** Events: 'job' (FaxJob) bei jeder Zustandsänderung, 'draft' (FaxDraft) für ein neu gedrucktes Dokument, 'drafts' bei Änderungen der Entwürfe */
export class FaxService extends EventEmitter {
  private readonly sip: SipClient;
  private readonly jobs: FaxJob[] = [];
  private readonly files = new Map<string, string>();
  private readonly drafts = new Map<string, FaxDraft & { pdf: Buffer }>();
  private registered = false;
  private busy = false;
  /** Laufende Anmeldung: gleichzeitige Aufrufer teilen sie sich */
  private registering?: Promise<void>;
  private stopped = false;

  constructor(private readonly opts: FaxServiceOptions) {
    super();
    this.sip = new SipClient({
      server: opts.sipServer, user: opts.user, password: opts.password,
      localPort: opts.sipLocalPort, localIp: opts.localIp, debug: opts.sipDebug,
    });
  }

  async start(): Promise<void> {
    const missing = faxPrerequisites();
    if (missing.length) log.warn(`Fax: es fehlt ${missing.join(', ')}`);
    await this.ensureRegistered().catch((err) => log.warn(`Fax: Anmeldung an der FRITZ!Box fehlgeschlagen: ${(err as Error).message}`));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.sip.stop();
    // PDFs aller Aufträge aus dem Temp-Ordner entfernen, auch des laufenden: der Prozess endet gleich danach
    // (ein Ordner, den Ghostscript oder faxmodem noch offen hält, darf das Beenden nicht scheitern lassen)
    for (const dir of this.files.values()) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* bleibt liegen */ }
    }
    this.files.clear();
  }

  status(): { registered: boolean; user: string; missing: string[]; jobs: FaxJob[]; drafts: FaxDraft[] } {
    const drafts = [...this.drafts.values()].map(({ pdf: _pdf, ...d }) => d).reverse();
    return { registered: this.registered, user: this.opts.user, missing: faxPrerequisites(), jobs: [...this.jobs].reverse(), drafts };
  }

  /** Gedrucktes Dokument ablegen; das Fax-Fenster fragt dann nach der Zielnummer. */
  addDraft(name: string, pdf: Buffer, pages?: number): FaxDraft {
    const draft: FaxDraft = { id: randomBytes(6).toString('hex'), name, pages, created: new Date().toISOString() };
    this.drafts.set(draft.id, { ...draft, pdf });
    while (this.drafts.size > KEEP_DRAFTS) {
      const oldest = this.drafts.values().next().value!;
      this.drafts.delete(oldest.id);
      log.warn(`Fax: Druckauftrag „${oldest.name}“ verworfen (mehr als ${KEEP_DRAFTS} warten)`);
    }
    this.emit('draft', draft);
    this.emit('drafts');
    return draft;
  }

  /** Entwurf an `number` faxen; der Entwurf ist danach weg (auch wenn die Nummer abgelehnt wird, bleibt er). */
  sendDraft(id: string, number: string): FaxJob {
    const draft = this.drafts.get(id);
    if (!draft) throw new Error('Druckauftrag nicht mehr vorhanden');
    const job = this.submit(number, draft.pdf, draft.name);
    this.drafts.delete(id);
    this.emit('drafts');
    return job;
  }

  discardDraft(id: string): boolean {
    const ok = this.drafts.delete(id);
    if (ok) this.emit('drafts');
    return ok;
  }

  /** Entwurf als PDF (Vorschau im Fax-Fenster) */
  draftPdf(id: string): Buffer | undefined {
    return this.drafts.get(id)?.pdf;
  }

  /** Nimmt ein PDF zum Versand an; liefert den Auftrag (Zustand dann über status()/Event 'job'). */
  submit(numberRaw: string, pdf: Buffer, name = 'Dokument.pdf'): FaxJob {
    const number = normalizeTarget(numberRaw);
    const blocked = checkDialTarget(number);
    if (blocked) throw new Error(blocked);
    if (number.startsWith('**')) throw new Error('Interne Nebenstellen können kein Fax empfangen');
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Kein PDF');
    const missing = faxPrerequisites();
    if (missing.length) throw new Error(`Faxen nicht möglich, es fehlt: ${missing.join(', ')}`);

    const job: FaxJob = { id: randomBytes(6).toString('hex'), number, name, state: 'queued', created: new Date().toISOString() };
    const dir = mkdtempSync(path.join(tmpdir(), 'sipfunk-fax-'));
    writeFileSync(path.join(dir, 'dokument.pdf'), pdf);
    this.files.set(job.id, dir);
    this.jobs.push(job);
    // Nur abgeschlossene Aufträge fallen aus der Liste; wartende bleiben, bis sie gesendet sind
    while (this.jobs.length > KEEP_JOBS) {
      const i = this.jobs.findIndex((j) => j.state === 'done' || j.state === 'failed');
      if (i < 0) break;
      this.jobs.splice(i, 1);
    }
    this.emit('job', job);
    log.info(`Fax: Auftrag ${job.id} angenommen (${name})`);
    void this.pump();
    return job;
  }

  private update(job: FaxJob, patch: Partial<FaxJob>): void {
    Object.assign(job, patch);
    this.emit('job', job);
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) return;
    this.registering ??= this.sip.start().then(
      () => {
        // Während der Anmeldung beendet (stop() hat den Client schon geschlossen): nicht weitermachen
        if (this.stopped) throw new Error('Faxdienst beendet');
        this.registered = true;
      },
    ).finally(() => (this.registering = undefined));
    await this.registering;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.next(); job && !this.stopped; job = this.next()) {
        const dir = this.files.get(job.id)!;
        try {
          this.update(job, { state: 'converting' });
          const tiff = path.join(dir, 'senden.tif');
          await toFaxTiff(path.join(dir, 'dokument.pdf'), tiff);
          await this.ensureRegistered();
          const r = await this.transmit(job, tiff);
          if (r.code === 0) this.update(job, { state: 'done', pages: r.pages, finished: new Date().toISOString() });
          else this.update(job, { state: 'failed', pages: r.pages, error: r.text, finished: new Date().toISOString() });
          log.info(`Fax: Auftrag ${job.id} ${r.code === 0 ? `zugestellt (${r.pages} Seite(n))` : `fehlgeschlagen: ${r.text}`}`);
        } catch (err) {
          this.update(job, { state: 'failed', error: (err as Error).message, finished: new Date().toISOString() });
          log.warn(`Fax: Auftrag ${job.id} fehlgeschlagen: ${(err as Error).message}`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
          this.files.delete(job.id);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private next(): FaxJob | undefined {
    return this.jobs.find((j) => j.state === 'queued');
  }

  /** Ein Faxanruf: wählen, nach dem Abheben T.30 über G.711 bis Phase E, dann auflegen. */
  private transmit(job: FaxJob, tiff: string): Promise<FaxResult> {
    return new Promise((resolve) => {
      this.update(job, { state: 'dialing' });
      // Nur 8 kHz (spandsp-Modems); keine Sprachpausen-Unterdrückung, sonst ersetzt Comfort Noise den Faxton
      const offer = buildOffer(this.sip.localIp, this.opts.rtpPort, false).replace('a=sendrecv', 'a=silenceSupp:off - - - -\r\na=sendrecv');
      const call = this.sip.call(job.number, offer);
      let rtp: RtpSession | undefined;
      let modem: FaxModem | undefined;
      const limit = setTimeout(() => {
        log.warn(`Fax: Zeitlimit für Auftrag ${job.id}, lege auf`);
        call.hangup();
      }, MAX_CALL_MS);

      call.on('answered', (sdp: string) => {
        let law: 'PCMA' | 'PCMU';
        try {
          const ans = parseAnswer(sdp, false);
          law = ans.codec.law;
          rtp = new RtpSession(this.opts.rtpPort, ans.codec);
          void rtp.start(ans.ip, ans.port).catch((err) => {
            log.warn(`Fax: RTP-Port ${this.opts.rtpPort}: ${(err as Error).message}`);
            call.hangup();
          });
        } catch (err) {
          log.warn(`Fax: ${(err as Error).message}`);
          call.hangup();
          return;
        }
        this.update(job, { state: 'sending' });
        modem = new FaxModem('send', tiff, {
          ident: this.opts.ident,
          header: this.opts.header,
          maxBitRate: this.opts.maxBitRate,
          verbose: this.opts.sipDebug,
          onPhase: (line) => {
            const ident = /^PHASE B gegenstelle="(.*)"$/.exec(line)?.[1]?.trim();
            if (ident) this.update(job, { remoteIdent: ident });
            const pages = /^PHASE D seiten=(\d+)/.exec(line)?.[1];
            if (pages) this.update(job, { pages: Number(pages) });
          },
        });
        // Empfang puffern (Paketgröße der Gegenstelle egal), 40 ms Vorpuffer gegen Jitter. Rückstand (Uhrendrift) baut sich
        // alle 25 Pakete um einen einzelnen Abtastwert ab (250 ppm, mehr Drift haben Uhren nicht); erst ab 2 s wird hart gekürzt
        let rxBuf = new Int16Array(0);
        let primed = false;
        let rxPackets = 0;
        const txQueue: Buffer[] = [];
        rtp!.on('frame', (payload: Buffer) => {
          const pcm = decodeG711(payload, law);
          const merged = new Int16Array(rxBuf.length + pcm.length);
          merged.set(rxBuf);
          merged.set(pcm, rxBuf.length);
          rxPackets++;
          rxBuf = merged.length > 16000 ? merged.subarray(merged.length - 1600) : merged.length > 3200 && rxPackets % 25 === 0 ? merged.subarray(1) : merged;
          if (rxBuf.length >= 2 * FAX_FRAME) primed = true;
        });
        modem.onTx = (f) => txQueue.push(f);
        // Senden erst mit zwei Frames Vorrat: kommt eine Antwort von faxmodem einmal zu spät, reißt der Träger nicht ab
        let txPrimed = false;
        const zero = new Int16Array(FAX_FRAME);
        rtp!.setSource(() => {
          let frame = zero;
          if (primed && rxBuf.length >= FAX_FRAME) {
            frame = rxBuf.slice(0, FAX_FRAME);
            rxBuf = rxBuf.subarray(FAX_FRAME);
          }
          modem!.write(Buffer.from(frame.buffer, frame.byteOffset, FAX_FRAME_BYTES));
          if (!txPrimed && txQueue.length >= 2) txPrimed = true;
          const out = txPrimed ? txQueue.shift() : undefined;
          return encodeG711(out ? new Int16Array(out.buffer, out.byteOffset, FAX_FRAME) : zero, law);
        });
        // Faxprotokoll fertig: kurze Schlusspause, dann auflegen (meist hat die Gegenstelle schon aufgelegt)
        void modem.result.then(() => setTimeout(() => call.hangup(), 500));
      });

      call.once('ended', (reason: string) => {
        clearTimeout(limit);
        rtp?.stop();
        if (!modem) return resolve({ code: -1, pages: 0, text: reason });
        modem.end();
        void modem.result.then(resolve);
      });
    });
  }
}
