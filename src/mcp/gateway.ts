// Gateway zwischen KI-Agenten (MCP) und SIPFunk: prüft, was ein Agent darf (Schalter, Ziele, Bestätigung, Limits),
// führt den einen Anruf des Agenten als Folge von Ereignissen und gibt nur heraus, was der Betreiber erlaubt hat.
// Alle Tools laufen hier durch – egal ob der Agent über Streamable HTTP (/mcp) oder den stdio-Prozess kommt.
import { ASK_TIMEOUT_MS } from '../ai/agentCall.js';
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
  /** answer = false: Eine offene Rückfrage der KI kennt der Agent noch nicht; der Text ist dann keine Antwort darauf */
  say(text: string, now: boolean, answer?: boolean): 'answered' | 'now' | 'next' | 'resumed' | 'ending' | 'closed';
  end(): 'ending' | 'closed';
  /** Lage im Gespräch in einem Satz (wer spricht, Stille, Rückfrage offen, Verabschiedung) */
  situation?(): string;
}

export interface AgentCallParams {
  task: string;
  context?: string;
  principal: string;
  address?: 'sie' | 'du';
  persona?: string;
  /** Höchstdauer dieses Anrufs in Sekunden */
  maxSeconds: number;
  /** Kennung des MCP-Clients, der den Anruf gestartet hat (Eigenangabe; siehe agentLabel) */
  client?: string;
}

