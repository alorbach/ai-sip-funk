// Aufbau der Benachrichtigungs-Mail nach einem angenommenen Anruf: Betreff, Textteil und HTML-Teil.
// Reine Funktionen ohne I/O. Ziel: in drei Sekunden sehen, wer angerufen hat, worum es ging und was zu tun ist.
// Betreff und Text entstehen aus Vorlagen mit Variablen ({anrufer}, {todo} …), die in der Web-UI änderbar sind;
// der HTML-Teil wird aus dem fertigen Text abgeleitet.
import type { Assessment } from '../ai/assess.js';
import type { CallRecord } from '../transcripts.js';

export interface MailTemplates {
  /** Betreff-Vorlage; leer = DEFAULT_MAIL_SUBJECT */
  subject?: string;
  /** Text-Vorlage; leer = DEFAULT_MAIL_BODY */
  body?: string;
}

export interface CallMailInput {
  record: CallRecord;
  assessment: Assessment;
  /** Name aus den Kontakten, falls die Nummer bekannt ist */
  contactName?: string;
  /** Für wen die KI abgenommen hat */
  principal: string;
  webPort: number;
  /** Spam-Abwehr war aktiv (Standard: record.spam) */
  spam?: boolean;
  /** Vorlagen aus den Einstellungen (leer = Standard) */
  templates?: MailTemplates;
  /** Bezugszeit für „heute“/„gestern“ (Standard: jetzt) */
  now?: Date;
}

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

type Kind = 'important' | 'normal' | 'spam' | 'test';

export const DEFAULT_MAIL_SUBJECT = '[SIPFunk] {status} · {anrufer} · {anliegen}';

export const DEFAULT_MAIL_BODY = [
  'Anrufer:  {kontakt}',
  'Zeit:     {zeit}, Dauer {dauer}',
  'Leitung:  {leitung}',
  '',
  'WAS ZU TUN IST',
  '{todo}',
  '',
  'WORUM ES GING',
  '{worum}',
  '',
  'EINSCHÄTZUNG',
  '{einschaetzung}',
  '',
  'GESPRÄCHSVERLAUF (GEKÜRZT)',
  '{verlauf}',
  '',
  '-- ',
  '{link}',
  'Protokoll {id} · {kosten}',
].join('\n');

/** Variablen der Vorlagen mit Kurzbeschreibung (für UI-Hinweis und Doku). */
export const MAIL_VARIABLES: Record<string, string> = {
  status: 'Wichtig, Anruf oder Spam abgewehrt',
  anrufer: 'Name aus den Kontakten, sonst die Nummer',
  name: 'Name aus den Kontakten (leer, wenn unbekannt)',
  nummer: 'Nummer des Anrufers (leer, wenn unterdrückt)',
  kontakt: 'Name und Nummer zusammen',
  anliegen: 'Kurzanliegen, höchstens 60 Zeichen',
  zeit: '„heute 14:50“, „gestern 09:05“ oder Datum mit Uhrzeit',
  dauer: 'Gesprächsdauer',
  gewaehlt: 'gewählte eigene Nummer',
  fuer: 'für wen die KI abgenommen hat',
  leitung: 'gewählte Nummer und „angenommen für …“ zusammen',
  todo: 'Rückruf mit Nummer und offene Punkte',
  worum: 'Ergebnis laut KI, sonst Zusammenfassung (höchstens 5 Zeilen)',
  zusammenfassung: 'vollständige Zusammenfassung',
  einschaetzung: 'wichtig oder unwichtig mit Grund',
  verlauf: 'gekürzter Gesprächsverlauf (bei Spam leer)',
  link: 'Adresse der Seite „Anrufe“ in der Web-UI',
  id: 'Protokoll-ID',
  kosten: '„Kosten ca. … USD“ (leer, wenn unbekannt)',
};

const SUBJECT_MAX = 60;
const TURN_MAX = 200;
const TURNS_MAX = 40;
const ABOUT_LINES = 5;
const ABOUT_CHARS = 600;

