// Einrichtungsassistent: .env gezielt schreiben, Zugangsdaten prüfen, SIP-Client zur Laufzeit neu anmelden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteEnvValue, updateEnvText, writeEnvValues } from '../src/envFile.js';
import { checkOpenAiKey, cleanOpenAiKey, cleanSipAccount, explainSipError, testSipAccount } from '../src/setup.js';
import { CallManager } from '../src/callManager.js';
import { buildAuthorization, parseChallenge } from '../src/sip/digest.js';
import { getHeader, getHeaders, parseMessage, serialize, type SipMessage } from '../src/sip/message.js';

const dir = mkdtempSync(join(tmpdir(), 'sipfunk-setup-'));
process.chdir(dir);
const { loadSettings, saveSettings } = await import('../src/settings.js');

function reply(req: SipMessage, status: number, reason: string, extra: [string, string][] = []): string {
  return serialize({ status, reason, headers: [...getHeaders(req, 'Via').map((v): [string, string] => ['Via', v]), ['From', getHeader(req, 'From')!], ['To', `${getHeader(req, 'To')!};tag=b`], ['Call-ID', getHeader(req, 'Call-ID')!], ['CSeq', getHeader(req, 'CSeq')!], ...extra], body: '' });
}

/** Telefonanlage auf localhost, die genau ein Konto kennt und das Kennwort wirklich prüft. */
async function fakeBox(user: string, password: string) {
  const box = dgram.createSocket('udp4');
  await new Promise<void>((r) => box.bind(0, '127.0.0.1', r));
  const seen: string[] = [];
  box.on('message', (buf, rinfo) => {
    const req = parseMessage(buf.toString());
    if (req.method !== 'REGISTER') return;
    const send = (raw: string) => box.send(raw, rinfo.port, rinfo.address);
    const auth = getHeader(req, 'Authorization');
    if (!auth) return send(reply(req, 401, 'Unauthorized', [['WWW-Authenticate', 'Digest realm="fritz.box", nonce="n1"']]));
    const a = parseChallenge(auth);
    const expected = parseChallenge(buildAuthorization({ challenge: 'Digest realm="fritz.box", nonce="n1"', method: 'REGISTER', uri: a.uri, username: user, password })).response;
    if (a.username !== user || a.response !== expected) return send(reply(req, 403, 'Forbidden'));
    seen.push(`${a.username}:${getHeader(req, 'Expires')}`);
    send(reply(req, 200, 'OK', [['Expires', getHeader(req, 'Expires') ?? '300']]));
  });
  return { port: box.address().port, seen, close: () => box.close() };
}

test('.env: Schlüssel ersetzen, anhängen, Kommentare und übrige Zeilen bleiben', () => {
  const before = '# SIP\r\nSIP_SERVER=fritz.box\r\nSIP_USER=\r\n# Kennwort\r\nSIP_PASSWORD=\r\nWEB_PORT=8080\r\nSIP_USER=alt-doppelt\r\n';
  const after = updateEnvText(before, { SIP_USER: 'tester', SIP_PASSWORD: 'geheim #1', OPENAI_API_KEY: 'sk-test' });
  assert.equal(after, "# SIP\r\nSIP_SERVER=fritz.box\r\nSIP_USER=tester\r\n# Kennwort\r\nSIP_PASSWORD='geheim #1'\r\nWEB_PORT=8080\r\n\r\nOPENAI_API_KEY=sk-test\r\n");
  assert.equal(updateEnvText('', { A: '1' }), 'A=1\n');
});

test('.env: Sonderzeichen überstehen den Weg durch process.loadEnvFile unverändert', () => {
  const values: Record<string, string> = {
    T_PLAIN: 'abc-123',
    T_HASH: 'pass#wort mit leer',
    T_QUOTE1: "it's",
    T_QUOTE2: 'sag "ja"',
    T_BOTH: `a'b"c`,
    T_DOLLAR: 'p$ss=w\\ord ',
  };
  const file = join(dir, 'roundtrip.env');
  writeFileSync(file, '# vorher\nT_PLAIN=alt\n');
  writeEnvValues(file, values);
  for (const k of Object.keys(values)) delete process.env[k];
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(values)) assert.equal(process.env[k], v, k);
  assert.match(readFileSync(file, 'utf8'), /^# vorher\n/);
  assert.throws(() => quoteEnvValue('zwei\nzeilen'), /Zeilenumbr/);
  assert.throws(() => quoteEnvValue('a\'b"c`d'), /Anführungszeichen/);
});

test('Eingaben des Assistenten: säubern und ablehnen', () => {
  assert.deepEqual(cleanSipAccount({ server: '  ', user: ' tester ', password: 'pw' }), { server: 'fritz.box', user: 'tester', password: 'pw' });
  assert.equal(cleanSipAccount({ server: '192.168.178.1', user: 'u', password: 'p' }).server, '192.168.178.1');
  assert.throws(() => cleanSipAccount({ server: 'http://fritz.box', user: 'u', password: 'p' }), /Adresse/);
  assert.throws(() => cleanSipAccount({ server: 'fritz.box', user: '', password: 'p' }), /Benutzername fehlt/);
  assert.throws(() => cleanSipAccount({ server: 'fritz.box', user: 'a b', password: 'p' }), /Benutzername/);
  assert.throws(() => cleanSipAccount({ server: 'fritz.box', user: 'u', password: '' }), /Kennwort fehlt/);
  assert.equal(cleanOpenAiKey('  sk-test-0123456789abcdefghij  '), 'sk-test-0123456789abcdefghij');
  assert.throws(() => cleanOpenAiKey('kurz'), /OpenAI-Schlüssel/);
  assert.throws(() => cleanOpenAiKey('sk-mit leerzeichen-0123456789'), /OpenAI-Schlüssel/);
  assert.match(explainSipError('Registrierung fehlgeschlagen: 403 Forbidden', 'fritz.box'), /abgelehnt/);
  assert.match(explainSipError('getaddrinfo ENOTFOUND fritz.box', 'fritz.box'), /nicht gefunden/);
  assert.match(explainSipError('REGISTER: keine Antwort vom Server (Timeout)', 'fritz.box'), /Keine Antwort von fritz.box/);
});

