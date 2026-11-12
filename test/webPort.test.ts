// Port der Web-UI: Prüfung, Ausweichen bei belegtem Port, Ablage für andere Prozesse und die Einstellung dazu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appBaseUrl, chooseWebPort, DEFAULT_WEB_PORT, parsePort, PORT_FILE, portFree, readPortFile, writePortFile } from '../src/webPort.js';

test('Port: nur ganze Zahlen von 1024 bis 65535', () => {
  assert.equal(parsePort('3865'), 3865);
  assert.equal(parsePort(' 8080 '), 8080);
  assert.equal(parsePort(65535), 65535);
  for (const bad of ['', '80', '1023', '65536', '99999', '38a5', '3865.5', '-1', undefined, null]) assert.equal(parsePort(bad), undefined, String(bad));
});

test('Port frei: bleibt; belegt: nächster freier, erst nach erneutem Prüfen', async () => {
  const quick = { retries: 2, retryMs: 1 };
  assert.deepEqual(await chooseWebPort(4000, { ...quick, free: async () => true }), { port: 4000, moved: false });
  const asked: number[] = [];
  const busy = new Set([4000, 4001]);
  assert.deepEqual(await chooseWebPort(4000, { ...quick, free: async (p) => { asked.push(p); return !busy.has(p); } }), { port: 4002, moved: true });
  assert.deepEqual(asked, [4000, 4000, 4000, 4001, 4002]);
  // Der alte Prozess gibt den Port erst beim zweiten Versuch frei (Neustart): nicht ausweichen
  let n = 0;
  assert.deepEqual(await chooseWebPort(4000, { ...quick, free: async () => ++n > 1 }), { port: 4000, moved: false });
  // Nichts frei in der Nähe: beim gewünschten bleiben, der Start meldet den Fehler
  assert.deepEqual(await chooseWebPort(4000, { ...quick, span: 3, free: async () => false }), { port: 4000, moved: false });
  assert.deepEqual(await chooseWebPort(65535, { ...quick, free: async () => false }), { port: 65535, moved: false });
});

test('Port wirklich belegt: wird erkannt und umgangen (nur 127.0.0.1)', async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = (blocker.address() as AddressInfo).port;
  try {
    assert.equal(await portFree(taken), false);
    const choice = await chooseWebPort(taken, { retries: 0 });
    assert.equal(choice.moved, true);
    assert.ok(choice.port > taken);
    assert.equal(await portFree(choice.port), true);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('Portdatei: der stdio-Prozess findet den Port der laufenden App', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-port-'));
  try {
    assert.equal(readPortFile(dir), undefined);
    assert.equal(appBaseUrl({ SIPFUNK_DATA_DIR: dir }), `http://127.0.0.1:${DEFAULT_WEB_PORT}`);
    writePortFile(dir, 4123);
    assert.equal(readFileSync(join(dir, PORT_FILE), 'utf8'), '4123\n');
    assert.equal(appBaseUrl({ SIPFUNK_DATA_DIR: dir }), 'http://127.0.0.1:4123');
    // Die Datei gewinnt gegen WEB_PORT; eine ausdrücklich gesetzte Adresse gewinnt gegen beides
    assert.equal(appBaseUrl({ SIPFUNK_DATA_DIR: dir, WEB_PORT: '9000' }), 'http://127.0.0.1:4123');
    assert.equal(appBaseUrl({ SIPFUNK_DATA_DIR: dir, SIPFUNK_URL: 'http://127.0.0.1:5000/' }), 'http://127.0.0.1:5000');
    // Portänderung: beim nächsten Aufruf gilt der neue Port
    writePortFile(dir, 4124);
    assert.equal(appBaseUrl({ SIPFUNK_DATA_DIR: dir }), 'http://127.0.0.1:4124');
    writeFileSync(join(dir, PORT_FILE), 'kaputt');
    assert.equal(appBaseUrl({ SIPFUNK_DATA_DIR: dir, WEB_PORT: '9000' }), 'http://127.0.0.1:9000');
    assert.equal(appBaseUrl({}), `http://127.0.0.1:${DEFAULT_WEB_PORT}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Einstellung webPort: wird gespeichert, Unsinn fällt auf die Vorgabe zurück', async () => {
  const { loadSettings, saveSettings } = await import('../src/settings.js');
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-set-'));
  const cwd = process.cwd(), envPort = process.env.WEB_PORT;
  process.chdir(dir);
  try {
    delete process.env.WEB_PORT;
    assert.equal(loadSettings().webPort, String(DEFAULT_WEB_PORT));
    // Bestehende Installation: WEB_PORT aus der .env bleibt die Basis
    process.env.WEB_PORT = '8080';
    assert.equal(loadSettings().webPort, '8080');
    assert.equal(saveSettings({ webPort: '4200' }).webPort, '4200');
    assert.equal(loadSettings().webPort, '4200');
    assert.equal(JSON.parse(readFileSync('settings.json', 'utf8')).webPort, '4200');
    for (const bad of ['80', 'abc', '70000', '']) assert.equal(saveSettings({ webPort: bad }).webPort, '8080', bad);
  } finally {
    process.chdir(cwd);
    if (envPort === undefined) delete process.env.WEB_PORT; else process.env.WEB_PORT = envPort;
    rmSync(dir, { recursive: true, force: true });
  }
});
