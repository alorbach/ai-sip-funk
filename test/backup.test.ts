import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { BackupPasswordError, createBackup, readBackup, restoreContacts, restoredConfig } from '../src/backup.js';
import { ContactStore } from '../src/contacts.js';
import { fromCsv, fromVcard } from '../src/contactImport.js';
import { toCsv, toVcard } from '../src/contactExport.js';

const ENV = 'SIP_SERVER=fritz.box\nSIP_USER=sipfunk\nSIP_PASSWORD=geheim1\nOPENAI_API_KEY=sk-test\nAI_KEY_ZWEI=k2\nLOCAL_IP=192.168.1.5\nWEB_PORT=3999\nFAX_USER=fax\n';
const SETTINGS = JSON.stringify({ aiName: 'Alex', incomingProfiles: '[{"number":"123","name":"Max"}]', scamNumbers: '0900', smtpHost: 'mail.example.org', smtpPass: 'mailgeheim', webPort: '3999' });

function withStore(fn: (store: ContactStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-b-'));
  try {
    fn(new ContactStore(join(dir, 'contacts.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Sicherung ohne Kennwörter: Klartext, ohne Geheimnisse und ohne rechnerbezogene Werte', () => {
  const text = createBackup({ envText: ENV, settingsText: SETTINGS, contacts: [], mailTokenText: '{"refresh":"x"}' }, { secrets: false, app: '1.0.7' });
  assert.ok(!/geheim|sk-test|k2|192\.168|3999/.test(text), 'Geheimnisse oder lokale Werte in der Sicherung');
  const { data, secrets } = readBackup(text);
  assert.equal(secrets, false);
  assert.deepEqual(data.env, { SIP_SERVER: 'fritz.box', SIP_USER: 'sipfunk', FAX_USER: 'fax' });
  assert.equal(data.settings.aiName, 'Alex');
  assert.equal(data.settings.incomingProfiles, '[{"number":"123","name":"Max"}]');
  assert.equal(data.settings.smtpPass, undefined);
  assert.equal(data.mailToken, undefined);
});

test('Sicherung mit Kennwörtern: verschlüsselt, nur mit dem richtigen Passwort lesbar', () => {
  assert.throws(() => createBackup({ envText: ENV, settingsText: SETTINGS, contacts: [] }, { secrets: true, password: 'kurz', app: '1' }), /8 Zeichen/);
  const text = createBackup({ envText: ENV, settingsText: SETTINGS, contacts: [], mailTokenText: '{"refresh":"x"}' }, { secrets: true, password: 'richtig-lang', app: '1' });
  assert.ok(!/geheim|sk-test|Alex/.test(text), 'Klartext in verschlüsselter Sicherung');
  assert.throws(() => readBackup(text), BackupPasswordError);
  assert.throws(() => readBackup(text, 'falsch-falsch'), BackupPasswordError);
  const { data } = readBackup(text, 'richtig-lang');
  assert.equal(data.env.SIP_PASSWORD, 'geheim1');
  assert.equal(data.env.AI_KEY_ZWEI, 'k2');
  assert.equal(data.env.LOCAL_IP, undefined);
  assert.equal(data.settings.smtpPass, 'mailgeheim');
  assert.deepEqual(data.mailToken, { refresh: 'x' });
});

test('Fremde oder neuere Dateien werden abgelehnt', () => {
  assert.throws(() => readBackup('kein json'), /keine SIPFunk-Sicherung/);
  assert.throws(() => readBackup('{"format":"x"}'), /keine SIPFunk-Sicherung/);
  assert.throws(() => readBackup('{"format":"sipfunk-backup","version":99,"data":{}}'), /neueren/);
});

test('Wiederherstellen: ersetzt Einstellungen, behält vorhandene Geheimnisse und den Port', () => {
  const backup = readBackup(createBackup({ envText: 'SIP_SERVER=fritz.box\nSIP_USER=alt\nAI_NAME=Bea\n', settingsText: JSON.stringify({ aiName: 'Bea', smtpHost: 'mail.example.org' }), contacts: [] }, { secrets: false, app: '1' })).data;
  const next = restoredConfig(backup, { envText: '# Kommentar\nSIP_SERVER=fritz.box\nSIP_USER=neu\nSIP_PASSWORD=bleibt\nWEB_PORT=4000\n', settingsText: SETTINGS });
  const env = parseEnv(next.envText);
  assert.equal(env.SIP_USER, 'alt');
  assert.equal(env.SIP_PASSWORD, 'bleibt');
  assert.equal(env.WEB_PORT, '4000');
  assert.ok(next.envText.startsWith('# Kommentar'));
  const s = JSON.parse(next.settingsText);
  assert.equal(s.aiName, 'Bea');
  assert.equal(s.smtpPass, 'mailgeheim');
  assert.equal(s.webPort, '3999');
});

test('Wiederherstellen: anderer Server ohne Kennwort in der Sicherung -> altes Kennwort entfällt', () => {
  const backup = readBackup(createBackup({ envText: 'SIP_SERVER=10.0.0.9\n', settingsText: JSON.stringify({ smtpHost: 'andere.example.org' }), contacts: [] }, { secrets: false, app: '1' })).data;
  const next = restoredConfig(backup, { envText: 'SIP_SERVER=fritz.box\nSIP_PASSWORD=alt\nFAX_PASSWORD=faxalt\n', settingsText: SETTINGS });
  const env = parseEnv(next.envText);
  assert.equal(env.SIP_PASSWORD, '');
  assert.equal(env.FAX_PASSWORD, '');
  assert.equal(JSON.parse(next.settingsText).smtpPass, '');
});

test('Wiederherstellen: Kontakte werden zusammengeführt', () => {
  withStore((store) => {
    store.create({ name: 'Max', number: '0171 1111111' });
    const now = new Date().toISOString();
    const r = restoreContacts(store, [
      { id: 'a', name: 'Max M.', number: '01711111111', numbers: ['030 2222222'], createdAt: now, updatedAt: now },
      { id: 'b', name: 'Erika', number: '0221 3333333', notes: 'Fax', persona: 'freundlich', createdAt: now, updatedAt: now },
    ]);
    assert.deepEqual([r.created, r.merged], [1, 1]);
    assert.deepEqual(store.findByNumber('0302222222')?.name, 'Max');
    const erika = store.findByNumber('02213333333');
    assert.equal(erika?.notes, 'Fax');
    assert.equal(erika?.persona, 'freundlich');
    assert.notEqual(erika?.id, 'b');
  });
});

test('Kontakt-Export: vCard und CSV lassen sich wieder importieren', () => {
  withStore((store) => {
    store.create({ name: 'Weber, Thomas; Praxis', number: '02443 31358', numbers: ['0171 5550100'], notes: 'Zeile 1\nZeile 2' });
    store.create({ name: 'Müller', number: '0221 1234567' });
    const list = store.list();
    const vcf = fromVcard(toVcard(list));
    const csv = fromCsv(toCsv(list).replace(/^﻿/, ''));
    for (const imported of [vcf, csv]) {
      const weber = imported.find((c) => c.name === 'Weber, Thomas; Praxis');
      assert.ok(weber, 'Name mit Komma und Semikolon');
      assert.deepEqual(weber!.numbers.map((n) => n.number).sort(), ['0171555010' + '0', '0244331358'].sort());
      assert.ok(imported.some((c) => c.name === 'Müller'));
    }
    assert.ok(toVcard(list).includes('NOTE:Zeile 1\\nZeile 2'));
  });
});