interface AgentCall {
  id: string;
  /** Normalisierte Rufnummer; geht nie an den Agenten, wenn er einen Kontaktnamen genannt hat */
  number: string;
  /** Wie der Agent das Ziel sieht: Kontaktname, sonst die Nummer, die er selbst genannt hat */
  label: string;
  contactName?: string;
  /** Der Kontakt ist für Agenten-Anrufe ohne Nachfrage freigegeben */
  direct?: boolean;
  params: AgentCallParams;
  state: AgentCallState;
  createdAt: number;
  connectedAt?: number;
  endReason?: string;
  /** Kennung des gespeicherten Protokolls (erst nach einem zustande gekommenen Gespräch) */
  recordId?: string;
  /** Offene Rückfrage der Sprach-KI; sie gilt nur, solange die KI auf die Antwort wartet (siehe openQuestion) */
  question?: string;
  questionAt?: number;
  /** Ereignisnummer der offenen Rückfrage, und bis wohin der Agent die Ereignisse abgeholt hat */
  questionSeq?: number;
  seenSeq?: number;
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
  /** agentDirect: der Betreiber hat den Kontakt für Agenten-Anrufe ohne Nachfrage freigegeben */
  contacts(): { name: string; number: string; agentDirect?: boolean }[];
  findContact(number: string): { name: string; number: string; agentDirect?: boolean } | undefined;
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
/**
 * Kennung eines Protokolls, wie der Agent sie sieht: nur der Zeitstempel. Die gespeicherte Kennung enthält dahinter die
 * gewählte Rufnummer (TranscriptStore.makeId) und darf deshalb nicht hinaus.
 */
const recordAlias = (id: string): string => id.split('_')[0];
/** Eine Zeile ohne Steuerzeichen: für Namen, die in die Systemanweisung gehen, und für Ereigniszeilen an den Agenten */
const oneLine = (v: string): string => v.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

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
      `Bestätigung durch den Betreiber vor dem Wählen: ${p.confirm === 'always' ? `immer, außer bei Kontakten, die der Betreiber dafür freigegeben hat${p.contacts ? ' (in list_contacts markiert)' : ''}` : p.confirm === 'unknown' ? 'nur bei Nummern ohne Kontakt' : 'nein'}`,
      `Noch möglich: ${q.hour} Anruf(e) in dieser Stunde, ${q.day} in 24 Stunden · Höchstdauer je Anruf: ${Math.round(Math.min(p.maxSeconds, line.maxCallSeconds) / 60)} Minuten`,
      `Kontaktnamen lesen: ${p.contacts ? 'erlaubt (list_contacts)' : 'nicht erlaubt'} · Protokolle: ${p.history === 'all' ? 'alle' : 'nur Anrufe über MCP'}`,
      a ? `Laufender Anruf: ${a.id} an ${a.label} – ${STATE_TEXT[a.state]}` : 'Kein laufender Anruf des Agenten.',
    ].join('\n');
  }

  private contactsText(): string {
    if (!this.deps.policy().contacts) throw new Error('Die Kontaktliste ist für Agenten nicht freigegeben (Einstellungen › MCP-Schnittstelle). start_call nimmt trotzdem den Namen eines Kontakts als target.');
    const all = this.deps.contacts();
    if (!all.length) return 'Keine Kontakte gespeichert.';
    // Die Markierung nur, wo sie etwas ändert: bei „immer bestätigen“
    const mark = this.deps.policy().confirm === 'always';
    const head = `Kontakte (Name als target für start_call${mark ? '; „ohne Bestätigung“: der Betreiber muss den Anruf nicht bestätigen' : ''}):`;
    return [head, ...all.map((c) => `- ${c.name}${mark && c.agentDirect ? ' (ohne Bestätigung)' : ''}`)].join('\n');
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
    let direct = false;
    /** Der Agent hat den Kontakt beim Namen genannt (dann kennt er den Namen, aber nicht die Nummer) */
    let named = false;
    if (NUMBER_LIKE.test(raw)) {
      number = this.deps.prepare(raw);
      const c = this.contactFor(number);
      contactName = c?.name;
      direct = c?.agentDirect === true;
    } else {
      const q = raw.toLowerCase();
      const all = this.deps.contacts();
      const exact = all.filter((c) => c.name.toLowerCase() === q);
      // Teiltreffer nur mit freigegebener Kontaktliste: Sonst ließen sich Namen durch Probieren kurzer Bruchstücke erraten
      const partial = p.contacts ? all.filter((c) => c.name.toLowerCase().includes(q)) : [];
      const hit = exact.length === 1 ? exact[0] : exact.length === 0 && partial.length === 1 ? partial[0] : undefined;
      if (!hit) throw new Error(`Kein eindeutiger Kontakt „${raw}“. ${p.contacts ? 'list_contacts zeigt die vorhandenen Namen.' : 'Bitte den Betreiber um den genauen Namen des Kontakts.'}`);
      // Auch die Nummer eines Kontakts geht durch den Rufzielschutz; der Grund einer Sperre verriete etwas über die Nummer
      try {
        number = this.deps.prepare(hit.number);
      } catch {
        throw new Error(`Der Kontakt „${hit.name}“ hat keine Rufnummer, die SIPFunk anrufen darf.`);
      }
      contactName = hit.name;
      direct = hit.agentDirect === true;
      named = true;
    }
    if (p.targets === 'contacts' && !contactName) throw new Error('Nicht erlaubt: Agenten dürfen nur gespeicherte Kontakte über deren Hauptnummer anrufen (Einstellungen › MCP-Schnittstelle); weitere Nummern eines Kontakts zählen nicht. Der Betreiber kann die Nummer als Kontakt anlegen oder zur Hauptnummer machen.');

    const line = this.deps.line();
    if (!line.registered) throw new Error('SIPFunk ist nicht an der Telefonanlage angemeldet.');
    if (!['idle', 'ended'].includes(line.phase)) throw new Error('Die Leitung ist belegt (es läuft ein anderes Gespräch). Später erneut versuchen.');

    const q = this.quota();
    if (q.hour <= 0) throw new Error(`Limit erreicht: höchstens ${p.perHour} Anrufe je Stunde über MCP.`);
    if (q.day <= 0) throw new Error(`Limit erreicht: höchstens ${p.perDay} Anrufe in 24 Stunden über MCP.`);

    const address = args.address === 'du' ? 'du' : args.address === 'sie' ? 'sie' : undefined;
    const wantedMinutes = typeof args.max_minutes === 'number' && Number.isFinite(args.max_minutes) ? Math.max(1, args.max_minutes) : undefined;
    const maxSeconds = Math.round(Math.min(p.maxSeconds, line.maxCallSeconds, wantedMinutes ? wantedMinutes * 60 : Infinity));
    // Der Name geht in die Systemanweisung: eine Zeile, begrenzt. Weicht er vom Namen des Betreibers ab, entscheidet immer der Betreiber
    const own = oneLine(this.deps.principal());
    const principal = oneLine(str(args.on_behalf_of)).slice(0, 80) || own;
    const otherPrincipal = principal.toLowerCase() !== own.toLowerCase();
    const call: AgentCall = {
      id: `c${++this.counter}`,
      number,
      // Der Agent sieht den Namen, wenn er ihn selbst genannt hat oder die Kontaktnamen lesen darf; sonst die Nummer, die er genannt hat
      label: contactName && (named || p.contacts) ? contactName : number,
      contactName,
      direct,
      params: { task, context: context || undefined, principal, address, persona: oneLine(str(args.persona)).slice(0, 40) || undefined, maxSeconds, client: this.access?.client },
      state: 'awaiting_approval',
      createdAt: this.now(),
      events: [],
    };
    this.attempts.push(call.createdAt);
    this.calls.unshift(call);
    for (const old of this.calls.splice(KEEP_CALLS)) clearTimeout(old.approvalTimer);
    log.info(`MCP: Agent möchte ${contactName ? `den Kontakt „${contactName}“` : number} anrufen (${call.id})`);

    // Ein freigegebener Kontakt wird auch bei „immer“ ohne Nachfrage gewählt; ein fremder Auftraggeber wird immer bestätigt
    const confirm = (p.confirm === 'always' && !direct) || (p.confirm === 'unknown' && !contactName) || otherPrincipal;
    if (!confirm) {
      log.info(`MCP: Anruf ${call.id} startet ohne Bestätigung (${direct ? 'Kontakt ist dafür freigegeben' : p.confirm === 'never' ? 'Bestätigung ist ausgeschaltet' : 'bekannter Kontakt'})`);
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
        timer.unref();
        this.waiters.add(done);
      });
    }
    const events = fresh();
    call.seenSeq = Math.max(call.seenSeq ?? 0, events.at(-1)?.seq ?? 0);
    const lines = [this.headline(call), ...events.map((e) => this.eventLine(e))];
    if (!events.length) lines.push(call.state === 'ended' ? '(keine weiteren Ereignisse)' : `(nichts Neues in ${timeoutSec} s)`);
    const open = this.openQuestion(call);
    if (open) call.seenSeq = Math.max(call.seenSeq ?? 0, call.questionSeq ?? 0);
    if (open) lines.push(`OFFENE RÜCKFRAGE der KI an dich: ${open} → jetzt mit say beantworten (die KI wartet etwa ${Math.round(ASK_TIMEOUT_MS / 1000)} s).`);
    lines.push(call.state === 'ended' ? `Beendet. Ergebnis, Zusammenfassung und Transkript: get_call_result (call_id ${call.id}).` : `Weiter mit wait_for_events (call_id ${call.id}, after ${this.lastSeq(call)}).`);
    return lines.join('\n');
  }

  private say(args: Record<string, unknown>): string {
    const call = this.find(args.call_id);
    if (!call) throw new Error('Kein Anruf bekannt.');
    const text = str(args.text);
    if (!text) throw new Error('text fehlt: was dem Gegenüber gesagt oder was es gefragt werden soll.');
    if (text.length > MAX_SAY) throw new Error(`text ist zu lang (höchstens ${MAX_SAY} Zeichen); kurze Anweisungen wirken am Telefon besser.`);
    // Ins Log kommen Zeitpunkt und Länge, nicht der Wortlaut (er steht als Ereignis beim Anruf)
    if (call.state !== 'connected' || !call.control) {
      log.info(`MCP: Vorgabe des Agenten für ${call.id} abgelehnt (Zustand: ${STATE_TEXT[call.state]})`);
      throw new Error(`Das geht nur im laufenden Gespräch (Zustand: ${STATE_TEXT[call.state]}).`);
    }
    // Hat der Agent die offene Rückfrage noch gar nicht abgeholt, kann sein Text keine Antwort darauf sein (beides hat sich gekreuzt)
    const open = this.openQuestion(call);
    const unseen = !!open && (call.seenSeq ?? 0) < (call.questionSeq ?? 0);
    const mode = call.control.say(text, args.when !== 'next', !unseen);
    const age = open ? `Rückfrage seit ${this.now() - (call.questionAt ?? this.now())} ms offen` : '';
    log.info(`MCP: Vorgabe des Agenten für ${call.id} (${text.length} Zeichen): ${mode}${open ? (unseen ? ` – ${age}, vom Agenten noch nicht gelesen: bleibt offen` : ` – ${age}`) : ''}`);
    if (mode === 'closed' || mode === 'ending') throw new Error('Das Gespräch wird gerade beendet; die Anweisung kommt nicht mehr an.');
    this.push(call, 'note', `Vorgabe des Agenten: ${text}`);
    if (unseen && mode !== 'resumed') {
      return `Als Vorgabe übergeben. Achtung: Die KI hat inzwischen eine Rückfrage an dich gestellt, die du noch nicht gelesen hast: „${open}“ Beantworte sie jetzt mit einem weiteren say – die KI wartet darauf und setzt deine Vorgabe danach um.`;
    }
    // Ob als Antwort oder als Vorgabe angekommen: Eine Rückfrage ist danach nicht mehr offen
    call.question = undefined;
    if (mode === 'resumed') return 'Übergeben. Die KI war schon dabei, das Gespräch zu beenden; das Auflegen ist zurückgenommen. Gesprochen ist die Vorgabe damit noch nicht: Achte auf die nächste Zeile „KI: …“; will die KI vorher wieder auflegen, hält SIPFunk sie einmal dazu an, und endet das Gespräch ohne die Vorgabe, meldet das ein Ereignis.';
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
      // Gesucht wird nur unter den Protokollen, die der Agent lesen darf, und nur über die Kennung, die er zu sehen bekommt
      const hit = this.deps.records.list().find((r) => this.mayRead(r) && recordAlias(r.id) === recordId);
      const record = hit ? this.deps.records.read(hit.id) : undefined;
      if (!record || !this.mayRead(record)) throw new Error('Protokoll nicht gefunden oder für Agenten nicht freigegeben.');
      return this.recordText(record);
    }
    const call = this.find(args.call_id);
    if (!call) throw new Error('Kein Anruf bekannt.');
    const head = [this.headline(call), `Auftrag: ${call.params.task}`];
    if (call.state !== 'ended') return [...head, 'Das Gespräch läuft noch; das Ergebnis gibt es nach dem Ende.'].join('\n');
    const record = call.recordId ? this.deps.records.read(call.recordId) : undefined;
    if (record) return [...head, '', this.recordText(record, call.label)].join('\n');
    // Kein Protokoll: Das Gespräch kam nicht zustande (nicht bestätigt, nicht abgenommen, besetzt)
    return [...head, 'Es kam kein Gespräch zustande; es gibt kein Protokoll.'].join('\n');
  }

  private listCalls(): string {
    const items = this.deps.records.list().filter((r) => this.mayRead(r)).slice(0, 30);
    if (!items.length) return 'Keine Protokolle, die für Agenten freigegeben sind.';
    return items.map((r) => `${recordAlias(r.id)} · ${this.targetLabel(r.target)} · ${r.startedAt} · ${r.durationSec}s · ${r.endReason}\n  ${(r.summary ?? r.outcome?.result ?? '').split('\n')[0]}`).join('\n');
  }

  /** Die Rückfrage, auf deren Antwort die Sprach-KI noch wartet; nach Ablauf ihrer Frist macht sie ohne Antwort weiter. */
  private openQuestion(call: AgentCall): string | undefined {
    if (call.question && this.now() - (call.questionAt ?? 0) >= ASK_TIMEOUT_MS) call.question = undefined;
    return call.question;
  }

  /** Kontakt zur Nummer – nur, wenn dessen gespeicherte Nummer selbst wählbar ist (eine Auslandsnummer kann sonst dieselben Ziffern haben wie eine andere Nummer). */
  private contactFor(number: string): { name: string; agentDirect?: boolean } | undefined {
    const c = this.deps.findContact(number);
    if (!c) return undefined;
    try {
      this.deps.prepare(c.number);
      return c;
    } catch {
      return undefined;
    }
  }

  private mayRead(r: { origin?: string }): boolean {
    return this.deps.policy().history === 'all' || r.origin === 'mcp';
  }

  /**
   * Ziel eines gespeicherten Protokolls für den Agenten: der Kontaktname, wenn er Kontaktnamen lesen darf. Ohne diese
   * Freigabe weder Name noch Nummer eines Kontakts (er kennt je nach Anruf nur das eine oder das andere); Nummern ohne
   * Kontakt stehen so da.
   */
  private targetLabel(number: string): string {
    const contact = this.contactFor(number);
    if (!contact) return number;
    return this.deps.policy().contacts ? contact.name : 'ein gespeicherter Kontakt';
  }

  /** `label`: wie der Agent das Ziel bei seinem eigenen Anruf kennt */
  private recordText(r: CallRecord, label?: string): string {
    const lines = [`Protokoll ${recordAlias(r.id)}`, `Ziel: ${label ?? this.targetLabel(r.target)} · Beginn: ${r.startedAt} · Dauer: ${r.durationSec}s · Ende: ${r.endReason}`];
    if (r.outcome) lines.push('', `Ergebnis laut KI: ${r.outcome.result}${r.outcome.open ? `\nOffen: ${r.outcome.open}` : ''}`);
    lines.push('', r.summary ? `Zusammenfassung:\n${r.summary}` : 'Zusammenfassung: noch nicht fertig (in einigen Sekunden erneut abrufen).');
    lines.push('', 'Transkript:');
    for (const e of r.entries) if (e.final) lines.push(`${e.speaker === 'ki' ? 'KI' : e.speaker === 'partner' ? 'Gegenüber' : '—'}: ${oneLine(e.text)}`);
    return lines.join('\n');
  }

  private headline(call: AgentCall): string {
    const sec = call.connectedAt && call.state === 'connected' ? Math.round((this.now() - call.connectedAt) / 1000) : undefined;
    const dur = sec === undefined ? '' : ` seit ${sec} s, noch höchstens ${Math.max(0, call.params.maxSeconds - sec)} s`;
    // Lage im Moment der Abfrage: Was zwischen den Ereignissen gilt (wer spricht, Stille, Verabschiedung), steht in keinem Ereignis
    const now = sec === undefined ? '' : oneLine(call.control?.situation?.() ?? '');
    return `Anruf ${call.id} an ${call.label}: ${STATE_TEXT[call.state]}${dur}${call.state === 'ended' && call.endReason ? ` (${call.endReason})` : ''}${now ? `
Lage jetzt: ${now}` : ''}`;
  }

  private eventLine(e: AgentEvent): string {
    const who = { state: 'Zustand', partner: 'Gegenüber', assistant: 'KI', question: 'RÜCKFRAGE der KI an dich', note: 'Hinweis' }[e.type];
    // Eine Zeile je Ereignis: Gesagtes kann sonst Zeilen nachahmen, die wie ein Zustand oder eine Rückfrage aussehen
    return `[${e.seq}] ${who}: ${oneLine(e.text)}`;
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
    call.questionAt = undefined;
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

  /** Der Anruf, der gerade auf der Leitung ist (gewählt, klingelt oder verbunden) – nur ihm gehören Äußerungen und Rückfragen. */
  private get onLine(): AgentCall | undefined {
    const call = this.active;
    return call && call.state !== 'awaiting_approval' ? call : undefined;
  }

  /** Fertige Äußerung aus dem Transkript des Agenten-Anrufs. */
  transcript(entry: { speaker: 'ki' | 'partner' | 'system'; text: string; final: boolean }): void {
    const call = this.onLine;
    if (!call || !entry.final || !entry.text.trim()) return;
    // Rückfragen meldet question(); die Zeile im Transkript wäre dasselbe noch einmal
    if (entry.speaker === 'system' && entry.text.startsWith('Rückfrage an den Agenten:')) return;
    this.push(call, entry.speaker === 'ki' ? 'assistant' : entry.speaker === 'partner' ? 'partner' : 'note', entry.text.trim());
  }

  /**
   * Der Gesprächsplan der Sprach-KI ist fertig. Der Agent bekommt die Schritte nur, wenn er das Ziel beim Namen kennt:
   * Der Plan kann den Kontaktnamen nennen, den ein Agent ohne Freigabe der Kontakte nicht erfahren soll.
   */
  plan(steps: string[]): void {
    const call = this.onLine;
    if (!call || !steps.length) return;
    if (call.contactName && call.label !== call.contactName) return;
    this.push(call, 'note', `Gesprächsplan der KI: ${steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`);
  }

  /** Die Sprach-KI fragt beim Agenten nach. */
  question(text: string): void {
    const call = this.onLine;
    if (!call) return;
    call.question = oneLine(text);
    call.questionAt = this.now();
    this.push(call, 'question', text);
    call.questionSeq = this.lastSeq(call);
    this.deps.publish(this.info());
  }

  /** Das Gespräch ist zu Ende; recordId nur, wenn es zustande kam und ein Protokoll entstand. */
  callEnded(reason: string, recordId?: string): void {
    const call = this.active;
    if (!call || call.state === 'awaiting_approval') return;
    this.finish(call, reason, recordId);
  }

  // ---- Web-UI ----

  /**
   * Der Betreiber bestätigt oder lehnt eine Anfrage ab. Liefert einen Grund, wenn bestätigt wurde, das Wählen aber
   * nicht ging (Leitung inzwischen belegt, Schnittstelle inzwischen ausgeschaltet).
   */
  approve(id: string, allow: boolean): string | undefined {
    const call = this.calls.find((c) => c.id === id);
    if (!call || call.state !== 'awaiting_approval') throw new Error('Diese Anfrage gibt es nicht mehr (abgelaufen oder zurückgezogen).');
    if (!allow) this.finish(call, 'Vom Betreiber abgelehnt');
    else if (!this.deps.policy().enabled) this.finish(call, 'Die MCP-Schnittstelle wurde inzwischen ausgeschaltet');
    else {
      log.info(`MCP: Anruf ${call.id} vom Betreiber bestätigt`);
      this.dialNow(call);
    }
    this.deps.publish(this.info());
    // (finish und dialNow ändern den Zustand; die Typprüfung sieht das nicht)
    return allow && (call.state as AgentCallState) === 'ended' ? call.endReason : undefined;
  }

  /**
   * Die Einstellungen wurden gespeichert. Ist die Schnittstelle jetzt aus, verfällt eine Anfrage, die noch auf Bestätigung
   * wartet. Ein laufendes Gespräch wird nicht mitten im Satz abgebrochen: Die KI führt es allein zu Ende (Höchstdauer gilt).
   */
  policyChanged(): void {
    const call = this.active;
    if (!this.deps.policy().enabled && call?.state === 'awaiting_approval') this.finish(call, 'Die MCP-Schnittstelle wurde ausgeschaltet');
    else this.deps.publish(this.info());
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
      pending: a?.state === 'awaiting_approval' ? { id: a.id, number: a.number, contact: a.contactName ?? '', task: a.params.task, context: a.params.context ?? '', principal: a.params.principal, ownPrincipal: a.params.principal.toLowerCase() === oneLine(this.deps.principal()).toLowerCase(), expiresAt: new Date(a.expiresAt ?? this.now()).toISOString() } : null,
      call: a && a.state !== 'awaiting_approval' ? { id: a.id, number: a.number, contact: a.contactName ?? '', state: a.state } : null,
    };
  }
}