/** Markdown-Reste der Zusammenfassung entfernen (Hervorhebungen, Überschriften, Backticks); einzelne Sterne wie in „**610“ bleiben. */
export function plain(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/(\*\*|__|`)(?=[^\s\d])(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Auf max Zeichen kürzen, möglichst an einer Wortgrenze, mit „…“. */
export function shorten(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const word = cut.replace(/\s+\S*$/, '');
  return `${(word.length > max / 2 ? word : cut).replace(/[\s,;:·–-]+$/, '')}…`;
}

/** „heute 14:50“, „gestern 09:05“ oder „07.11.2026 14:50“. */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `heute ${time}`;
  if (diff === 1) return `gestern ${time}`;
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${time}`;
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
}

export function buildCallMail(input: CallMailInput): MailContent {
  const { record, assessment, principal } = input;
  const spam = input.spam ?? record.spam === true;
  const number = /\d/.test(record.target) ? record.target.trim() : '';
  const name = input.contactName?.trim() || '';
  const result = plain(record.outcome?.result ?? '');
  const open = plain(record.outcome?.open ?? '');
  const summary = plain(record.summary ?? '');

  // Kurzanliegen: Kurzzeile der Einschätzung, sonst erste Zeile des Ergebnisses bzw. der Zusammenfassung
  let brief = plain(assessment.headline || '') || (result || summary).split('\n')[0] || '';
  if (name && brief.toLowerCase().startsWith(name.toLowerCase())) {
    // „Praxis Weber: Termin …“ – der Name steht im Betreff schon davor
    const tail = brief.slice(name.length);
    const rest = tail.replace(/^\s*[:,–-]\s*/, '');
    if (rest !== tail) brief = rest;
  }

  let todo: string[];
  let einschaetzung: string;
  let verlauf: string[] = [];
  if (spam) {
    // Spam bewusst kurz: Grund, was verkauft werden sollte, Hinweis auf den Beschwerde-Entwurf; kein Verlauf
    const reason = record.entries.find((e) => e.speaker === 'system' && e.text.startsWith('Spam-Abwehr:'))?.text.replace(/^Spam-Abwehr:\s*/, '') || assessment.reason || 'als Werbe-/Betrugsanruf erkannt';
    einschaetzung = `Spam-Abwehr: ${shorten(plain(reason), 300)}`;
    todo = ['- Nichts. Beschwerde-Entwurf in der Web-UI unter Anrufe.'];
  } else {
    // Einfache Wortsuche; „kein Rückruf nötig“ zählt nicht als Rückrufwunsch
    const said = `${result} ${open} ${assessment.headline}`;
    const wantsCallback = assessment.important || (/r(ü|ue)ckruf|zur(ü|ue)ck\s?(zu)?rufen|zur(ü|ue)ckmelden/i.test(said) && !/kein(en)?\s+r(ü|ue)ckruf|nicht\s+zur(ü|ue)ck/i.test(said));
    todo = [];
    if (wantsCallback) todo.push(number ? `- Zurückrufen: ${number}${name ? ` (${name})` : ''}` : '- Rückruf gewünscht, aber Nummer unterdrückt');
    for (const item of open.split(/\n|;\s+/).map((x) => x.replace(/^-\s*/, '').trim()).filter((x) => x && !/^(nichts|keine?|–)\.?$/i.test(x))) todo.push(`- Offen: ${shorten(item, 240)}`);
    if (!todo.length) todo.push('- Nichts, kein Rückruf nötig.');
    einschaetzung = `${assessment.important ? 'Wichtig' : 'Unwichtig'}${assessment.reason ? ` – ${shorten(plain(assessment.reason), 240)}` : ''}`;
    const turns = record.entries.filter((e) => e.final && e.text.trim() && (e.speaker !== 'system' || e.text.startsWith('Spam-Abwehr:')));
    verlauf = turns.slice(0, TURNS_MAX).map((e) => `${e.speaker === 'ki' ? 'KI: ' : e.speaker === 'partner' ? 'Anr.: ' : ''}${shorten(e.text, TURN_MAX)}`);
    if (turns.length > TURNS_MAX) verlauf.push(`… ${turns.length - TURNS_MAX} weitere Beiträge im Protokoll`);
  }

  const vars: Record<string, string> = {
    status: spam ? 'Spam abgewehrt' : assessment.important ? 'Wichtig' : 'Anruf',
    anrufer: name || number || 'Unbekannt',
    name,
    nummer: number,
    kontakt: name ? `${name}, ${number || 'Nummer unterdrückt'}` : number || 'unbekannt (Nummer unterdrückt)',
    anliegen: spam ? '' : shorten(brief, SUBJECT_MAX),
    zeit: formatWhen(record.startedAt, input.now),
    dauer: formatDuration(record.durationSec),
    gewaehlt: record.called ?? '',
    fuer: principal,
    leitung: [record.called, principal ? `angenommen für ${principal}` : ''].filter(Boolean).join(' · '),
    todo: todo.join('\n'),
    worum: aboutLines(result || summary).join('\n') || (spam ? '' : '(keine Zusammenfassung)'),
    zusammenfassung: summary,
    einschaetzung,
    verlauf: verlauf.join('\n'),
    link: `http://127.0.0.1:${input.webPort}/#calls`,
    id: record.id,
    kosten: record.costUsd !== undefined ? `Kosten ca. ${record.costUsd.toFixed(3).replace('.', ',')} USD` : '',
  };
  return render(spam ? 'spam' : assessment.important ? 'important' : 'normal', vars, input.templates);
}

/** Probe-Mail: dieselben Vorlagen wie die Anruf-Mail, gefüllt mit erkennbaren Beispieldaten. */
export function buildTestMail(provider: string, templates?: MailTemplates, now = new Date()): MailContent {
  const vars: Record<string, string> = {
    status: 'Probe-Mail',
    anrufer: 'Praxis Beispiel',
    name: 'Praxis Beispiel',
    nummer: '030 23125123',
    kontakt: 'Praxis Beispiel, 030 23125123',
    anliegen: `Versand funktioniert (${provider})`,
    zeit: formatWhen(now.toISOString(), now),
    dauer: '1:25 min',
    gewaehlt: '030 23125150',
    fuer: 'dich',
    leitung: '030 23125150 · angenommen für dich',
    todo: '- Nichts. Das ist nur eine Probe; so sind Mails nach echten Anrufen aufgebaut.',
    worum: 'Hier steht das Ergebnis des Gesprächs in wenigen Zeilen.',
    zusammenfassung: 'Hier steht die vollständige Zusammenfassung des Gesprächs.',
    einschaetzung: 'Wichtig oder unwichtig, mit einem Satz Begründung.',
    verlauf: 'KI: Hier folgt bei echten Anrufen der gekürzte Gesprächsverlauf.\nAnr.: Lange Beiträge werden gekürzt, das volle Protokoll steht in der Web-UI.',
    link: '',
    id: 'Beispiel',
    kosten: 'Kosten ca. 0,042 USD',
  };
  return render('test', vars, templates);
}

/** Ergebnis bzw. Zusammenfassung auf wenige Zeilen und Zeichen begrenzen (Zeilenumbrüche bleiben). */
function aboutLines(s: string): string[] {
  const capped = s.length <= ABOUT_CHARS ? s : `${s.slice(0, ABOUT_CHARS - 1).replace(/\s+\S*$/, '')}…`;
  const lines = capped.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= ABOUT_LINES) return lines;
  return [...lines.slice(0, ABOUT_LINES - 1), `${lines[ABOUT_LINES - 1].replace(/[.…]+$/, '')} …`];
}

