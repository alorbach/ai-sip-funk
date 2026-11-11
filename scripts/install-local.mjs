// Aktualisiert eine vorhandene SIPFunk-Installation auf den Stand dieses Arbeitsordners (nur Windows):
// baut den Installer und lässt ihn still über die installierte Fassung laufen. Einstellungen und Daten
// unter %APPDATA%\SIPFunk bleiben dabei unberührt. Installiert nie neu: Ohne vorhandene Installation
// passiert nichts.
//
//   npm run install:local          jetzt bauen und installieren
//   npm run install:auto           Git-Hooks einrichten: nach jedem Commit oder Merge auf main von selbst
//   npm run install:auto -- --off  Git-Hooks wieder entfernen
//
// Die Hooks starten dieses Skript mit --hook; es prüft den Zweig und arbeitet dann im Hintergrund weiter.
// Was es tut, steht in release/install-local.log.
import { execFileSync, execSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'release');
const LOG = join(OUT, 'install-local.log');
const LOCK = join(OUT, 'install-local.lock');
const AGAIN = join(OUT, 'install-local.again');
const HOOK_MARK = '# SIPFunk install-local';
const HOOKS = ['post-commit', 'post-merge'];
const args = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const product = pkg.build?.productName || 'SIPFunk';

const say = (text) => console.log(`${new Date().toLocaleTimeString('de-DE')} ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();

/** Ordner der installierten Fassung laut Windows („Installierte Apps“), sonst ''. */
function installDir() {
  for (const hive of ['HKCU', 'HKLM']) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', product, '/d'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    } catch { continue; } // kein Treffer
    for (const block of out.split(/\r?\n\r?\n/)) {
      if (!new RegExp(`^\\s+DisplayName\\s+REG_SZ\\s+${product}( |$)`, 'm').test(block)) continue;
      const m = /^\s+InstallLocation\s+REG_SZ\s+(.+)$/m.exec(block) || /^\s+UninstallString\s+REG_SZ\s+"?(.+?)\\[^\\]+\.exe/m.exec(block);
      const dir = m ? m[1].trim().replace(/^"|"$/g, '') : '';
      if (dir && existsSync(join(dir, `${product}.exe`))) return dir;
    }
  }
  return '';
}

/** Zustand der laufenden App über die lokale Web-UI; null, wenn nichts antwortet. */
async function phase() {
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.WEB_PORT || 8080}/api/status`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).status?.phase ?? '';
  } catch {
    return null;
  }
}

function setupHooks(off) {
  const dir = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks');
  mkdirSync(dir, { recursive: true });
  for (const name of HOOKS) {
    const file = join(dir, name);
    const own = existsSync(file) && readFileSync(file, 'utf8').includes(HOOK_MARK);
    if (existsSync(file) && !own) {
      say(`${name}: Es gibt schon einen anderen Hook, er bleibt unverändert. Füge dort von Hand ein: node scripts/install-local.mjs --hook`);
      continue;
    }
    if (off) { rmSync(file, { force: true }); say(`${name}: entfernt`); continue; }
    writeFileSync(file, `#!/bin/sh\n${HOOK_MARK}: installierte App nach Commit/Merge auf main aktualisieren (npm run install:auto)\n[ -f scripts/install-local.mjs ] && node scripts/install-local.mjs --hook >/dev/null 2>&1\nexit 0\n`, { mode: 0o755 });
    say(`${name}: eingerichtet`);
  }
  if (!off) say(installDir() ? 'Ab jetzt wird die installierte App nach jedem Commit oder Merge auf main aktualisiert.' : `Hinweis: ${product} ist noch nicht installiert. Erst einmal den Installer von Hand ausführen, danach greifen die Hooks.`);
}

async function update() {
  const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  say(`Baue den Installer aus ${git('rev-parse', '--short', 'HEAD')} …`);
  run('npm run build');
  run('npm run icons');
  run('npx electron-builder --win nsis --publish never');
  const installer = join(OUT, `${product}-${pkg.version}-win-x64.exe`);
  if (!existsSync(installer)) throw new Error(`Installer fehlt: ${installer}`);

  // Kein Update mitten im Gespräch: bis zu 15 Minuten warten, dann aufgeben
  const busy = ['calling', 'ringing', 'incoming', 'connected'];
  for (let i = 0; busy.includes(await phase()); i++) {
    if (i === 0) say('Es läuft ein Gespräch – warte, bis es beendet ist …');
    if (i >= 90) throw new Error('Gespräch läuft noch immer; nichts installiert. Später „npm run install:local“ ausführen.');
    await sleep(10_000);
  }

  // Erst höflich beenden (auflegen, an der Telefonanlage abmelden); der Installer würde den Prozess sonst hart beenden
  const dir = installDir();
  if (dir && (await phase()) !== null) {
    spawn(join(dir, `${product}.exe`), ['--quit'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 16 && (await phase()) !== null; i++) await sleep(500);
  }

  say('Installiere über die vorhandene Fassung …');
  execFileSync(installer, ['/S', '--force-run'], { stdio: 'ignore' });
  say(`Fertig: ${product} läuft mit dem Stand ${git('rev-parse', '--short', 'HEAD')}.`);
}

async function main() {
  if (process.platform !== 'win32') { say('Nur unter Windows.'); return; }
  if (args.includes('--setup')) return setupHooks(args.includes('--off'));

  if (args.includes('--hook')) {
    // Nur auf main; alles Weitere im Hintergrund, damit Git nicht wartet
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') return;
    mkdirSync(OUT, { recursive: true });
    const log = openSync(LOG, 'a');
    spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
    closeSync(log);
    return;
  }

  if (!installDir()) {
    say(`${product} ist nicht installiert. Erst einmal den Installer von Hand ausführen (Releases oder „npm run dist:win“).`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });
  // Läuft schon ein Durchgang (jünger als 20 Minuten), merkt der sich, dass danach noch einer fällig ist
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 20 * 60_000) {
    writeFileSync(AGAIN, '');
    say('Es läuft schon ein Durchgang; der neue Stand folgt direkt danach.');
    return;
  }
  writeFileSync(LOCK, String(process.pid));
  try {
    do {
      rmSync(AGAIN, { force: true });
      await update();
    } while (existsSync(AGAIN));
  } finally {
    rmSync(LOCK, { force: true });
    rmSync(AGAIN, { force: true });
  }
}

main().catch((err) => {
  say(`Fehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
});
