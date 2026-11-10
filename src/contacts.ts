// Kontakte in contacts.json (lokal, nicht im Git). Alles außer Name und Nummer ist optional.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { normalizeTarget } from './dialPolicy.js';

export interface Contact {
  id: string;
  name: string;
  number: string;
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

/** Nummern vergleichbar machen: +49/0049 -> 0, nur Ziffern (bzw. ** für intern). */
export function numberKey(raw: string): string {
  const n = normalizeTarget(raw);
  if (n.startsWith('**')) return n;
  return n.replace(/^\+49|^0049/, '0').replace(/\D/g, '');
}

export class ContactStore {
  private contacts: Contact[] = [];

  constructor(private file: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.contacts = JSON.parse(readFileSync(this.file, 'utf8')) as Contact[];
    } catch {
      this.contacts = [];
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.contacts, null, 2) + '\n');
  }

  list(): Contact[] {
    return [...this.contacts].sort((a, b) => Number(b.owner ?? false) - Number(a.owner ?? false) || a.name.localeCompare(b.name, 'de'));
  }

  get(id: string): Contact | undefined {
    return this.contacts.find((c) => c.id === id);
  }

  findByNumber(raw: string): Contact | undefined {
    const key = numberKey(raw);
    return key ? this.contacts.find((c) => numberKey(c.number) === key) : undefined;
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
    this.persist();
    return contact;
  }

  update(id: string, input: ContactInput): Contact {
    const existing = this.get(id);
    if (!existing) throw new Error('Kontakt nicht gefunden');
    const clean = this.validate({ ...existing, ...input }, id);
    const updated: Contact = { ...existing, ...clean, updatedAt: new Date().toISOString() };
    this.contacts = this.contacts.map((c) => (c.id === id ? updated : c));
    this.persist();
    return updated;
  }

  delete(id: string): boolean {
    const before = this.contacts.length;
    this.contacts = this.contacts.filter((c) => c.id !== id);
    if (this.contacts.length === before) return false;
    this.persist();
    return true;
  }

  private validate(input: ContactInput, selfId?: string): Omit<Contact, 'id' | 'createdAt' | 'updatedAt'> {
    const name = String(input.name ?? '').trim();
    const number = normalizeTarget(String(input.number ?? ''));
    if (!name) throw new Error('Name fehlt');
    if (!number) throw new Error('Nummer fehlt');
    const dup = this.findByNumber(number);
    if (dup && dup.id !== selfId) throw new Error(`Nummer ist schon bei „${dup.name}" hinterlegt`);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
      name,
      number,
      owner: input.owner === true || undefined,
      address: input.address === 'du' ? 'du' : input.address === 'sie' ? 'sie' : undefined,
      persona: str(input.persona),
      voice: str(input.voice),
      task: str(input.task),
      notes: str(input.notes),
    };
  }
}
