// Kontakt-Import mit erfundenen Daten und ohne Netzzugriffe (fetch wird ersetzt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContactStore, numberKey, sameMainNumber } from '../src/contacts.js';
import { applyImport, buildPreview, decodeImportFile, splitNumbers, fromCsv, fromFile, fromGoogle, fromGraph, fromVcard, ImportSession, normalizeImportNumber, previewCounts } from '../src/contactImport.js';
import { ContactSources } from '../src/contactSources.js';

function withStore(fn: (store: ContactStore, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-imp-'));
  try {
    const file = join(dir, 'contacts.json');
    fn(new ContactStore(file), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Nummern-Normalisierung für den Import', () => {
  assert.equal(normalizeImportNumber('+49 (0)30 1234567'), '0301234567');
  assert.equal(normalizeImportNumber('+49 171 5550100'), '01715550100');
  assert.equal(normalizeImportNumber('0049 171-5550100'), '01715550100');
  assert.equal(normalizeImportNumber('(030) 123 45-67'), '0301234567');
  assert.equal(normalizeImportNumber('tel:+43-1-5550100'), '+4315550100');
  assert.equal(normalizeImportNumber('0041 44 555 01 00'), '+41445550100');
  assert.equal(normalizeImportNumber('030 1234567 ext. 12'), '0301234567');
  assert.equal(normalizeImportNumber('**610'), '**610');
  assert.equal(normalizeImportNumber('12'), undefined);
  assert.equal(normalizeImportNumber('keine Nummer'), undefined);
  assert.equal(normalizeImportNumber(''), undefined);
});

test('vCard: Namen, Typen, gefaltete Zeilen, Quoted-Printable, Fax und Einträge ohne Nummer', () => {
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Muster;Erika;;;', 'FN:Erika Muster',
    'TEL;TYPE=CELL,VOICE:+49 171 5550100', 'TEL;type=HOME:030 5550', ' 101', 'TEL;TYPE=FAX:030 5550199',
    'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==', 'item1.TEL:0221 5550102', 'item1.X-ABLabel:Büro', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:2.1', 'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:B=C3=A4cker;Bernd=', ';;;', 'TEL;WORK;VOICE:089 5550103', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Nur Mail', 'EMAIL:nur@example.invalid', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'ORG:Beispiel GmbH;Vertrieb', 'TEL:040 5550104', 'END:VCARD',
  ].join('\r\n');
  const c = fromVcard(vcf);
  assert.deepEqual(c.map((x) => x.name), ['Beispiel GmbH', 'Bernd Bäcker', 'Erika Muster']);
  const erika = c.find((x) => x.name === 'Erika Muster')!;
  assert.deepEqual(erika.numbers, [
    { number: '01715550100', label: 'mobil' },
    { number: '0305550101', label: 'privat' },
    { number: '02215550102', label: 'geschäftlich' }, // iCloud-Bezeichnung „Büro“ (item1.X-ABLabel)
  ]);
  assert.deepEqual(c.find((x) => x.name === 'Bernd Bäcker')!.numbers, [{ number: '0895550103', label: 'geschäftlich' }]);
});

test('CSV: Google-Export mit mehreren Nummern je Feld', () => {
  const csv = [
    'First Name,Middle Name,Last Name,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value',
    'Max,,Beispiel,Mobile,+49 160 5550200 ::: +49 160 5550201,Work,"030 5550202"',
    'Ohne,,Nummer,,,,',
  ].join('\n');
  const c = fromCsv(csv);
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'Max Beispiel');
  assert.deepEqual(c[0].numbers.map((n) => n.number), ['01605550200', '01605550201', '0305550202']);
});

test('CSV: Outlook-Export (deutsch, Semikolon, BOM) ohne Fax', () => {
  const csv = '\uFEFFVorname;Nachname;Firma;Telefon geschäftlich;Fax geschäftlich;Mobiltelefon;Telefon privat\r\n' + 'Lena;Probe;"Test; AG";0711 5550300;0711 5550399;0151 5550301;\r\n';
  const c = fromFile('kontakte.csv', csv);
  assert.equal(c[0].name, 'Lena Probe');
  assert.deepEqual(c[0].numbers, [
    { number: '01515550301', label: 'mobil' },
    { number: '07115550300', label: 'geschäftlich' },
  ]);
});

