// Fax-Test ohne App: PDF -> Fax-TIFF (Ghostscript) -> T.30 über G.711 (spandsp im Hilfsprozess faxmodem) -> SIP/RTP.
//
//   npm run fax-poc -- loopback <datei.pdf>         ohne Netz: Sender und Empfänger faxen gegeneinander (über A-law)
//   npm run fax-poc -- send <rufnummer> <datei.pdf>  echtes Fax über den Fax-Zugang aus der .env (FAX_SIP_USER/FAX_SIP_PASSWORD)
//
// Voraussetzung: MSYS2 mit spandsp und Ghostscript, faxmodem gebaut (tools/faxmodem/build.sh).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { log } from '../log.js';
import { decodeG711, encodeG711 } from '../rtp/g711.js';
import { FAX_FRAME, FAX_FRAME_BYTES, FaxModem, faxPrerequisites, toFaxTiff } from '../fax/modem.js';
import { FaxService } from '../fax/service.js';

async function loopback(pdf: string): Promise<boolean> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sipfunk-fax-'));
  const tx = path.join(dir, 'senden.tif');
  const rx = path.join(dir, 'empfangen.tif');
  await toFaxTiff(pdf, tx);
  const a = new FaxModem('send', tx, { header: 'SIPFunk Loopback' });
  const b = new FaxModem('recv', rx);
  // Wie auf der Leitung: jeder Frame einmal durch G.711 A-law
  const viaAlaw = (f: Buffer): Buffer => {
    const pcm = decodeG711(encodeG711(new Int16Array(f.buffer, f.byteOffset, FAX_FRAME), 'PCMA'), 'PCMA');
    return Buffer.from(pcm.buffer, pcm.byteOffset, FAX_FRAME_BYTES);
  };
  a.onTx = (f) => b.write(viaAlaw(f));
  b.onTx = (f) => a.write(viaAlaw(f));
  const silence = Buffer.alloc(FAX_FRAME_BYTES);
  a.write(silence);
  b.write(silence);
  void a.result.then(() => b.end());
  void b.result.then(() => a.end());
  const [ra, rb] = await Promise.all([a.result, b.result]);
  log.info(`Loopback: Sender ${ra.code} „${ra.text}“ (${ra.pages} S.), Empfänger ${rb.code} „${rb.text}“ (${rb.pages} S.) – ${rx}`);
  return ra.code === 0 && rb.code === 0;
}

async function send(number: string, pdf: string): Promise<boolean> {
  const config = loadConfig();
  if (!config.fax.sipUser || !config.fax.sipPassword) throw new Error('Konfiguration fehlt: FAX_SIP_USER und FAX_SIP_PASSWORD (siehe .env.example)');
  const fax = new FaxService({
    sipServer: config.sipServer, user: config.fax.sipUser, password: config.fax.sipPassword,
    sipLocalPort: config.fax.sipLocalPort, rtpPort: config.fax.rtpPort, localIp: config.localIp,
    sipDebug: config.sipDebug, ident: config.fax.ident, header: config.fax.header, maxBitRate: config.fax.maxBitRate,
  });
  await fax.start();
  const job = fax.submit(number, readFileSync(pdf), path.basename(pdf));
  const done = await new Promise<boolean>((resolve) => {
    fax.on('job', (j) => {
      if (j.id !== job.id) return;
      log.info(`Fax: ${j.state}${j.pages ? `, ${j.pages} Seite(n)` : ''}${j.error ? ` – ${j.error}` : ''}`);
      if (j.state === 'done' || j.state === 'failed') resolve(j.state === 'done');
    });
  });
  await fax.stop();
  return done;
}

const missing = faxPrerequisites();
if (missing.length) throw new Error(`Es fehlt: ${missing.join(', ')}`);
const [mode, a1, a2] = process.argv.slice(2);
let ok: boolean;
if (mode === 'loopback' && a1) ok = await loopback(a1);
else if (mode === 'send' && a1 && a2) ok = await send(a1, a2);
else {
  console.log('Aufruf: npm run fax-poc -- loopback <datei.pdf> | send <rufnummer> <datei.pdf>');
  process.exit(2);
}
process.exit(ok ? 0 : 1);
