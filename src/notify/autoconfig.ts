// Automatische Mail-Einrichtung aus der Adresse: erst die Mozilla-ISPDB (dieselbe Datenbank, die
// Thunderbird nutzt), dann bekannte Anbieter, dann MX-Einträge (Microsoft 365 / Google Workspace),
// zuletzt die üblichen Hostnamen smtp.<domain> und mail.<domain> mit Verbindungsprobe.
import { promises as dns } from 'node:dns';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface MailSuggestion {
  /** Empfohlener Versandweg */
  provider: 'smtp' | 'gmail' | 'm365';
  host?: string;
  port?: number;
  /** true = SSL/TLS (meist 465), false = STARTTLS (meist 587) */
  secure?: boolean;
  /** Benutzername: meist die volle Adresse */
  user?: string;
  /** Woher der Vorschlag stammt */
  source: 'ispdb' | 'preset' | 'mx' | 'probe';
  /** Hinweis für den Benutzer (App-Passwort, OAuth empfohlen …) */
  note?: string;
  /** Alternative: OAuth-Anbieter, falls SMTP mit Passwort beim Anbieter eingeschränkt ist */
  oauth?: 'gmail' | 'm365';
}

/** Bekannte Anbieter (Stand 2026); Reihenfolge egal, Treffer über die Domain. */
const PRESETS: Record<string, Omit<MailSuggestion, 'source'>> = {
  'gmail.com': { provider: 'smtp', host: 'smtp.gmail.com', port: 465, secure: true, oauth: 'gmail', note: 'Google: App-Passwort nötig (2-Faktor-Authentifizierung aktiv) oder Anmeldung per OAuth über „Gmail“.' },
  'googlemail.com': { provider: 'smtp', host: 'smtp.gmail.com', port: 465, secure: true, oauth: 'gmail', note: 'Google: App-Passwort nötig oder Anmeldung per OAuth über „Gmail“.' },
  'outlook.com': { provider: 'm365', oauth: 'm365', host: 'smtp-mail.outlook.com', port: 587, secure: false, note: 'Microsoft lässt für private Postfächer kein Passwort mehr per SMTP zu – Anmeldung per OAuth über „Microsoft 365“.' },
  'hotmail.com': { provider: 'm365', oauth: 'm365', host: 'smtp-mail.outlook.com', port: 587, secure: false, note: 'Microsoft lässt für private Postfächer kein Passwort mehr per SMTP zu – Anmeldung per OAuth über „Microsoft 365“.' },
  'hotmail.de': { provider: 'm365', oauth: 'm365', host: 'smtp-mail.outlook.com', port: 587, secure: false, note: 'Microsoft lässt für private Postfächer kein Passwort mehr per SMTP zu – Anmeldung per OAuth über „Microsoft 365“.' },
  'live.com': { provider: 'm365', oauth: 'm365', host: 'smtp-mail.outlook.com', port: 587, secure: false, note: 'Anmeldung per OAuth über „Microsoft 365“.' },
  'live.de': { provider: 'm365', oauth: 'm365', host: 'smtp-mail.outlook.com', port: 587, secure: false, note: 'Anmeldung per OAuth über „Microsoft 365“.' },
  'gmx.de': { provider: 'smtp', host: 'mail.gmx.net', port: 587, secure: false, note: 'GMX: In den Postfach-Einstellungen „POP3/IMAP-Zugriff“ erlauben.' },
  'gmx.net': { provider: 'smtp', host: 'mail.gmx.net', port: 587, secure: false, note: 'GMX: In den Postfach-Einstellungen „POP3/IMAP-Zugriff“ erlauben.' },
  'gmx.at': { provider: 'smtp', host: 'mail.gmx.net', port: 587, secure: false },
  'gmx.ch': { provider: 'smtp', host: 'mail.gmx.net', port: 587, secure: false },
  'web.de': { provider: 'smtp', host: 'smtp.web.de', port: 587, secure: false, note: 'WEB.DE: In den Postfach-Einstellungen „POP3/IMAP-Zugriff“ erlauben.' },
  't-online.de': { provider: 'smtp', host: 'securesmtp.t-online.de', port: 465, secure: true, note: 'Telekom: Im E-Mail-Center ein eigenes „Passwort für E-Mail-Programme“ anlegen.' },
  'magenta.de': { provider: 'smtp', host: 'securesmtp.t-online.de', port: 465, secure: true },
  'posteo.de': { provider: 'smtp', host: 'posteo.de', port: 465, secure: true },
  'mailbox.org': { provider: 'smtp', host: 'smtp.mailbox.org', port: 465, secure: true },
  'ionos.de': { provider: 'smtp', host: 'smtp.ionos.de', port: 465, secure: true },
  '1und1.de': { provider: 'smtp', host: 'smtp.1und1.de', port: 465, secure: true },
  'strato.de': { provider: 'smtp', host: 'smtp.strato.de', port: 465, secure: true },
  'icloud.com': { provider: 'smtp', host: 'smtp.mail.me.com', port: 587, secure: false, note: 'Apple: App-spezifisches Passwort unter appleid.apple.com anlegen.' },
  'me.com': { provider: 'smtp', host: 'smtp.mail.me.com', port: 587, secure: false, note: 'Apple: App-spezifisches Passwort unter appleid.apple.com anlegen.' },
  'yahoo.com': { provider: 'smtp', host: 'smtp.mail.yahoo.com', port: 465, secure: true, note: 'Yahoo: App-Passwort in den Kontoeinstellungen erzeugen.' },
  'yahoo.de': { provider: 'smtp', host: 'smtp.mail.yahoo.com', port: 465, secure: true, note: 'Yahoo: App-Passwort in den Kontoeinstellungen erzeugen.' },
  'freenet.de': { provider: 'smtp', host: 'mx.freenet.de', port: 465, secure: true },
  'arcor.de': { provider: 'smtp', host: 'mail.arcor.de', port: 465, secure: true },
  'vodafone.de': { provider: 'smtp', host: 'smtp.vodafonemail.de', port: 587, secure: false },
  'protonmail.com': { provider: 'smtp', host: '127.0.0.1', port: 1025, secure: false, note: 'Proton: SMTP nur über die lokale Proton Mail Bridge (Port 1025) oder einen SMTP-Token im Business-Tarif.' },
  'proton.me': { provider: 'smtp', host: '127.0.0.1', port: 1025, secure: false, note: 'Proton: SMTP nur über die lokale Proton Mail Bridge (Port 1025) oder einen SMTP-Token im Business-Tarif.' },
};

