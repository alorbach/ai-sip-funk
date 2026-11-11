// Gateway zwischen KI-Agenten (MCP) und SIPFunk: prüft, was ein Agent darf (Schalter, Ziele, Bestätigung, Limits),
// führt den einen Anruf des Agenten als Folge von Ereignissen und gibt nur heraus, was der Betreiber erlaubt hat.
// Alle Tools laufen hier durch – egal ob der Agent über Streamable HTTP (/mcp) oder den stdio-Prozess kommt.
import { log } from '../log.js';
import type { McpPolicy } from '../settings.js';
import type { CallRecord, CallRecordSummary } from '../transcripts.js';

export type AgentCallState = 'awaiting_approval' | 'dialing' | 'ringing' | 'connected' | 'ended';

export interface AgentEvent {
  seq: number;
  at: string;
  /** state = Zustand des Anrufs, partner = Gegenüber, assistant = die Sprach-KI, question = Rückfrage der KI an den Agenten, note = Hinweis von SIPFunk */
  type: 'state' | 'partner' | 'assistant' | 'question' | 'note';
  text: string;
}

/** Steuerung des laufenden Gesprächs (die Brücke zur Sprach-KI). */
export interface AgentCallControl {
  say(text: string, now: boolean): 'answered' | 'now' | 'next' | 'ending' | 'closed';
  end(): 'ending' | 'closed';
}

export interface AgentCallParams {
  task: string;
  context?: string;
  principal: string;
  address?: 'sie' | 'du';
  persona?: string;
  /** Höchstdauer dieses Anrufs in Sekunden */
  maxSeconds: number;
}

interface AgentCall {
  id: string;
  /** Normalisierte Rufnummer; geht nie an den Agenten, wenn er einen Kontaktnamen genannt hat */
  number: string;
  /** Wie der Agent das Ziel sieht: Kontaktname, sonst die Nummer, die er selbst genannt hat */
  label: string;
  contactName?: string;
  params: AgentCallParams;
  state: AgentCallState;
  createdAt: number;
  connectedAt?: number;
  endReason?: string;
  /** Kennung des gespeicherten Protokolls (erst nach einem zustande gekommenen Gespräch) */
  recordId?: string;
  /** Offene Rückfrage der Sprach-KI */
  question?: string;
  events: AgentEvent[];
  control?: AgentCallControl;
  approvalTimer?: NodeJS.Timeout;
  limitTimer?: NodeJS.Timeout;
  expiresAt?: number;
}

