// Fax: Loopback über spandsp (faxmodem) und G.711, Annahmeprüfung des Faxdienstes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeG711, encodeG711 } from '../src/rtp/g711.js';
import { FAX_FRAME, FAX_FRAME_BYTES, FaxModem, faxPrerequisites, toFaxTiff } from '../src/fax/modem.js';
import { FaxService } from '../src/fax/service.js';
import { cleanPostScript, FaxPrintPort, postScriptInfo, type PrintedDocument } from '../src/fax/printPort.js';
import { connect } from 'node:net';

const missing = faxPrerequisites();
const skip = missing.length ? `Fax-Bausteine fehlen: ${missing.join(', ')}` : false;
const PDF = path.resolve('tools/faxmodem/test/testseite.pdf');

test('Fax: eine Seite über A-law von Sender zu Empfänger', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sipfunk-fax-test-'));
  const tx = path.join(dir, 'tx.tif');
  await toFaxTiff(PDF, tx);
  const a = new FaxModem('send', tx);
  const b = new FaxModem('recv', path.join(dir, 'rx.tif'));
  const viaAlaw = (f: Buffer): Buffer => {
    const pcm = decodeG711(encodeG711(new Int16Array(f.buffer, f.byteOffset, FAX_FRAME), 'PCMA'), 'PCMA');
    return Buffer.from(pcm.buffer, pcm.byteOffset, FAX_FRAME_BYTES);
  };
  a.onTx = (f) => b.write(viaAlaw(f));
  b.onTx = (f) => a.write(viaAlaw(f));
  a.write(Buffer.alloc(FAX_FRAME_BYTES));
  b.write(Buffer.alloc(FAX_FRAME_BYTES));
  void a.result.then(() => b.end());
  void b.result.then(() => a.end());
  const [ra, rb] = await Promise.all([a.result, b.result]);
  assert.equal(ra.code, 0, ra.text);
  assert.equal(rb.code, 0, rb.text);
  assert.equal(rb.pages, 1);
});

test('Fax: gesperrte Ziele, Nebenstellen und Nicht-PDFs werden abgelehnt', () => {
  const fax = new FaxService({ sipServer: '127.0.0.1', user: 'fax', password: 'x', sipLocalPort: 0, rtpPort: 0 });
  const pdf = readFileSync(PDF);
  assert.throws(() => fax.submit('0900123456', pdf), /Mehrwertnummer/);
  assert.throws(() => fax.submit('**610', pdf), /Nebenstellen/);
  assert.throws(() => fax.submit('030123456', Buffer.from('kein pdf')), /Kein PDF/);
});

test('Fax-Drucker: PJL-Umschlag weg, Titel und Seitenzahl aus den DSC-Kommentaren', () => {
  const ps = '%!PS-Adobe-3.0\n%%Title: (Rechnung 42.pdf)\n%%Pages: (atend)\nshowpage\n%%Pages: 3\n%%EOF\n';
  const job = Buffer.from('\x1b%-12345X@PJL JOB\r\n@PJL ENTER LANGUAGE=POSTSCRIPT\r\n' + ps + '\x1b%-12345X@PJL EOJ\r\n', 'latin1');
  const clean = cleanPostScript(job);
  assert.equal(clean.toString('latin1'), ps);
  assert.deepEqual(postScriptInfo(clean), { title: 'Rechnung 42.pdf', pages: 3 });
  assert.throws(() => cleanPostScript(Buffer.from('PCL-Daten')), /kein PostScript/);
});

test('Fax-Drucker: Druckauftrag über TCP wird zum PDF-Entwurf', { skip }, async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  let resolveDoc!: (d: PrintedDocument) => void;
  const got = new Promise<PrintedDocument>((r) => (resolveDoc = r));
  const printer = new FaxPrintPort(port, resolveDoc);
  await printer.start();
  try {
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.end(readFileSync('tools/faxmodem/test/testseite.ps'));
    const doc = await got;
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    const fax = new FaxService({ sipServer: '127.0.0.1', user: 'fax', password: 'x', sipLocalPort: 0, rtpPort: 0 });
    const draft = fax.addDraft(doc.name, doc.pdf, doc.pages);
    assert.equal(fax.status().drafts[0].id, draft.id);
    assert.throws(() => fax.sendDraft(draft.id, '0900123'), /Mehrwertnummer/);
    assert.equal(fax.status().drafts.length, 1, 'abgelehnte Nummer: Entwurf bleibt');
    assert.ok(fax.discardDraft(draft.id));
    assert.equal(fax.status().drafts.length, 0);
  } finally {
    printer.stop();
  }
});

test('Fax-Drucker: nur Aufträge, die mit PostScript oder PJL beginnen (keine HTTP-Anfragen)', () => {
  assert.throws(() => cleanPostScript(Buffer.from('POST / HTTP/1.1\r\nHost: 127.0.0.1:9101\r\n\r\n%!PS-Adobe-3.0\nshowpage\n')), /kein PostScript/);
  assert.equal(cleanPostScript(Buffer.from('\x04\r\n%!PS-Adobe-3.0\nshowpage\n', 'latin1')).toString('latin1'), '%!PS-Adobe-3.0\nshowpage\n');
});

test('Fax im Anrufe-Log: Protokoll mit mode „fax“, in der Liste und als Markdown', async () => {
  const { TranscriptStore } = await import('../src/transcripts.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'sipfunk-faxlog-'));
  const store = new TranscriptStore(dir, 7);
  const id = TranscriptStore.makeId(new Date('2026-11-26T10:00:00Z'), '0301234567') + '_fax';
  store.save({
    id, startedAt: '2026-11-26T10:00:00.000Z', endedAt: '2026-11-26T10:00:48.000Z', target: '0301234567', mode: 'fax',
    durationSec: 48, endReason: 'zugestellt', entries: [], summary: 'Fax „Rechnung“: 2 Seite(n) zugestellt',
    fax: { name: 'Rechnung', delivered: true, pages: 2, totalPages: 2, bitRate: 14400, ecm: true },
  });
  const item = store.list().find((r) => r.id === id);
  assert.equal(item?.mode, 'fax');
  assert.equal(item?.fax?.pages, 2);
  assert.match(readFileSync(path.join(dir, `${id}.md`), 'utf8'), /^# Fax .*\n\n- Dokument: Rechnung\n- Ergebnis: zugestellt\n- Seiten: 2 von 2/);
});
