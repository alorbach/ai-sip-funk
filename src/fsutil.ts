// Kleine Dateihelfer für die Daten im Datenordner (settings.json, contacts.json, .env).
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Schreibt erst in eine Nachbardatei und benennt dann um: Bricht der Prozess mitten im Schreiben ab,
 * bleibt die alte Datei vollständig erhalten statt als halbe, unlesbare Datei zurückzubleiben.
 */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    // Unter Windows scheitert das Umbenennen, wenn ein anderes Programm (Editor, Virenscanner) die Datei offen hält
    writeFileSync(file, text);
    try { rmSync(tmp, { force: true }); } catch { /* bleibt liegen */ }
  }
}

/** Schalterwerte aus .env und Einstellungen: 1, true, yes, ja, on (Groß/Klein egal). */
export function isOn(value: string): boolean {
  return ['1', 'true', 'yes', 'ja', 'on'].includes(value.trim().toLowerCase());
}
