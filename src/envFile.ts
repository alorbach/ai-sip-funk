// .env im Datenordner gezielt ändern: Der Einrichtungsassistent schreibt hierüber die Zugangsdaten
// (SIP, OpenAI). Kommentare und alle anderen Zeilen bleiben, wie sie sind. Gelesen wird die Datei
// weiterhin nur beim Start über process.loadEnvFile; zurückgeliefert werden die Werte nie.
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fsutil.js';

/**
 * Wert so schreiben, dass process.loadEnvFile ihn unverändert liest: Ohne Anführungszeichen beginnt mit „#" ein
 * Kommentar und Leerzeichen am Rand entfallen; in doppelten wird „\n" umgesetzt. Darum einfache Anführungszeichen,
 * und nur wenn der Wert selbst eines enthält, doppelte bzw. Backticks.
 */
export function quoteEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Zeilenumbrüche sind in Zugangsdaten nicht erlaubt');
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new Error('Dieser Wert enthält alle drei Arten von Anführungszeichen und lässt sich nicht in der .env ablegen');
}

/** Setzt die genannten Schlüssel im .env-Text: vorhandene Zeile ersetzen (erste gewinnt, Dubletten entfallen), sonst anhängen. */
export function updateEnvText(text: string, values: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !(key in values)) {
      out.push(line);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    out.push(`${key}=${quoteEnvValue(values[key])}`);
  }
  const missing = Object.keys(values).filter((k) => !done.has(k));
  if (missing.length) {
    while (out.length && out[out.length - 1] === '') out.pop();
    if (out.length) out.push('');
    for (const k of missing) out.push(`${k}=${quoteEnvValue(values[k])}`);
  }
  if (out[out.length - 1] !== '') out.push('');
  return out.join(eol);
}

/** Schreibt die Schlüssel in die .env (legt sie an, falls sie fehlt) und übernimmt sie in den laufenden Prozess. */
export function writeEnvValues(file: string, values: Record<string, string>): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileAtomic(file, updateEnvText(text, values));
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}
