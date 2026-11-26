// Windows-Drucker „SIPFunk Fax“ aus der Web-UI prüfen, einrichten und entfernen. Einrichten und Entfernen laufen über
// scripts/fax-printer.ps1 (im Installationspaket resources/fax/fax-printer.ps1); das Skript fragt per UAC nach
// Administratorrechten. Nur unter Windows.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRINTER_NAME = 'SIPFunk Fax';
const here = path.dirname(fileURLToPath(import.meta.url));

function scriptPath(): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [resources && path.join(resources, 'fax', 'fax-printer.ps1'), path.resolve(here, '../../../fax/fax-printer.ps1'), path.resolve(here, '../../scripts/fax-printer.ps1')];
  return candidates.find((p): p is string => Boolean(p && existsSync(p)));
}

function powershell(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export interface PrinterStatus {
  /** false = kein Windows, Drucker lässt sich hier nicht verwalten */
  supported: boolean;
  installed: boolean;
  /** Port, auf den der Drucker druckt (aus dem Druckeranschluss), falls eingerichtet */
  port?: number;
  /** Skript zum Einrichten gefunden */
  script: boolean;
}

/** Ist der Drucker eingerichtet, und auf welchen Port druckt er? */
export async function printerStatus(): Promise<PrinterStatus> {
  if (process.platform !== 'win32') return { supported: false, installed: false, script: false };
  const cmd = `$p = Get-Printer -Name '${PRINTER_NAME}' -ErrorAction SilentlyContinue; if ($p) { $port = Get-PrinterPort -Name $p.PortName -ErrorAction SilentlyContinue; "ok $($port.PortNumber)" } else { 'fehlt' }`;
  const r = await powershell(['-Command', cmd], 15_000);
  const m = /^ok\s*(\d*)/m.exec(r.out);
  return { supported: true, installed: Boolean(m), port: m?.[1] ? Number(m[1]) : undefined, script: Boolean(scriptPath()) };
}

/** Drucker einrichten (auf den Port) oder entfernen. Windows fragt nach Administratorrechten; wartet, bis das Skript fertig ist. */
export async function changePrinter(action: 'install' | 'remove', port: number): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: 'Den Drucker gibt es nur unter Windows.' };
  const script = scriptPath();
  if (!script) return { ok: false, error: 'Skript fax-printer.ps1 nicht gefunden.' };
  const args = ['-File', script, '-Port', String(port)];
  if (action === 'remove') args.push('-Remove');
  // Das Skript startet sich bei Bedarf mit UAC neu und wartet auf die erhöhte Instanz; die Nachfrage kann dauern
  const r = await powershell(args, 5 * 60_000);
  if (r.code === 0) return { ok: true };
  return { ok: false, error: /abgebrochen|canceled|cancelled|1223/i.test(r.out) ? 'Die Windows-Abfrage nach Administratorrechten wurde abgelehnt.' : r.out.split(/\r?\n/).pop() || `Skript endete mit Code ${r.code}` };
}
