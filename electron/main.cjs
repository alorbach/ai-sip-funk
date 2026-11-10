'use strict';
// SIPFunk als Windows-Tray-App: startet den Server (dist/main.js) als Kindprozess, zeigt Zustand im Tray,
// öffnet die Web-UI per Doppelklick. Kein Fenster – alles läuft über das Tray-Menü.

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { app, Menu, nativeImage, shell, Tray, dialog, clipboard, Notification, BrowserWindow, screen } = require('electron');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'dist', 'main.js');
const ICON = path.join(ROOT, 'assets', 'icon.ico');
const ICON_PNG = path.join(ROOT, 'assets', 'icon.png');

/** Im installierten Programm liegen die Daten im Benutzerprofil, im Entwicklungsordner direkt im Projekt. */
const dataDir = process.env.SIPFUNK_DATA_DIR || (app.isPackaged ? app.getPath('userData') : ROOT);
const envFile = path.join(dataDir, '.env');

let tray = null;
let child = null;
let state = { server: 'startet', phase: '', registered: false, incoming: false, target: '', webPort: Number(process.env.WEB_PORT || 8080), error: '' };
let quitting = false;
let ringWin = null;
/** Die Web-UI wurde für die Ersteinrichtung schon einmal geöffnet (nicht bei jedem Server-Neustart wieder) */
let setupOpened = false;

