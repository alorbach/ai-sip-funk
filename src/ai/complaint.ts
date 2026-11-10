// Beschwerde-Entwurf für die Bundesnetzagentur (unerlaubte Telefonwerbung / Rufnummernmissbrauch)
// aus einem Gesprächsprotokoll der Spam-Abwehr. Nur ein Textvorschlag; der Inhaber prüft, ergänzt
// und reicht ihn selbst ein (Online-Formular der Bundesnetzagentur). Keine Rechtsberatung.
import { responsesText } from './summary.js';
import type { CallRecord } from '../transcripts.js';

/** Die Fakten aus dem Protokoll, die in jede Beschwerde gehören – ohne Modell, testbar. */
export function complaintFacts(r: CallRecord, callerName?: string): string[] {
  const when = new Date(r.startedAt);
  const date = when.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = when.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const caller = /\d{3,}/.test(r.target) ? r.target : 'unterdrückt / nicht übermittelt';
  const called = r.called || 'eigener Anschluss';
  return [
    `Datum: ${date}, Uhrzeit: ${time} Uhr`,
    `Anrufende Rufnummer (Anzeige): ${caller}${callerName ? ` (gespeichert als „${callerName}“)` : ''}`,
    `Angerufene Rufnummer: ${called}`,
    `Gesprächsdauer: ${r.durationSec} Sekunden`,
    `Einwilligung in Werbeanrufe: nicht erteilt`,
    ...(r.outcome?.result ? [`Anliegen laut Gespräch: ${r.outcome.result}`] : []),
  ];
}

/** Prompt für das Textmodell; getrennt, damit Tests ihn prüfen können. */
export function buildComplaintPrompt(r: CallRecord, callerName?: string): string {
  const dialog = r.entries
    .filter((e) => e.final || e.speaker === 'system')
    .map((e) => `${e.speaker === 'ki' ? 'Angerufener (automatischer Assistent)' : e.speaker === 'partner' ? 'Anrufer' : 'System'}: ${e.text}`)
    .join('\n');
  return [
    'Verfasse einen sachlichen Beschwerdetext für das Online-Formular der Bundesnetzagentur zu unerlaubter Telefonwerbung (§ 7 UWG) bzw. Rufnummernmissbrauch (§ 123 TKG). Der Text ist aus Sicht des Anschlussinhabers in der Ich-Form, höflich, ohne Vorwürfe, die das Protokoll nicht belegt, ohne Rechtsbewertung und ohne Floskeln.',
    'Aufbau: 1. Sachverhalt (Datum, Uhrzeit, Nummern, Dauer). 2. Inhalt des Anrufs: wer hat angerufen (genannte Firma, Produkt, Angebot, Aufforderungen), möglichst mit wörtlichen Zitaten des Anrufers aus dem Protokoll. 3. Hinweis, dass keine Einwilligung in Werbeanrufe vorliegt. 4. Hinweis, dass der Anruf von einem automatischen Telefonassistenten des Anschlussinhabers entgegengenommen wurde und das Gespräch als Textprotokoll vorliegt, das auf Wunsch nachgereicht wird. 5. Bitte um Prüfung.',
    'Erfinde nichts: Was im Protokoll nicht steht (Firmenname, Produkt, Nummer), lass weg oder markiere es als „nicht genannt“. Keine Anrede- und Grußzeile, keine Platzhalter in eckigen Klammern außer [Name, Anschrift] am Ende. Höchstens 250 Wörter.',
    '',
    '## Fakten',
    ...complaintFacts(r, callerName),
    '',
    '## Gesprächsprotokoll',
    dialog || '(leer)',
    ...(r.summary ? ['', '## Zusammenfassung', r.summary] : []),
  ].join('\n');
}

export async function draftComplaint(apiKey: string, model: string, record: CallRecord, callerName?: string): Promise<string> {
  const text = await responsesText(apiKey, model, buildComplaintPrompt(record, callerName), 1500);
  const body = text.trim();
  return [
    body,
    '',
    ...(body.includes('[Name, Anschrift]') ? [] : ['[Name, Anschrift]', '']),
    '— Entwurf aus SIPFunk. Bitte prüfen und selbst einreichen: Bundesnetzagentur › Verbraucher › Unerlaubte Telefonwerbung (Online-Formular). Keine Rechtsberatung.',
  ].join('\n');
}
