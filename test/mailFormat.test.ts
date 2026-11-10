import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallMail, buildTestMail, DEFAULT_MAIL_BODY, DEFAULT_MAIL_SUBJECT, expandBody, expandSubject, formatWhen, MAIL_VARIABLES, shorten } from '../src/notify/mailFormat.js';
import { publicSettings, type FormSettings } from '../src/settings.js';
import type { CallRecord } from '../src/transcripts.js';

const now = new Date(2026, 10, 10, 16, 0);
const record = (over: Partial<CallRecord> = {}): CallRecord => ({
  id: '2026-11-10T13-50-00_03023125123',
  startedAt: new Date(2026, 10, 10, 14, 50).toISOString(),
  endedAt: new Date(2026, 10, 10, 14, 52).toISOString(),
  target: '030 23125123',
  called: '030 23125150',
  mode: 'ai',
  durationSec: 85,
  endReason: 'bye',
  summary: '**Anliegen:** Die Praxis möchte den Termin am Dienstag verschieben.\n* Rückruf erbeten',
  outcome: { result: 'Praxis Weber möchte den Termin am Dienstag verschieben und bittet um Rückruf.', open: 'Neuen Termin abstimmen; Versichertenkarte mitbringen' },
  entries: [
    { speaker: 'ki', text: 'Guten Tag, hier ist der Anrufbeantworter.', final: true },
    { speaker: 'partner', text: 'Halb', final: false },
    { speaker: 'partner', text: `Hallo, Praxis Weber hier. ${'Sehr lang. '.repeat(40)}`, final: true },
    { speaker: 'system', text: 'Ergebnis laut KI: intern', final: true },
  ],
  costUsd: 0.0421,
  ...over,
});
const base = { principal: 'Max', webPort: 8080, now };

test('Mail-Format: wichtiger Anruf – Betreff, Blöcke, Rückruf, keine Markdown-Sterne', () => {
  const m = buildCallMail({ ...base, record: record(), contactName: 'Praxis Weber', assessment: { important: true, reason: 'Termin mit **Frist**.', headline: 'Praxis Weber: Termin verschieben, bitte Rückruf' } });
  assert.equal(m.subject, '[SIPFunk] Wichtig · Praxis Weber · Termin verschieben, bitte Rückruf');
  // Kopf: Name, Nummer, Zeit, Dauer, gewählte Nummer
  assert.match(m.text, /Anrufer:\s+Praxis Weber, 030 23125123/);
  assert.match(m.text, /Zeit:\s+heute 14:50, Dauer 1:25 min/);
  assert.match(m.text, /Leitung:\s+030 23125150 · angenommen für Max/);
  assert.match(m.text, /- Zurückrufen: 030 23125123/);
  assert.match(m.text, /- Offen: Neuen Termin abstimmen\n- Offen: Versichertenkarte mitbringen/);
  assert.match(m.text, /Wichtig – Termin mit Frist\./);
  assert.ok(!m.text.includes('*'));
  // Reihenfolge der Blöcke
  const pos = ['WAS ZU TUN IST', 'WORUM ES GING', 'EINSCHÄTZUNG', 'GESPRÄCHSVERLAUF', 'http://127.0.0.1:8080/#calls'].map((t) => m.text.indexOf(t));
  assert.ok(pos.every((p, i) => p > 0 && (i === 0 || p > pos[i - 1])), `Reihenfolge: ${pos.join(',')}`);
  // Verlauf: nur finale Beiträge, gekürzt, ohne interne Systemzeilen
  assert.ok(!m.text.includes('Halb'));
  assert.ok(!m.text.includes('Ergebnis laut KI'));
  const turn = m.text.split('\n').find((l) => l.startsWith('Anr.: '))!;
  assert.ok(turn.length <= 210 && turn.endsWith('…'));
  assert.match(m.text, /Protokoll 2026-11-10T13-50-00_03023125123 · Kosten ca\. 0,042 USD/);
  // HTML: Betrefftext, Einschätzungszeile in kräftiger Farbe, keine externen Ressourcen
  assert.ok(m.html.includes('Wichtig · Praxis Weber · Termin verschieben, bitte Rückruf'));
  assert.ok(m.html.includes('background:#c62828'));
  assert.ok(m.html.includes('Wichtig – Termin mit Frist.'));
  assert.ok(!/<img|<link|<script|src=/.test(m.html));
});

