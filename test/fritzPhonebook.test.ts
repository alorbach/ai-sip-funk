// FRITZ!Box-Telefonbuch: XML (Export oder TR-064) in Vorschläge, Faxnummern erkannt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FritzPhonebook, parseFritzPhonebook } from '../src/fritzPhonebook.js';

const XML = `<?xml version="1.0" encoding="utf-8"?>
<phonebooks><phonebook owner="1" name="Telefonbuch">
<contact><category>0</category><person><realName>Müller &amp; Söhne</realName></person>
<telephony nid="3"><number type="work" prio="1" id="0">030 1234567</number><number type="fax_work" id="1">030 1234568</number><number type="fax_work" id="2"></number></telephony></contact>
<contact><person><realName><![CDATA[Anna]]></realName></person><telephony><number type="mobile">+49 171 2345678</number><number type="intern">**610</number></telephony></contact>
<contact><person><realName></realName></person><telephony><number type="home">0301</number></telephony></contact>
</phonebook></phonebooks>`;

test('FRITZ!Box-Telefonbuch: Namen, Nummern und Faxnummern', () => {
  assert.deepEqual(parseFritzPhonebook(XML), [
    { name: 'Anna', number: '01712345678', label: 'mobil', book: 'Telefonbuch' },
    { name: 'Anna', number: '**610', label: 'sonstige', book: 'Telefonbuch' },
    { name: 'Müller & Söhne', number: '0301234567', label: 'geschäftlich', book: 'Telefonbuch' },
    { name: 'Müller & Söhne', number: '0301234568', label: 'fax', book: 'Telefonbuch' },
  ]);
});

test('FRITZ!Box-Telefonbuch: ohne Zugangsdaten aus der gespeicherten Datei', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sipfunk-fritz-')), 'fritz-telefonbuch.xml');
  const pb = new FritzPhonebook({ host: '127.0.0.1', xmlFile: file });
  assert.equal((await pb.get()).source, null);
  assert.throws(() => pb.saveXml('<html></html>'), /Keine Telefonbuch-Datei/);
  assert.equal(pb.saveXml(XML), 4);
  const st = await pb.get();
  assert.equal(st.source, 'xml');
  assert.equal(st.items.filter((x) => x.label === 'fax').length, 1);
  pb.removeXml();
  assert.equal((await pb.get()).source, null);
});
