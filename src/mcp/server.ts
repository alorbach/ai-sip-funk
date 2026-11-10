// MCP-Server (stdio) für Claude Code, Codex und Claude Desktop.
// Spricht mit der laufenden SIPFunk-Web-UI über HTTP; SIPFunk muss also laufen (`npm start`).
//
// Wichtig: Dieser Server läuft rein lokal. Der Rufzielschutz, das Gesprächslimit und
// "ein Gespräch gleichzeitig" werden von SIPFunk selbst durchgesetzt, nicht vom Client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.SIPFUNK_URL ?? `http://127.0.0.1:${process.env.WEB_PORT ?? '8080'}`;

interface Status {
  phase: string;
  registered: boolean;
  target?: string;
  mode?: string;
  durationSec: number;
  codec?: string;
  result?: string;
  maxCallSeconds: number;
}

interface Contact {
  id: string;
  name: string;
  number: string;
  owner?: boolean;
  address?: string;
  persona?: string;
  voice?: string;
  task?: string;
  notes?: string;
}

interface CallRecord {
  id: string;
  startedAt: string;
  target: string;
  durationSec: number;
  endReason: string;
  outcome?: { result: string; open: string };
  summary?: string;
  costUsd?: number;
  task?: string;
  entries?: { speaker: string; text: string; final: boolean }[];
}

async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`SIPFunk ist nicht erreichbar unter ${BASE} – läuft \`npm start\`? (${(err as Error).message})`);
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatRecord(r: CallRecord, withTranscript: boolean): string {
  const lines = [
    `Gespräch ${r.id}`,
    `Ziel: ${r.target} · Beginn: ${r.startedAt} · Dauer: ${r.durationSec}s · Ende: ${r.endReason}${r.costUsd !== undefined ? ` · Kosten ca. ${r.costUsd.toFixed(3)} USD` : ''}`,
  ];
  if (r.task) lines.push(`Auftrag: ${r.task.split('\n\nHintergrundwissen:')[0]}`);
  if (r.outcome) lines.push('', `Ergebnis laut KI: ${r.outcome.result}${r.outcome.open ? `\nOffen: ${r.outcome.open}` : ''}`);
  lines.push('', r.summary ? `Zusammenfassung:\n${r.summary}` : 'Zusammenfassung: (noch nicht vorhanden)');
  if (withTranscript && r.entries) {
    lines.push('', 'Transkript:');
    for (const e of r.entries) {
      if (!e.final) continue;
      lines.push(`${e.speaker === 'ki' ? 'KI' : e.speaker === 'partner' ? 'Gegenüber' : '—'}: ${e.text}`);
    }
  }
  return lines.join('\n');
}

/**
 * Wartet bis zum Gesprächsende und liefert das Protokoll (inkl. Zusammenfassung, sofern sie rechtzeitig kommt).
 * MCP-Clients brechen Requests meist nach ~60 s ab; deshalb kurze Wartefenster und Fortschrittsmeldungen.
 */
async function waitForCall(sinceIso: string, timeoutSec: number, progress?: (msg: string) => Promise<void>): Promise<string> {
  const deadline = Date.now() + timeoutSec * 1000;
  // Phase 1: bis das Gespräch vorbei ist
  for (;;) {
    const { status } = await api<{ status: Status }>('/api/status');
    if (!['calling', 'ringing', 'incoming', 'connected'].includes(status.phase)) break;
    if (Date.now() > deadline) {
      return `Gespräch läuft noch (Status ${status.phase}, ${status.durationSec}s von max. ${status.maxCallSeconds}s). Bitte wait_for_call erneut aufrufen (gleicher since-Wert), oder hangup.`;
    }
    await progress?.(`${status.phase}, ${status.durationSec}s`);
    await sleep(2000);
  }
  // Phase 2: Protokoll mit Zusammenfassung abwarten (max. 30 s; 10 s, wenn die KI schon ein Ergebnis gemeldet hat)
  const started = Date.now();
  let record: CallRecord | undefined;
  for (;;) {
    const { items } = await api<{ items: CallRecord[] }>('/api/transcripts');
    record = items.find((r) => r.startedAt >= sinceIso);
    const waited = Date.now() - started;
    if (record?.summary || waited > 30_000 || (record?.outcome && waited > 10_000)) break;
    await sleep(2000);
  }
  if (!record) {
    const { status } = await api<{ status: Status }>('/api/status');
    return `Gespräch beendet ohne Protokoll (${status.result ?? 'kein Ergebnis'}). Bei Modus "ai" sollte ein Protokoll entstehen; vermutlich kam es nicht zustande (z. B. nicht verbunden).`;
  }
  const full = await api<CallRecord>(`/api/transcripts/${encodeURIComponent(record.id)}`);
  return formatRecord(full, true);
}