// ---- Vorlagen füllen ----

const VAR = /\{([a-z_]+)\}/g;

const known = (vars: Record<string, string>, k: string) => Object.hasOwn(vars, k);

/** Trenner aufräumen, die durch leere Variablen übrig bleiben („A ·  · B“, „A · “, „A - - “). */
function tidy(line: string): string {
  return line
    .replace(/(\s+[·|–-])(\s+[·|–-])+(?=\s|$)/g, '$1')
    .replace(/^\s*[·|]\s*/, '')
    .replace(/(\s+[·|–-]|,)\s*$/, '');
}

/** Vorlage füllen; aufgeräumt wird nur, wenn eine Variable der Zeile leer war (Werte bleiben sonst unangetastet). */
function fill(tpl: string, vars: Record<string, string>): string {
  let empty = false;
  const out = tpl.replace(VAR, (m, k: string) => {
    if (!known(vars, k)) return m;
    // Leerzeilen in Werten würden den Absatz teilen
    const v = vars[k].replace(/\n\s*\n+/g, '\n');
    if (!v) empty = true;
    return v;
  });
  return empty ? out.split('\n').map(tidy).join('\n') : out;
}

/** Betreff: einzeilig; unbekannte Variablen bleiben stehen, damit Tippfehler auffallen. */
export function expandSubject(tpl: string, vars: Record<string, string>): string {
  return fill(tpl.replace(/\s+/g, ' '), vars).replace(/\s+/g, ' ').trim();
}

/**
 * Text: Zeilen, deren Variablen alle leer sind, entfallen; ein Absatz (durch Leerzeile getrennt),
 * dessen Variablen-Zeilen alle entfallen, entfällt samt Überschrift (z. B. der Verlauf bei Spam).
 */
export function expandBody(tpl: string, vars: Record<string, string>): string {
  const blocks: string[] = [];
  for (const block of tpl.replace(/\r/g, '').split(/\n[ \t]*\n+/)) {
    const kept: string[] = [];
    let hadVars = false;
    let keptVars = false;
    for (const line of block.split('\n')) {
      const names = [...line.matchAll(VAR)].map((m) => m[1]).filter((k) => known(vars, k));
      if (!names.length) {
        kept.push(line);
        continue;
      }
      hadVars = true;
      if (names.every((k) => !vars[k])) continue;
      keptVars = true;
      kept.push(...fill(line, vars).split('\n'));
    }
    if (hadVars && !keptVars) continue;
    if (kept.some((l) => l.trim())) blocks.push(kept.join('\n'));
  }
  return blocks.join('\n\n');
}

