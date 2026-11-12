// Kontakt-Import: Adressbuchdaten (Google, Microsoft, vCard, CSV) in Kandidaten mit Telefonnummern umwandeln,
// mit den vorhandenen Kontakten abgleichen und die Auswahl übernehmen. Alles läuft nur im Arbeitsspeicher;
// gespeichert werden allein die Kontakte, die der Nutzer übernimmt.
import { randomBytes } from 'node:crypto';
import { numberKey, type Contact, type ContactInput, type ContactStore } from './contacts.js';
import { checkDialTarget } from './dialPolicy.js';

export type PhoneLabel = 'mobil' | 'privat' | 'geschäftlich' | 'sonstige';

export interface ImportCandidate {
  name: string;
  numbers: { number: string; label: PhoneLabel }[];
}

/** Ein Eintrag der Vorschau: je Nummer, ob und bei wem sie schon gespeichert ist. */
export interface PreviewItem {
  id: string;
  name: string;
  /** known = Name des Kontakts, der die Nummer schon hat; shared = steht auch bei einem anderen Eintrag dieses Adressbuchs */
  numbers: { number: string; label: PhoneLabel; known?: string; shared?: boolean; sharedWith?: string[] }[];
  /** new = keine Nummer bekannt; partial = einige Nummern gehören schon zu einem Kontakt; exists = alle bekannt */
  status: 'new' | 'partial' | 'exists';
  /** Vorhandener Kontakt, zu dem bekannte Nummern gehören */
  existing?: string;
  /**
   * partial: true = derselbe Mensch, fehlende Nummern lassen sich beim vorhandenen Kontakt ergänzen (siehe canMerge);
   * sonst wird beim Import ein neuer Kontakt nur mit den noch unbekannten Nummern angelegt.
   */
  mergeable?: boolean;
  /** partial: die eigene Karte des Inhabers – wird nicht importiert (weitere eigene Nummern von Hand eintragen) */
  ownCard?: boolean;
  /** Es gibt schon einen Kontakt mit genau diesem Namen (andere Nummer); ein Import legt ihn ein zweites Mal an */
  sameName?: boolean;
  /** Der Name steht mehrmals im Adressbuch; gewählte Karten mit genau diesem Namen werden ein Kontakt */
  twin?: boolean;
}

const LABEL_ORDER: PhoneLabel[] = ['mobil', 'privat', 'geschäftlich', 'sonstige'];

/**
 * Nummer aus dem Adressbuch in die SIPFunk-Schreibweise bringen: nur Ziffern, deutsche Nummern national mit 0,
 * ausländische mit +. Durchwahl-Zusätze („ext. 12“) und Fremdtext fallen weg; zu kurz oder leer = undefined.
 */