test('OpenAI-Schlüssel prüfen: gültig, abgelehnt, nicht erreichbar – der Schlüssel geht nur an api.openai.com', async () => {
  const calls: { url: string; auth: string }[] = [];
  const fake = (status: number): typeof fetch => async (url, init) => {
    calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization) });
    return new Response('{}', { status });
  };
  assert.deepEqual(await checkOpenAiKey('sk-test', fake(200)), { ok: true });
  assert.deepEqual(calls[0], { url: 'https://api.openai.com/v1/models', auth: 'Bearer sk-test' });
  const denied = await checkOpenAiKey('sk-test', fake(401));
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /abgelehnt/);
  // Die Meldung enthält den Schlüssel nie
  assert.doesNotMatch(denied.error ?? '', /sk-test/);
  const offline = await checkOpenAiKey('sk-test', async () => { throw new Error('ECONNREFUSED sk-test'); });
  assert.match(offline.error ?? '', /nicht erreichbar/);
  assert.doesNotMatch(offline.error ?? '', /sk-test/);
});

test('Probe-Anmeldung: richtiges Kennwort gelingt, falsches wird verständlich abgelehnt, stumme Anlage läuft in den Timeout', async () => {
  const box = await fakeBox('tester', 'richtig');
  assert.deepEqual(await testSipAccount({ server: '127.0.0.1', user: 'tester', password: 'richtig' }, { serverPort: box.port, localIp: '127.0.0.1' }), { ok: true });
  const wrong = await testSipAccount({ server: '127.0.0.1', user: 'tester', password: 'falsch' }, { serverPort: box.port, localIp: '127.0.0.1' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error ?? '', /abgelehnt/);
  await new Promise((r) => setTimeout(r, 300));
  box.close();
  const silent = dgram.createSocket('udp4');
  await new Promise<void>((r) => silent.bind(0, '127.0.0.1', r));
  const t0 = Date.now();
  const none = await testSipAccount({ server: '127.0.0.1', user: 'tester', password: 'x' }, { serverPort: silent.address().port, localIp: '127.0.0.1', timeoutMs: 700 });
  assert.match(none.error ?? '', /Keine Antwort/);
  assert.ok(Date.now() - t0 < 2000);
  silent.close();
});

test('SIP zur Laufzeit: ohne Zugangsdaten bleibt die App offline, neue Daten melden an, ein Wechsel meldet die alten ab', async () => {
  const box = await fakeBox('tester', 'richtig');
  const manager = new CallManager({ sipServer: '127.0.0.1', sipServerPort: box.port, sipUser: '', sipPassword: '', sipLocalPort: 0, rtpPort: 0, localIp: '127.0.0.1', sipDebug: false, maxCallSeconds: 60, liveListenEnabled: false });
  assert.equal((await manager.start()).ok, false);
  assert.equal(manager.status().phase, 'offline');
  assert.equal(manager.status().sipConfigured, false);
  assert.throws(() => manager.checkDial('**610'), /noch nicht eingerichtet/);

  // Falsches Kennwort: Fehler bleibt im Status stehen
  const bad = await manager.reconfigureSip({ server: '127.0.0.1', user: 'tester', password: 'falsch' });
  assert.equal(bad.ok, false);
  assert.equal(manager.status().registered, false);
  assert.match(manager.status().sipError ?? '', /403/);

  const good = await manager.reconfigureSip({ server: '127.0.0.1', user: 'tester', password: 'richtig' });
  assert.deepEqual(good, { ok: true });
  assert.equal(manager.status().phase, 'idle');
  assert.equal(manager.status().registered, true);
  assert.equal(manager.status().sipConfigured, true);
  assert.equal(manager.status().sipError, undefined);
  assert.equal(manager.checkDial('**610'), '**610');

  // Erneut dieselben Daten (Assistent später noch einmal): alter Client meldet sich ab, neuer an
  assert.deepEqual(await manager.reconfigureSip({ server: '127.0.0.1', user: 'tester', password: 'richtig' }), { ok: true });
  assert.deepEqual(box.seen, ['tester:300', 'tester:0', 'tester:300']);
  await manager.stop();
  box.close();
});

test('Einstellungen: Assistent erledigt wird gemerkt', () => {
  assert.equal(loadSettings().setupDone, 'off');
  assert.equal(saveSettings({ setupDone: 'on' }).setupDone, 'on');
  assert.equal(saveSettings({ aiName: 'Kim' }).setupDone, 'on');
  assert.equal(saveSettings({ setupDone: 'vielleicht' }).setupDone, 'off');
});
