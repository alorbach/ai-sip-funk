'use strict';

/*
 * Screenshots der Web-UI für die Dokumentation – ohne echte Daten.
 *
 * Aufruf (braucht ein echtes Browserfenster, läuft deshalb in Electron):
 *
 *   npm run screenshots            (baut vorher) oder: npx electron scripts/capture-screenshots.cjs
 *
 * Optionen:
 *   --out <ordner>   Zielordner (Standard: doc/images)
 *   --only a,b       nur die genannten Bilder (z. B. dashboard,settings-ai)
 *   --lang de,en     nur diese Sprachen (Standard: beide)
 *   --verbose        Server-Log und Konsolenmeldungen der Seite ausgeben
 *   --keep-temp      den temporären Datenordner behalten (zur Fehlersuche)
 *
 * Was passiert:
 *   1. Ein frischer temporärer Datenordner bekommt erfundene Einstellungen, Kontakte und Protokolle
 *      (Namen wie „Max Mustermann“, Rufnummern aus den für Film und Fernsehen reservierten Bereichen).
 *      SIPFUNK_DATA_DIR zeigt dorthin; der echte Datenordner wird nie gelesen. Umgebungsvariablen mit
 *      Schlüsseln und Kennwörtern werden für die Demo-Instanz entfernt.
 *   2. Eine kleine Schein-Telefonanlage auf 127.0.0.1:5060 beantwortet die Anmeldung, damit die Oberfläche
 *      „Telefonanlage verbunden“ zeigt. Ist der Port belegt, bleibt die Anlage „nicht erreichbar“.
 *   3. Der Server startet als eigener Prozess mit einem Vorspann, der jeden Abruf bei OpenAI abfängt
 *      (Modell-Liste aus einer festen Beispielliste). Es geht nichts ins Internet.
 *   4. Versteckte Fenster öffnen die Seiten in Deutsch und Englisch und speichern PNGs.
 *
 * Die Bilder vor dem Einchecken immer ansehen.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron === 'string' || !electron.app) {
  process.stderr.write('Dieses Skript läuft in Electron: npm run screenshots\n');
  process.exit(1);
}
const { app, BrowserWindow, nativeTheme } = electron;

const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out || path.join(ROOT, 'doc', 'images'));
const langs = String(args.lang || 'de,en').split(',').map((s) => s.trim()).filter(Boolean);
const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sipfunk-shots-'));
const dataDir = path.join(tempRoot, 'data');
const userDataDir = path.join(tempRoot, 'electron-user-data');
fs.mkdirSync(path.join(dataDir, 'transcripts'), { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

app.setPath('userData', userDataDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith('--')) continue;
    const key = list[i].slice(2);
    if (list[i + 1] && !list[i + 1].startsWith('--')) out[key] = list[++i];
    else out[key] = true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > start + 200) return reject(new Error('kein freier Port'));
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

// ---- Erfundene Daten ----

function isoAgo(days, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function demoRecord(start, durationSec, target, rest) {
  const ts = start.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = `${ts}_${target.replace(/[^\w+]/g, '')}`;
  return {
    id,
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + durationSec * 1000).toISOString(),
    target,
    mode: 'ai',
    durationSec,
    codec: 'PCMA',
    endReason: 'KI hat aufgelegt',
    model: 'gpt-realtime-2.1',
    ...rest,
    entries: rest.entries.map(([speaker, text]) => ({ speaker, text, final: true })),
  };
}

function writeDemoData(webPort) {
  fs.writeFileSync(path.join(dataDir, '.env'), [
    'SIP_SERVER=127.0.0.1',
    'SIP_USER=demo',
    'SIP_PASSWORD=demo-demo',
    'SIP_LOCAL_PORT=5074',
    'RTP_PORT=40200',
    'LOCAL_IP=127.0.0.1',
    'OPENAI_API_KEY=sk-demo-0000000000000000',
    `WEB_PORT=${webPort}`,
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    uiMode: 'easy',
    uiLang: 'de',
    setupDone: 'on',
    aiName: 'Alex',
    principal: 'Max Mustermann',
    address: 'sie',
    persona: 'professionell',
    voice: 'marin',
    task: 'Frag bei der Zahnarztpraxis Dr. Beispiel nach einem Termin zur Kontrolle in der nächsten Woche, am liebsten vormittags.',
    incoming: 'on',
    incomingRings: '4',
    incomingProfiles: JSON.stringify([
      { number: '23125100', name: 'Max Mustermann', kind: 'person', members: '', address: '', persona: '', voice: '', task: '', extra: '', answer: '', rings: '', notifyTray: '', notifyEmail: '', notifyCall: '' },
      { number: '23125200', name: 'Familie Mustermann', kind: 'family', members: 'Max, Erika, Lukas', address: '', persona: 'herzlich', voice: '', task: '', extra: '', answer: '', rings: '', notifyTray: '', notifyEmail: '', notifyCall: '' },
    ]),
    notifyTray: 'on',
    scamMode: 'on',
    scamStyle: 'beschaeftigen',
    scamMaxMinutes: '5',
    scamName: 'Robin',
    scamNumbers: 'anonym\n030 23125 9',
    retentionDays: '7',
  }, null, 2) + '\n');

  const now = new Date().toISOString();
  const contact = (id, name, number, rest) => ({ id, name, number, ...rest, createdAt: now, updatedAt: now });
  fs.writeFileSync(path.join(dataDir, 'contacts.json'), JSON.stringify([
    contact('demo01', 'Max Mustermann (Handy)', '0171 3920012', { owner: true, address: 'du' }),
    contact('demo02', 'Zahnarztpraxis Dr. Beispiel', '030 23125 310', { address: 'sie', persona: 'professionell', notes: 'Sprechzeiten Mo–Fr 8–12 Uhr' }),
    contact('demo03', 'Erika Mustermann', '0171 3920034', { address: 'du', persona: 'herzlich' }),
    contact('demo04', 'Schornsteinfeger Beispiel', '030 23125 455', { address: 'sie', notes: 'Termin im Frühjahr' }),
    contact('demo05', 'Autowerkstatt Muster GmbH', '030 23125 620', { address: 'sie', persona: 'locker' }),
  ], null, 2) + '\n');

  const records = [
    demoRecord(isoAgo(0, 9, 12), 74, '03023125310', {
      task: 'Frag bei der Zahnarztpraxis Dr. Beispiel nach einem Termin zur Kontrolle in der nächsten Woche, am liebsten vormittags.',
      persona: { persona: 'professionell', voice: 'marin', address: 'sie' },
      outcome: { result: 'Termin zur Kontrolle am Dienstag um 9:30 Uhr vereinbart. Bitte die Versichertenkarte mitbringen.', open: '' },
      summary: 'Kontrolltermin am Dienstag um 9:30 Uhr vereinbart; Versichertenkarte mitbringen.',
      costUsd: 0.21,
      entries: [
        ['partner', 'Zahnarztpraxis Dr. Beispiel, guten Tag.'],
        ['ki', 'Guten Tag, hier ist Alex, der KI-Assistent von Max Mustermann. Ich rufe an, um einen Termin zur Kontrolle zu vereinbaren, am liebsten nächste Woche vormittags.'],
        ['partner', 'Da hätte ich Dienstag um halb zehn.'],
        ['ki', 'Dienstag um 9:30 Uhr passt gut. Soll Herr Mustermann etwas mitbringen?'],
        ['partner', 'Nur die Versichertenkarte, bitte.'],
        ['ki', 'Gern, das richte ich aus. Vielen Dank und auf Wiederhören.'],
      ],
    }),
    demoRecord(isoAgo(0, 8, 3), 52, '03023125455', {
      called: '23125100',
      outcome: { result: 'Der Schornsteinfeger möchte den jährlichen Termin abstimmen und schlägt Donnerstag zwischen 8 und 10 Uhr vor. Er bittet um Rückruf.', open: 'Rückruf zur Bestätigung des Termins' },
      summary: 'Schornsteinfeger schlägt Donnerstag 8–10 Uhr vor und bittet um Rückruf. Einschätzung: wichtig.',
      costUsd: 0.14,
      entries: [
        ['ki', 'Hallo?'],
        ['partner', 'Guten Morgen, hier ist der Schornsteinfeger Beispiel. Ist Herr Mustermann zu sprechen?'],
        ['ki', 'Hier ist Alex, der KI-Assistent von Max Mustermann. Er ist gerade nicht erreichbar. Kann ich etwas ausrichten?'],
        ['partner', 'Ja, es geht um den jährlichen Termin. Donnerstag zwischen acht und zehn würde bei mir passen.'],
        ['ki', 'Donnerstag zwischen 8 und 10 Uhr, das gebe ich weiter. Soll er Sie zurückrufen?'],
        ['partner', 'Ja, bitte.'],
      ],
    }),
    demoRecord(isoAgo(1, 17, 41), 213, 'anonym', {
      called: '23125100',
      spam: true,
      endReason: 'Gegenstelle hat aufgelegt',
      outcome: { result: 'Werbeanruf zu einem angeblichen Gewinnspiel. Keine Daten genannt, der Anrufer hat nach gut drei Minuten aufgelegt.', open: '' },
      summary: 'Werbeanruf (Gewinnspiel) mit unterdrückter Nummer; 3:33 Minuten hingehalten, keine Daten genannt.',
      costUsd: 0.38,
      entries: [
        ['ki', 'Hallo?'],
        ['partner', 'Guten Tag, Sie haben bei unserem Gewinnspiel gewonnen!'],
        ['ki', 'Oh, das ist ja interessant. Um welches Gewinnspiel geht es denn genau?'],
      ],
    }),
    demoRecord(isoAgo(2, 11, 20), 96, '03023125620', {
      task: 'Frag bei der Autowerkstatt nach, ob der Wagen fertig ist und was die Reparatur kostet.',
      persona: { persona: 'locker', voice: 'marin', address: 'sie' },
      outcome: { result: 'Der Wagen ist fertig und kann bis 18 Uhr abgeholt werden. Die Reparatur kostet 284 Euro.', open: '' },
      summary: 'Wagen ist fertig, Abholung bis 18 Uhr, Kosten 284 Euro.',
      costUsd: 0.26,
      entries: [
        ['partner', 'Autowerkstatt Muster, hallo.'],
        ['ki', 'Guten Tag, hier ist Alex, der KI-Assistent von Max Mustermann. Ist sein Wagen schon fertig?'],
        ['partner', 'Ja, der ist fertig. Abholen geht heute bis achtzehn Uhr, das macht zweihundertvierundachtzig Euro.'],
      ],
    }),
  ];
  for (const r of records) fs.writeFileSync(path.join(dataDir, 'transcripts', `${r.id}.json`), JSON.stringify(r, null, 2) + '\n');

  // Vorspann für den Server-Prozess: Kein Abruf verlässt den Rechner; die Modell-Liste ist eine feste Beispielliste.
  fs.writeFileSync(path.join(tempRoot, 'preload.mjs'), `
const models = ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime-2', 'gpt-realtime', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-terra'];
const local = /^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])[:/]/;
globalThis.fetch = async (input) => {
  const url = String(input && input.url ? input.url : input);
  if (local.test(url)) throw new Error('unerwarteter lokaler Abruf');
  if (/api\\.openai\\.com\\/v1\\/models/.test(url)) {
    return new Response(JSON.stringify({ object: 'list', data: models.map((id, i) => ({ id, object: 'model', owned_by: 'openai', created: 1900000000 - i })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: { message: 'Demo: kein Netz' } }), { status: 503, headers: { 'content-type': 'application/json' } });
};
`);
}

// ---- Schein-Telefonanlage: beantwortet REGISTER und OPTIONS mit 200 OK ----

function startFakeRegistrar() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => { try { sock.close(); } catch { /* schon zu */ } resolve(null); });
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const first = text.split('\r\n', 1)[0];
      if (!/^(REGISTER|OPTIONS) /.test(first)) return;
      const lines = text.split('\r\n');
      const pick = (name) => lines.filter((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'));
      const to = (pick('To')[0] || '').replace(/\s*$/, '') + ';tag=demo';
      const contact = pick('Contact')[0];
      const res = [
        'SIP/2.0 200 OK',
        ...pick('Via'),
        ...pick('From'),
        to,
        ...pick('Call-ID'),
        ...pick('CSeq'),
        ...(contact ? [contact.replace(/\s*$/, '') + ';expires=300'] : []),
        'Expires: 300',
        'Content-Length: 0',
        '',
        '',
      ].join('\r\n');
      sock.send(res, rinfo.port, rinfo.address);
    });
    sock.bind(5060, '127.0.0.1', () => resolve(sock));
  });
}