test('Google People API und Microsoft Graph umwandeln', () => {
  const g = fromGoogle([
    { names: [{ displayName: 'Anna Test' }], phoneNumbers: [{ value: '0170 5550400', canonicalForm: '+491705550400', type: 'mobile' }, { value: '030 5550401', type: 'homeFax' }] },
    { organizations: [{ name: 'Firma Beispiel' }], phoneNumbers: [{ value: '069 5550402', type: 'work' }] },
    { names: [{ displayName: 'Ohne Telefon' }] },
  ]);
  assert.deepEqual(g, [
    { name: 'Anna Test', numbers: [{ number: '01705550400', label: 'mobil' }] },
    { name: 'Firma Beispiel', numbers: [{ number: '0695550402', label: 'geschäftlich' }] },
  ]);
  const m = fromGraph([{ givenName: 'Paul', surname: 'Probe', mobilePhone: '+49 152 5550500', homePhones: [], businessPhones: ['+49 30 5550501', '+49 152 5550500'] }]);
  assert.deepEqual(m, [{ name: 'Paul Probe', numbers: [{ number: '01525550500', label: 'mobil' }, { number: '0305550501', label: 'geschäftlich' }] }]);
});

test('Dubletten: Vorschau erkennt vorhandene Nummern, auch Zusatznummern', () => {
  withStore((store) => {
    store.create({ name: 'Vorhanden', number: '0171 5550600', numbers: ['030 5550601'], persona: 'professionell' });
    const items = buildPreview(
      [
        { name: 'Neu', numbers: [{ number: '0891234567', label: 'mobil' }] },
        { name: 'Alt', numbers: [{ number: '+49 30 5550601', label: 'privat' }] },
        { name: 'Teils', numbers: [{ number: '01715550600', label: 'mobil' }, { number: '0405550602', label: 'privat' }] },
      ],
      store,
    );
    assert.deepEqual(items.map((i) => [i.status, i.existing]), [['new', undefined], ['exists', 'Vorhanden'], ['partial', 'Vorhanden']]);
    assert.deepEqual(previewCounts(items), { total: 3, new: 1, partial: 1, exists: 1 });
  });
});

test('Auswahl-Import: nur gewählte, vorhandene nie überschrieben, Ergänzen nur auf Wunsch', () => {
  withStore((store, file) => {
    const old = store.create({ name: 'Vorhanden', number: '0171 5550700', persona: 'professionell', task: 'Termin bestätigen' });
    const cands = [
      { name: 'Eins', numbers: [{ number: '01605550701', label: 'mobil' as const }, { number: '0305550702', label: 'privat' as const }] },
      { name: 'Zwei', numbers: [{ number: '01605550703', label: 'mobil' as const }] },
      { name: 'Vorhanden Büro', numbers: [{ number: '01715550700', label: 'mobil' as const }, { number: '0405550704', label: 'geschäftlich' as const }] },
    ];
    // Ohne Bestätigung: der teilweise vorhandene Eintrag bleibt unverändert, Unbekanntes ignoriert
    let r = applyImport(cands, ['0', '2', '99', 'x'], store);
    assert.deepEqual([r.created, r.merged, r.unchanged], [1, 0, 1]);
    const eins = store.findByName('Eins')!;
    assert.equal(eins.number, '01605550701');
    assert.deepEqual(eins.numbers, ['0305550702']);
    assert.equal(store.findByName('Zwei'), undefined);
    assert.deepEqual(store.get(old.id)!.numbers, undefined);

    // Mit Bestätigung: nur die fehlende Nummer kommt dazu; Name, Stil und Auftrag bleiben
    r = applyImport(cands, ['2'], store, { addToExisting: true });
    assert.deepEqual([r.created, r.merged], [0, 1]);
    const merged = new ContactStore(file).get(old.id)!;
    assert.equal(merged.name, 'Vorhanden');
    assert.equal(merged.persona, 'professionell');
    assert.equal(merged.task, 'Termin bestätigen');
    assert.deepEqual(merged.numbers, ['0405550704']);
    assert.equal(store.findByNumber('040 5550704')?.id, old.id);

    // Zweiter Lauf legt nichts doppelt an
    r = applyImport(cands, ['0', '1', '2'], store, { addToExisting: true });
    assert.deepEqual([r.created, r.merged, r.unchanged], [1, 0, 2]);
    assert.equal(store.list().length, 3);
  });
});