/** Pop-up unten rechts, solange ein Anruf klingelt: Anrufer, Spam-Einschätzung, Umleiten. Nimmt den Fokus nicht weg. */
function showRing() {
  if (ringWin && !ringWin.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const w = 480, h = 276;
  ringWin = new BrowserWindow({
    width: w, height: h, x: area.x + area.width - w - 16, y: area.y + area.height - h - 16,
    frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    title: 'SIPFunk – eingehender Anruf', icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ringWin.setAlwaysOnTop(true, 'screen-saver');
  ringWin.once('ready-to-show', () => { if (ringWin && !ringWin.isDestroyed()) ringWin.showInactive(); });
  ringWin.on('closed', () => { ringWin = null; });
  ringWin.loadURL(`${webUrl()}/ring.html`).catch(() => hideRing());
}
function hideRing() {
  if (ringWin && !ringWin.isDestroyed()) ringWin.destroy();
  ringWin = null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function ensureEnv() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(envFile)) return true;
  const example = path.join(ROOT, '.env.example');
  if (fs.existsSync(example)) fs.copyFileSync(example, envFile);
  return false;
}

function webUrl() {
  return `http://127.0.0.1:${state.webPort}`;
}

function openUi() {
  if (state.server === 'läuft') shell.openExternal(webUrl());
  else openEnv();
}

function openEnv() {
  ensureEnv();
  shell.openPath(envFile);
}

function icon() {
  const img = nativeImage.createFromPath(ICON);
  return img.isEmpty() ? nativeImage.createFromPath(ICON_PNG).resize({ width: 16, height: 16 }) : img;
}

function phaseLabel() {
  const names = { starting: 'startet', offline: 'nicht registriert', idle: 'bereit', calling: 'wählt', ringing: 'klingelt', incoming: 'eingehender Anruf', connected: 'verbunden', ended: 'beendet' };
  return names[state.phase] || state.phase || '–';
}

function stateLine() {
  if (state.server !== 'läuft') return `Server: ${state.server}`;
  const box = state.registered ? 'FRITZ!Box registriert' : 'FRITZ!Box offline';
  const call = state.target ? ` · ${state.target}` : '';
  return `${box} · ${phaseLabel()}${call}`;
}

async function setIncoming(enabled) {
  try {
    const res = await fetch(`${webUrl()}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ incoming: enabled ? 'on' : 'off' }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    dialog.showErrorBox('SIPFunk', `Anrufbeantworter konnte nicht umgeschaltet werden: ${err.message}`);
  }
  refresh();
}

function buildMenu() {
  const running = state.server === 'läuft';
  return Menu.buildFromTemplate([
    { label: `SIPFunk ${pkg.version}`, enabled: false },
    { label: stateLine(), enabled: false },
    ...(state.error ? [{ label: `Fehler: ${state.error.slice(0, 80)}`, click: () => clipboard.writeText(state.error) }] : []),
    { type: 'separator' },
    { label: 'Web-UI öffnen', enabled: running, click: () => shell.openExternal(webUrl()) },
    { label: 'Anrufbeantworter', type: 'checkbox', checked: state.incoming, enabled: running, click: (item) => setIncoming(item.checked) },
    { type: 'separator' },
    { label: 'Einstellungen (.env) bearbeiten', click: openEnv },
    { label: 'Datenordner öffnen', click: () => shell.openPath(dataDir) },
    { label: 'Beim Anmelden starten', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Server neu starten', click: () => restart() },
    { label: 'Beenden', click: () => app.quit() },
  ]);
}

function refresh() {
  if (!tray) return;
  tray.setToolTip(`SIPFunk\n${stateLine()}${state.incoming && state.server === 'läuft' ? '\nAnrufbeantworter an' : ''}`);
  tray.setContextMenu(buildMenu());
}

// Betriebslog: sipfunk.log enthält Rufnummern. Je Tag eine Datei (ältere heißen sipfunk-JJJJ-MM-TT.log);
// was älter ist als die Aufbewahrungsfrist der Protokolle (Einstellungen, Standard 7 Tage), wird gelöscht.
const LOG_FILE = path.join(dataDir, 'sipfunk.log');
let logDay = '';
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function logRetentionDays() {
  try {
    const n = parseInt(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).retentionDays, 10);
    if (n >= 1) return n;
  } catch { /* keine Einstellungen: Standard */ }
  return 7;
}
function rotateLog() {
  try {
    const day = dayOf(fs.statSync(LOG_FILE).mtime);
    if (day !== dayOf(new Date())) fs.renameSync(LOG_FILE, path.join(dataDir, `sipfunk-${day}.log`));
  } catch { /* noch kein Log */ }
  const cutoff = Date.now() - logRetentionDays() * 86_400_000;
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (!/^sipfunk-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const file = path.join(dataDir, f);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch { /* Ordner nicht lesbar */ }
}
function writeLog(data) {
  const today = dayOf(new Date());
  if (today !== logDay) {
    logDay = today;
    rotateLog();
  }
  try { fs.appendFileSync(LOG_FILE, data); } catch { /* Platte voll o. Ä.: Log ist nicht wichtiger als der Betrieb */ }
}

function startServer() {
  ensureEnv();
  state = { ...state, server: 'startet', error: '', phase: '', registered: false, target: '' };
  refresh();
  if (!fs.existsSync(SERVER)) {
    state.server = 'dist/main.js fehlt – erst „npm run build“';
    refresh();
    return;
  }
  child = fork(SERVER, [], {
    cwd: dataDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SIPFUNK_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const proc = child;
  proc.stdout.on('data', (d) => writeLog(d));
  proc.stderr.on('data', (d) => {
    writeLog(d);
    const text = String(d).trim();
    // Konfigurationsfehler (z. B. SIP_USER fehlt) als Zustand zeigen
    const m = /Konfiguration[^\n]*/.exec(text) || /Error: ([^\n]*)/.exec(text);
    if (m) { state.error = m[0].replace(/^Error: /, ''); refresh(); }
  });
  proc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      state.server = 'läuft'; state.webPort = Number(msg.webPort) || state.webPort;
      // Noch nicht eingerichtet: Web-UI öffnen, dort führt der Einrichtungsassistent durch das Nötigste
      if (msg.setupNeeded && !setupOpened) { setupOpened = true; shell.openExternal(webUrl()); }
    }
    else if (msg.type === 'status') { state.phase = msg.phase; state.registered = !!msg.registered; state.incoming = !!msg.incoming; state.target = msg.target || ''; }
    else if (msg.type === 'error') state.error = String(msg.message || '');
    else if (msg.type === 'ring') showRing();
    else if (msg.type === 'ringEnd') hideRing();
    else if (msg.type === 'notice') {
      // Hinweis nach einem angenommenen Anruf; Klick öffnet die Web-UI
      if (Notification.isSupported()) {
        const n = new Notification({ title: String(msg.title || 'SIPFunk'), body: String(msg.body || ''), icon: ICON_PNG });
        n.on('click', () => shell.openExternal(webUrl()));
        n.show();
      }
    }
    refresh();
  });
  proc.on('exit', (code) => {
    hideRing();
    if (child === proc) child = null;
    if (quitting) return;
    state.server = code === 0 ? 'beendet' : `abgestürzt (Code ${code})`;
    refresh();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const proc = child;
    child = null;
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 4000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    // Erst höflich per IPC: Unter Windows beendet kill() den Prozess sofort – ein laufendes Gespräch würde
    // nicht aufgelegt und die Registrierung an der FRITZ!Box nicht abgemeldet
    try { proc.send({ type: 'shutdown' }); } catch { try { proc.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); } }
  });
}

let restarting = false;
async function restart() {
  // Doppelklick: Ein zweiter Neustart würde den noch laufenden alten Server nicht sehen und einen zweiten starten
  if (restarting) return;
  restarting = true;
  try {
    await stopServer();
    startServer();
  } finally {
    restarting = false;
  }
}

app.whenReady().then(() => {
  // Zweite Instanz: app.quit() oben wirkt erst später – hier kein zweites Tray und keinen zweiten Server starten
  if (!gotLock) return;
  // Windows zeigt Benachrichtigungen nur mit AppUserModelId (im Installer gesetzt, hier für „electron ." nötig)
  app.setAppUserModelId(pkg.build?.appId || 'org.sipfunk.app');
  tray = new Tray(icon());
  tray.on('double-click', openUi);
  tray.on('click', () => tray.popUpContextMenu());
  refresh();
  startServer();
  setInterval(refresh, 10000).unref();
});

app.on('second-instance', openUi);
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', (e) => {
  quitting = true;
  // Erst den Server sauber beenden (auflegen, abmelden), dann die App
  if (child) { e.preventDefault(); stopServer().then(() => app.quit()); }
});
