// Gesprächsprotokolle in transcripts/: JSON (maschinenlesbar) + Markdown (zum Lesen).
// Nur zur Fehleranalyse; automatische Löschung nach TRANSCRIPT_RETENTION_DAYS.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallOutcome, TranscriptEntry, Usage } from './ai/realtimeBridge.js';
import { numberKey } from './contacts.js';
import { log } from './log.js';

export interface CallRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  target: string;
  mode: string;
  durationSec: number;
  codec?: string;
  endReason: string;
  task?: string;
  /** Vorab erstellter Gesprächsplan (Textabschnitt der Systemanweisung) */
  plan?: string;
  /** Ergebnis, das die KI beim end_call gemeldet hat */
  outcome?: CallOutcome;
  persona?: Record<string, string>;
  model?: string;
  entries: TranscriptEntry[];
  usage?: Usage;
  costUsd?: number;
  summary?: string;
  /** true = Spam-Abwehr war aktiv (KI trat als Privatperson auf) */
  spam?: boolean;
  /** Eingehender Anruf: gewählte (eigene) Rufnummer */
  called?: string;
  /** true = Rückruf der KI an den Inhaber nach einem angenommenen Anruf */
  notify?: boolean;
}

export interface CallRecordSummary {
  id: string;
  startedAt: string;
  target: string;
  mode: string;
  durationSec: number;
  endReason: string;
  outcome?: CallOutcome;
  summary?: string;
  costUsd?: number;
  spam?: boolean;
  called?: string;
  notify?: boolean;
}

export class TranscriptStore {
  constructor(private dir: string, private retentionDays: number) {
    mkdirSync(dir, { recursive: true });
  }

  static makeId(startedAt: Date, target: string): string {
    const ts = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // '*' ist in Windows-Dateinamen verboten: **610 -> int610
    return `${ts}_${target.replace(/^\*\*/, 'int').replace(/[^\w+]/g, '')}`;
  }

  save(record: CallRecord): void {
    writeFileSync(join(this.dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
    writeFileSync(join(this.dir, `${record.id}.md`), toMarkdown(record));
  }

  list(): CallRecordSummary[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .flatMap((f) => {
        const r = this.read(f.slice(0, -5));
        if (!r) return [];
        const { id, startedAt, target, mode, durationSec, endReason, outcome, summary, costUsd, spam, called, notify } = r;
        return [{ id, startedAt, target, mode, durationSec, endReason, outcome, summary, costUsd, spam, called, notify }];
      });
  }

  /** Alle Protokolle zu einer Nummer (neueste zuerst). */
  listByNumber(raw: string): CallRecordSummary[] {
    const key = numberKey(raw);
    return key ? this.list().filter((r) => numberKey(r.target) === key) : [];
  }

  read(id: string): CallRecord | undefined {
    if (!/^[\w+*-]+$/.test(id)) return undefined;
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as CallRecord;
    } catch {
      return undefined;
    }
  }

  delete(id: string): boolean {
    if (!this.read(id)) return false;
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(join(this.dir, `${id}.md`), { force: true });
    return true;
  }

  /** Aufbewahrung aus den Einstellungen übernehmen (wirkt beim nächsten Aufräumen). */
  setRetention(days: number): void {
    this.retentionDays = days;
  }

  /** Löscht alles, was älter als die Aufbewahrungsfrist ist. */
  cleanup(now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    const cutoff = now - this.retentionDays * 86_400_000;
    let removed = 0;
    for (const f of readdirSync(this.dir)) {
      // Nur eigene Protokolldateien; ein Unterordner oder eine fremde Datei ließ rmSync werfen und den Start abbrechen
      if (!/\.(json|md)$/.test(f)) continue;
      const path = join(this.dir, f);
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed++;
      }
    }
    if (removed) log.info(`Transkripte: ${removed} Datei(en) älter als ${this.retentionDays} Tage gelöscht`);
    return removed;
  }

  startCleanupTimer(): NodeJS.Timeout {
    this.cleanup();
    return setInterval(() => this.cleanup(), 3_600_000).unref();
  }
}

export function toMarkdown(r: CallRecord): string {
  const lines = [
    `# Gespräch ${r.startedAt.slice(0, 16).replace('T', ' ')} – ${r.target}`,
    '',
    `- Dauer: ${r.durationSec}s · Ende: ${r.endReason} · Codec: ${r.codec ?? '–'} · Modus: ${r.mode}`,
  ];
  if (r.model) lines.push(`- Modell: ${r.model}${r.costUsd !== undefined ? ` · Kosten ca. ${r.costUsd.toFixed(3)} USD` : ''}`);
  if (r.persona) lines.push(`- Persona: ${Object.entries(r.persona).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (r.task) lines.push('', '## Auftrag', '', r.task);
  if (r.outcome) lines.push('', '## Ergebnis laut KI', '', r.outcome.result, ...(r.outcome.open ? ['', `Offen: ${r.outcome.open}`] : []));
  if (r.summary) lines.push('', '## Zusammenfassung', '', r.summary);
  if (r.plan) lines.push('', '## Gesprächsplan', '', r.plan.replace(/^## Gesprächsplan\n/, ''));
  lines.push('', '## Transkript', '');
  for (const e of r.entries) {
    if (!e.final && e.speaker !== 'system') continue;
    const who = e.speaker === 'ki' ? 'KI' : e.speaker === 'partner' ? 'Gegenüber' : '—';
    lines.push(`**${who}:** ${e.text}`, '');
  }
  return lines.join('\n');
}