// ---- Server-Prozess ----

function startServer() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(API_KEY|_TOKEN|SECRET|PASSWORD|^SIP_|^OPENAI_|^SMTP_|^MAIL_|^AI_|^OWNER_|^WEB_PORT$|^RTP_PORT$|^LOCAL_IP$|^ELECTRON_)/i.test(k)) continue;
    env[k] = v;
  }
  env.SIPFUNK_DATA_DIR = dataDir;
  const child = spawn('node', ['--import', pathToFileURL(path.join(tempRoot, 'preload.mjs')).href, path.join(ROOT, 'dist', 'main.js')], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logText = '';
  child.stdout.on('data', (d) => { logText += d; });
  child.stderr.on('data', (d) => { logText += d; });
  return { child, log: () => logText };
}

async function waitForServer(port, server) {
  for (let i = 0; i < 80; i++) {
    if (server.child.exitCode !== null) throw new Error('Server beendet:\n' + server.log().slice(-1500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (res.ok) return;
    } catch { /* noch nicht da */ }
    await sleep(250);
  }
  throw new Error('Server antwortet nicht:\n' + server.log().slice(-1500));
}

// ---- Aufnahmen ----

const SHOTS = [
  { name: 'dashboard', hash: 'dashboard', mode: 'easy', height: 960 },
  { name: 'calls', hash: 'calls', mode: 'easy', height: 860, after: `(() => { const row = document.querySelector('#page-calls [data-id], #page-calls li, #page-calls .row'); if (row) row.click(); })()` },
  { name: 'contacts', hash: 'contacts', mode: 'easy', height: 500 },
  { name: 'settings-ai', hash: 'settings', mode: 'easy', height: 900 },
  { name: 'settings-incoming', hash: 'settings', mode: 'easy', height: 900, section: 'settings-incoming' },
  { name: 'settings-scam', hash: 'settings', mode: 'advanced', height: 900, section: 'settings-scam' },
  { name: 'setup', hash: 'dashboard', mode: 'easy', height: 760, after: `openSetup(0)` },
];

async function setSettings(port, values) {
  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
  if (!res.ok) throw new Error('Einstellungen nicht gespeichert: ' + res.status);
}

async function capture(port, lang, shot) {
  const win = new BrowserWindow({ width: 1280, height: shot.height, show: false, useContentSize: true, backgroundColor: '#ffffff', webPreferences: { partition: `shots-${lang}-${shot.name}`, backgroundThrottling: false } });
  try {
    if (args.verbose) win.webContents.on('console-message', (_e, _level, message) => process.stdout.write(`[${shot.name}] ${message}\n`));
    const step = (t) => { if (args.verbose) process.stdout.write(`[${shot.name}.${lang}] ${t}\n`); };
    const url = `http://127.0.0.1:${port}/#${shot.hash}`;
    await setSettings(port, { uiLang: lang, uiMode: shot.mode });
    step('Einstellungen gesetzt');
    await win.loadURL(url);
    step('Seite geladen');
    // Die Seite lädt sich selbst neu, wenn Sprache oder Stufe im Browser von den Einstellungen abweichen.
    // Deshalb von außen abfragen, bis der Status der Anlage feststeht und die Seite eine Sekunde lang dieselbe geblieben ist
    // (eine Abfrage in der Seite ginge beim Neuladen verloren).
    let state = '';
    let stableSince = '';
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { state = await win.webContents.executeJavaScript(`document.readyState === 'complete' && [performance.timeOrigin, document.documentElement.lang, document.documentElement.dataset.ui, document.getElementById('regtext').textContent].join('|')`); } catch { state = ''; }
      const [origin, pageLang, pageMode, text] = String(state || '').split('|');
      const ready = pageLang === lang && pageMode === shot.mode && text && !/verbinde|connecting/i.test(text);
      if (ready && stableSince === origin && i % 2 === 0) break;
      if (ready && stableSince !== origin) stableSince = origin;
      if (!ready) stableSince = '';
    }
    step('Status: ' + state);
    await win.webContents.insertCSS('::-webkit-scrollbar { display: none; }');
    await sleep(900);
    // Sofort springen (die Seite scrollt sonst weich) und Platz für die feste Kopfzeile lassen
    if (shot.section) await win.webContents.executeJavaScript(`(() => { const el = document.getElementById(${JSON.stringify(shot.section)}); const head = document.querySelector('header'); window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 0) - 20, behavior: 'instant' }); })()`);
    if (shot.after) await win.webContents.executeJavaScript(`Promise.resolve(${shot.after}).then(() => true, () => false)`);
    await sleep(900);
    step('nehme auf');
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `${shot.name}.${lang}.png`);
    fs.writeFileSync(file, image.toPNG());
    process.stdout.write(`${path.relative(ROOT, file)}  ${image.getSize().width}x${image.getSize().height}\n`);
  } finally {
    win.destroy();
  }
}