test('Mail-Format: unwichtiger Anruf ohne Kontakt – Nummer im Betreff, Kurzanliegen gekürzt', () => {
  const long = 'Der Anrufer wollte sich nur allgemein nach den Öffnungszeiten erkundigen und meldet sich bei Bedarf wieder';
  const m = buildCallMail({ ...base, record: record({ outcome: { result: long, open: '' }, summary: '' }), assessment: { important: false, reason: 'Kein Anliegen.', headline: '' } });
  assert.ok(m.subject.startsWith('[SIPFunk] Anruf · 030 23125123 · Der Anrufer wollte'));
  const brief = m.subject.split(' · ')[2];
  assert.ok(brief.length <= 60 && brief.endsWith('…'), brief);
  assert.match(m.text, /- Nichts, kein Rückruf nötig\./);
  assert.match(m.text, /Unwichtig – Kein Anliegen\./);
  assert.ok(m.html.includes('background:#5f6b7a'));
});

test('Mail-Format: Zusammenfassung als Ersatz, Markdown entfernt, unterdrückte Nummer', () => {
  const m = buildCallMail({ ...base, record: record({ target: '', outcome: undefined }), assessment: { important: true, reason: 'Rückrufwunsch', headline: 'Termin verschieben' } });
  assert.equal(m.subject, '[SIPFunk] Wichtig · Unbekannt · Termin verschieben');
  assert.match(m.text, /Anliegen: Die Praxis möchte den Termin am Dienstag verschieben\.\n- Rückruf erbeten/);
  assert.match(m.text, /Rückruf gewünscht, aber Nummer unterdrückt/);
  assert.ok(!m.text.includes('**'));
});

test('Mail-Format: Spam kurz – Grund, Hinweis auf Beschwerde-Entwurf, kein Verlauf', () => {
  const r = record({
    spam: true,
    outcome: { result: 'Wollte einen Stromvertrag der Beispiel Energie GmbH verkaufen.', open: '' },
    entries: [
      { speaker: 'system', text: 'Spam-Abwehr: Werbeanruf ohne Einwilligung', final: true },
      { speaker: 'partner', text: 'Wir haben ein Angebot für Sie.', final: true },
    ],
  });
  const m = buildCallMail({ ...base, record: r, assessment: { important: false, reason: 'Spam-Abwehr war aktiv', headline: '' } });
  assert.equal(m.subject, '[SIPFunk] Spam abgewehrt · 030 23125123');
  assert.match(m.text, /EINSCHÄTZUNG\nSpam-Abwehr: Werbeanruf ohne Einwilligung/);
  assert.match(m.text, /Stromvertrag/);
  assert.match(m.text, /Beschwerde-Entwurf in der Web-UI unter Anrufe/);
  assert.ok(!m.text.includes('GESPRÄCHSVERLAUF'));
  assert.ok(!m.text.includes('Wir haben ein Angebot'));
  assert.ok(m.html.includes('background:#f0a020'));
});

test('Mail-Format: Probe-Mail, Zeitangabe, Kürzung, HTML-Escaping', () => {
  const t = buildTestMail('smtp', undefined, now);
  assert.equal(t.subject, '[SIPFunk] Probe-Mail · Praxis Beispiel · Versand funktioniert (smtp)');
  assert.match(t.text, /WAS ZU TUN IST/);
  assert.ok(t.html.includes('Probe-Mail · Praxis Beispiel · Versand funktioniert (smtp)'));

  assert.equal(formatWhen(new Date(2026, 10, 9, 9, 5).toISOString(), now), 'gestern 09:05');
  assert.equal(formatWhen(new Date(2026, 10, 7, 14, 50).toISOString(), now), '07.11.2026 14:50');
  assert.equal(shorten('kurz', 60), 'kurz');
  assert.equal(shorten('eins zwei drei vier fünf', 17), 'eins zwei drei…');

  const m = buildCallMail({ ...base, record: record({ outcome: { result: 'Frage zu <Tarif> & Preis', open: '' } }), assessment: { important: false, reason: '', headline: '' } });
  assert.ok(m.html.includes('Frage zu &lt;Tarif&gt; &amp; Preis'));
});