test('Kontakte: Zusatznummern prüfen Dubletten und kommen aus dem Formular als Text', () => {
  withStore((store) => {
    const a = store.create({ name: 'A', number: '0171 5550800', numbers: '030 5550801, 0171 5550800; 040 5550802' as unknown as string[] });
    assert.deepEqual(a.numbers, ['0305550801', '0405550802']);
    assert.throws(() => store.create({ name: 'B', number: '0305550801' }), /schon bei „A"/);
    assert.throws(() => store.create({ name: 'B', number: '0891111111', numbers: ['+49 40 5550802'] }), /schon bei „A"/);
    assert.equal(store.update(a.id, { numbers: [] }).numbers, undefined);
  });
});

// ---------------------------------------------------------------- Anmeldung und Abruf mit ersetztem fetch

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: URLSearchParams } };

function fakeFetch(routes: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: Call['init']) => {
    const c = { url, init };
    calls.push(c);
    const r = routes(c);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  return { fn, calls };
}

test('Google: PKCE-Anmeldung, Token nur im Speicher, Abruf mit Blättern, Trennen', async () => {
  let now = 1_000_000;
  const { fn, calls } = fakeFetch((c) => {
    if (c.url.startsWith('https://oauth2.googleapis.com/token')) return { body: { access_token: 'tok-g', expires_in: 3600 } };
    if (c.url.includes('pageToken=p2')) return { body: { connections: [{ names: [{ displayName: 'Zweite Seite' }], phoneNumbers: [{ value: '030 5550901', type: 'home' }] }] } };
    return { body: { connections: [{ names: [{ displayName: 'Erste Seite' }], phoneNumbers: [{ value: '0170 5550900', type: 'mobile' }] }], nextPageToken: 'p2' } };
  });
  const src = new ContactSources(() => ({ google: { clientId: 'cid.apps', clientSecret: 'nicht-geheim' } }), () => 'http://127.0.0.1:3000/oauth/callback', fn, () => now);
  assert.deepEqual(src.status().google, { configured: true, connected: false });
  await assert.rejects(src.load('google'), /Nicht verbunden/);

  const url = new URL(src.authUrl('google'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/contacts.readonly');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), null); // kein Refresh-Token
  const state = url.searchParams.get('state')!;
  assert.equal(src.owns(state), true);
  await assert.rejects(src.handleCallback('code', 'fremd'), /abgelaufen oder unbekannt/);

  assert.equal(await src.handleCallback('auth-code', state), 'google');
  assert.equal(src.owns(state), false);
  const body = calls[0].init!.body!;
  assert.equal(body.get('code'), 'auth-code');
  assert.equal(body.get('client_secret'), 'nicht-geheim');
  // Der Verifier passt zur Challenge aus der Anmelde-Adresse
  const challenge = createHash('sha256').update(body.get('code_verifier')!).digest('base64url');
  assert.equal(challenge, url.searchParams.get('code_challenge'));
  assert.equal(src.status().google.connected, true);

  const cands = await src.load('google');
  assert.deepEqual(cands.map((c) => c.name), ['Erste Seite', 'Zweite Seite']);
  assert.equal(calls[1].init!.headers!.Authorization, 'Bearer tok-g');
  assert.match(calls[1].url, /personFields=names%2CphoneNumbers/);

  src.disconnect('google');
  assert.equal(src.status().google.connected, false);
  await assert.rejects(src.load('google'), /Nicht verbunden/);

  // Abgelaufenes Token gilt als getrennt
  const s2 = src.authUrl('google');
  await src.handleCallback('c2', new URL(s2).searchParams.get('state')!);
  now += 3600_000;
  assert.equal(src.status().google.connected, false);
});

test('Microsoft: öffentlicher Client ohne Secret, Ordner, Folgeseiten nur bei Graph', async () => {
  const { fn, calls } = fakeFetch((c) => {
    if (c.url.includes('/oauth2/v2.0/token')) return { body: { access_token: 'tok-m', expires_in: 3600 } };
    if (c.url.endsWith('skip=1')) return { body: { value: [{ id: '2', displayName: 'Seite Zwei', mobilePhone: '0152 5551001' }], '@odata.nextLink': 'https://example.invalid/stehlen' } };
    if (c.url.includes('/me/contactFolders?')) return { body: { value: [{ id: 'f1' }] } };
    if (c.url.includes('/me/contactFolders/f1/contacts')) return { body: { value: [{ id: '1', displayName: 'Doppelt' }, { id: '3', displayName: 'Im Ordner', businessPhones: ['069 5551002'] }] } };
    return { body: { value: [{ id: '1', displayName: 'Seite Eins', homePhones: ['030 5551000'] }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contacts?skip=1' } };
  });
  const src = new ContactSources(() => ({ microsoft: { clientId: 'ms-id', tenant: 'common' } }), () => 'http://localhost:3000/oauth/callback', fn);
  const url = new URL(src.authUrl('microsoft'));
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('scope'), 'https://graph.microsoft.com/Contacts.Read');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/oauth/callback');
  await src.handleCallback('code', url.searchParams.get('state')!);
  assert.equal(calls[0].init!.body!.get('client_secret'), null);

  const cands = await src.load('microsoft');
  assert.deepEqual(cands.map((c) => c.name), ['Im Ordner', 'Seite Eins', 'Seite Zwei']);
  assert.equal(calls.some((c) => c.url.includes('example.invalid')), false);
  await assert.rejects(Promise.resolve().then(() => src.authUrl('google')), /Client-ID/);
});

test('Abruffehler werden verständlich gemeldet', async () => {
  const { fn } = fakeFetch((c) => (c.url.includes('token') ? { body: { access_token: 't', expires_in: 3600 } } : { status: 403, body: { error: { message: 'People API has not been used in project' } } }));
  const src = new ContactSources(() => ({ google: { clientId: 'x' } }), () => 'http://127.0.0.1:1/oauth/callback', fn);
  await src.handleCallback('c', new URL(src.authUrl('google')).searchParams.get('state')!);
  await assert.rejects(src.load('google'), /Abruf fehlgeschlagen \(403\): People API/);
});

// ---------------------------------------------------------------- Nachbesserungen aus dem Review

test('Nummern: Bezeichnung davor, Wahlpausen, 0 nach Landesvorwahl, lange Felder', () => {
  assert.equal(normalizeImportNumber('Handy 0171 5550100'), '01715550100');
  assert.equal(normalizeImportNumber('0171 5550100,,1234'), '01715550100');
  assert.equal(normalizeImportNumber('030 5550100;1234'), '0305550100');
  assert.equal(normalizeImportNumber('030 5550100 x12'), '0305550100');
  assert.equal(normalizeImportNumber('+43 0664 5550100'), '+436645550100');
  assert.equal(normalizeImportNumber('+43 (0)664 5550100'), '+436645550100');
  const started = Date.now();
  assert.equal(normalizeImportNumber('0' + ' '.repeat(60_000) + 'x1'), undefined);
  assert.ok(Date.now() - started < 200);
});

test('Nummern-Schlüssel: Auslandsschreibweisen und „+49 (0)“ gelten als gleich', () => {
  assert.equal(numberKey('0043 664 5550100'), numberKey('+43 664 5550100'));
  assert.equal(numberKey('+49 (0)30 5550100'), '0305550100');
  assert.equal(numberKey('+49030 5550100'), '0305550100');
  assert.equal(numberKey('0049 171 5550100'), '01715550100');
  withStore((store) => {
    store.create({ name: 'Wien', number: '0043 664 5550100' });
    const items = buildPreview(fromVcard('BEGIN:VCARD\nFN:Wien neu\nTEL:+43 664 5550100\nEND:VCARD'), store);
    assert.equal(items[0].status, 'exists');
  });
});

test('Datei: Zeichensatz wird erkannt (UTF-8, Windows-1252, UTF-16)', () => {
  const csv = 'Vorname;Nachname;Mobiltelefon;Telefon geschäftlich\r\nJürgen;Müßig;0171 5550100;030 5550101\r\n';
  const utf8 = decodeImportFile(Buffer.from(csv, 'utf8'));
  const ansi = decodeImportFile(Buffer.from(csv, 'latin1'));
  const utf16 = decodeImportFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]));
  for (const text of [utf8, ansi, utf16]) {
    const [c] = fromFile('export.csv', text);
    assert.equal(c.name, 'Jürgen Müßig');
    assert.deepEqual(c.numbers.map((n) => n.label), ['mobil', 'geschäftlich']);
  }
  assert.equal(decodeImportFile(Buffer.from([0xef, 0xbb, 0xbf, 0x46, 0x4e])), 'FN');
});

test('CSV: Excel-Zeile „sep=;“ und Tabulator-Text', () => {
  assert.equal(fromCsv('sep=;\nName;Telefon\nEva Probe;040 5550200\n')[0].name, 'Eva Probe');
  assert.equal(fromCsv('Name\tMobile Phone\nTom Probe\t0160 5550201\n')[0].numbers[0].number, '01605550201');
});

test('vCard: Karte ohne END und Quoted-Printable im Windows-Zeichensatz', () => {
  const c = fromVcard('BEGIN:VCARD\nFN:Ohne Ende\nTEL:040 5550300\nBEGIN:VCARD\nFN;CHARSET=WINDOWS-1252;ENCODING=QUOTED-PRINTABLE:J=FCrgen\nTEL:040 5550301\n');
  assert.deepEqual(c.map((x) => x.name), ['Jürgen', 'Ohne Ende']);
});

test('Gemeinsame Nummer: beide in der Vorschau, beim Import bekommt sie der erste gewählte', () => {
  withStore((store) => {
    const cands = fromVcard('BEGIN:VCARD\nFN:Anna Familie\nTEL;TYPE=HOME:030 5550400\nTEL;TYPE=CELL:0171 5550401\nEND:VCARD\nBEGIN:VCARD\nFN:Ben Familie\nTEL;TYPE=HOME:030 5550400\nEND:VCARD');
    const items = buildPreview(cands, store);
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.numbers.some((n) => n.shared)));
    const r = applyImport(cands, ['1', '0'], store);
    assert.deepEqual([r.created, r.unchanged], [1, 1]);
    const anna = store.findByName('Anna Familie')!;
    assert.deepEqual([anna.number, anna.numbers], ['01715550401', ['0305550400']]);
  });
});