async function main() {
  await app.whenReady();
  nativeTheme.themeSource = 'light';
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort(8930);
  writeDemoData(port);
  const registrar = await startFakeRegistrar();
  if (!registrar) process.stdout.write('Hinweis: Port 5060 auf 127.0.0.1 ist belegt, die Anlage erscheint als nicht verbunden.\n');
  const server = startServer();
  let failed = false;
  try {
    await waitForServer(port, server);
    await sleep(1500);
    if (args.verbose) process.stdout.write('--- Server-Log nach dem Start ---\n' + server.log().slice(-2500) + '\n');
    for (const lang of langs) {
      for (const shot of SHOTS) {
        if (only && !only.includes(shot.name)) continue;
        await Promise.race([capture(port, lang, shot), sleep(45000).then(() => { throw new Error(`Zeit abgelaufen bei ${shot.name}.${lang}`); })]);
      }
    }
  } catch (err) {
    failed = true;
    if (args.verbose) process.stderr.write('--- Server-Log ---\n' + server.log().slice(-3000) + '\n');
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  } finally {
    server.child.kill();
    if (registrar) registrar.close();
    await sleep(500);
    if (args['keep-temp']) process.stdout.write('Temporärer Ordner: ' + tempRoot + '\n');
    else {
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* bleibt im Temp-Ordner liegen */ }
      try { fs.rmSync(path.join(tempRoot, 'preload.mjs'), { force: true }); } catch { /* egal */ }
    }
  }
  app.exit(failed ? 1 : 0);
}

app.on('window-all-closed', () => { /* das Skript beendet die App selbst */ });
main();
