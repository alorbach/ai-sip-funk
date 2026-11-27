'use strict';
// SIPFunk als Windows-Tray-App: startet den Server (dist/main.js) als Kindprozess, zeigt Zustand im Tray,
// öffnet die Oberfläche per Doppelklick in einem eigenen Fenster (oder auf Wunsch im Browser).

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { app, Menu, nativeImage, shell, Tray, dialog, clipboard, Notification, BrowserWindow, screen, session } = require('electron');
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
let state = { server: 'startet', phase: '', registered: false, incoming: false, target: '', webPort: Number(process.env.WEB_PORT || 3865), error: '' };
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
    title: T('SIPFunk – eingehender Anruf'), icon: ICON,
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

/** Pop-up unten rechts, wenn ein KI-Agent (MCP) einen Anruf anfragt: Ziel, Auftrag, „Anrufen“ und „Ablehnen“. */
let askWin = null;
function showAsk() {
  if (askWin && !askWin.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const w = 480, h = 360;
  askWin = new BrowserWindow({
    width: w, height: h, x: area.x + area.width - w - 16, y: area.y + area.height - h - 16,
    frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    title: T('SIPFunk – KI-Agent möchte anrufen'), icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  askWin.setAlwaysOnTop(true, 'screen-saver');
  askWin.once('ready-to-show', () => { if (askWin && !askWin.isDestroyed()) askWin.showInactive(); });
  askWin.on('closed', () => { askWin = null; });
  askWin.loadURL(`${webUrl()}/mcp-ask.html`).catch(() => hideAsk());
}
function hideAsk() {
  if (askWin && !askWin.isDestroyed()) askWin.destroy();
  askWin = null;
}

/** Fenster nach dem Drucken an „SIPFunk Fax“: Zielnummer eingeben und faxen. Holt sich den Fokus, damit man sofort tippen kann. */
let faxWin = null;
function showFax() {
  if (faxWin && !faxWin.isDestroyed()) { faxWin.show(); faxWin.focus(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  const w = 480, h = 396;
  faxWin = new BrowserWindow({
    width: w, height: h, x: area.x + area.width - w - 16, y: area.y + area.height - h - 16,
    frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: false, alwaysOnTop: true, show: false,
    title: T('SIPFunk – Fax senden'), icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Nur die PDF-Vorschau eines Druckauftrags öffnet ein (normales) Fenster; andere Links, auch aus dem PDF in der
  // Vorschau, gehen in den Browser bzw. das Mailprogramm
  const external = (url) => { if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url); };
  faxWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${webUrl()}/api/fax/drafts/`)) return { action: 'allow', overrideBrowserWindowOptions: { width: 800, height: 1000, frame: true, alwaysOnTop: false, icon: ICON } };
    external(url);
    return { action: 'deny' };
  });
  faxWin.webContents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    child.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith(`${webUrl()}/api/fax/drafts/`)) { ev.preventDefault(); external(url); } });
  });
  faxWin.once('ready-to-show', () => { if (faxWin && !faxWin.isDestroyed()) { faxWin.show(); faxWin.focus(); } });
  faxWin.on('closed', () => { faxWin = null; });
  faxWin.loadURL(`${webUrl()}/fax.html`).catch(() => { if (faxWin && !faxWin.isDestroyed()) faxWin.destroy(); faxWin = null; });
}

/**
 * Hauptfenster: dieselbe Oberfläche wie im Browser, nur in einem eigenen Fenster. Läuft in einem eigenen
 * Renderer-Prozess – Tray und Server laufen unabhängig weiter, auch wenn das Fenster hängt oder geschlossen wird.
 * Schließen beendet SIPFunk nicht; das geht nur über das Tray-Menü.
 */
let mainWin = null;
/** Größe, Lage und Zoom des Fensters (window.json im Datenordner; settings.json gehört dem Server) */
const WINDOW_FILE = path.join(dataDir, 'window.json');
function loadWindowState() {
  try {
    const w = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
    const b = { x: Number(w.x), y: Number(w.y), width: Number(w.width), height: Number(w.height) };
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 420 || b.height < 480) return null;
    // Nur übernehmen, wenn das Fenster noch auf einem vorhandenen Bildschirm liegt (Monitor abgesteckt)
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 20 && b.y < area.y + area.height - 80;
    return visible ? { ...b, maximized: w.maximized === true, zoom: Math.max(-3, Math.min(5, Number(w.zoom) || 0)) } : null;
  } catch { return null; }
}
function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({ ...b, maximized: win.isMaximized(), zoom: win.webContents.getZoomLevel() }));
  } catch { /* nicht wichtig */ }
}
/** Strg+Plus / Strg+Minus / Strg+0: Das Fenster hat kein Menü, also auch nicht dessen Tastenkürzel zum Zoomen */
function zoomKeys(win) {
  win.webContents.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    const wc = win.webContents;
    // Zeichen der Taste (deutsche wie englische Tastatur), dazu der Ziffernblock über seinen Tastencode
    const step = { '+': 0.5, '=': 0.5, '-': -0.5 }[input.key] ?? { NumpadAdd: 0.5, NumpadSubtract: -0.5 }[input.code];
    if (step !== undefined) wc.setZoomLevel(Math.max(-3, Math.min(5, wc.getZoomLevel() + step)));
    else if (input.key === '0' || input.code === 'Numpad0') wc.setZoomLevel(0);
    else return;
    ev.preventDefault();
  });
}
function showMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show(); mainWin.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const saved = loadWindowState();
  mainWin = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: Math.min(1280, area.width - 40), height: Math.min(900, area.height - 40) }),
    minWidth: 420, minHeight: 480,
    show: false, autoHideMenuBar: true, title: 'SIPFunk', icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.removeMenu();
  zoomKeys(mainWin);
  if (saved?.maximized) mainWin.maximize();
  // Zoom gilt erst, wenn die Seite geladen ist (Chromium merkt ihn je Adresse, nicht über einen Neustart)
  mainWin.webContents.on('did-finish-load', () => { if (saved?.zoom && mainWin && !mainWin.isDestroyed() && mainWin.webContents.getZoomLevel() === 0) mainWin.webContents.setZoomLevel(saved.zoom); });
  const win = mainWin;
  win.on('close', () => saveWindowState(win));
  const own = (url) => url === webUrl() || url.startsWith(`${webUrl()}/`);
  const external = (url) => { if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url); };
  // Neue Fenster (Anmeldung bei Google/Microsoft, Links zu Anbietern, PDF-Vorschau) gehen in den Browser
  mainWin.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  mainWin.webContents.on('will-navigate', (ev, url) => { if (!own(url)) { ev.preventDefault(); external(url); } });
  mainWin.once('ready-to-show', () => { if (mainWin && !mainWin.isDestroyed()) mainWin.show(); });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.loadURL(webUrl()).catch(() => { /* Server gerade nicht erreichbar: die Seite versucht es selbst erneut */ });
}

/** Mikrofon (Spracheingabe für den Auftrag) nur für die eigene Oberfläche erlauben, alles andere ablehnen. */
function limitPermissions() {
  const ok = (wc, permission, details) => {
    const origin = details?.requestingUrl || details?.securityOrigin || wc?.getURL() || '';
    return (permission === 'media' || permission === 'clipboard-sanitized-write') && (origin === webUrl() || origin.startsWith(`${webUrl()}/`))
      && (!details?.mediaTypes || details.mediaTypes.every((t) => t === 'audio'));
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(ok(wc, permission, details)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => ok(wc, permission, { ...details, securityOrigin: origin }));
}

// Sprache des Tray-Menüs: wie in der Web-UI eingestellt (settings.json, uiLang), sonst nach dem System.
// Deutsch ist die Quelle; fehlt eine Übersetzung, bleibt der deutsche Text stehen.
const EN = {
  'startet': 'starting', 'läuft': 'running', 'beendet': 'stopped', 'nicht registriert': 'not registered', 'bereit': 'ready', 'wählt': 'dialling',
  'klingelt': 'ringing', 'eingehender Anruf': 'incoming call', 'verbunden': 'connected',
  'Telefonanlage verbunden': 'Phone system connected', 'Telefonanlage nicht verbunden': 'Phone system not connected',
  'SIPFunk öffnen': 'Open SIPFunk', 'Im Browser öffnen': 'Open in browser', 'Anrufbeantworter': 'Answering machine', 'Anrufbeantworter an': 'Answering machine on',
  'Einstellungen (.env) bearbeiten': 'Edit settings (.env)', 'Datenordner öffnen': 'Open data folder', 'Beim Anmelden starten': 'Start at login',
  'Server neu starten': 'Restart server', 'Beenden': 'Quit', 'Fehler': 'Error',
  'dist/main.js fehlt – erst „npm run build“': 'dist/main.js is missing – run "npm run build" first',
  'Anrufbeantworter konnte nicht umgeschaltet werden': 'The answering machine could not be switched',
  'SIPFunk – eingehender Anruf': 'SIPFunk – incoming call',
  'SIPFunk – KI-Agent möchte anrufen': 'SIPFunk – AI agent wants to call',
  'SIPFunk – Fax senden': 'SIPFunk – send fax',
  'Port {0} war belegt. Die Oberfläche läuft jetzt auf Port {1}. Eingetragene KI-Agenten bitte in den Einstellungen aktualisieren.': 'Port {0} was in use. The web UI now runs on port {1}. Please update registered AI agents in the settings.',
  'SIPFunk startet künftig nach der Windows-Anmeldung. Abschalten: Tray-Menü › „Beim Anmelden starten“.': 'SIPFunk now starts after you sign in to Windows. To turn this off: tray menu › "Start at login".',
};
function uiLang() {
  let pref = 'auto';
  try { pref = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).uiLang || 'auto'; } catch { /* keine Einstellungen */ }
  if (pref === 'de' || pref === 'en') return pref;
  return /^de\b/i.test(app.getLocale() || 'de') ? 'de' : 'en';
}
const T = (text) => (uiLang() === 'en' && EN[text]) || text;

const gotLock = app.requestSingleInstanceLock();
// "SIPFunk.exe --quit" beendet die laufende Instanz sauber (scripts/install-local.mjs vor einem Update)
const quitOnly = process.argv.includes('--quit');
if (!gotLock || quitOnly) app.quit();

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
  if (state.server === 'läuft') showMain();
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
  return T(names[state.phase] || state.phase || '–');
}

function stateLine() {
  if (state.server !== 'läuft') return `Server: ${T(state.server)}`;
  const box = T(state.registered ? 'Telefonanlage verbunden' : 'Telefonanlage nicht verbunden');
  const call = state.target ? ` · ${state.target}` : '';
  return `${box} · ${phaseLabel()}${call}`;
}

async function setIncoming(enabled) {
  try {
    const res = await fetch(`${webUrl()}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ incoming: enabled ? 'on' : 'off' }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    dialog.showErrorBox('SIPFunk', `${T('Anrufbeantworter konnte nicht umgeschaltet werden')}: ${err.message}`);
  }
  refresh();
}

// Autostart nach der Windows-Anmeldung (Eintrag unter HKCU\…\Run mit der AppUserModelId als Name; der
// Deinstaller entfernt ihn, siehe build/installer.nsh). Nur für das gepackte Programm: Aus dem Repository
// gestartet würde der Eintrag auf ein nacktes electron.exe zeigen.
function autostartOn() {
  const s = app.getLoginItemSettings();
  // executableWillLaunchAtLogin beachtet auch, ob der Eintrag in den Windows-Einstellungen abgeschaltet wurde
  return process.platform === 'win32' ? !!s.executableWillLaunchAtLogin : !!s.openAtLogin;
}
function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: on, enabled: true });
  refresh();
}
/**
 * Erster Start nach der Installation: Autostart einschalten und einmal darauf hinweisen. Die Merkdatei im
 * Datenordner sorgt dafür, dass ein später abgeschalteter Autostart auch nach einem Update aus bleibt.
 * Die portable ZIP-Fassung (kein Deinstaller neben der .exe) schaltet nichts von selbst ein.
 */
function firstRunAutostart() {
  const installed = app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${pkg.build?.productName || 'SIPFunk'}.exe`));
  const mark = path.join(dataDir, 'autostart.flag');
  if (!installed || fs.existsSync(mark)) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(mark, 'Autostart wurde beim ersten Start eingerichtet. Ein-/Ausschalten: Tray-Menü.\n');
    app.setLoginItemSettings({ openAtLogin: true, enabled: true });
    if (Notification.isSupported()) new Notification({ title: 'SIPFunk', body: T('SIPFunk startet künftig nach der Windows-Anmeldung. Abschalten: Tray-Menü › „Beim Anmelden starten“.'), icon: ICON_PNG }).show();
  } catch { /* ohne Autostart läuft SIPFunk trotzdem */ }
}

function buildMenu() {
  const running = state.server === 'läuft';
  return Menu.buildFromTemplate([
    { label: `SIPFunk ${pkg.version}`, enabled: false },
    { label: stateLine(), enabled: false },
    ...(state.error ? [{ label: `${T('Fehler')}: ${state.error.slice(0, 80)}`, click: () => clipboard.writeText(state.error) }] : []),
    { type: 'separator' },
    { label: T('SIPFunk öffnen'), enabled: running, click: showMain },
    { label: running ? `${T('Im Browser öffnen')} (Port ${state.webPort})` : T('Im Browser öffnen'), enabled: running, click: () => shell.openExternal(webUrl()) },
    { label: T('Anrufbeantworter'), type: 'checkbox', checked: state.incoming, enabled: running, click: (item) => setIncoming(item.checked) },
    { type: 'separator' },
    { label: T('Einstellungen (.env) bearbeiten'), click: openEnv },
    { label: T('Datenordner öffnen'), click: () => shell.openPath(dataDir) },
    ...(app.isPackaged ? [{ label: T('Beim Anmelden starten'), type: 'checkbox', checked: autostartOn(), click: (item) => setAutostart(item.checked) }] : []),
    { type: 'separator' },
    { label: T('Server neu starten'), click: () => restart() },
    { label: T('Beenden'), click: () => app.quit() },
  ]);
}

function refresh() {
  if (!tray) return;
  tray.setToolTip(`SIPFunk\n${stateLine()}${state.incoming && state.server === 'läuft' ? `\n${T('Anrufbeantworter an')}` : ''}`);
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
      // Das Fenster zeigt noch die alte Adresse (Port geändert): neu laden
      if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.getURL().startsWith(webUrl())) mainWin.loadURL(webUrl()).catch(() => {});
      // Noch nicht eingerichtet: Oberfläche öffnen, dort führt der Einrichtungsassistent durch das Nötigste
      if (msg.setupNeeded && !setupOpened) { setupOpened = true; showMain(); }
      // Der eingestellte Port war belegt: SIPFunk ist ausgewichen und hat den neuen Port gespeichert
      if (msg.webPortMovedFrom && Notification.isSupported()) {
        const n = new Notification({ title: 'SIPFunk', body: T('Port {0} war belegt. Die Oberfläche läuft jetzt auf Port {1}. Eingetragene KI-Agenten bitte in den Einstellungen aktualisieren.').replace('{0}', msg.webPortMovedFrom).replace('{1}', state.webPort), icon: ICON_PNG });
        n.on('click', () => { showMain(); mainWin?.loadURL(`${webUrl()}/#settings`).catch(() => {}); });
        n.show();
      }
    }
    // Die Oberfläche bittet um einen Neustart (z. B. nach einer Portänderung)
    else if (msg.type === 'restart') restart();
    else if (msg.type === 'status') { state.phase = msg.phase; state.registered = !!msg.registered; state.incoming = !!msg.incoming; state.target = msg.target || ''; }
    else if (msg.type === 'error') state.error = String(msg.message || '');
    else if (msg.type === 'ring') showRing();
    else if (msg.type === 'ringEnd') hideRing();
    else if (msg.type === 'mcpAsk') showAsk();
    else if (msg.type === 'mcpAskEnd') hideAsk();
    else if (msg.type === 'faxPrint') showFax();
    else if (msg.type === 'notice') {
      // Hinweis nach einem angenommenen Anruf; Klick öffnet die Web-UI
      if (Notification.isSupported()) {
        const n = new Notification({ title: String(msg.title || 'SIPFunk'), body: String(msg.body || ''), icon: ICON_PNG });
        n.on('click', showMain);
        n.show();
      }
    }
    refresh();
  });
  proc.on('exit', (code) => {
    hideRing();
    hideAsk();
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
  if (!gotLock || quitOnly) return;
  // Windows zeigt Benachrichtigungen nur mit AppUserModelId; unter diesem Namen steht auch der Autostart-Eintrag.
  // Im gepackten Programm fehlt der Abschnitt „build“ der package.json, dort gilt der feste Wert – er muss zur
  // appId in der package.json passen (build/installer.nsh entfernt den Eintrag unter diesem Namen).
  app.setAppUserModelId(pkg.build?.appId || 'org.sipfunk.app');
  firstRunAutostart();
  limitPermissions();
  tray = new Tray(icon());
  tray.on('double-click', openUi);
  tray.on('click', () => tray.popUpContextMenu());
  refresh();
  startServer();
  setInterval(refresh, 10000).unref();
});

app.on('second-instance', (_e, argv) => (argv.includes('--quit') ? app.quit() : openUi()));
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', (e) => {
  quitting = true;
  // Erst den Server sauber beenden (auflegen, abmelden), dann die App
  if (child) { e.preventDefault(); stopServer().then(() => app.quit()); }
});
