// FRITZ!Box-Telefonbuch live lesen: über TR-064 (X_AVM-DE_OnTel, braucht FRITZ_USER/FRITZ_PASSWORD) oder, ohne
// Zugangsdaten, aus einer in der FRITZ!Box gesicherten XML-Datei (Telefonbuch > Sichern), die im Datenordner liegt.
// Nichts davon wird in die SIPFunk-Kontakte übernommen; die Einträge dienen nur als Vorschläge (Fax-Fenster, Wählfeld).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { normalizeImportNumber } from './contactImport.js';
import { log } from './log.js';

export type FritzLabel = 'fax' | 'mobil' | 'privat' | 'geschäftlich' | 'sonstige';

export interface FritzEntry {
  name: string;
  number: string;
  label: FritzLabel;
  /** Name des Telefonbuchs in der Box */
  book: string;
}

export interface FritzPhonebookStatus {
  /** tr064 = live aus der Box, xml = gesicherte Datei, null = keine Quelle */
  source: 'tr064' | 'xml' | null;
  items: FritzEntry[];
  updated?: string;
  error?: string;
}

const TYPE_LABEL: Record<string, FritzLabel> = {
  fax_work: 'fax', fax_home: 'fax', fax: 'fax',
  mobile: 'mobil', home: 'privat', work: 'geschäftlich',
};

const decode = (s: string): string =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : undefined;
};

/** Telefonbuch-XML der FRITZ!Box (Export oder TR-064) in Einträge, je Nummer einer */
export function parseFritzPhonebook(xml: string): FritzEntry[] {
  const out: FritzEntry[] = [];
  const seen = new Set<string>();
  for (const pb of xml.match(/<phonebook\b[\s\S]*?<\/phonebook>/g) ?? []) {
    const book = decode(/<phonebook\b[^>]*\bname="([^"]*)"/.exec(pb)?.[1] ?? '');
    for (const contact of pb.match(/<contact\b[\s\S]*?<\/contact>/g) ?? []) {
      const name = tag(contact, 'realName');
      if (!name) continue;
      for (const m of contact.matchAll(/<number\b([^>]*)>([\s\S]*?)<\/number>/g)) {
        const number = normalizeImportNumber(decode(m[2]));
        if (!number) continue;
        const type = /\btype="([^"]*)"/.exec(m[1])?.[1] ?? '';
        const label = TYPE_LABEL[type] ?? 'sonstige';
        const key = `${name}\u0000${number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, number, label, book });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** SOAP-Aufruf mit HTTP-Digest (so verlangt es TR-064 der FRITZ!Box) */
async function soap(host: string, user: string, password: string, action: string, args: Record<string, string> = {}): Promise<string> {
  const service = 'urn:dslforum-org:service:X_AVM-DE_OnTel:1';
  const uri = '/upnp/control/x_contact';
  const url = `http://${host}:49000${uri}`;
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const headers: Record<string, string> = { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `${service}#${action}` };
  const post = (extra: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body, signal: AbortSignal.timeout(8000) });
  let res = await post();
  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate') ?? '';
    const p = (k: string) => new RegExp(`${k}="([^"]*)"`, 'i').exec(challenge)?.[1] ?? '';
    const realm = p('realm');
    const nonce = p('nonce');
    const cnonce = randomBytes(8).toString('hex');
    const nc = '00000001';
    const ha1 = md5(`${user}:${realm}:${password}`);
    const ha2 = md5(`POST:${uri}`);
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    res = await post({ Authorization: `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}", algorithm=MD5` });
  }
  const text = await res.text();
  if (res.status === 401) throw new Error('FRITZ!Box lehnt die Anmeldung ab – FRITZ_USER/FRITZ_PASSWORD prüfen');
  if (!res.ok) throw new Error(`FRITZ!Box antwortet ${res.status} auf ${action}`);
  return text;
}