function render(kind: Kind, vars: Record<string, string>, templates?: MailTemplates): MailContent {
  const subject = expandSubject(templates?.subject?.trim() || DEFAULT_MAIL_SUBJECT, vars);
  const text = expandBody(templates?.body?.trim() ? templates.body : DEFAULT_MAIL_BODY, vars);
  return { subject, text, html: renderHtml(kind, subject, text) };
}

// ---- HTML aus dem fertigen Text ----

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Kopfzeile: eigene Hintergrund- UND Schriftfarbe, damit sie hell wie dunkel lesbar bleibt.
// Der Rest setzt keine Farben für Fließtext und Hintergrund; der Mailclient nimmt seine eigenen (auch im Dark Mode).
const BANNER: Record<Kind, string> = {
  important: 'background:#c62828;color:#ffffff',
  normal: 'background:#5f6b7a;color:#ffffff',
  spam: 'background:#f0a020;color:#1a1a1a',
  test: 'background:#2e7d32;color:#ffffff',
};
const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTED = 'color:#808890';
const RULE = 'border-top:1px solid #80889055';
const LABEL = /^([A-ZÄÖÜ][\wäöüÄÖÜß. ]{0,15}):\s+(.+)$/;
const TURN = /^(KI|Anr\.|Spam-Abwehr): (.*)$/;

/** Überschrift = kurze Zeile in Großbuchstaben, der noch Zeilen folgen. */
const isHeading = (line: string) => line.length <= 50 && /[A-ZÄÖÜ]/.test(line) && line === line.toUpperCase() && !/[{}:]/.test(line);

function renderHtml(kind: Kind, subject: string, text: string): string {
  const row = (inner: string, style: string) => `<tr><td style="padding:12px 16px;${style}">${inner}</td></tr>`;
  const title = (t: string) => `<div style="font-size:12px;font-weight:bold;letter-spacing:.04em;${MUTED};margin:0 0 4px">${esc(t)}</div>`;
  const div = (inner: string, size = 14) => `<div style="font-size:${size}px;line-height:1.5">${inner || '&nbsp;'}</div>`;
  // Kopfzeile = Betreff ohne vorangestelltes „[SIPFunk] “
  const rows: string[] = [`<tr><td style="padding:12px 16px;font-size:16px;font-weight:bold;border-radius:6px;${BANNER[kind]}">${esc(subject.replace(/^\[[^\]]*\]\s*/, ''))}</td></tr>`];

  text.split(/\n\n+/).forEach((block, i) => {
    let lines = block.split('\n');
    const rule = i === 0 ? '' : RULE;
    if (lines[0].trim() === '--') {
      // Fußzeile: klein und gedämpft, Adressen als Link
      const inner = lines.slice(1).map((l) => (/^https?:\/\/\S+$/.test(l) ? `<a href="${esc(l)}">${esc(l)}</a>` : esc(l))).join('<br>');
      rows.push(row(inner, `font-size:12px;line-height:1.5;${MUTED};${rule}`));
      return;
    }
    let head = '';
    if (lines.length > 1 && isHeading(lines[0])) {
      head = title(lines[0]);
      lines = lines.slice(1);
    }
    let inner: string;
    if (!head && lines.every((l) => LABEL.test(l))) {
      // Kopf: „Anrufer: …“ als zweispaltige Tabelle
      inner = `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5">${lines
        .map((l) => LABEL.exec(l)!)
        .map((m) => `<tr><td style="padding:0 12px 0 0;vertical-align:top;${MUTED}">${esc(m[1])}</td><td style="vertical-align:top">${esc(m[2])}</td></tr>`)
        .join('')}</table>`;
    } else if (lines.some((l) => TURN.test(l)) && lines.every((l) => TURN.test(l) || l.startsWith('… '))) {
      // Gesprächsverlauf: kleiner Schriftgrad, Sprecher fett
      inner = lines.map((l) => { const m = TURN.exec(l); return div(m ? `<b>${esc(m[1])}:</b> ${esc(m[2])}` : esc(l), 12); }).join('');
    } else {
      inner = lines.map((l) => div(esc(l.replace(/^- /, '• ')))).join('');
    }
    rows.push(row(head + inner, rule));
  });

  return [
    '<!DOCTYPE html>',
    '<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>',
    `<body style="margin:0;padding:12px;${FONT}">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;${FONT}">`,
    ...rows,
    '</table></body></html>',
  ].join('\n');
}
