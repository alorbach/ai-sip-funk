// Tests zu den Befunden des Code-Reviews: Rufzielschutz, Speichern der Einstellungen, defekte Dateien,
// Herkunftsprüfung der API, sauberes Stoppen des SIP-Clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDialTarget } from '../src/dialPolicy.js';
import { isOn } from '../src/fsutil.js';
import { CallManager } from '../src/callManager.js';
import { ContactStore } from '../src/contacts.js';
import { apiFetchAllowed } from '../src/web/server.js';
import { isPrivateIp, SipClient } from '../src/sip/client.js';
import { getHeader, getHeaders, parseMessage, serialize } from '../src/sip/message.js';
import { lookupTellows } from '../src/spamCheck.js';
import { EchoHandler } from '../src/rtp/testSources.js';

// settings.json liegt im Arbeitsverzeichnis: jeder Test dieser Datei arbeitet in einem leeren Ordner
const dir = mkdtempSync(join(tmpdir(), 'sipfunk-review-'));
process.chdir(dir);
const { loadSettings, saveSettings, SECRET_MASK } = await import('../src/settings.js');

test('Rufzielschutz: „+49 (0)…“ ist erlaubt, Call-by-Call gesperrt', () => {
  assert.equal(checkDialTarget('+49 (0)30 23125100'), undefined);
  assert.equal(checkDialTarget('+49 30 23125100'), undefined);
  assert.match(checkDialTarget('01013 0900123456') ?? '', /Call-by-Call/);
  assert.match(checkDialTarget('+49 (0)900 123456') ?? '', /Mehrwert/);
});

test('Vermitteln prüft das Ziel wie beim Wählen', async () => {
  const manager = new CallManager({ sipServer: '127.0.0.1', sipUser: 'tester', sipPassword: 'pw', sipLocalPort: 0, rtpPort: 0, sipDebug: false, maxCallSeconds: 60, liveListenEnabled: false });
  assert.match((await manager.transfer('0900 123456')).reason, /Mehrwert/);
  assert.match((await manager.transfer('+44 20 7946 0958')).reason, /Ausland/);
  // erlaubtes Ziel, aber kein Gespräch
  assert.match((await manager.transfer('030 23125100')).reason, /kein ausgehendes Gespräch/);
});

test('Schalterwerte: .env und Einstellungen lesen dieselben Schreibweisen', () => {
  for (const v of ['1', 'true', 'YES', 'ja', 'On']) assert.equal(isOn(v), true, v);
  for (const v of ['0', 'false', 'off', 'nein', '']) assert.equal(isOn(v), false, v);
});

test('Einstellungen: Teil-Speichern lässt alles andere unberührt, Kennwort-Maske ändert nichts', () => {
  saveSettings({ aiName: 'Robin', smtpPass: 'geheim', stallMs: '4000' });
  // Nur ein Feld schicken (so speichert die Web-UI jetzt): die übrigen Werte bleiben
  const saved = saveSettings({ incoming: 'on', smtpPass: SECRET_MASK });
  assert.equal(saved.incoming, 'on');
  assert.equal(saved.aiName, 'Robin');
  assert.equal(saved.stallMs, '4000');
  assert.equal(saved.smtpPass, 'geheim');
  assert.equal(existsSync('settings.json.tmp'), false);
  assert.throws(() => saveSettings([] as never), /JSON-Objekt/);
});

test('Einstellungen: defekte settings.json führt zu den Vorgaben statt zum Absturz', () => {
  writeFileSync('settings.json', '{"aiName": "Rob');
  assert.equal(loadSettings().aiName, 'Alex');
  writeFileSync('settings.json', 'null');
  assert.equal(loadSettings().aiName, 'Alex');
});

test('Kontakte: defekte contacts.json wird vor dem Überschreiben gesichert', () => {
  const file = join(dir, 'contacts.json');
  writeFileSync(file, '{"kein": "Array"}');
  const store = new ContactStore(file);
  assert.deepEqual(store.list(), []);
  store.create({ name: 'Max Mustermann', number: '030 23125100' });
  assert.equal(readFileSync(`${file}.defekt`, 'utf8'), '{"kein": "Array"}');
  assert.equal(new ContactStore(file).list().length, 1);
});

test('API: Abrufe, die eine fremde Seite auslöst, werden abgelehnt', () => {
  assert.equal(apiFetchAllowed(undefined), true); // Tray-App, MCP-Server
  assert.equal(apiFetchAllowed('same-origin'), true);
  assert.equal(apiFetchAllowed('none'), true); // Adresszeile
  assert.equal(apiFetchAllowed('cross-site'), false);
  assert.equal(apiFetchAllowed('same-site'), false); // anderer Port auf localhost
});

test('tellows: Auslandsnummern werden nicht abgefragt', async () => {
  assert.equal(await lookupTellows('+44 20 7946 0958'), undefined);
  assert.equal(await lookupTellows('0044 20 7946 0958'), undefined);
});

