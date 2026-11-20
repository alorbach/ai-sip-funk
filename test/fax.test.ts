// Fax: Loopback über spandsp (faxmodem) und G.711, Annahmeprüfung des Faxdienstes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeG711, encodeG711 } from '../src/rtp/g711.js';
import { FAX_FRAME, FAX_FRAME_BYTES, FaxModem, faxPrerequisites, toFaxTiff } from '../src/fax/modem.js';
import { FaxService } from '../src/fax/service.js';

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
