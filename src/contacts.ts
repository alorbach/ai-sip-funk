// Kontakte in contacts.json (lokal, nicht im Git). Alles außer Name und Nummer ist optional.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { normalizeTarget } from './dialPolicy.js';
import { writeFileAtomic } from './fsutil.js';
import { log } from './log.js';

export interface Contact {
  id: string;
  name: string;
  number: string;
  /** Weitere Nummern derselben Person (z. B. aus dem Adressbuch-Import); zählen bei der Anrufererkennung mit, gewählt wird `number` */
  numbers?: string[];
  /** true = das ist der Auftraggeber selbst; die KI stellt sich dort nur als „dein Agent" vor */
  owner?: boolean;
  address?: 'sie' | 'du';
  persona?: string;
  voice?: string;
  task?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type ContactInput = Partial<Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Nummern vergleichbar machen (bzw. ** für intern): „+49 (0)30 …“, +49 und 0049 -> 0, sonst 00 wie + (Ausland ohne
 * führende Zeichen), nur Ziffern. So gelten „0043 664 …“ und „+43 664 …“ als dieselbe Nummer.
 */
export function numberKey(raw: string): string {
  const n = normalizeTarget(String(raw ?? '').replace(/\(0\)/g, ''));
  if (n.startsWith('**')) return n;
  const intl = n.startsWith('+') ? n.slice(1) : n.startsWith('00') ? n.slice(2) : undefined;
  if (intl === undefined) return n.replace(/\D/g, '');
  const digits = intl.replace(/\D/g, '');
  return digits.startsWith('49') ? '0' + digits.slice(2).replace(/^0/, '') : digits;
}

/** Nur die Hauptnummer (die gewählt wird) vergleichen, nicht die weiteren Nummern */
export function sameMainNumber(c: Pick<Contact, 'number'>, raw: string): boolean {
  const key = numberKey(raw);
  return key !== '' && numberKey(c.number) === key;
}

/** Hauptnummer und weitere Nummern eines Kontakts */
export function allNumbers(c: Pick<Contact, 'number' | 'numbers'>): string[] {
  return [c.number, ...(c.numbers ?? [])];
}

export class ContactStore {
  private contacts: Contact[] = [];
  /** contacts.json war beim Laden defekt und ist noch nicht gesichert */
  private broken = false;
  /**
   * Nachschlagetabelle Nummer -> Kontakt-ID (erster Treffer gewinnt, wie bisher) und ID -> Kontakt; wird bei Bedarf
   * neu gebildet. Ohne sie bräuchte ein Import mit Tausenden Einträgen gegen Tausende Kontakte viele Sekunden.
   */
  private index?: { byKey: Map<string, string>; byId: Map<string, Contact> };