test('SIP: private Adressen erkennen', () => {
  for (const ip of ['192.168.178.1', '10.0.0.1', '172.16.5.4', '127.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['172.32.0.1', '8.8.8.8', '193.168.1.1']) assert.equal(isPrivateIp(ip), false, ip);
});

test('SIP: stop() mit offener Transaktion kehrt zügig zurück und sendet danach nichts mehr', async () => {
  // Box, die die Registrierung annimmt, aber auf INVITE und die Abmeldung nie antwortet
  const box = dgram.createSocket('udp4');
  await new Promise<void>((r) => box.bind(0, '127.0.0.1', r));
  let registered = false;
  let afterStop = 0;
  let stopped = false;
  box.on('message', (buf, rinfo) => {
    if (stopped) afterStop++;
    const req = parseMessage(buf.toString());
    if (req.method !== 'REGISTER' || registered) return;
    registered = true;
    box.send(serialize({ status: 200, reason: 'OK', headers: [...getHeaders(req, 'Via').map((v): [string, string] => ['Via', v]), ['From', getHeader(req, 'From')!], ['To', `${getHeader(req, 'To')!};tag=b`], ['Call-ID', getHeader(req, 'Call-ID')!], ['CSeq', getHeader(req, 'CSeq')!], ['Expires', '300']], body: '' }), rinfo.port, rinfo.address);
  });
  const client = new SipClient({ server: '127.0.0.1', serverPort: box.address().port, user: 'tester', password: 'pw', localPort: 0, localIp: '127.0.0.1' });
  await client.start();
  const call = client.call('**610', 'v=0\r\n');
  call.on('ended', () => undefined);
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await client.stop();
  stopped = true;
  assert.ok(Date.now() - t0 < 3500, `stop() brauchte ${Date.now() - t0} ms`);
  // Früher lief hier der Retransmit-Timer auf den geschlossenen Socket und beendete den Prozess
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(afterStop, 0);
  box.close();
});

test('Stufe der Oberfläche: Standard „easy“, wird gespeichert, ändert und verliert keine anderen Werte', () => {
  writeFileSync('settings.json', '{}');
  assert.equal(loadSettings().uiMode, 'easy');
  saveSettings({ stallMs: '4500', scamName: 'Schmidt', mailBody: 'Eigene Vorlage {anrufer}' });
  // Umschalten speichert nur dieses eine Feld; alles in „Einfach“ Ausgeblendete bleibt, wie es war
  const adv = saveSettings({ uiMode: 'advanced' });
  assert.equal(adv.uiMode, 'advanced');
  const easy = saveSettings({ uiMode: 'easy' });
  assert.equal(easy.uiMode, 'easy');
  assert.equal(easy.stallMs, '4500');
  assert.equal(easy.scamName, 'Schmidt');
  assert.equal(easy.mailBody, 'Eigene Vorlage {anrufer}');
  // Speichern aus der einfachen Ansicht (nur geänderte Felder) lässt die Stufe und die Technik-Werte stehen
  const after = saveSettings({ aiName: 'Kim' });
  assert.equal(after.uiMode, 'easy');
  assert.equal(after.stallMs, '4500');
  // Unbekannte Werte fallen auf den Standard zurück
  assert.equal(saveSettings({ uiMode: 'profi' }).uiMode, 'easy');
  writeFileSync('settings.json', '{"uiMode": 42}');
  assert.equal(loadSettings().uiMode, 'easy');
});

test('Mail: neuer Server ohne neu eingegebenes Passwort verwirft das gespeicherte', () => {
  writeFileSync('settings.json', '{}');
  saveSettings({ smtpHost: 'smtp.example.com', smtpPass: 'geheim' });
  // Andere Felder und die Maske lassen das Passwort stehen
  assert.equal(saveSettings({ smtpPort: '465', smtpPass: SECRET_MASK }).smtpPass, 'geheim');
  assert.equal(saveSettings({ smtpHost: ' SMTP.example.com ' }).smtpPass, 'geheim');
  // Server geändert, Passwort nicht neu eingegeben (fehlt oder Maske): weg damit
  assert.equal(saveSettings({ smtpHost: 'smtp.example.org', smtpPass: SECRET_MASK }).smtpPass, '');
  // Server und Passwort in einem Schritt (so speichert „Automatisch einrichten“): bleibt
  assert.equal(saveSettings({ smtpHost: 'smtp.example.net', smtpPass: 'neu' }).smtpPass, 'neu');
  assert.equal(saveSettings({ smtpHost: 'smtp.example.org' }).smtpPass, '');
});

test('Sprache der Oberfläche: Standard „auto“, nur de/en werden gespeichert', () => {
  writeFileSync('settings.json', '{}');
  assert.equal(loadSettings().uiLang, 'auto');
  assert.equal(saveSettings({ uiLang: 'en' }).uiLang, 'en');
  assert.equal(saveSettings({ aiName: 'Kim' }).uiLang, 'en');
  assert.equal(saveSettings({ uiLang: 'fr' }).uiLang, 'auto');
});

test('Echo: 10-ms-Pakete der Anlage kommen vollständig und in 20-ms-Frames zurück', () => {
  const echo = new EchoHandler(100);
  echo.onConnected(16000);
  // 1 s Audio in 10-ms-Paketen (160 Samples), fortlaufend nummeriert
  let n = 0;
  const out: number[] = [];
  for (let tick = 0; tick < 50; tick++) {
    for (let k = 0; k < 2; k++) echo.onRemoteAudio(Int16Array.from({ length: 160 }, () => n++ % 30000));
    const frame = echo.nextFrame();
    if (frame) {
      assert.equal(frame.length, 320);
      out.push(...frame);
    }
  }
  // Alles bis auf die Verzögerung (100 ms = 1600 Samples) ist zurückgekommen, lückenlos und in der Reihenfolge
  assert.equal(out.length, 16000 - 1600);
  assert.ok(out.every((v, i) => v === i));
});
