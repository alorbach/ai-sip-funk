// Einrichtungsassistent (Server-Seite): Zugangsdaten prüfen, bevor sie in die .env geschrieben werden.
// Die Geheimnisse (SIP-Kennwort, OpenAI-Schlüssel) nimmt der Server nur entgegen; er liefert sie nie zurück
// und schreibt sie in kein Log.
import { SipClient } from './sip/client.js';
import type { SipAccount } from './callManager.js';

export interface CheckResult {
  ok: boolean;
  error?: string;
}

/** Eingaben des Assistenten zur Telefonanlage prüfen und säubern; wirft mit einer verständlichen Meldung. */
export function cleanSipAccount(input: { server?: unknown; user?: unknown; password?: unknown }): SipAccount {
  const server = String(input.server ?? '').trim() || 'fritz.box';
  const user = String(input.user ?? '').trim();
  const password = String(input.password ?? '');
  // Hostname oder IPv4, optional nichts weiter: kein Schema, kein Pfad, keine Leerzeichen
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(server)) throw new Error('Adresse der Telefonanlage: nur Name oder IP-Adresse, z. B. fritz.box');
  if (!user) throw new Error('Benutzername fehlt');
  if (/[\s"<>@]/.test(user)) throw new Error('Benutzername: ohne Leerzeichen, Anführungszeichen, „@“ oder spitze Klammern');
  if (!password) throw new Error('Kennwort fehlt');
  if (/[\r\n]/.test(password)) throw new Error('Kennwort darf keinen Zeilenumbruch enthalten');
  return { server, user, password };
}

/** Meldung der Telefonanlage in einen Satz übersetzen, mit dem man etwas anfangen kann. */
export function explainSipError(message: string, server: string): string {
  if (/\b(401|403|407)\b/.test(message)) return 'Die Telefonanlage hat Benutzername oder Kennwort abgelehnt.';
  if (/\b404\b/.test(message)) return 'Die Telefonanlage kennt diesen Benutzernamen nicht.';
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return `„${server}“ wurde im Netz nicht gefunden – stimmt die Adresse?`;
  if (/Timeout|keine Antwort/i.test(message)) return `Keine Antwort von ${server} – läuft die Telefonanlage, und stimmt die Adresse?`;
  if (/EADDRINUSE/.test(message)) return 'Der lokale SIP-Port ist belegt – läuft SIPFunk ein zweites Mal?';
  return message;
}

/**
 * Probe-Anmeldung mit einem eigenen, kurzlebigen SIP-Client auf einem freien Port. Der laufende Client und
 * seine Anmeldung bleiben unberührt, solange die Probe nicht gelingt.
 */
export async function testSipAccount(account: SipAccount, opts: { serverPort?: number; localIp?: string; timeoutMs?: number } = {}): Promise<CheckResult> {
  const client = new SipClient({ server: account.server, serverPort: opts.serverPort, user: account.user, password: account.password, localPort: 0, localIp: opts.localIp });
  // Wiederholte Anmeldungen nach der Probe gibt es nicht: stop() räumt den Timer ab
  client.on('registrationFailed', () => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('keine Antwort (Timeout)')), opts.timeoutMs ?? 8000);
      }),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explainSipError((err as Error).message, account.server) };
  } finally {
    clearTimeout(timer);
    // Nicht auf das Abmelden warten (bis 2 s): Die Antwort an den Assistenten soll sofort kommen
    void client.stop().catch(() => undefined);
  }
}

/** Form eines OpenAI-Schlüssels grob prüfen (keine Leerzeichen, plausibel lang); wirft mit Meldung. */
export function cleanOpenAiKey(input: unknown): string {
  const key = String(input ?? '').trim();
  if (!key) throw new Error('Schlüssel fehlt');
  if (/\s/.test(key) || key.length < 20 || key.length > 400) throw new Error('Das sieht nicht nach einem OpenAI-Schlüssel aus (beginnt meist mit „sk-“, ohne Leerzeichen)');
  return key;
}

/** Schlüssel bei OpenAI prüfen: Liste der Modelle abrufen. Der Schlüssel geht nur an api.openai.com. */
export async function checkOpenAiKey(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<CheckResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'OpenAI hat den Schlüssel abgelehnt – bitte neu kopieren.' };
    if (res.status === 429) return { ok: false, error: 'OpenAI meldet ein erschöpftes Kontingent oder zu viele Anfragen – Guthaben im OpenAI-Konto prüfen.' };
    return { ok: false, error: `OpenAI antwortete mit Status ${res.status}.` };
  } catch {
    return { ok: false, error: 'OpenAI ist nicht erreichbar – besteht eine Internetverbindung?' };
  } finally {
    clearTimeout(timer);
  }
}
