// Machbarkeitstest Fax: PDF -> Fax-TIFF (Ghostscript) -> T.30 über G.711 (spandsp im Hilfsprozess faxmodem) -> SIP/RTP.
//
//   npm run fax-poc -- loopback <datei.pdf>         ohne Netz: Sender und Empfänger faxen gegeneinander
//   npm run fax-poc -- send <rufnummer> <datei.pdf>  echtes Fax über die FRITZ!Box (SIP-Zugang aus .env)
//
// Optionen: --ident <Absenderkennung>  --header <Kopfzeile>  --maxbit 14400|9600|4800  --normal (98 statt 196 dpi)
// Voraussetzung: MSYS2 mit spandsp und Ghostscript, faxmodem gebaut (tools/faxmodem/build.sh).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { log } from '../log.js';
import { SipClient } from '../sip/client.js';
import { buildOffer, codecLabel, parseAnswer } from '../sip/sdp.js';
import { RtpSession } from '../rtp/session.js';
import { decodeG711, encodeG711 } from '../rtp/g711.js';

const FRAME = 160; // 20 ms bei 8 kHz
const FRAME_BYTES = FRAME * 2;
const MSYS_BIN = process.env.MSYS2_BIN ?? 'C:\\msys64\\ucrt64\\bin';
const here = path.dirname(fileURLToPath(import.meta.url));
const FAXMODEM = path.resolve(here, '../../tools/faxmodem/bin/faxmodem.exe');

const args = process.argv.slice(2);
function opt(name: string, fallback = ''): string {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? fallback;
}
const ident = opt('--ident', process.env.FAX_IDENT ?? '');
const header = opt('--header', 'SIPFunk Fax-Test');
const maxbit = opt('--maxbit', '14400');
const normal = args.includes('--normal');
const pos = args.filter((a) => !a.startsWith('--'));
const childEnv = { ...process.env, PATH: `${MSYS_BIN};${process.env.PATH ?? ''}` };

/** PDF/PS -> mehrseitiges Fax-TIFF, 1728 Pixel breit (204 dpi auf 215 mm), A4-Höhe. */
async function toFaxTiff(src: string, dst: string): Promise<void> {
  const widthPt = (1728 / 204) * 72;
  const gsArgs = [
    '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT',
    '-sDEVICE=tiffg3', `-r204x${normal ? 98 : 196}`,
    `-dDEVICEWIDTHPOINTS=${widthPt.toFixed(2)}`, '-dDEVICEHEIGHTPOINTS=841.89',
    '-dFIXEDMEDIA', '-dPDFFitPage', '-dAdjustWidth=0',
    `-sOutputFile=${dst}`, src,
  ];
  await new Promise<void>((resolve, reject) => {
    const gs = spawn(path.join(MSYS_BIN, 'gswin64c.exe'), gsArgs, { env: childEnv });
    let err = '';
    gs.stderr.on('data', (d) => (err += d));
    gs.on('error', reject);
    gs.on('close', (code) => (code === 0 && existsSync(dst) ? resolve() : reject(new Error(`Ghostscript: ${code} ${err.trim()}`))));
  });
  log.info(`Fax-TIFF: ${dst} (${Math.round(statSync(dst).size / 1024)} KB)`);
}

interface FaxResult { code: number; pages: number; text: string }

/** Hilfsprozess faxmodem: je geschriebenem 20-ms-Frame kommt genau ein Frame zurück ('tx'). */
class FaxModem {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly result: Promise<FaxResult>;
  private pending = Buffer.alloc(0);
  onTx: (frame: Buffer) => void = () => undefined;

  constructor(readonly name: string, mode: 'send' | 'recv', tiff: string, verbose: boolean) {
    this.proc = spawn(FAXMODEM, [mode, tiff, ident, header, maxbit], { env: childEnv });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.pending = Buffer.concat([this.pending, d]);
      while (this.pending.length >= FRAME_BYTES) {
        const frame = this.pending.subarray(0, FRAME_BYTES);
        this.pending = this.pending.subarray(FRAME_BYTES);
        this.onTx(frame);
      }
    });
    this.proc.stdin.on('error', () => undefined); // Prozess schon beendet
    let resultLine = '';
    let rest = '';
    this.proc.stderr.on('data', (d: Buffer) => {
      const lines = (rest + d.toString('latin1')).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('RESULT ')) resultLine = line;
        else if (line.startsWith('PHASE ') || verbose) log.info(`[${this.name}] ${line}`);
      }
    });
    this.result = new Promise((resolve) => {
      this.proc.on('close', () => {
        const m = /^RESULT (-?\d+) (\d+) (.*)$/.exec(resultLine);
        resolve(m ? { code: Number(m[1]), pages: Number(m[2]), text: m[3] } : { code: -1, pages: 0, text: 'kein Ergebnis' });
      });
    });
  }

  write(frame: Buffer): void {
    if (this.proc.stdin.writable) this.proc.stdin.write(frame);
  }

  end(): void {
    if (this.proc.stdin.writable) this.proc.stdin.end();
  }
}