test('Ergänzen: nie beim Inhaber, nie wenn Nummern zu verschiedenen Kontakten gehören', () => {
  withStore((store) => {
    store.create({ name: 'Ich', number: '0171 5550500', owner: true });
    store.create({ name: 'X', number: '030 5550501' });
    store.create({ name: 'Y', number: '030 5550502' });
    const cands = [
      { name: 'Ich privat', numbers: [{ number: '01715550500', label: 'mobil' as const }, { number: '0405550503', label: 'privat' as const }] },
      { name: 'XY', numbers: [{ number: '0305550501', label: 'privat' as const }, { number: '0305550502', label: 'geschäftlich' as const }, { number: '0405550504', label: 'sonstige' as const }] },
    ];
    const items = buildPreview(cands, store);
    assert.deepEqual(items.map((i) => [i.status, i.mergeable]), [['partial', undefined], ['partial', undefined]]);
    const r = applyImport(cands, ['0', '1'], store, { addToExisting: true });
    assert.deepEqual([r.created, r.merged, r.unchanged], [0, 0, 2]);
    assert.equal(store.findByNumber('0405550503'), undefined);
  });
});

test('Kontaktspeicher: Fehler beim Ergänzen bricht den Import nicht ab', () => {
  withStore((_store, file) => {
    // Altbestand mit doppelter Nummer (von Hand in contacts.json geschrieben); die Prüfung findet beim Ergänzen von A zuerst B
    const now = new Date().toISOString();
    writeFileSync(file, JSON.stringify([
      { id: 'b', name: 'Alt B', number: '0305550600', createdAt: now, updatedAt: now },
      { id: 'a', name: 'Alt A', number: '0305550600', createdAt: now, updatedAt: now },
    ]));
    const s = new ContactStore(file);
    const r = s.importMany([{ name: 'Neu', number: '0405550601' }], [{ id: 'a', numbers: ['0405550602'] }]);
    assert.equal(r.created, 1);
    assert.equal(r.merged, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(new ContactStore(file).list().length, 3);
  });
});

test('Vorschau-Kennung: eine ältere Vorschau importiert nichts', () => {
  withStore((store) => {
    const session = new ImportSession();
    const first = session.show('file', [{ name: 'Erste', numbers: [{ number: '0405550700', label: 'mobil' }] }], store);
    const second = session.show('google', [{ name: 'Zweite', numbers: [{ number: '0405550701', label: 'mobil' }] }], store);
    assert.throws(() => session.apply(first.token, ['0'], store), /nicht mehr aktuell/);
    session.discard({ token: first.token }); // verwirft die neuere nicht
    session.discard({ source: 'microsoft' });
    assert.equal(session.apply(second.token, ['0'], store).created, 1);
    assert.equal(store.findByName('Zweite')?.number, '0405550701');
    assert.throws(() => session.apply(second.token, ['0'], store), /nicht mehr aktuell/);
  });
});

test('Trennen: Google widerruft das Token, Microsoft nur lokal', async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { access_token: 'tok', expires_in: 3600 } }));
  const src = new ContactSources(() => ({ google: { clientId: 'g' }, microsoft: { clientId: 'm', tenant: 'common' } }), () => 'http://127.0.0.1:1/oauth/callback', fn);
  await src.handleCallback('c', new URL(src.authUrl('google')).searchParams.get('state')!);
  await src.handleCallback('c', new URL(src.authUrl('microsoft')).searchParams.get('state')!);
  await src.disconnect('google');
  await src.disconnect('microsoft');
  const revokes = calls.filter((c) => c.url === 'https://oauth2.googleapis.com/revoke');
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0].init!.body!.get('token'), 'tok');
  assert.deepEqual(src.status(), { google: { configured: true, connected: false }, microsoft: { configured: true, connected: false } });
});