const server = new McpServer({ name: 'sipfunk', version: '0.1.0' });

server.registerTool(
  'get_status',
  {
    description: 'Aktueller Zustand von SIPFunk: FRITZ!Box-Registrierung, laufendes Gespräch, letztes Ergebnis.',
    inputSchema: {},
  },
  async () => {
    const { status, personas, voices, model } = await api<{ status: Status; personas: { id: string; label: string }[]; voices: string[]; model: string }>('/api/status');
    return text(
      [
        `Zustand: ${status.phase} · FRITZ!Box: ${status.registered ? 'registriert' : 'NICHT registriert'}`,
        status.target ? `Ziel: ${status.target} (${status.mode}) · Dauer ${status.durationSec}s · Codec ${status.codec ?? '–'}` : '',
        status.result ? `Letztes Ergebnis: ${status.result}` : '',
        `Limit je Anruf: ${status.maxCallSeconds}s · Standardmodell: ${model}`,
        `Personas: ${personas.map((p) => p.id).join(', ')} · Stimmen: ${voices.join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
);

server.registerTool(
  'start_call',
  {
    description:
      'Startet sofort einen KI-Telefonanruf über die FRITZ!Box. Die KI stellt sich als KI im Auftrag von `principal` vor, arbeitet `task` Punkt für Punkt ab, macht keine verbindlichen Zusagen und legt danach selbst auf. ' +
      'Vor dem Anruf wird aus `task` ein Gesprächsplan erstellt; das Ergebnis meldet die KI beim Auflegen (wait_for_call liefert es). ' +
      'Geeignet für einfache Aufträge (etwas fragen, ausrichten, einen Termin erfragen) und um den Nutzer unterwegs anzurufen; mit `context` kann die KI Rückfragen beantworten. ' +
      'Notruf-, Sonder- und Auslandsnummern sind gesperrt; interne Nebenstellen mit ** (z. B. **610). Danach mit wait_for_call auf das Ergebnis warten.',
    inputSchema: {
      target: z.string().describe('Rufnummer (z. B. 0171… oder **610) oder der Name eines gespeicherten Kontakts'),
      task: z
        .string()
        .describe(
          'Der Auftrag in normaler Sprache, 1–4 Sätze: wer vermutlich abnimmt (Name oder Beziehung zum Nutzer, falls kein Kontakt), was gefragt oder ausgerichtet werden soll, was die KI dazu wissen muss (z. B. Termin, Ort). Beispiel: „Ruf Herrn Berg an (mein Steuerberater) und frag, ob die Unterlagen für 2025 angekommen sind und bis wann er sie braucht."',
        ),
      context: z
        .string()
        .optional()
        .describe('Hintergrundwissen für Rückfragen: Projekt, aktuelle Session, Stand der Arbeit, Fakten. Die KI trägt es nicht vor, nutzt es aber, wenn das Gegenüber nachfragt.'),
      principal: z.string().describe('In wessen Auftrag die KI anruft (Name des Nutzers)'),
      persona: z.string().optional().describe('Stil-Preset: professionell (Standard), locker, formell, herzlich'),
      voice: z.string().optional().describe('OpenAI-Stimme, z. B. marin, cedar, shimmer'),
      address: z.enum(['sie', 'du']).optional().describe('Anrede des Gegenübers, Standard sie'),
      aiName: z.string().optional().describe('Name, mit dem sich die KI vorstellt (Standard Alex)'),
      personaExtra: z.string().optional().describe('Zusätzliche Verhaltenshinweise'),
      model: z.string().optional().describe('Realtime-Modell, z. B. gpt-realtime-2.1-mini oder gpt-realtime-2.1'),
    },
  },
  async (args) => {
    let target = args.target;
    let label = target;
    if (!/^[\d+*\s\-/()]+$/.test(target)) {
      // Kein Nummernformat: als Kontaktname auflösen
      const { items } = await api<{ items: Contact[] }>('/api/contacts');
      const q = target.trim().toLowerCase();
      const hits = items.filter((c) => c.name.toLowerCase() === q);
      const found = hits[0] ?? (items.filter((c) => c.name.toLowerCase().includes(q)).length === 1 ? items.find((c) => c.name.toLowerCase().includes(q)) : undefined);
      if (!found) throw new Error(`Kein eindeutiger Kontakt „${target}" – list_contacts zeigt die vorhandenen`);
      target = found.number;
      label = `${found.name} (${found.number})`;
    }
    await api('/api/call/prepare', { target }); // liefert den Sperrgrund als Fehler
    const startedAt = new Date().toISOString();
    await api('/api/call/dial', { ...args, target, mode: 'ai' });
    return text(`Anruf an ${label} gestartet (${startedAt}). Mit wait_for_call auf das Ergebnis warten.`);
  },
);

server.registerTool(
  'wait_for_call',
  {
    description:
      'Wartet auf das Ende des laufenden Gesprächs und liefert Zusammenfassung und Transkript. Wartet höchstens timeout_sec (Standard 50 s, wegen Client-Timeouts); ' +
      'läuft das Gespräch dann noch, kommt eine Statusmeldung zurück – dann einfach erneut aufrufen.',
    inputSchema: {
      timeout_sec: z.number().int().min(5).max(600).optional(),
      since: z.string().optional().describe('ISO-Zeitstempel; nur Protokolle ab diesem Zeitpunkt (Standard: jetzt minus 10 Minuten)'),
    },
  },
  async ({ timeout_sec, since }, extra) => {
    const token = extra._meta?.progressToken;
    let n = 0;
    const progress = token === undefined ? undefined : (message: string) => extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } });
    return text(await waitForCall(since ?? new Date(Date.now() - 600_000).toISOString(), timeout_sec ?? 50, progress));
  },
);