export function normalizeImportNumber(raw: string): string | undefined {
  // Begrenzen und Leerraum zusammenfassen, bevor gesucht wird (keine langen Laufzeiten bei präparierten Dateien)
  let s = String(raw ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
  // FRITZ!Box-Nebenstelle, auch mit Zusatz („**610 (Büro)“); ohne die Sterne ginge der Anruf ins öffentliche Netz
  const internal = /^\*\*\s*(\d+)/.exec(s);
  if (internal) return '**' + internal[1];
  // Vorangestellte Bezeichnung („tel:“, „Handy 0171 …“) weg: ab dem ersten +, ( oder Ziffer
  const start = s.search(/[+(\d]/);
  if (start < 0) return undefined;
  s = s.slice(start);
  // Hinter der Nummer: Wahlpausen (, ;), Durchwahl-Zusätze („ext. 12“, „x12“, „p123“) und sonstiger Text fallen weg
  const end = s.search(/[,;a-z]/i);
  if (end >= 0) s = s.slice(0, end);
  s = s.replace(/\(0\)/g, '').replace(/^\(\s*\+\s*(\d{1,3})\s*\)/, '+$1'); // „+49 (0)30 …“, „(+49) 171 …“
  const plus = s.startsWith('+');
  // „+43 0664 …“: eine nach der Landesvorwahl irrtümlich mitgeschriebene 0 entfällt
  // (nicht in Italien, San Marino und dem Vatikan: dort gehört die 0 zur Nummer, „+39 06 …“)
  if (plus) s = s.replace(/^\+(\d{1,3})[ \-/]+0(?=\d)/, (m, cc: string) => (/^(39|378|379)$/.test(cc) ? m : `+${cc} `));
  let digits = s.replace(/\D/g, '');
  if (!plus && digits.startsWith('00')) digits = '+' + digits.slice(2);
  else if (plus) digits = '+' + digits;
  if (digits.startsWith('+49')) digits = '0' + digits.slice(3).replace(/^0/, '');
  const count = digits.replace(/\D/g, '').length;
  return count >= 3 && count <= 20 ? digits : undefined;
}

/**
 * Inhalt einer Adressbuch-Datei als Text: UTF-8 (mit oder ohne BOM), UTF-16 mit BOM (Excel „Unicode-Text“),
 * sonst Windows-1252 – so speichern deutsches Outlook und Excel ihre CSV-Dateien.
 */
export function decodeImportFile(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Ein Feld mit mehreren Nummern („0171 … / 0221 …“, „… , …“, „… oder …“, Google „ ::: “) aufteilen. Teile mit
 * weniger als sechs Ziffern hinter der ersten Nummer sind Wahlpausen oder Durchwahlen („,,1234“) und fallen weg.
 * Ein Schrägstrich zwischen Vorwahl und Rufnummer bleibt Teil der Nummer („0171/5550100“, „0171 / 5550100“).
 */
export function splitNumbers(value: string): string[] {
  const parts = String(value ?? '')
    .slice(0, 400)
    .split(/[,;]|:::|\s+oder\s+|\s+or\s+|\n/i)
    // „ / “ trennt nur zwei ganze Nummern; „0171 / 5550100“ und „+49 (0)221 / 1234567“ sind Vorwahl und Rufnummer.
    // Eine ganze Nummer beginnt mit +, 0, ( oder *; eine Teilnehmernummer nie mit 0.
    .flatMap((p) => {
      const s = p.split(/\s+\/\s+/);
      const whole = s.length > 1 && s.every((x) => x.replace(/\D/g, '').length >= 6) && s.slice(1).every((x) => /^[+(0*]/.test(x.trim()));
      return whole ? s : [p];
    })
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.filter((p, i) => i === 0 || p.replace(/\D/g, '').length >= 6);
}

/** Bezeichnung einer Nummer aus Typ-Angaben wie „CELL“, „mobile“, „Business Phone“, „Telefon privat“; Fax und Pager = undefined. */
export function phoneLabel(type: string): PhoneLabel | undefined {
  const t = type.toLowerCase();
  if (/fax|pager|piepser/.test(t)) return undefined;
  if (/cell|mobil|handy|iphone/.test(t)) return 'mobil';
  if (/work|business|geschäft|geschaeft|büro|buero|company|firma|dienst/.test(t)) return 'geschäftlich';
  if (/home|privat|zuhause/.test(t)) return 'privat';
  return 'sonstige';
}

/**
 * Kandidaten bereinigen: Nummern normalisieren, Mobil zuerst, doppelte Nummern innerhalb eines Eintrags nur einmal.
 * Teilen sich zwei Einträge eine Nummer (Festnetz der Familie), stehen beide in der Vorschau; beim Import bekommt
 * sie der erste gewählte Eintrag (applyImport).
 */
export function cleanCandidates(raw: { name: string; numbers: { value: string; type: string }[] }[]): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  for (const r of raw) {
    const seen = new Set<string>();
    const numbers: ImportCandidate['numbers'] = [];
    for (const n of r.numbers.flatMap((x) => splitNumbers(x.value).map((value) => ({ value, type: x.type })))) {
      const label = phoneLabel(n.type);
      const number = label ? normalizeImportNumber(n.value) : undefined;
      if (!label || !number) continue;
      const key = numberKey(number);
      if (seen.has(key)) continue;
      seen.add(key);
      numbers.push({ number, label });
    }
    if (!numbers.length) continue;
    // Mobil vor Privat vor Geschäftlich; eine wählbare Nummer vor einer gesperrten (Ausland, Sondernummer), denn die
    // erste wird die Nummer, die SIPFunk wählt
    const dialable = (n: string) => (checkDialTarget(n) === undefined ? 0 : 1);
    numbers.sort((a, b) => dialable(a.number) - dialable(b.number) || LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label));
    // Begrenzt: Namen und Nummernzahl einer Karte gehen in Vergleiche ein, die je Nummer laufen
    const name = r.name.replace(/\s+/g, ' ').trim().slice(0, 120) || numbers[0].number;
    out.push({ name, numbers: numbers.slice(0, 20) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// ---------------------------------------------------------------- Google People API

interface GooglePerson {
  names?: { displayName?: string }[];
  organizations?: { name?: string }[];
  phoneNumbers?: { value?: string; canonicalForm?: string; type?: string; formattedType?: string }[];
}

export function fromGoogle(people: GooglePerson[]): ImportCandidate[] {
  return cleanCandidates(
    people.map((p) => ({
      name: p.names?.[0]?.displayName || p.organizations?.[0]?.name || '',
      numbers: (p.phoneNumbers ?? []).map((n) => ({ value: n.canonicalForm || n.value || '', type: n.type || n.formattedType || '' })),
    })),
  );
}

// ---------------------------------------------------------------- Microsoft Graph

interface GraphContact {
  displayName?: string;
  givenName?: string;
  surname?: string;
  companyName?: string;
  mobilePhone?: string | null;
  homePhones?: string[];
  businessPhones?: string[];
}

export function fromGraph(contacts: GraphContact[]): ImportCandidate[] {
  return cleanCandidates(
    contacts.map((c) => ({
      name: c.displayName || [c.givenName, c.surname].filter(Boolean).join(' ') || c.companyName || '',
      numbers: [
        ...(c.mobilePhone ? [{ value: c.mobilePhone, type: 'mobile' }] : []),
        ...(c.homePhones ?? []).map((value) => ({ value, type: 'home' })),
        ...(c.businessPhones ?? []).map((value) => ({ value, type: 'business' })),
      ],
    })),
  );
}

// ---------------------------------------------------------------- vCard (iCloud, Google, Outlook, Handy-Export)

function decodeQuotedPrintable(text: string, charset = 'utf-8'): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(text[i], 'utf8'));
  }
  try {
    return new TextDecoder(charset).decode(Buffer.from(bytes));
  } catch {
    return Buffer.from(bytes).toString('utf8'); // unbekannter Zeichensatz
  }
}

const unescapeVcard = (s: string) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

export function fromVcard(text: string): ImportCandidate[] {
  // Gefaltete Zeilen zusammenführen (Fortsetzung beginnt mit Leerzeichen/Tab; bei Quoted-Printable endet die Zeile mit „=“)
  const lines: string[] = [];
  for (const l of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && /^[ \t]/.test(l)) lines[lines.length - 1] = prev + l.slice(1);
    else if (prev !== undefined && /QUOTED-PRINTABLE/i.test(prev.split(':')[0]) && prev.endsWith('=')) lines[lines.length - 1] = prev.slice(0, -1) + l;
    else lines.push(l);
  }
  const raw: { name: string; numbers: { value: string; type: string }[] }[] = [];
  type Card = { fn: string; n: string; org: string; numbers: { value: string; type: string; group?: string }[]; labels: Map<string, string> };
  let cur: Card | undefined;
  // iCloud schreibt eigene Bezeichnungen als „item1.TEL“ mit „item1.X-ABLabel:Büro“ daneben
  const finish = (c: Card) => raw.push({ name: c.fn || c.n || c.org, numbers: c.numbers.map((x) => ({ value: x.value, type: [x.type, x.group ? c.labels.get(x.group) : ''].filter(Boolean).join(',') })) });
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);
    const [propRaw, ...params] = head.split(';');
    const group = /^([^.]+)\./.exec(propRaw)?.[1]?.toLowerCase();
    const prop = propRaw.replace(/^[^.]+\./, '').toUpperCase();
    if (prop === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') {
      if (cur) finish(cur); // Karte ohne END:VCARD nicht verlieren
      cur = { fn: '', n: '', org: '', numbers: [], labels: new Map() };
      continue;
    }
    if (!cur) continue;
    if (prop === 'END' && value.trim().toUpperCase() === 'VCARD') {
      finish(cur);
      cur = undefined;
      continue;
    }
    if (params.some((p) => /^(ENCODING=)?QUOTED-PRINTABLE$/i.test(p))) {
      const charset = params.find((p) => /^CHARSET=/i.test(p))?.slice(8);
      value = decodeQuotedPrintable(value, charset || 'utf-8');
    }
    if (prop === 'X-ABLABEL' && group) cur.labels.set(group, value.replace(/^_\$!<|>!\$_$/g, ''));
    if (prop === 'FN') cur.fn = unescapeVcard(value).trim();
    else if (prop === 'N') {
      const [family = '', given = '', middle = ''] = value.split(';').map(unescapeVcard);
      cur.n = [given, middle, family].filter((x) => x.trim()).join(' ');
    } else if (prop === 'ORG') cur.org = unescapeVcard(value.split(';')[0]).trim();
    else if (prop === 'TEL') {
      // TYPE=CELL,VOICE · type=cell;type=pref · vCard 2.1: TEL;CELL;VOICE:…
      const type = params.map((p) => p.replace(/^TYPE=/i, '')).join(',');
      cur.numbers.push({ value, type, group });
    }
  }
  if (cur) finish(cur);
  return cleanCandidates(raw);
}