  constructor(private file: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(data)) throw new Error('keine Liste');
      this.contacts = (data as Contact[]).filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.number === 'string');
    } catch (err) {
      // Nicht stillschweigend leer weiterarbeiten: der nächste gespeicherte Kontakt würde die Datei überschreiben
      this.broken = true;
      log.warn(`contacts.json ist nicht lesbar (${(err as Error).message}) – Kontakte bleiben leer; die Datei wird beim nächsten Speichern als contacts.json.defekt gesichert`);
    }
  }

  private persist(): void {
    if (this.broken) {
      this.broken = false;
      try {
        copyFileSync(this.file, `${this.file}.defekt`);
      } catch {
        /* Sicherung ist best effort */
      }
    }
    writeFileAtomic(this.file, JSON.stringify(this.contacts, null, 2) + '\n');
  }

  list(): Contact[] {
    return [...this.contacts].sort((a, b) => Number(b.owner ?? false) - Number(a.owner ?? false) || a.name.localeCompare(b.name, 'de'));
  }

  private lookup(): { byKey: Map<string, string>; byId: Map<string, Contact> } {
    if (!this.index) {
      this.index = { byKey: new Map(), byId: new Map() };
      for (const c of this.contacts) this.indexAdd(c);
    }
    return this.index;
  }

  /** Kontakt in die Nachschlagetabelle aufnehmen (nur, wenn sie schon gebildet ist) */
  private indexAdd(c: Contact): void {
    if (!this.index) return;
    this.index.byId.set(c.id, c);
    for (const n of allNumbers(c)) {
      const key = numberKey(n);
      if (key && !this.index.byKey.has(key)) this.index.byKey.set(key, c.id);
    }
  }

  get(id: string): Contact | undefined {
    return this.lookup().byId.get(id);
  }

  findByNumber(raw: string): Contact | undefined {
    const key = numberKey(raw);
    if (!key) return undefined;
    const t = this.lookup();
    const id = t.byKey.get(key);
    return id === undefined ? undefined : t.byId.get(id);
  }

  /** Name exakt (ohne Groß/Klein) oder eindeutiger Teilstring. */
  findByName(name: string): Contact | undefined {
    const q = name.trim().toLowerCase();
    if (!q) return undefined;
    const exact = this.contacts.find((c) => c.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = this.contacts.filter((c) => c.name.toLowerCase().includes(q));
    return partial.length === 1 ? partial[0] : undefined;
  }

  isOwnerNumber(raw: string): boolean {
    return this.findByNumber(raw)?.owner === true;
  }

  create(input: ContactInput): Contact {
    const clean = this.validate(input);
    const now = new Date().toISOString();
    const contact: Contact = { id: randomBytes(5).toString('hex'), ...clean, createdAt: now, updatedAt: now };
    this.contacts.push(contact);
    this.indexAdd(contact);
    this.persist();
    return contact;
  }

  update(id: string, input: ContactInput): Contact {
    const existing = this.get(id);
    if (!existing) throw new Error('Kontakt nicht gefunden');
    const clean = this.validate({ ...existing, ...input }, id);
    const updated: Contact = { ...existing, ...clean, updatedAt: new Date().toISOString() };
    this.contacts = this.contacts.map((c) => (c.id === id ? updated : c));
    this.index = undefined;
    this.persist();
    return updated;
  }

  /**
   * Import in einem Schritt (eine Schreiboperation): neue Kontakte anlegen und bei vorhandenen nur Nummern ergänzen.
   * Einstellungen vorhandener Kontakte bleiben unberührt; Einträge, die nicht passen (z. B. Nummer inzwischen vergeben), werden übersprungen.
   */
  importMany(create: ContactInput[], addNumbers: { id: string; numbers: string[] }[] = []): { created: number; merged: number; skipped: string[] } {
    const now = new Date().toISOString();
    const skipped: string[] = [];
    let created = 0;
    let merged = 0;
    // Scheitert das Speichern, bleibt der Stand im Speicher wie auf der Platte
    const before = this.contacts;
    this.contacts = [...before];
    try {
      for (const add of addNumbers) {
        const existing = this.get(add.id);
        if (!existing) continue;
        const fresh = add.numbers.filter((n) => !this.findByNumber(n));
        if (!fresh.length) continue;
        try {
          const clean = this.validate({ ...existing, numbers: [...(existing.numbers ?? []), ...fresh] }, existing.id);
          const updated: Contact = { ...existing, numbers: clean.numbers, updatedAt: now };
          this.contacts = this.contacts.map((c) => (c.id === existing.id ? updated : c));
          this.indexAdd(updated);
          merged++;
        } catch (err) {
          skipped.push(`${existing.name}: ${(err as Error).message}`);
        }
      }
      for (const input of create) {
        try {
          const clean = this.validate(input);
          const contact: Contact = { id: randomBytes(5).toString('hex'), ...clean, createdAt: now, updatedAt: now };
          this.contacts.push(contact);
          this.indexAdd(contact);
          created++;
        } catch (err) {
          skipped.push(`${String(input.name ?? '')}: ${(err as Error).message}`);
        }
      }
      if (created || merged) this.persist();
    } catch (err) {
      this.contacts = before;
      this.index = undefined;
      throw err;
    }
    return { created, merged, skipped };
  }

  delete(id: string): boolean {
    const before = this.contacts.length;
    this.contacts = this.contacts.filter((c) => c.id !== id);
    this.index = undefined;
    if (this.contacts.length === before) return false;
    this.persist();
    return true;
  }

  private validate(input: ContactInput, selfId?: string): Omit<Contact, 'id' | 'createdAt' | 'updatedAt'> {
    const name = String(input.name ?? '').trim();
    const number = normalizeTarget(String(input.number ?? ''));
    if (!name) throw new Error('Name fehlt');
    if (!number) throw new Error('Nummer fehlt');
    // Weitere Nummern: Liste oder Text mit Komma, Semikolon oder Zeilenumbruch (Formular)
    const extra = input.numbers as unknown;
    const rawExtra: unknown[] = Array.isArray(extra) ? extra : typeof extra === 'string' ? extra.split(/[,;\n]/) : [];
    const numbers: string[] = [];
    for (const n of rawExtra.map((x) => normalizeTarget(String(x ?? ''))).filter(Boolean)) {
      if (![number, ...numbers].some((x) => numberKey(x) === numberKey(n))) numbers.push(n);
    }
    for (const n of [number, ...numbers]) {
      const dup = this.findByNumber(n);
      if (dup && dup.id !== selfId) throw new Error(`Nummer ist schon bei „${dup.name}" hinterlegt`);
    }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
      name,
      number,
      numbers: numbers.length ? numbers : undefined,
      owner: input.owner === true || undefined,
      address: input.address === 'du' ? 'du' : input.address === 'sie' ? 'sie' : undefined,
      persona: str(input.persona),
      voice: str(input.voice),
      task: str(input.task),
      notes: str(input.notes),
    };
  }
}