server.registerTool(
  'hangup',
  { description: 'Legt das laufende Gespräch sofort auf.', inputSchema: {} },
  async () => {
    await api('/api/call/hangup', {});
    return text('Aufgelegt.');
  },
);

server.registerTool(
  'list_contacts',
  { description: 'Listet gespeicherte Kontakte (Name, Nummer, Standardwerte, Notizen). start_call akzeptiert den Kontaktnamen als Ziel.', inputSchema: {} },
  async () => {
    const { items } = await api<{ items: Contact[] }>('/api/contacts');
    if (!items.length) return text('Keine Kontakte gespeichert.');
    return text(
      items
        .map((c) => {
          const extras = [c.owner ? 'Inhaber' : '', c.address ? `Anrede ${c.address}` : '', c.persona ? `Persona ${c.persona}` : '', c.voice ? `Stimme ${c.voice}` : '', c.task ? `Standard-Auftrag: ${c.task}` : '', c.notes ? `Notizen: ${c.notes}` : ''].filter(Boolean);
          return `${c.name} · ${c.number}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
        })
        .join('\n'),
    );
  },
);

server.registerTool(
  'call_history',
  { description: 'Gesprächsprotokolle zu einer Nummer oder einem Kontaktnamen (neueste zuerst).', inputSchema: { target: z.string() } },
  async ({ target }) => {
    let number = target;
    if (!/^[\d+*\s\-/()]+$/.test(target)) {
      const { items } = await api<{ items: Contact[] }>('/api/contacts');
      const found = items.find((c) => c.name.toLowerCase() === target.trim().toLowerCase());
      if (!found) throw new Error(`Kontakt „${target}" nicht gefunden`);
      number = found.number;
    }
    const { items } = await api<{ items: CallRecord[] }>(`/api/transcripts?number=${encodeURIComponent(number)}`);
    if (!items.length) return text('Keine Gespräche zu diesem Ziel.');
    return text(items.map((r) => `${r.id} · ${r.durationSec}s · ${r.endReason}\n  ${(r.summary ?? '').split('\n')[0]}`).join('\n'));
  },
);

server.registerTool(
  'list_calls',
  { description: 'Listet gespeicherte Gesprächsprotokolle (neueste zuerst) mit Kurzzusammenfassung.', inputSchema: {} },
  async () => {
    const { items } = await api<{ items: CallRecord[] }>('/api/transcripts');
    if (!items.length) return text('Keine gespeicherten Gespräche.');
    return text(items.map((r) => `${r.id} · ${r.target} · ${r.durationSec}s · ${r.endReason}\n  ${(r.summary ?? '').split('\n')[0]}`).join('\n'));
  },
);

server.registerTool(
  'get_call',
  { description: 'Liefert ein gespeichertes Gesprächsprotokoll mit Zusammenfassung und Transkript.', inputSchema: { id: z.string() } },
  async ({ id }) => text(formatRecord(await api<CallRecord>(`/api/transcripts/${encodeURIComponent(id)}`), true)),
);

await server.connect(new StdioServerTransport());