// ---------------------------------------------------------------- CSV (Google-CSV, Outlook-CSV, allgemein)

/** CSV nach RFC 4180 mit Anführungszeichen; Trennzeichen Komma oder Semikolon (deutsches Excel/Outlook) wird erkannt. */
export function parseCsv(text: string): string[][] {
  let src = text.replace(/^\uFEFF/, '');
  // Excel schreibt auf Wunsch „sep=;“ als erste Zeile
  let sep: string | undefined;
  const sepLine = /^sep=(.)\r?\n/i.exec(src);
  if (sepLine) {
    sep = sepLine[1];
    src = src.slice(sepLine[0].length);
  }
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const count = (c: string) => firstLine.split(c).length - 1;
  // Komma, Semikolon (deutsches Excel/Outlook) oder Tabulator (Excel „Unicode-Text“)
  sep ??= ['\t', ';', ','].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true; // ein " mitten im Feld ist ein Zeichen, kein Feldbeginn
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export function fromCsv(text: string): ImportCandidate[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const h = header.map((x) => x.trim());
  const col = (...names: string[]) => h.findIndex((x) => names.some((n) => x.toLowerCase() === n.toLowerCase()));
  const nameCol = col('Name', 'Display Name', 'Anzeigename', 'Full Name');
  const parts = [col('First Name', 'Given Name', 'Vorname'), col('Middle Name', 'Additional Name', 'Weitere Vornamen', 'Zweiter Vorname'), col('Last Name', 'Family Name', 'Nachname')];
  const orgCol = col('Organization 1 - Name', 'Organization Name', 'Company', 'Firma', 'Organisation');
  // Google-CSV: „Phone 1 - Value“ mit „Phone 1 - Type“/„Label“; ein Feld kann mehrere Nummern mit „ ::: “ enthalten
  const googlePhones = h.flatMap((x, i) => {
    const m = /^Phone (\d+) - Value$/i.exec(x);
    if (!m) return [];
    const typeCol = h.findIndex((y) => new RegExp(`^Phone ${m[1]} - (Type|Label)$`, 'i').test(y));
    return [{ value: i, type: typeCol }];
  });
  // Outlook und allgemein: jede Spalte, deren Kopf nach Telefon aussieht (Fax/Pager filtert phoneLabel)
  const otherPhones = googlePhones.length
    ? []
    : h.flatMap((x, i) => (/phone|telefon|mobil|handy|^tel\b|rufnummer|cell/i.test(x) && !/ - (type|label)$|assist|company main|zentrale|callback|rückruf|telefon firma|firmentelefon|hörbehinderte|\btty\b|autotelefon|car phone/i.test(x) ? [{ value: i, header: x }] : []));
  return cleanCandidates(
    rows.map((r) => {
      const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
      const name = get(nameCol) || parts.map(get).filter(Boolean).join(' ') || get(orgCol);
      const numbers = [
        ...googlePhones.flatMap((p) => get(p.value).split(':::').map((value) => ({ value, type: get(p.type) || 'other' }))),
        ...otherPhones.map((p) => ({ value: get(p.value), type: p.header })),
      ];
      return { name, numbers };
    }),
  );
}

/** Datei nach Endung bzw. Inhalt erkennen. */
export function fromFile(name: string, text: string): ImportCandidate[] {
  if (/\.vcf$/i.test(name) || /BEGIN:VCARD/i.test(text.slice(0, 2000))) return fromVcard(text);
  if (/\.(csv|txt)$/i.test(name) || text.includes(',') || text.includes(';')) return fromCsv(text);
  throw new Error('Unbekanntes Dateiformat – bitte eine vCard- (.vcf) oder CSV-Datei wählen');
}

// ---------------------------------------------------------------- Abgleich und Übernahme

/** Vorschau: Kandidaten mit den gespeicherten Kontakten abgleichen (über alle Nummern eines Kontakts). */
export function buildPreview(candidates: ImportCandidate[], store: Pick<ContactStore, 'findByNumber' | 'list'>): PreviewItem[] {
  const shared = sharedKeys(candidates);
  const holders = new Map<string, number[]>();
  // Für die Anzeige jede Nummer, die bei mehr als einem Eintrag steht (auch zwei Karten derselben Person): sie bekommt nur der erste gewählte
  candidates.forEach((c, i) => { for (const n of c.numbers) { const k = numberKey(n.number); const list = holders.get(k); if (list) list.push(i); else holders.set(k, [i]); } });
  const names = new Set(store.list().map((c) => c.name.trim().toLowerCase()));
  const ownerContacts = store.list().filter((c) => c.owner);
  const nameCount = new Map<string, number>();
  for (const c of candidates) nameCount.set(nameKey(c.name), (nameCount.get(nameKey(c.name)) ?? 0) + 1);
  return candidates.map((c, i) => {
    const owners = c.numbers.map((n) => store.findByNumber(n.number));
    const numbers = c.numbers.map((n, j) => {
      const list = holders.get(numberKey(n.number)) ?? [];
      const others: string[] = [];
      for (const x of list) { if (x !== i) others.push(candidates[x].name); if (others.length >= 3) break; }
      return { ...n, known: owners[j]?.name, shared: others.length ? true : undefined, sharedWith: others.length ? others : undefined };
    });
    const known = owners.filter((o): o is Contact => !!o);
    const status: PreviewItem['status'] = !known.length ? 'new' : known.length === numbers.length ? 'exists' : 'partial';
    const mergeable = status === 'partial' && canMerge(c, owners, shared);
    const ownCard = status !== 'exists' && isOwnCard(c, ownerContacts) ? true : undefined;
    const sameName = !ownCard && (status === 'new' || (status === 'partial' && !mergeable)) && names.has(c.name.trim().toLowerCase()) ? true : undefined;
    const twin = (nameCount.get(nameKey(c.name)) ?? 0) > 1 ? true : undefined;
    return { id: String(i), name: c.name, numbers, status, existing: known[0]?.name, mergeable: mergeable || undefined, ownCard, sameName, twin };
  });
}

/** Nummern, die bei mehr als einem Eintrag des Adressbuchs stehen */
function sharedKeys(candidates: ImportCandidate[]): Set<string> {
  // Zählt nur verschiedene Personen (sameperson): zwei Karten derselben Person, auch „Erika B.“ und „Erika Beispiel“,
  // sind kein gemeinsames Festnetz. Je Nummer ein Name als Vertreter jeder Person
  const people = new Map<string, string[]>();
  for (const c of candidates) for (const n of c.numbers) {
    const k = numberKey(n.number);
    const reps = people.get(k) ?? [];
    if (reps.length < 2 && !reps.some((r) => sameperson(r, c.name))) reps.push(c.name);
    people.set(k, reps);
  }
  return new Set([...people].filter(([, reps]) => reps.length > 1).map(([k]) => k));
}

/**
 * Die eigene Karte des Inhabers (genau derselbe Name wie ein Kontakt mit „Inhaber“): wird weder ergänzt (weitere
 * Inhabernummern hätten Sonderrechte) noch als zweiter Kontakt angelegt – auch wenn keine Nummer übereinstimmt.
 * Bewusst ohne Abkürzungen: „Tom W.“ kann jemand anderes sein.
 */
function isOwnCard(c: ImportCandidate, ownerContacts: Contact[]): boolean {
  const n = nameKey(c.name);
  return n !== '' && ownerContacts.some((o) => nameKey(o.name) === n);
}

const nameParts = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Name ohne Groß/Klein, Satzzeichen und doppelte Leerzeichen */
const nameKey = (s: string) => nameParts(s).join(' ');

/**
 * Derselbe Name? Vorname gleich und Nachname gleich oder auf den Anfangsbuchstaben abgekürzt („Erika B.“ / „Erika
 * Beispiel“); einteilige Namen müssen ganz gleich sein. Ein gemeinsamer Vorname allein reicht nicht („Anna Müller“ /
 * „Anna Schmidt“). Wird nur zusammen mit einer gemeinsamen Nummer benutzt (Ergänzen, gemeinsames Festnetz).
 */
export function sameperson(a: string, b: string): boolean {
  const x = nameParts(a);
  const y = nameParts(b);
  if (!x.length || !y.length) return false;
  if (x.length < 2 || y.length < 2) return x.join(' ') === y.join(' ');
  const [lx, ly] = [x[x.length - 1], y[y.length - 1]];
  const abbrev = (short: string, long: string) => short.length === 1 && long.startsWith(short);
  return x[0] === y[0] && (lx === ly || abbrev(lx, ly) || abbrev(ly, lx));
}

/**
 * Darf ein teilweise bekannter Eintrag seine übrigen Nummern beim vorhandenen Kontakt ergänzen? Nur wenn alle bekannten
 * Nummern zu genau einem Kontakt gehören, das nicht der Inhaber ist, mindestens eine davon keine Geschäftsnummer ist
 * (eine Zentrale teilen sich viele), keine davon bei einem anderen Eintrag des Adressbuchs steht (gemeinsames Festnetz)
 * und es derselbe Name ist. Sonst landete etwa das Handy der Oma beim Vater, nur weil beide dasselbe Festnetz haben.
 */
function canMerge(c: ImportCandidate, owners: (Contact | undefined)[], shared: Set<string>): boolean {
  const known = owners.filter((o): o is Contact => !!o);
  if (!known.length || known[0].owner || !known.every((o) => o.id === known[0].id)) return false;
  if (c.numbers.some((n, i) => owners[i] && shared.has(numberKey(n.number)))) return false;
  if (!c.numbers.some((n, i) => owners[i] && n.label !== 'geschäftlich')) return false;
  return sameperson(c.name, known[0].name);
}

export function previewCounts(items: PreviewItem[]): { total: number; new: number; partial: number; exists: number } {
  return {
    total: items.length,
    new: items.filter((i) => i.status === 'new').length,
    partial: items.filter((i) => i.status === 'partial').length,
    exists: items.filter((i) => i.status === 'exists').length,
  };
}

/**
 * Ausgewählte Einträge übernehmen. Neue werden angelegt (erste Nummer = Hauptnummer, weitere als Zusatznummern).
 * Vorhandene Kontakte werden nie überschrieben; nur mit `addToExisting` (ausdrücklich bestätigt) bekommen sie
 * fehlende Nummern als Zusatznummern – Name, Stil, Auftrag usw. bleiben, wie sie sind. Ist ein teilweise bekannter
 * Eintrag ein anderer Mensch (canMerge nein, etwa die Partnerin am Festnetz des Inhabers), wird er neu angelegt,
 * nur mit den Nummern, die noch niemand hat.
 */
export function applyImport(
  candidates: ImportCandidate[],
  ids: string[],
  store: ContactStore,
  opts: { addToExisting?: boolean } = {},
): { created: number; merged: number; combined: number; unchanged: number; skipped: string[] } {
  const create: ContactInput[] = [];
  const add: { id: string; numbers: string[] }[] = [];
  let unchanged = 0;
  /** Karten, deren Nummern zu einer anderen gewählten Karte mit genau demselben Namen kamen */
  let combined = 0;
  /** Genau gleicher Name -> Ziel in diesem Durchgang (neuer Kontakt oder Ergänzung), damit Doppelkarten ein Kontakt werden */
  const byName = new Map<string, { numbers?: string[] }>();
  /** Nummern, die in diesem Durchgang schon einem Eintrag zugeteilt sind (gemeinsames Festnetz: der erste bekommt sie) */
  const taken = new Set<string>();
  const shared = sharedKeys(candidates);
  const ownerContacts = store.list().filter((x) => x.owner);
  const order = [...new Set(ids)].filter((id) => /^\d+$/.test(id) && candidates[Number(id)]).sort((a, b) => Number(a) - Number(b));
  for (const id of order) {
    const c = candidates[Number(id)];
    const owners = c.numbers.map((n) => store.findByNumber(n.number));
    const fresh = c.numbers.filter((n, i) => !owners[i] && !taken.has(numberKey(n.number))).map((n) => n.number);
    const existing = owners.find((o): o is Contact => !!o);
    const mergeable = existing && canMerge(c, owners, shared);
    const createNew = !existing || !mergeable;
    const own = isOwnCard(c, ownerContacts);
    // Eine weitere Karte mit genau demselben Namen in diesem Durchgang: Nummern zu deren Ziel (neu oder ergänzt)
    const sibling = createNew ? byName.get(nameKey(c.name)) : undefined;
    if (!fresh.length || own) unchanged++;
    else if (sibling) {
      sibling.numbers = [...(sibling.numbers ?? []), ...fresh];
      combined++;
    } else if (createNew) {
      const input: ContactInput = { name: c.name, number: fresh[0], numbers: fresh.slice(1) };
      create.push(input);
      byName.set(nameKey(c.name), input);
    } else if (opts.addToExisting) {
      const entry = { id: existing.id, numbers: fresh };
      add.push(entry);
      if (!byName.has(nameKey(c.name))) byName.set(nameKey(c.name), entry);
    } else unchanged++;
    if (fresh.length && !own && (createNew || opts.addToExisting)) for (const n of fresh) taken.add(numberKey(n));
  }
  const r = store.importMany(create, add);
  return { ...r, combined, unchanged };
}

/**
 * Die zuletzt geladene Vorschau. Jede Vorschau hat eine eigene Kennung: Übernommen wird nur mit der Kennung der
 * gerade gültigen Vorschau, damit ein älterer Browser-Tab nicht die Einträge einer neueren Liste importiert.
 */
export class ImportSession {
  private current?: { token: string; source: string; candidates: ImportCandidate[]; at: number };

  /** Nach dieser Zeit verfällt eine Vorschau, auch wenn der Tab ohne Schließen des Dialogs verschwunden ist */
  constructor(private ttlMs = 30 * 60_000, private now: () => number = Date.now) {}

  private valid(): typeof this.current {
    if (this.current && this.now() - this.current.at > this.ttlMs) this.current = undefined;
    return this.current;
  }

  show(source: string, candidates: ImportCandidate[], store: Pick<ContactStore, 'findByNumber' | 'list'>) {
    const token = randomBytes(8).toString('hex');
    this.current = { token, source, candidates, at: this.now() };
    const items = buildPreview(candidates, store);
    return { token, items, counts: previewCounts(items) };
  }

  apply(token: unknown, ids: string[], store: ContactStore, opts: { addToExisting?: boolean } = {}) {
    const cur = this.valid();
    if (!cur || token !== cur.token) throw new Error('Diese Vorschau ist nicht mehr aktuell – bitte das Adressbuch neu laden');
    const r = applyImport(cur.candidates, ids, store, opts); // scheitert das Speichern, bleibt die Vorschau
    this.current = undefined;
    return r;
  }

  /** Läuft eine Vorschau ab, ohne dass jemand fragt, soll sie trotzdem nicht im Speicher bleiben */
  sweep(): void {
    this.valid();
  }

  /** Vorschau verwerfen: die mit dieser Kennung bzw. alle aus dieser Quelle */
  discard(match: { token: unknown } | { source: string }): void {
    if (!this.current) return;
    if ('token' in match ? match.token === this.current.token : match.source === this.current.source) this.current = undefined;
  }
}