async function loopback(pdf: string): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sipfunk-fax-'));
  const tx = path.join(dir, 'senden.tif');
  const rx = path.join(dir, 'empfangen.tif');
  await toFaxTiff(pdf, tx);
  const a = new FaxModem('Sender', 'send', tx, false);
  const b = new FaxModem('Empfänger', 'recv', rx, false);
  // Wie auf der Leitung: jeder Frame einmal durch G.711 A-law
  const viaAlaw = (f: Buffer): Buffer => {
    const pcm = decodeG711(encodeG711(new Int16Array(f.buffer, f.byteOffset, FRAME), 'PCMA'), 'PCMA');
    return Buffer.from(pcm.buffer, pcm.byteOffset, FRAME_BYTES);
  };
  a.onTx = (f) => b.write(viaAlaw(f));
  b.onTx = (f) => a.write(viaAlaw(f));
  const silence = Buffer.alloc(FRAME_BYTES);
  a.write(silence);
  b.write(silence);
  const t0 = Date.now();
  void a.result.then(() => b.end());
  void b.result.then(() => a.end());
  const [ra, rb] = await Promise.all([a.result, b.result]);
  log.info(`Loopback in ${((Date.now() - t0) / 1000).toFixed(1)} s: Sender ${ra.code} „${ra.text}“ (${ra.pages} S.), Empfänger ${rb.code} „${rb.text}“ (${rb.pages} S.)`);
  log.info(`Empfangenes TIFF: ${rx}`);
  process.exit(ra.code === 0 && rb.code === 0 ? 0 : 1);
}

async function sendFax(number: string, pdf: string): Promise<void> {
  const config = loadConfig();
  if (!config.sipUser || !config.sipPassword) throw new Error('Konfiguration fehlt: SIP_USER und SIP_PASSWORD (siehe .env.example)');
  const dir = mkdtempSync(path.join(tmpdir(), 'sipfunk-fax-'));
  const tiff = path.join(dir, 'senden.tif');
  await toFaxTiff(pdf, tiff);

  const sip = new SipClient({
    server: config.sipServer, user: config.sipUser, password: config.sipPassword,
    localPort: config.sipLocalPort, localIp: config.localIp, debug: config.sipDebug,
  });
  await sip.start();
  // Nur 8 kHz (spandsp-Modems), keine Sprachpausen-Unterdrückung: der Faxton darf nie durch Comfort Noise ersetzt werden
  const offer = buildOffer(sip.localIp, config.rtpPort, false).replace('a=sendrecv', 'a=silenceSupp:off - - - -\r\na=sendrecv');
  const call = sip.call(number, offer);
  let rtp: RtpSession | undefined;
  let modem: FaxModem | undefined;
  const maxTimer = setTimeout(() => { log.warn('Zeitlimit 10 min: lege auf'); call.hangup(); }, 10 * 60_000);

  call.on('state', (s) => log.info(`Anruf: ${s}`));
  call.on('answered', (sdp: string) => {
    const ans = parseAnswer(sdp, false);
    log.info(`Verbunden: ${codecLabel(ans.codec)} zu ${ans.ip}:${ans.port}`);
    const law = ans.codec.law;
    rtp = new RtpSession(config.rtpPort, ans.codec);
    modem = new FaxModem('Fax', 'send', tiff, process.env.FAX_VERBOSE === '1');
    // Empfangene Samples puffern (Paketgröße der Gegenstelle egal), 40 ms Vorpuffer gegen Jitter
    let rxBuf = new Int16Array(0);
    let primed = false;
    const txQueue: Buffer[] = [];
    let underruns = 0;
    rtp.on('frame', (payload: Buffer) => {
      const pcm = decodeG711(payload, law);
      const merged = new Int16Array(rxBuf.length + pcm.length);
      merged.set(rxBuf);
      merged.set(pcm, rxBuf.length);
      // Uhrendrift: nie mehr als 200 ms puffern
      rxBuf = merged.length > 1600 ? merged.subarray(merged.length - 640) : merged;
      if (rxBuf.length >= 2 * FRAME) primed = true;
    });
    modem.onTx = (f) => txQueue.push(f);
    const zero = new Int16Array(FRAME);
    rtp.setSource(() => {
      let frame = zero;
      if (primed && rxBuf.length >= FRAME) {
        frame = rxBuf.slice(0, FRAME);
        rxBuf = rxBuf.subarray(FRAME);
      } else if (primed) underruns++;
      modem!.write(Buffer.from(frame.buffer, frame.byteOffset, FRAME_BYTES));
      const out = txQueue.shift();
      return encodeG711(out ? new Int16Array(out.buffer, out.byteOffset, FRAME) : zero, law);
    });
    void rtp.start(ans.ip, ans.port);
    void modem.result.then((r) => {
      log.info(`Fax-Ergebnis: ${r.code} „${r.text}“, ${r.pages} Seite(n); RTP-Unterläufe: ${underruns}`);
      setTimeout(() => call.hangup(), 500); // Schlusspause, dann auflegen
    });
  });
  call.once('ended', async (reason: string) => {
    clearTimeout(maxTimer);
    log.info(`Anruf beendet: ${reason}`);
    rtp?.stop();
    modem?.end();
    const r = modem ? await modem.result : { code: -1, pages: 0, text: 'nicht verbunden' };
    await sip.stop();
    log.info(r.code === 0 ? `ERFOLG: ${r.pages} Seite(n) zugestellt` : `FEHLGESCHLAGEN: ${r.text}`);
    process.exit(r.code === 0 ? 0 : 1);
  });
  process.on('SIGINT', () => call.hangup());
}

if (!existsSync(FAXMODEM)) throw new Error(`faxmodem fehlt: ${FAXMODEM} – erst tools/faxmodem/build.sh ausführen`);
const [mode, a1, a2] = pos;
if (mode === 'loopback' && a1) await loopback(a1);
else if (mode === 'send' && a1 && a2) await sendFax(a1, a2);
else {
  console.log('Aufruf: npm run fax-poc -- loopback <datei.pdf> | send <rufnummer> <datei.pdf> [--ident ..] [--header ..] [--maxbit 9600] [--normal]');
  process.exit(2);
}