test('MCP-Freigabe „nur Kontakte“ gilt nur für die Hauptnummer', () => {
  const c = { number: '0171 5550800', numbers: ['030 5550801'] };
  assert.equal(sameMainNumber(c, '+49 171 5550800'), true);
  assert.equal(sameMainNumber(c, '030 5550801'), false);
});

// ---------------------------------------------------------------- Review-Runde 1

test('Nummern: Italien behält die 0, mehrere Nummern in einem Feld', () => {
  assert.equal(normalizeImportNumber('+39 06 12345678'), '+390612345678');
  assert.equal(normalizeImportNumber('+39 0612345678'), '+390612345678');
  assert.deepEqual(splitNumbers('0171 5550100 / 0221 5550101'), ['0171 5550100', '0221 5550101']);
  assert.deepEqual(splitNumbers('0171 5550100, 0221 5550101'), ['0171 5550100', '0221 5550101']);
  assert.deepEqual(splitNumbers('0171 5550100 oder 0221 5550101'), ['0171 5550100', '0221 5550101']);
  assert.deepEqual(splitNumbers('0171 5550100,,1234'), ['0171 5550100']);
  assert.deepEqual(splitNumbers('0171/5550100'), ['0171/5550100']);
  const [c] = fromVcard('BEGIN:VCARD\nFN:Zwei Nummern\nTEL;TYPE=CELL:+49 171 5550100 / 0221 5550101\nEND:VCARD');
  assert.deepEqual(c.numbers.map((n) => n.number), ['01715550100', '02215550101']);
});