test('Mail-Format: eigene Vorlagen mit Variablen', () => {
  const templates = { subject: 'Tel: {anrufer} ({status}) {gibtsnicht}', body: 'Von {name} / {nummer} um {zeit}\n\nNOTIZ\n{worum}\n\nVERLAUF\n{verlauf}\n\nID {id} · {kosten}' };
  const a = { important: true, reason: 'Frist', headline: 'Termin' };
  const m = buildCallMail({ ...base, record: record({ costUsd: undefined }), contactName: 'Praxis Weber', assessment: a, templates });
  // Unbekannte Variablen bleiben stehen, damit Tippfehler auffallen
  assert.equal(m.subject, 'Tel: Praxis Weber (Wichtig) {gibtsnicht}');
  assert.ok(m.text.startsWith('Von Praxis Weber / 030 23125123 um heute 14:50\n\nNOTIZ\nPraxis Weber möchte'));
  // Leere Variable am Zeilenende: Trenner verschwindet
  assert.ok(m.text.endsWith('\n\nID 2026-11-10T13-50-00_03023125123'));
  assert.ok(m.html.includes('>NOTIZ</div>'));
  assert.ok(m.html.includes('Tel: Praxis Weber (Wichtig)'));
  // Spam: Absatz mit leerem Verlauf entfällt samt Überschrift
  const spam = buildCallMail({ ...base, record: record({ spam: true }), assessment: a, templates });
  assert.ok(!spam.text.includes('VERLAUF'));
  // Leere Vorlagen = Standard
  const def = buildCallMail({ ...base, record: record(), assessment: a, templates: { subject: ' ', body: '' } });
  assert.ok(def.subject.startsWith('[SIPFunk] Wichtig · '));
  assert.ok(def.text.startsWith('Anrufer:  030 23125123\n'));

  assert.equal(expandSubject('{a} · {b} · {c}', { a: 'X', b: '', c: '' }), 'X');
  assert.equal(expandSubject('{a} · {b} · {c}', { a: 'X', b: '', c: 'Z' }), 'X · Z');
  assert.equal(expandBody('Fest\n\nKOPF\n{a}\n{b}\n\nENDE {a}', { a: '', b: 'eins\nzwei' }), 'Fest\n\nKOPF\neins\nzwei');
  // Jede Variable der Standardvorlagen ist dokumentiert
  for (const v of `${DEFAULT_MAIL_SUBJECT}\n${DEFAULT_MAIL_BODY}`.matchAll(/\{([a-z_]+)\}/g)) assert.ok(v[1] in MAIL_VARIABLES, v[1]);
});

test('Mail-Vorlagen in den Einstellungen: leer zeigt die Standardvorlage', () => {
  const s = publicSettings({ mailSubject: '', mailBody: '  ', smtpPass: '' } as FormSettings);
  assert.equal(s.mailSubject, DEFAULT_MAIL_SUBJECT);
  assert.equal(s.mailBody, DEFAULT_MAIL_BODY);
  assert.equal(publicSettings({ mailSubject: 'Eigen {anrufer}', mailBody: '' } as FormSettings).mailSubject, 'Eigen {anrufer}');
});

test('Mail-Format: Randfälle aus dem Review', () => {
  const a = { important: false, reason: '', headline: '' };
  // Verneinter Rückruf ist kein Rückrufwunsch; „nichts“ ist kein offener Punkt
  const no = buildCallMail({ ...base, record: record({ outcome: { result: 'Paket wurde abgegeben. Kein Rückruf nötig.', open: 'nichts' } }), assessment: a });
  assert.ok(!no.text.includes('Zurückrufen'));
  assert.match(no.text, /- Nichts, kein Rückruf nötig\./);
  // Interne Nummern behalten ihre Sterne, Hervorhebungen verlieren sie
  const star = buildCallMail({ ...base, record: record({ outcome: { result: 'Anruf von **610 wegen **Termin** und *Frist*.', open: '' } }), assessment: a });
  assert.match(star.text, /Anruf von \*\*610 wegen Termin und Frist\./);
  // Werte bleiben unangetastet, wenn keine Variable der Zeile leer ist
  assert.equal(expandBody('{a}', { a: 'Ja, das stimmt,' }), 'Ja, das stimmt,');
  assert.equal(expandSubject('{a} - {b} - {c}', { a: 'X', b: '', c: '' }), 'X');
  assert.equal(expandSubject('{constructor} {a}', { a: 'X' }), '{constructor} X');
  // Leerzeilen in Werten teilen den Absatz nicht
  assert.equal(expandBody('KOPF\n{a}', { a: 'eins\n\nzwei' }), 'KOPF\neins\nzwei');
  // Kurzzeile, die nur aus dem Namen besteht, fällt weg
  const max = buildCallMail({ ...base, record: record(), contactName: 'Max', assessment: { important: false, reason: '', headline: 'Max: ' } });
  assert.equal(max.subject, '[SIPFunk] Anruf · Max');
});
