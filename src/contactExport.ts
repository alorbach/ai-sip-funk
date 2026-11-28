// Kontakt-Export als vCard (Outlook, Google, Handy) oder CSV (Excel). Beides liest der Kontakt-Import wieder ein.
import { allNumbers, type Contact } from './contacts.js';

/** vCard-Text maskieren (RFC 6350): Backslash, Zeilenumbruch, Komma, Semikolon */
const vcText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

/** vCard 3.0, eine Karte je Kontakt; die Hauptnummer (die SIPFunk wählt) zuerst und als bevorzugt markiert */
export function toVcard(contacts: Contact[]): string {
  const cards = contacts.map((c) => {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vcText(c.name)}`, `N:${vcText(c.name)};;;;`];
    allNumbers(c).forEach((n, i) => lines.push(i === 0 ? `TEL;TYPE=VOICE,PREF:${vcText(n)}` : `TEL;TYPE=VOICE:${vcText(n)}`));
    if (c.notes) lines.push(`NOTE:${vcText(c.notes)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  });
  return cards.length ? cards.join('\r\n') + '\r\n' : '';
}

/** CSV-Feld: in Anführungszeichen, wenn Trennzeichen, Anführungszeichen oder Zeilenumbruch darin stehen */
const csvField = (s: string) => (/[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * CSV mit Semikolon und BOM, so öffnet deutsches Excel die Datei per Doppelklick richtig. Weitere Nummern stehen
 * in einer Spalte, getrennt mit Komma (der Import teilt dort auf).
 */
export function toCsv(contacts: Contact[]): string {
  const rows = [['Name', 'Telefon', 'Telefon weitere', 'Notizen']];
  for (const c of contacts) rows.push([c.name, c.number, (c.numbers ?? []).join(', '), c.notes ?? '']);
  return '\uFEFF' + rows.map((r) => r.map(csvField).join(';')).join('\r\n') + '\r\n';
}

/** Dateiname „SIPFunk-Kontakte-2026-11-28.vcf“ */
export function exportFileName(format: 'vcf' | 'csv', now = new Date()): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `SIPFunk-Kontakte-${d}.${format}`;
}