test('CSV: keine Kunden- oder Assistenznummern, Thunderbird „Cell Number“, " mitten im Feld', () => {
  const c = fromCsv('First Name,Last Name,Kundennummer,Assistant\'s Phone,Cell Number\nJo "Joe",Probe,4711,030 5550900,0171 5550901\nEva,Probe,100234,,0171 5550902\n');
  assert.deepEqual(c.map((x) => [x.name, x.numbers.map((n) => n.number)]), [['Eva Probe', ['01715550902']], ['Jo "Joe" Probe', ['01715550901']]]);
});

test('Ergänzen nur bei ähnlichem Namen und nicht geteilter Nummer; gleicher Name wird markiert', () => {
  withStore((store) => {
    store.create({ name: 'Papa', number: '0171 5551000', numbers: ['0221 5551001'] });
    store.create({ name: 'Mama', number: '0171 5551002' });
    const cands = [
      { name: 'Oma', numbers: [{ number: '01715551003', label: 'mobil' as const }, { number: '02215551001', label: 'privat' as const }] },
      { name: 'Papa Mobil', numbers: [{ number: '01715551000', label: 'mobil' as const }, { number: '01605551004', label: 'mobil' as const }] },
      { name: 'Mama', numbers: [{ number: '01605551005', label: 'mobil' as const }] },
    ];
    const items = buildPreview(cands, store);
    assert.deepEqual(items.map((i) => [i.status, i.mergeable, i.sameName]), [['partial', undefined, undefined], ['partial', true, undefined], ['new', undefined, true]]);
    const r = applyImport(cands, ['0', '1'], store, { addToExisting: true });
    assert.deepEqual([r.created, r.merged, r.unchanged], [0, 1, 1]);
    assert.equal(store.findByNumber('0171 5551003'), undefined);
    assert.equal(store.findByNumber('0160 5551004')?.name, 'Papa');
  });
});