export function domainOf(email: string): string {
  const m = /@([^@\s>]+)\s*$/.exec(email.trim());
  return (m?.[1] ?? '').toLowerCase();
}

/** Bekannter Anbieter? Rein lokal, ohne Netz. */
export function presetFor(email: string): MailSuggestion | undefined {
  const d = domainOf(email);
  const p = PRESETS[d];
  return p ? { ...p, user: email.trim(), source: 'preset' } : undefined;
}

/** Mozilla-ISPDB-Antwort (XML) lesen: erster outgoingServer vom Typ smtp. Exportiert für Tests. */
export function parseIspdb(xml: string, email: string): MailSuggestion | undefined {
  const block = /<outgoingServer[^>]*type="smtp"[^>]*>([\s\S]*?)<\/outgoingServer>/i.exec(xml);
  if (!block) return undefined;
  const get = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(block[1])?.[1]?.trim();
  const host = get('hostname');
  const port = Number.parseInt(get('port') ?? '', 10);
  const socket = (get('socketType') ?? '').toUpperCase();
  if (!host || !port) return undefined;
  const userTpl = get('username') ?? '%EMAILADDRESS%';
  const local = email.split('@')[0];
  const user = userTpl.replace('%EMAILADDRESS%', email.trim()).replace('%EMAILLOCALPART%', local);
  return { provider: 'smtp', host, port, secure: socket === 'SSL', user, source: 'ispdb' };
}

async function ispdb(email: string): Promise<MailSuggestion | undefined> {
  const d = domainOf(email);
  if (!d) return undefined;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(d)}`, { signal: ctl.signal, headers: { 'User-Agent': 'SIPFunk' } });
    clearTimeout(t);
    if (!res.ok) return undefined;
    return parseIspdb(await res.text(), email);
  } catch {
    return undefined;
  }
}

/** MX-Einträge verraten gehostete Postfächer (Microsoft 365, Google Workspace). */
export async function suggestFromMx(email: string): Promise<MailSuggestion | undefined> {
  const d = domainOf(email);
  if (!d) return undefined;
  let mx: { exchange: string }[] = [];
  try {
    mx = await dns.resolveMx(d);
  } catch {
    return undefined;
  }
  const hosts = mx.map((m) => m.exchange.toLowerCase());
  if (hosts.some((h) => h.endsWith('.outlook.com') || h.endsWith('.office365.com'))) {
    return { provider: 'm365', oauth: 'm365', host: 'smtp.office365.com', port: 587, secure: false, user: email.trim(), source: 'mx', note: 'Postfach bei Microsoft 365: Anmeldung per OAuth empfohlen; SMTP mit Passwort geht nur, wenn der Administrator SMTP-AUTH erlaubt.' };
  }
  if (hosts.some((h) => h.endsWith('.google.com') || h.endsWith('.googlemail.com'))) {
    return { provider: 'smtp', host: 'smtp.gmail.com', port: 465, secure: true, user: email.trim(), source: 'mx', oauth: 'gmail', note: 'Postfach bei Google Workspace: App-Passwort nötig oder Anmeldung per OAuth über „Gmail“.' };
  }
  return undefined;
}

/** Verbindungsprobe: antwortet der Host auf dem Port mit einer SMTP-Begrüßung? */
export function probeSmtp(host: string, port: number, secure: boolean, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = secure ? tlsConnect({ host, port, servername: host, rejectUnauthorized: false }) : connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('error', () => done(false));
    sock.once('data', (buf) => done(/^220/.test(buf.toString('utf8'))));
  });
}

async function guess(email: string): Promise<MailSuggestion | undefined> {
  const d = domainOf(email);
  if (!d) return undefined;
  const candidates: [string, number, boolean][] = [
    [`smtp.${d}`, 587, false],
    [`smtp.${d}`, 465, true],
    [`mail.${d}`, 587, false],
    [`mail.${d}`, 465, true],
  ];
  for (const [host, port, secure] of candidates) {
    try {
      await dns.lookup(host);
    } catch {
      continue;
    }
    if (await probeSmtp(host, port, secure)) return { provider: 'smtp', host, port, secure, user: email.trim(), source: 'probe', note: 'Server gefunden; Benutzername ist meist die volle Adresse, manchmal nur der Teil vor dem @.' };
  }
  return undefined;
}

/** Vorschlag für die Adresse; undefined, wenn nichts gefunden wurde. */
export async function suggestMail(email: string): Promise<MailSuggestion | undefined> {
  if (!domainOf(email)) return undefined;
  return presetFor(email) ?? (await ispdb(email)) ?? (await suggestFromMx(email)) ?? (await guess(email));
}
