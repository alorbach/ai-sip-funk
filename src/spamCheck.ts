// Einschätzung einer Anrufernummer beim Klingeln: Kontakt, Spam-Liste, frühere Spam-Gespräche,
// auffällige Rufnummerngassen und – nur wenn in den Einstellungen erlaubt – eine Abfrage bei tellows.de.
// Die Einschätzung ist ein Hinweis für das Pop-up; umgeleitet wird nur auf Knopfdruck.
import { isScamNumber } from './ai/scam.js';

export type SpamLevel = 'contact' | 'spam' | 'suspicious' | 'ok' | 'unknown';

export interface SpamVerdict {
  level: SpamLevel;
  /** Kurz fürs Pop-up, z. B. „Spam-Verdacht" */
  label: string;
  /** Ein Satz Begründung */
  detail: string;
  /** Woher die Einschätzung stammt */
  source: 'kontakte' | 'liste' | 'verlauf' | 'rufnummer' | 'tellows' | 'keine';
  /** tellows-Score 1 (seriös) bis 9 (Spam), falls abgefragt */
  score?: number;
}

export const normalize = (n: string): string => n.replace(/\D/g, '').replace(/^0049/, '0').replace(/^49(?=[1-9])/, '0');

/** Auffällige Rufnummerngassen (deutsche Sicht); undefined = unauffällig. */
export function numberHint(caller: string): string | undefined {
  const raw = caller.replace(/[^\d+]/g, '');
  const d = normalize(caller);
  if (d.length < 3) return undefined;
  if (/^(\+|00)(?!49)/.test(raw)) return 'Auslandsnummer';
  if (/^0900/.test(d)) return 'Premium-Dienst (0900)';
  if (/^013[78]/.test(d)) return 'Massenverkehrsnummer (0137/0138)';
  if (/^0180/.test(d)) return 'Service-Dienst (0180)';
  if (/^0800/.test(d)) return 'kostenlose Servicenummer (0800), oft Vertrieb';
  if (/^032/.test(d)) return 'ortsunabhängige Nummer (032), häufig Callcenter';
  if (/^118/.test(d)) return 'Auskunftsdienst (118)';
  return undefined;
}

export interface LocalFacts {
  contactName?: string;
  /** Text der Spam-Liste aus den Einstellungen */
  scamNumbers: string;
  /** Anzahl früherer Gespräche mit dieser Nummer, die als Spam-Abwehr liefen */
  spamCalls: number;
}

/** Einschätzung ohne Netz: Kontakt > Liste > Verlauf > Rufnummerngasse. */
export function localVerdict(caller: string, f: LocalFacts): SpamVerdict {
  const known = /\d{3,}/.test(caller.replace(/\D/g, ''));
  if (f.contactName) return { level: 'contact', label: 'Kontakt', detail: `Gespeichert als „${f.contactName}".`, source: 'kontakte' };
  if (isScamNumber(caller, f.scamNumbers)) return { level: 'spam', label: 'Auf deiner Spam-Liste', detail: known ? 'Die Nummer oder ihre Vorwahl steht in „Bekannte Spam-Nummern".' : 'Unterdrückte Nummern stehen auf deiner Spam-Liste („anonym").', source: 'liste' };
  if (f.spamCalls > 0) return { level: 'spam', label: 'Schon als Spam abgewehrt', detail: `${f.spamCalls} frühere${f.spamCalls === 1 ? 's' : ''} Gespräch${f.spamCalls === 1 ? '' : 'e'} mit dieser Nummer lief${f.spamCalls === 1 ? '' : 'en'} als Spam-Abwehr.`, source: 'verlauf' };
  if (!known) return { level: 'unknown', label: 'Nummer unterdrückt', detail: 'Keine Nummer übermittelt – keine Einschätzung möglich.', source: 'keine' };
  const hint = numberHint(caller);
  if (hint) return { level: 'suspicious', label: 'Auffällige Nummer', detail: `${hint}.`, source: 'rufnummer' };
  return { level: 'unknown', label: 'Unbekannte Nummer', detail: 'Nicht in den Kontakten, nicht auf der Spam-Liste.', source: 'keine' };
}

export interface TellowsResult {
  score: number;
  searches: number;
  comments: number;
  name?: string;
  location?: string;
}

/** Antwort der tellows-Basic-Schnittstelle lesen (JSON, dahinter steht teils noch Text). Exportiert für Tests. */
export function parseTellows(body: string): TellowsResult | undefined {
  const start = body.indexOf('{');
  if (start < 0) return undefined;
  // Das JSON endet an der zum ersten „{" gehörenden Klammer
  let depth = 0;
  let end = -1;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  try {
    const t = (JSON.parse(body.slice(start, end + 1)) as { tellows?: Record<string, unknown> }).tellows;
    if (!t) return undefined;
    const score = Number.parseInt(String(t.score ?? ''), 10);
    if (!(score >= 1 && score <= 9)) return undefined;
    const details = (t.numberDetails ?? {}) as Record<string, unknown>;
    return {
      score,
      searches: Number.parseInt(String(t.searches ?? '0'), 10) || 0,
      comments: Number.parseInt(String(t.comments ?? '0'), 10) || 0,
      name: String(details.name ?? '').trim() || undefined,
      location: String(t.location ?? '').trim() || undefined,
    };
  } catch {
    return undefined;
  }
}

/** Abfrage bei tellows.de (überträgt die Anrufernummer dorthin; nur mit eingeschalteter Einstellung aufrufen). */
export async function lookupTellows(caller: string, timeoutMs = 4000): Promise<TellowsResult | undefined> {
  const d = normalize(caller);
  if (d.length < 5) return undefined;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://www.tellows.de/basic/num/${encodeURIComponent(d)}?json=1`, { signal: ctl.signal, headers: { 'User-Agent': 'SIPFunk' } });
    if (!res.ok) return undefined;
    return parseTellows(await res.text());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** tellows-Ergebnis in die lokale Einschätzung einarbeiten. Kontakt und eigene Liste haben Vorrang. */
export function withTellows(local: SpamVerdict, t: TellowsResult | undefined): SpamVerdict {
  if (!t || local.level === 'contact' || local.source === 'liste' || local.source === 'verlauf') return local;
  const who = [t.name, t.location].filter(Boolean).join(', ');
  const stats = `tellows-Score ${t.score} von 9, ${t.searches} Suchanfragen, ${t.comments} Bewertung${t.comments === 1 ? '' : 'en'}${who ? ` · ${who}` : ''}`;
  if (t.score >= 7) return { level: 'spam', label: 'Spam-Verdacht', detail: `${stats}.`, source: 'tellows', score: t.score };
  if (t.score === 6 || (t.score === 5 && t.comments >= 3)) return { level: 'suspicious', label: 'Auffällig', detail: `${stats}.`, source: 'tellows', score: t.score };
  // Ein neutraler Score ohne Bewertungen sagt wenig: auffällige Rufnummerngasse bleibt stehen
  if (local.level === 'suspicious') return { ...local, detail: `${local.detail} ${stats}.`, score: t.score };
  if (t.score <= 4 && (t.name || t.comments > 0)) return { level: 'ok', label: 'Eher seriös', detail: `${stats}.`, source: 'tellows', score: t.score };
  return { ...local, detail: `${local.detail} ${stats}.`, score: t.score };
}
