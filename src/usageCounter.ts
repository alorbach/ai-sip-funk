// Monatsverbrauch: Summe der von SIPFunk selbst geschätzten Gesprächskosten je Monat und KI-Anbieter, fortgeschrieben
// in usage.json im Datenordner. Die Protokolle taugen dafür nicht, weil sie nach der Aufbewahrungsfrist gelöscht
// werden. Enthalten sind nur die Gespräche (Sprachmodell); Textmodell und Hörproben fehlen. Eine Schätzung, keine Rechnung.
//
// Dazu, nur auf Wunsch: die tatsächlichen Monatskosten bei OpenAI. Die gibt die API nur mit einem Admin-Schlüssel
// der Organisation heraus (nicht mit dem normalen API-Schlüssel), und sie umfassen alles, was die Organisation nutzt.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fsutil.js';

export interface MonthUsage {
  calls: number;
  seconds: number;
  costUsd: number;
}

type Months = Record<string, Record<string, MonthUsage>>;

/** Monat in Ortszeit als „2026-11“ */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** So viele Monate bleiben in der Datei */
const KEEP_MONTHS = 13;

export class UsageCounter {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** true, solange noch nie gezählt wurde (dann lässt sich der laufende Monat aus den Protokollen nachtragen) */
  get empty(): boolean {
    return !existsSync(this.file);
  }

  private read(keepBroken = false): Months {
    if (!existsSync(this.file)) return {};
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { months?: unknown };
      return data.months && typeof data.months === 'object' ? (data.months as Months) : {};
    } catch {
      // Vor dem Überschreiben bleibt eine nicht lesbare Datei als .defekt erhalten (sonst wären die früheren Monate weg)
      if (keepBroken) copyFileSync(this.file, `${this.file}.defekt`);
      return {};
    }
  }

  /** Ein beendetes Gespräch dazuzählen. */
  add(provider: string, seconds: number, costUsd: number, at: Date = this.now()): void {
    const months = this.read(true);
    const month = (months[monthKey(at)] ??= {});
    const u = (month[provider] ??= { calls: 0, seconds: 0, costUsd: 0 });
    u.calls += 1;
    u.seconds += Math.max(0, Math.round(seconds));
    u.costUsd = Math.round((u.costUsd + Math.max(0, costUsd)) * 1e6) / 1e6;
    const keep = Object.keys(months).sort().slice(-KEEP_MONTHS);
    writeFileAtomic(this.file, JSON.stringify({ months: Object.fromEntries(keep.map((k) => [k, months[k]])) }, null, 2) + '\n');
  }

  /** Verbrauch eines Monats je Anbieter (ohne Angabe: der laufende). */
  month(key: string = monthKey(this.now())): Record<string, MonthUsage> {
    return this.read()[key] ?? {};
  }
}

/** Form eines OpenAI-Admin-Schlüssels grob prüfen; wirft mit Meldung. */
export function cleanAdminKey(input: unknown): string {
  const key = String(input ?? '').trim();
  if (!key) throw new Error('Schlüssel fehlt');
  if (/\s/.test(key) || key.length < 20 || key.length > 400) throw new Error('Das sieht nicht nach einem Admin-Schlüssel aus (beginnt mit „sk-admin-“, ohne Leerzeichen)');
  if (!key.startsWith('sk-admin-')) throw new Error('Das ist kein Admin-Schlüssel: Er beginnt mit „sk-admin-“. Der normale API-Schlüssel gehört in das Feld darüber.');
  return key;
}

/**
 * Tatsächliche Kosten der OpenAI-Organisation seit Monatsanfang (UTC) in US-Dollar. Der Schlüssel geht nur an
 * api.openai.com und steht in keiner Meldung. Tageswerte, mit Verzögerung: keine Live-Anzeige.
 */
export async function fetchOpenAiMonthCosts(adminKey: string, fetchImpl: typeof fetch = fetch, now: Date = new Date(), timeoutMs = 8000): Promise<number> {
  const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
  let total = 0;
  let page: string | undefined;
  for (let i = 0; i < 5; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    let body: unknown;
    try {
      res = await fetchImpl(`https://api.openai.com/v1/organization/costs?start_time=${start}&limit=31${page ? `&page=${encodeURIComponent(page)}` : ''}`, { headers: { Authorization: `Bearer ${adminKey}` }, signal: ctl.signal });
      body = res.ok ? await res.json() : undefined;
    } catch {
      throw new Error('OpenAI ist nicht erreichbar – besteht eine Internetverbindung?');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new Error('OpenAI hat den Admin-Schlüssel abgelehnt. Die Kosten gibt es nur mit einem Admin-Schlüssel der Organisation.');
    if (!res.ok) throw new Error(`OpenAI antwortete mit Status ${res.status}.`);
    const data = body as { data?: { results?: { amount?: { value?: unknown; currency?: unknown } }[] }[]; has_more?: boolean; next_page?: string } | null;
    if (!Array.isArray(data?.data)) throw new Error('OpenAI lieferte keine Kostenübersicht.');
    for (const bucket of data.data) for (const r of bucket.results ?? []) if (String(r.amount?.currency ?? 'usd').toLowerCase() === 'usd') total += Number(r.amount?.value) || 0;
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return Math.round(total * 100) / 100;
}