test('Vorschau verfällt nach der Frist und bleibt bei einem Fehler erhalten', () => {
  withStore((store) => {
    let now = 0;
    const session = new ImportSession(1000, () => now);
    const a = session.show('file', [{ name: 'Frist', numbers: [{ number: '0405551100', label: 'mobil' }] }], store);
    now = 2000;
    assert.throws(() => session.apply(a.token, ['0'], store), /nicht mehr aktuell/);
    const b = session.show('file', [{ name: 'Fehler', numbers: [{ number: '0405551101', label: 'mobil' }] }], store);
    const broken = { importMany: () => { throw new Error('Platte voll'); }, findByNumber: () => undefined } as unknown as ContactStore;
    assert.throws(() => session.apply(b.token, ['0'], broken), /Platte voll/);
    assert.equal(session.apply(b.token, ['0'], store).created, 1);
  });
});

test('Kontaktspeicher: Nachschlagen bleibt bei großen Importen schnell und richtig', () => {
  withStore((store) => {
    const many = Array.from({ length: 4000 }, (_, i) => ({ name: 'P' + i, numbers: [{ number: '030' + String(5000000 + i), label: 'privat' as const }, { number: '0171' + String(5000000 + i), label: 'mobil' as const }] }));
    const started = Date.now();
    const r = applyImport(many, many.map((_, i) => String(i)), store);
    const items = buildPreview(many, store);
    assert.equal(r.created, 4000);
    assert.ok(items.every((i) => i.status === 'exists'));
    assert.ok(Date.now() - started < 3000, 'zu langsam');
    const p = store.findByNumber('+49 30 5000123')!;
    store.update(p.id, { numbers: [] });
    assert.equal(store.findByNumber('0305000123')?.name, 'P123');
    store.delete(p.id);
    assert.equal(store.findByNumber('0305000123'), undefined);
  });
});