/** Alle Telefonbücher über TR-064 holen und als ein XML zusammensetzen */
export async function fetchFritzPhonebooks(host: string, user: string, password: string): Promise<string> {
  const list = tag(await soap(host, user, password, 'GetPhonebookList'), 'NewPhonebookList') ?? '';
  const ids = list.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!ids.length) throw new Error('FRITZ!Box meldet keine Telefonbücher');
  // Jedes Buch für sich: ein kaputtes kostet nicht die übrigen; nur wenn keins kommt, gilt der Abruf als gescheitert
  const parts: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      const url = tag(await soap(host, user, password, 'GetPhonebook', { NewPhonebookID: id }), 'NewPhonebookURL');
      if (!url) throw new Error('keine Adresse');
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      parts.push(await res.text());
    } catch (err) {
      errors.push(`Telefonbuch ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!parts.length) throw new Error(errors.join('; '));
  if (errors.length) log.warn(`FRITZ!Box-Telefonbuch: ${errors.join('; ')}`);
  return parts.join('\n');
}

export interface FritzPhonebookOptions {
  host: string;
  user?: string;
  password?: string;
  /** Gesicherte XML-Datei im Datenordner */
  xmlFile: string;
  /** Wie lange ein Abruf aus der Box gilt */
  maxAgeMs?: number;
}

export class FritzPhonebook {
  private cache?: { at: number; status: FritzPhonebookStatus };
  private loading?: Promise<FritzPhonebookStatus>;
  /** Steigt, wenn sich die Quelle ändert (Datei gespeichert/entfernt): ältere Abrufe landen nicht mehr im Cache */
  private generation = 0;

  constructor(private readonly opts: FritzPhonebookOptions) {}

  get live(): boolean {
    return Boolean(this.opts.user && this.opts.password);
  }

  /** Einträge; live aus der Box (kurz zwischengespeichert), sonst aus der XML-Datei */
  async get(force = false): Promise<FritzPhonebookStatus> {
    const maxAge = this.opts.maxAgeMs ?? 5 * 60_000;
    // Fehlschläge nur kurz merken: nach einem Neustart der Box soll der nächste Abruf es bald wieder versuchen
    const age = this.cache ? Date.now() - this.cache.at : Infinity;
    if (!force && this.cache && age < (this.cache.status.error ? 30_000 : maxAge)) return this.cache.status;
    const gen = this.generation;
    if (!this.loading) {
      const p = this.load().finally(() => { if (this.loading === p) this.loading = undefined; });
      this.loading = p;
    }
    const status = await this.loading;
    // Während des Abrufs hat sich die Quelle geändert: neu laden
    if (gen !== this.generation) return this.get(true);
    this.cache = { at: Date.now(), status };
    return status;
  }

  private async load(): Promise<FritzPhonebookStatus> {
    let error: string | undefined;
    if (this.live) {
      try {
        const items = parseFritzPhonebook(await fetchFritzPhonebooks(this.opts.host, this.opts.user!, this.opts.password!));
        return { source: 'tr064', items, updated: new Date().toISOString() };
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (existsSync(this.opts.xmlFile)) {
      return { source: 'xml', items: parseFritzPhonebook(readFileSync(this.opts.xmlFile, 'utf8')), error };
    }
    return { source: null, items: [], error };
  }

  /** XML-Datei aus der FRITZ!Box speichern; liefert die Anzahl der Einträge */
  saveXml(xml: string): number {
    if (!/<phonebooks?\b/.test(xml)) throw new Error('Keine Telefonbuch-Datei der FRITZ!Box');
    const items = parseFritzPhonebook(xml);
    writeFileSync(this.opts.xmlFile, xml);
    this.invalidate();
    return items.length;
  }

  removeXml(): void {
    rmSync(this.opts.xmlFile, { force: true });
    this.invalidate();
  }

  private invalidate(): void {
    this.generation++;
    this.cache = undefined;
    this.loading = undefined;
  }
}