export interface GatewayDeps {
  policy(): McpPolicy;
  /** In wessen Auftrag die KI anruft, wenn der Agent nichts nennt */
  principal(): string;
  contacts(): { name: string; number: string }[];
  findContact(number: string): { name: string } | undefined;
  /** Rufzielschutz: liefert die normalisierte Nummer oder wirft mit dem Sperrgrund */
  prepare(target: string): string;
  line(): { phase: string; registered: boolean; maxCallSeconds: number };
  /** Wählt mit der aktiven KI-Verbindung; wirft, wenn das gerade nicht geht */
  dial(number: string, params: AgentCallParams): AgentCallControl;
  hangup(reason: string): void;
  records: { list(): CallRecordSummary[]; read(id: string): CallRecord | undefined };
  /** Zustand an die Web-UI (Bestätigungsdialog, Statusanzeige) */
  publish(info: Record<string, unknown>): void;
  /** Hinweis der Tray-App */
  notify(title: string, body: string): void;
  now?: () => number;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** So lange wartet eine Anfrage auf die Bestätigung des Betreibers. */
export const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_TASK = 2000;
const MAX_CONTEXT = 6000;
const MAX_SAY = 600;
const KEEP_CALLS = 20;
const NUMBER_LIKE = /^[\d+*\s\-/()]+$/;
const DISABLED = 'Die MCP-Schnittstelle ist in SIPFunk ausgeschaltet. Der Betreiber schaltet sie in der Web-UI unter „Einstellungen › MCP-Schnittstelle“ ein.';

const STATE_TEXT: Record<AgentCallState, string> = {
  awaiting_approval: 'wartet auf die Bestätigung des Betreibers',
  dialing: 'wählt',
  ringing: 'klingelt',
  connected: 'verbunden',
  ended: 'beendet',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export class McpGateway {
  private calls: AgentCall[] = [];
  private seq = 0;
  private counter = 0;
  /** Zeitpunkte der angenommenen Anruf-Anfragen (für die Limits je Stunde und Tag) */
  private attempts: number[] = [];
  private waiters = new Set<() => void>();
  private access: { at: number; tool: string; client: string; count: number } | undefined;

  constructor(private deps: GatewayDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Der Anruf, der gerade läuft oder auf Bestätigung wartet. */
  private get active(): AgentCall | undefined {
    return this.calls.find((c) => c.state !== 'ended');
  }

  private find(id: unknown): AgentCall | undefined {
    const wanted = str(id);
    return wanted ? this.calls.find((c) => c.id === wanted) : this.calls[0];
  }

  // ---- Tools ----

  /** Führt ein Tool aus. Fehler kommen als Text zurück, damit der Agent den Grund lesen kann. */
  async run(tool: string, args: Record<string, unknown> = {}, client = ''): Promise<ToolResult> {
    const count = (this.access?.count ?? 0) + 1;
    this.access = { at: this.now(), tool, client: client.slice(0, 60), count };
    try {
      if (!this.deps.policy().enabled) throw new Error(DISABLED);
      const text = await this.dispatch(tool, args);
      this.deps.publish(this.info());
      return { text };
    } catch (err) {
      this.deps.publish(this.info());
      return { text: (err as Error).message, isError: true };
    }
  }

  private dispatch(tool: string, args: Record<string, unknown>): string | Promise<string> {
    switch (tool) {
      case 'get_status':
        return this.statusText();
      case 'list_contacts':
        return this.contactsText();
      case 'start_call':
        return this.start(args);
      case 'wait_for_events':
        return this.wait(args);
      case 'say':
        return this.say(args);
      case 'end_call':
        return this.end(args);
      case 'get_call_result':
        return this.result(args);
      case 'list_calls':
        return this.listCalls();
      default:
        throw new Error(`Unbekanntes Tool: ${tool}`);
    }
  }

  private quota(): { hour: number; day: number } {
    const p = this.deps.policy();
    const now = this.now();
    this.attempts = this.attempts.filter((t) => now - t < 86_400_000);
    return { hour: Math.max(0, p.perHour - this.attempts.filter((t) => now - t < 3_600_000).length), day: Math.max(0, p.perDay - this.attempts.length) };
  }

  private statusText(): string {
    const p = this.deps.policy();
    const line = this.deps.line();
    const q = this.quota();
    const a = this.active;
    return [
      `Telefonanlage: ${line.registered ? 'angemeldet' : 'NICHT angemeldet'} · Leitung: ${line.phase === 'idle' ? 'frei' : line.phase}`,
      `Erlaubte Ziele: ${p.targets === 'contacts' ? 'nur gespeicherte Kontakte (Name als target angeben)' : 'Kontakte und jede Nummer, die der Rufzielschutz erlaubt'}`,
      `Bestätigung durch den Betreiber vor dem Wählen: ${p.confirm === 'always' ? 'immer' : p.confirm === 'unknown' ? 'nur bei Nummern ohne Kontakt' : 'nein'}`,
      `Noch möglich: ${q.hour} Anruf(e) in dieser Stunde, ${q.day} in 24 Stunden · Höchstdauer je Anruf: ${Math.round(Math.min(p.maxSeconds, line.maxCallSeconds) / 60)} Minuten`,
      `Kontaktnamen lesen: ${p.contacts ? 'erlaubt (list_contacts)' : 'nicht erlaubt'} · Protokolle: ${p.history === 'all' ? 'alle' : 'nur Anrufe über MCP'}`,
      a ? `Laufender Anruf: ${a.id} an ${a.label} – ${STATE_TEXT[a.state]}` : 'Kein laufender Anruf des Agenten.',
    ].join('\n');
  }

  private contactsText(): string {
    if (!this.deps.policy().contacts) throw new Error('Die Kontaktliste ist für Agenten nicht freigegeben (Einstellungen › MCP-Schnittstelle). start_call nimmt trotzdem den Namen eines Kontakts als target.');
    const names = this.deps.contacts().map((c) => c.name);
    return names.length ? `Kontakte (Name als target für start_call):\n${names.map((n) => `- ${n}`).join('\n')}` : 'Keine Kontakte gespeichert.';
  }

  private start(args: Record<string, unknown>): string {
    const p = this.deps.policy();
    const busy = this.active;
    if (busy) throw new Error(`Es läuft bereits ein Anruf dieses Agenten (${busy.id}, ${STATE_TEXT[busy.state]}). Erst beenden (end_call) oder das Ende abwarten.`);
    const task = str(args.task);
    if (!task) throw new Error('task fehlt: der Auftrag für das Gespräch in normaler Sprache.');
    if (task.length > MAX_TASK) throw new Error(`task ist zu lang (höchstens ${MAX_TASK} Zeichen); Hintergrundwissen gehört in context.`);
    const context = str(args.context);
    if (context.length > MAX_CONTEXT) throw new Error(`context ist zu lang (höchstens ${MAX_CONTEXT} Zeichen).`);
    const raw = str(args.target);
    if (!raw) throw new Error('target fehlt: Name eines Kontakts oder eine Rufnummer.');

    // Ziel auflösen: Nummernformat oder Kontaktname (genau, sonst ein eindeutiger Teiltreffer)
    let number: string;
    let contactName: string | undefined;
    if (NUMBER_LIKE.test(raw)) {
      number = this.deps.prepare(raw);
      contactName = this.deps.findContact(number)?.name;
    } else {
      const q = raw.toLowerCase();
      const all = this.deps.contacts();
      const exact = all.filter((c) => c.name.toLowerCase() === q);
      const partial = all.filter((c) => c.name.toLowerCase().includes(q));
      const hit = exact.length === 1 ? exact[0] : exact.length === 0 && partial.length === 1 ? partial[0] : undefined;
      if (!hit) throw new Error(`Kein eindeutiger Kontakt „${raw}“. ${p.contacts ? 'list_contacts zeigt die vorhandenen Namen.' : 'Bitte den Betreiber um den genauen Namen des Kontakts.'}`);
      // Auch die Nummer eines Kontakts geht durch den Rufzielschutz
      number = this.deps.prepare(hit.number);
      contactName = hit.name;
    }
    if (p.targets === 'contacts' && !contactName) throw new Error('Nicht erlaubt: Agenten dürfen nur gespeicherte Kontakte anrufen (Einstellungen › MCP-Schnittstelle). Der Betreiber kann die Nummer als Kontakt anlegen.');

    const line = this.deps.line();
    if (!line.registered) throw new Error('SIPFunk ist nicht an der Telefonanlage angemeldet.');
    if (!['idle', 'ended'].includes(line.phase)) throw new Error('Die Leitung ist belegt (es läuft ein anderes Gespräch). Später erneut versuchen.');

    const q = this.quota();
    if (q.hour <= 0) throw new Error(`Limit erreicht: höchstens ${p.perHour} Anrufe je Stunde über MCP.`);
    if (q.day <= 0) throw new Error(`Limit erreicht: höchstens ${p.perDay} Anrufe in 24 Stunden über MCP.`);

    const address = args.address === 'du' ? 'du' : args.address === 'sie' ? 'sie' : undefined;
    const wantedMinutes = typeof args.max_minutes === 'number' && args.max_minutes > 0 ? args.max_minutes : undefined;
    const maxSeconds = Math.round(Math.min(p.maxSeconds, line.maxCallSeconds, wantedMinutes ? wantedMinutes * 60 : Infinity));
    const call: AgentCall = {
      id: `c${++this.counter}`,
      number,
      label: contactName ?? number,
      contactName,
      params: { task, context: context || undefined, principal: str(args.on_behalf_of).slice(0, 80) || this.deps.principal(), address, persona: str(args.persona) || undefined, maxSeconds },
      state: 'awaiting_approval',
      createdAt: this.now(),
      events: [],
    };
    this.attempts.push(call.createdAt);
    this.calls.unshift(call);
    for (const old of this.calls.splice(KEEP_CALLS)) clearTimeout(old.approvalTimer);
    log.info(`MCP: Agent möchte ${contactName ? `den Kontakt „${contactName}“` : number} anrufen (${call.id})`);

    const confirm = p.confirm === 'always' || (p.confirm === 'unknown' && !contactName);
    if (!confirm) {
      this.dialNow(call);
      if (call.state === 'ended') throw new Error(call.endReason ?? 'Anruf nicht möglich');
      return `Anruf ${call.id} an ${call.label} gestartet (${STATE_TEXT[call.state]}). Weiter mit wait_for_events (call_id ${call.id}, after ${this.lastSeq(call)}).`;
    }
    call.expiresAt = this.now() + APPROVAL_TIMEOUT_MS;
    call.approvalTimer = setTimeout(() => this.finish(call, 'Vom Betreiber nicht rechtzeitig bestätigt'), APPROVAL_TIMEOUT_MS);
    call.approvalTimer.unref();
    this.push(call, 'state', 'Wartet auf die Bestätigung des Betreibers');
    this.deps.notify('KI-Agent möchte anrufen', `${call.label}: ${task.slice(0, 120)}\nIn der Web-UI bestätigen oder ablehnen.`);
    return `Anruf ${call.id} an ${call.label} angefragt. Der Betreiber muss ihn in SIPFunk bestätigen (bis zu ${APPROVAL_TIMEOUT_MS / 1000} s). Weiter mit wait_for_events (call_id ${call.id}, after ${this.lastSeq(call)}).`;
  }

  private dialNow(call: AgentCall): void {
    clearTimeout(call.approvalTimer);
    call.expiresAt = undefined;
    try {
      call.control = this.deps.dial(call.number, call.params);
    } catch (err) {
      this.finish(call, `Anruf nicht möglich: ${(err as Error).message}`);
      return;
    }
    call.state = 'dialing';
    this.push(call, 'state', 'Wählt');
  }

  private async wait(args: Record<string, unknown>): Promise<string> {
    const call = this.find(args.call_id);
    if (!call) throw new Error('Kein Anruf bekannt. Erst start_call aufrufen.');
    const after = typeof args.after === 'number' ? args.after : 0;
    const timeoutSec = Math.min(50, Math.max(1, typeof args.timeout_sec === 'number' ? args.timeout_sec : 25));
    const fresh = () => call.events.filter((e) => e.seq > after);
    if (!fresh().length && call.state !== 'ended') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutSec * 1000);
        this.waiters.add(done);
      });
    }
    const events = fresh();
    const lines = [this.headline(call), ...events.map((e) => this.eventLine(e))];
    if (!events.length) lines.push(call.state === 'ended' ? '(keine weiteren Ereignisse)' : `(nichts Neues in ${timeoutSec} s)`);
    if (call.question) lines.push(`OFFENE RÜCKFRAGE der KI an dich: ${call.question} → jetzt mit say beantworten (die KI wartet etwa 25 s).`);
    lines.push(call.state === 'ended' ? `Beendet. Ergebnis, Zusammenfassung und Transkript: get_call_result (call_id ${call.id}).` : `Weiter mit wait_for_events (call_id ${call.id}, after ${this.lastSeq(call)}).`);
    return lines.join('\n');
  }

  private say(args: Record<string, unknown>): string {
    const call = this.find(args.call_id);
    if (!call) throw new Error('Kein Anruf bekannt.');
    const text = str(args.text);
    if (!text) throw new Error('text fehlt: was dem Gegenüber gesagt oder was es gefragt werden soll.');
    if (text.length > MAX_SAY) throw new Error(`text ist zu lang (höchstens ${MAX_SAY} Zeichen); kurze Anweisungen wirken am Telefon besser.`);
    if (call.state !== 'connected' || !call.control) throw new Error(`Das geht nur im laufenden Gespräch (Zustand: ${STATE_TEXT[call.state]}).`);
    const mode = call.control.say(text, args.when !== 'next');
    if (mode === 'closed' || mode === 'ending') throw new Error('Das Gespräch wird gerade beendet; die Anweisung kommt nicht mehr an.');
    if (mode === 'answered') call.question = undefined;
    this.push(call, 'note', `Vorgabe des Agenten: ${text}`);
    return mode === 'answered'
      ? 'Als Antwort auf die Rückfrage übergeben; die KI gibt es jetzt weiter.'
      : mode === 'now'
        ? 'Übergeben; die KI sagt es bei der nächsten Gelegenheit (sofort, wenn gerade niemand spricht).'
        : 'Übergeben; die KI berücksichtigt es, wenn sie das nächste Mal spricht.';
  }

  private end(args: Record<string, unknown>): string {
    const call = this.find(args.call_id);
    if (!call) throw new Error('Kein Anruf bekannt.');
    if (call.state === 'ended') return `Anruf ${call.id} ist bereits beendet (${call.endReason ?? 'ohne Grund'}).`;
    if (call.state === 'awaiting_approval') {
      this.finish(call, 'Vom Agenten zurückgezogen');
      return `Anfrage ${call.id} zurückgezogen.`;
    }
    if (args.mode === 'now' || call.state !== 'connected' || !call.control) {
      this.deps.hangup('Vom Agenten aufgelegt (MCP)');
      return 'Aufgelegt.';
    }
    if (call.control.end() === 'closed') {
      this.deps.hangup('Vom Agenten aufgelegt (MCP)');
      return 'Aufgelegt.';
    }
    call.question = undefined;
    this.push(call, 'note', 'Der Agent hat das Beenden angefordert; die KI verabschiedet sich');
    return `Die KI verabschiedet sich und legt dann auf. Mit wait_for_events (call_id ${call.id}, after ${this.lastSeq(call)}) auf „beendet“ warten; mode "now" legt sofort auf.`;
  }

  private result(args: Record<string, unknown>): string {
    const recordId = str(args.record_id);
    if (recordId) {
      const record = this.deps.records.read(recordId);
      if (!record || !this.mayRead(record)) throw new Error('Protokoll nicht gefunden oder für Agenten nicht freigegeben.');
      return this.recordText(record);
    }
    const call = this.find(args.call_id);
    if (!call) throw new Error('Kein Anruf bekannt.');
    const head = [this.headline(call), `Auftrag: ${call.params.task}`];
    if (call.state !== 'ended') return [...head, 'Das Gespräch läuft noch; das Ergebnis gibt es nach dem Ende.'].join('\n');
    const record = call.recordId ? this.deps.records.read(call.recordId) : undefined;
    if (record) return [...head, '', this.recordText(record)].join('\n');
    // Kein Protokoll: Das Gespräch kam nicht zustande (nicht bestätigt, nicht abgenommen, besetzt)
    return [...head, 'Es kam kein Gespräch zustande; es gibt kein Protokoll.'].join('\n');
  }

  private listCalls(): string {
    const items = this.deps.records.list().filter((r) => this.mayRead(r)).slice(0, 30);
    if (!items.length) return 'Keine Protokolle, die für Agenten freigegeben sind.';
    return items.map((r) => `${r.id} · ${this.targetLabel(r.target)} · ${r.startedAt} · ${r.durationSec}s · ${r.endReason}\n  ${(r.summary ?? r.outcome?.result ?? '').split('\n')[0]}`).join('\n');
  }

  private mayRead(r: { origin?: string }): boolean {
    return this.deps.policy().history === 'all' || r.origin === 'mcp';
  }

  /** Für den Agenten steht ein Kontaktname statt der Nummer, wo es einen gibt. */
  private targetLabel(number: string): string {
    return this.deps.findContact(number)?.name ?? number;
  }

  private recordText(r: CallRecord): string {
    const lines = [`Protokoll ${r.id}`, `Ziel: ${this.targetLabel(r.target)} · Beginn: ${r.startedAt} · Dauer: ${r.durationSec}s · Ende: ${r.endReason}`];
    if (r.outcome) lines.push('', `Ergebnis laut KI: ${r.outcome.result}${r.outcome.open ? `\nOffen: ${r.outcome.open}` : ''}`);
    lines.push('', r.summary ? `Zusammenfassung:\n${r.summary}` : 'Zusammenfassung: noch nicht fertig (in einigen Sekunden erneut abrufen).');
    lines.push('', 'Transkript:');
    for (const e of r.entries) if (e.final) lines.push(`${e.speaker === 'ki' ? 'KI' : e.speaker === 'partner' ? 'Gegenüber' : '—'}: ${e.text}`);
    return lines.join('\n');
  }

  private headline(call: AgentCall): string {
    const dur = call.connectedAt && call.state === 'connected' ? ` seit ${Math.round((this.now() - call.connectedAt) / 1000)} s` : '';
    return `Anruf ${call.id} an ${call.label}: ${STATE_TEXT[call.state]}${dur}${call.state === 'ended' && call.endReason ? ` (${call.endReason})` : ''}`;
  }

  private eventLine(e: AgentEvent): string {
    const who = { state: 'Zustand', partner: 'Gegenüber', assistant: 'KI', question: 'RÜCKFRAGE der KI an dich', note: 'Hinweis' }[e.type];
    return `[${e.seq}] ${who}: ${e.text}`;
  }

  private lastSeq(call: AgentCall): number {
    return call.events.at(-1)?.seq ?? 0;
  }

  private push(call: AgentCall, type: AgentEvent['type'], text: string): void {
    call.events.push({ seq: ++this.seq, at: new Date(this.now()).toISOString(), type, text });
    for (const wake of [...this.waiters]) wake();
  }

  private finish(call: AgentCall, reason: string, recordId?: string): void {
    if (call.state === 'ended') return;
    clearTimeout(call.approvalTimer);
    clearTimeout(call.limitTimer);
    call.state = 'ended';
    call.endReason = reason;
    call.recordId = recordId;
    call.control = undefined;
    call.question = undefined;
    call.expiresAt = undefined;
    this.push(call, 'state', `Beendet: ${reason}`);
    log.info(`MCP: Anruf ${call.id} beendet (${reason})`);
    this.deps.publish(this.info());
  }

  // ---- Rückmeldungen aus dem Gesprächsablauf (main.ts) ----

  /** Zustand der Leitung hat sich geändert. */
  linePhase(phase: string): void {
    const call = this.active;
    if (!call || call.state === 'awaiting_approval') return;
    if (phase === 'ringing' && call.state === 'dialing') {
      call.state = 'ringing';
      this.push(call, 'state', 'Klingelt');
    } else if (phase === 'connected' && call.state !== 'connected') {
      call.state = 'connected';
      call.connectedAt = this.now();
      this.push(call, 'state', 'Verbunden – das Gegenüber hat abgenommen');
      call.limitTimer = setTimeout(() => {
        this.push(call, 'note', 'Höchstdauer für Agenten-Anrufe erreicht');
        this.deps.hangup('Höchstdauer für Agenten-Anrufe erreicht (MCP)');
      }, call.params.maxSeconds * 1000);
      call.limitTimer.unref();
    } else return;
    this.deps.publish(this.info());
  }

  /** Fertige Äußerung aus dem Transkript des Agenten-Anrufs. */
  transcript(entry: { speaker: 'ki' | 'partner' | 'system'; text: string; final: boolean }): void {
    const call = this.active;
    if (!call || !entry.final || !entry.text.trim()) return;
    // Rückfragen meldet question(); die Zeile im Transkript wäre dasselbe noch einmal
    if (entry.speaker === 'system' && entry.text.startsWith('Rückfrage an den Agenten:')) return;
    this.push(call, entry.speaker === 'ki' ? 'assistant' : entry.speaker === 'partner' ? 'partner' : 'note', entry.text.trim());
  }

  /** Die Sprach-KI fragt beim Agenten nach. */
  question(text: string): void {
    const call = this.active;
    if (!call) return;
    call.question = text;
    this.push(call, 'question', text);
    this.deps.publish(this.info());
  }

  /** Das Gespräch ist zu Ende; recordId nur, wenn es zustande kam und ein Protokoll entstand. */
  callEnded(reason: string, recordId?: string): void {
    const call = this.active;
    if (!call || call.state === 'awaiting_approval') return;
    this.finish(call, reason, recordId);
  }

  // ---- Web-UI ----

  /** Der Betreiber bestätigt oder lehnt eine Anfrage ab. */
  approve(id: string, allow: boolean): void {
    const call = this.calls.find((c) => c.id === id);
    if (!call || call.state !== 'awaiting_approval') throw new Error('Diese Anfrage gibt es nicht mehr (abgelaufen oder zurückgezogen).');
    if (allow) {
      log.info(`MCP: Anruf ${call.id} vom Betreiber bestätigt`);
      this.dialNow(call);
    } else this.finish(call, 'Vom Betreiber abgelehnt');
    this.deps.publish(this.info());
  }

  /** Zustand für die Web-UI: letzter Zugriff, offene Anfrage, laufender Anruf, Kontingent. Mit Rufnummer – das sieht nur der Betreiber. */
  info(): Record<string, unknown> {
    const a = this.active;
    const q = this.quota();
    return {
      type: 'mcp',
      enabled: this.deps.policy().enabled,
      lastAccess: this.access ? { at: new Date(this.access.at).toISOString(), tool: this.access.tool, client: this.access.client, count: this.access.count } : null,
      quota: q,
      pending: a?.state === 'awaiting_approval' ? { id: a.id, number: a.number, contact: a.contactName ?? '', task: a.params.task, principal: a.params.principal, expiresAt: new Date(a.expiresAt ?? this.now()).toISOString() } : null,
      call: a && a.state !== 'awaiting_approval' ? { id: a.id, number: a.number, contact: a.contactName ?? '', state: a.state } : null,
    };
  }
}
