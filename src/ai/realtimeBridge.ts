// Brücke zwischen Telefon-Audio (PCM16, 8 oder 16 kHz) und dem Live-Sprachmodell eines KI-Anbieters.
// Hier steckt die anbieterunabhängige Gesprächslogik: Begrüßung, Unterbrechung prüfen, Wächter gegen Stille,
// Verabschiedung und Auflegen, Transkript, Tool-Aufrufe. Das Protokoll des Anbieters (OpenAI Realtime, Gemini Live)
// übersetzt eine LiveSession aus ai/providers; zwischen Telefon und deren Abtastrate wird resampelt.
import type WebSocket from 'ws';
import type { AudioHandler } from '../callManager.js';
import { log } from '../log.js';
import { Resampler } from '../rtp/resample.js';
import { samplesPerFrame } from '../rtp/session.js';
import { isBackchannel, isFarewell } from './farewell.js';
import { END_CALL_AFTER_SILENCE, END_CALL_TOOL, END_CALL_WHILE_SPEAKING, TRANSFER_CALL_TOOL, endCallCheckInstruction, farewellInstruction } from './personas.js';
import { AGENT_END_NOTE, ASK_NO_ANSWER, ASK_PRINCIPAL_TOOL, ASK_REPLACED, ASK_TIMEOUT_MS, agentNote, askAnswer } from './agentCall.js';
import { FLAG_SPAM_ACK, FLAG_SPAM_ACK_OPEN, FLAG_SPAM_TOOL, SCAM_FAREWELL, SCAM_STALL } from './scam.js';
import { OpenAiLive } from './providers/openaiLive.js';
import { EMPTY_USAGE, type LiveConfig, type LiveError, type LiveEvents, type LiveResponseDone, type LiveSession, type Usage } from './providers/types.js';

export type { Usage } from './providers/types.js';

/** Was die KI beim end_call als Ergebnis für den Auftraggeber meldet. */
export interface CallOutcome {
  /** Erreichtes Ergebnis, Antworten und Nachrichten fürs Gegenüber in 1–3 Sätzen */
  result: string;
  /** Nicht erledigte Punkte; leer, wenn alles erledigt ist */
  open: string;
}

export interface TranscriptEntry {
  speaker: 'ki' | 'partner' | 'system';
  text: string;
  final: boolean;
  itemId?: string;
}

export interface RealtimeBridgeOptions {
  apiKey: string;
  model: string;
  instructions: string;
  voice: string;
  greetingInstruction: string;
  /** Anrede des Gegenübers (für die Verabschiedung) */
  formal: boolean;
  /** true = Gegenüber ist der Inhaber selbst (Rückruf): Verabschiedung ohne „ich gebe das weiter" */
  owner?: boolean;
  /** true = Spam-Abwehr von Anfang an (Listentreffer, von Hand umgeleitet): Verabschiedung wie eine Privatperson */
  scam?: boolean;
  /** true = die Spam-Rolle tritt offen als KI auf (KI-Kennung der Spam-Abwehr): bestimmt die Antwort auf flag_spam */
  scamDisclose?: boolean;
  /** Namen, die die Transkription kennen soll (Auftraggeber, Kontakt, KI-Name) */
  transcriptionHints?: string[];
  /** false = Gegenüber kann die KI nicht unterbrechen (Gegenprobe bei Echo-Problemen) */
  allowInterrupt: boolean;
  /** Verstärkung der KI-Stimme Richtung Telefon (1 = unverändert) */
  outputGain: number;
  /** Sprechgeschwindigkeit (OpenAI speed 0.25–1.5) */
  speechSpeed: number;
  /** Obergrenze je Antwort (Text + Audio-Token); Default 900 ≈ 22 s Sprache */
  maxOutputTokens?: number;
  /** Stille in ms bis Satzende (Server-VAD); zu kurz = KI redet in Denkpausen rein */
  vadSilenceMs: number;
  /** Schwelle der Spracherkennung (Server-VAD, 0–1): höher = Geräusche lösen seltener aus */
  vadThreshold?: number;
  /** Nachhörphase nach der Verabschiedung, bevor aufgelegt wird */
  hangupGraceMs: number;
  /** Stillstandswächter: so lange nach dem Ende der KI-Ausgabe darf es still bleiben, bevor die KI angestoßen wird (0 = aus) */
  stallMs: number;
  /** So lange nach Annahme auf das Gegenüber warten, bevor die KI von sich aus begrüßt */
  greetingWaitMs: number;
  /** Reagiert das Gegenüber auf die Begrüßung nicht, spricht die KI nach afterMs von sich aus weiter (Anrufbeantworter: „Hallo?" → Vorstellung) */
  greetingFollowUp?: { afterMs: number; instruction: string };
  onTranscript: (entry: TranscriptEntry) => void;
  onUsage: (usage: Usage) => void;
  onEndCall: (reason: string) => void;
  /** Ergebnis, das die KI beim end_call gemeldet hat */
  onOutcome?: (outcome: CallOutcome) => void;
  /** Weitervermittlung (Tool transfer_call): verbindet den Gesprächspartner mit dem Anrufer; Ergebnis als Text fürs Modell */
  onTransfer?: () => Promise<{ ok: boolean; reason: string }>;
  /** Spam-Abwehr (Tool flag_spam): liefert die neuen Anweisungen, mit denen das Gespräch weitergeht */
  onFlagSpam?: (reason: string) => string;
  /** Anruf eines KI-Agenten (MCP): Die KI darf per Tool ask_principal beim Agenten nachfragen; hier kommt die Frage an */
  onAskAgent?: (question: string) => void;
  onError: (message: string) => void;
  /** Gespräch ist angenommen (z. B. Start des Spam-Zeitlimits) */
  onConnected?: () => void;
  /** Nur für Tests: liefert statt der Verbindung zum Anbieter einen nachgestellten WebSocket */
  createSocket?: (url: string) => WebSocket;
  /** Baut die Live-Verbindung des gewählten Anbieters auf; ohne Angabe OpenAI Realtime */
  createLive?: (config: LiveConfig, events: LiveEvents) => LiveSession;
}

// Das Modell generiert ca. 3x schneller als Echtzeit; eine lange Antwort liegt also fast komplett
// im Puffer. Die Grenze ist nur ein Sicherheitsnetz und darf im Normalfall nie greifen –
// ein zu kleiner Wert hat hier Frames übersprungen und die Stimme "zu schnell" klingen lassen.
const MAX_OUTPUT_QUEUE = 3000; // 60 s
// Audio vom Anbieter kommt in Schüben. Ohne Vorpuffer spielt der erste Frame sofort,
// die nächsten sind noch unterwegs – der Satzanfang klingt abgehackt.
const PREBUFFER_FRAMES = 15; // 300 ms sammeln, bevor eine Antwort losgeht
const PREBUFFER_MAX_WAIT_MS = 500; // spätestens dann loslegen, auch mit weniger
// Weicher Begrenzer für die Verstärkung: ab hier werden Spitzen gestaucht statt hart abgeschnitten (klirrt sonst)
const LIMIT_KNEE = 24000;
// So lange darf die KI nach einer Anforderung oder nach dem Satzende des Gegenübers stumm bleiben
const AUDIO_WATCHDOG_MS = 5000;
/** Das Gegenüber gab vor der Begrüßung einen Laut von sich: Entsteht so lange nach dessen Ende keine Antwort, begrüßt die KI doch selbst */
const OPENING_REPLY_MS = 2000;
// Stillstandswächter: höchstens so oft hintereinander anstoßen, ohne dass das Gegenüber etwas sagt
const STALL_MAX_NUDGES = 2;
/** Unterbrechung prüfen statt sofort verwerfen: erst ab so viel Rest-Audio lohnt das Weitersprechen */
const HOLD_MIN_MS = 1000;
/** Längste Pause der KI-Ausgabe, solange das Gegenüber noch redet */
const HOLD_MAX_MS = 15000;
/** So lange nach dem Satzende des Gegenübers wird auf die Transkription gewartet */
const HOLD_AFTER_SPEECH_MS = 3000;
/** So lange nach einem bloßen Zuhör-Laut gilt eine neu beginnende Antwort noch als Antwort darauf (Anbieter, die erst danach antworten) */
const NOISE_REPLY_MS = 3000;
/** Nach einem abgelehnten end_call: so lange darf das Gegenüber nach dem Ende des Satzes schweigen */
const REJECT_SILENCE_MS = 2500;
/** Sprache nach der Verabschiedung: so lange wird auf die Transkription gewartet */
const FAREWELL_DECISION_MS = 4000;

const STALL_INSTRUCTION =
  'Es ist still geworden: Du hast zuletzt gesprochen, und das Gegenüber hat seitdem nichts gesagt. Hast du etwas angekündigt („einen Moment", „ich halte das fest") oder eine Frage vorbereitet, dann stell diese Frage jetzt direkt. Sonst frag in einem kurzen Satz, ob das Gegenüber noch dran ist. Ein Satz, dann warten.';

export class RealtimeBridge implements AudioHandler {
  private live: LiveSession;
  private ready = false;
  private closed = false;
  private connected = false;
  private greeted = false;
  private outQueue: Int16Array[] = []; // PCM-Frames à 20 ms in der Abtastrate des Gesprächs
  private outRemainder = Buffer.alloc(0); // angefangenes 16-Bit-Sample aus dem letzten Delta
  private pcmRemainder = new Int16Array(0); // resampelte Samples, die noch keinen ganzen Frame füllen
  private callRate = 8000;
  private toAi: Resampler;
  private fromAi: Resampler;
  private usage: Usage = { ...EMPTY_USAGE };
  private endRequested?: string;
  // Ablauf bei end_call: Modell ruft Tool auf -> wir erzwingen eine letzte Antwort (Ergebnis + Verabschiedung)
  // -> erst wenn die komplett ausgespielt ist, wird aufgelegt. Sonst legt das Modell mitten im Satz auf.
  private goodbye: 'none' | 'pending' | 'speaking' | 'done' = 'none';
  private hangupTimer?: NodeJS.Timeout;
  // Gegenüber hat nach der Verabschiedung gesprochen: Transkription abwarten, dann entscheiden
  private farewellDecisionTimer?: NodeJS.Timeout;
  private goodbyeResponseId?: string;
  private endSafetyTimer?: NodeJS.Timeout;
  // Schritte des Gesprächsplans; der erste end_call wird damit zur Selbstprüfung zurückgegeben
  private planSteps: string[] = [];
  private endCallChecked = false;
  // Nach einem abgelehnten end_call (Sprache + Tool): Schweigt das Gegenüber, muss die KI selbst wieder dran
  private rejectTimer?: NodeJS.Timeout;
  private kiLive = '';
  private playing = false;
  private firstQueuedAt = 0;
  // Item, dessen Audio zuletzt in die Warteschlange kam
  private currentItemId?: string;
  // Welche Items in der Warteschlange liegen (in Abspielreihenfolge, mit Frame-Zahl) und wie viel vom gerade
  // gespielten schon zu hören war – um bei Unterbrechung je Item die gehörte Länge zu melden
  private queuedItems: { id: string; frames: number }[] = [];
  private playItemId?: string;
  private playedMsForItem = 0;
  // Das Modell liefert manchmal zwei Nachrichten in einer Antwort. Bei der Begrüßung („Hallo … / Hallo …")
  // wird nur die erste gespielt, weitere werden verworfen und aus dem Kontext gelöscht. Im Gespräch werden
  // alle gespielt: Dort war die zweite Nachricht die eigentliche Frage („einen Moment … / Kann er Sie …?"),
  // und ihr Verwerfen ließ die KI 20 s verstummen (Testanruf 09.11.2026).
  private responseFirstItem?: string;
  private droppedItems: string[] = [];
  // Messwerte je Antwort, werden bei response.done geloggt
  private stats = { underruns: 0, maxQueue: 0, framesPlayed: 0, interruptions: 0, discarded: 0, firstDeltaAt: 0, deltas: 0 };
  // Wächter: Nach einer Anforderung bzw. nach dem Satzende des Gegenübers muss Audio kommen.
  // Am Telefon blieb die KI sonst stumm, ohne dass im Protokoll ein Grund stand.
  private activeResponse = false;
  private awaitingAudioSince = 0;
  private awaitingLabel = '';
  private audioWatchdog?: NodeJS.Timeout;
  // Begrüßung läuft noch; danach ggf. nachfassen, wenn das Gegenüber nichts sagt
  private greetingResponse = false;
  private followUpTimer?: NodeJS.Timeout;
  private limitedSamples = 0;
  // Stillstandswächter: Nach dem Ende der KI-Ausgabe muss entweder das Gegenüber sprechen oder eine
  // neue Antwort entstehen. Am Telefon blieb die KI sonst stumm (z. B. „einen Moment …" und dann nichts).
  private stallTimer?: NodeJS.Timeout;
  private stallNudges = 0;
  /** true zwischen speech_started und speech_stopped: Das Gegenüber redet, also herrscht kein Stillstand */
  private partnerSpeaking = false;
  /** Audio einer Antwort, die nach der Verabschiedung entstand, während noch offen ist, ob das Gegenüber gesprochen hat */
  private heldAudio: { itemId: string; buf: Buffer }[] = [];
  /** true = nach der Verabschiedung war es nur ein Geräusch oder ein „Tschüss": weitere Antworten bleiben stumm */
  private muteAfterGoodbye = false;
  /**
   * Das Gegenüber hat mitten in die KI-Ausgabe hinein einen Laut gemacht: Die Ausgabe pausiert, bis die
   * Transkription zeigt, ob es Inhalt war (Rest verwerfen) oder nur ein Geräusch/Zuhör-Laut (Satz zu Ende sprechen).
   * held = Audio der Antwort, die der Server inzwischen auf den Laut hin erzeugt.
   */
  private hold?: { timer: NodeJS.Timeout; itemId?: string; /** die KI sprach noch einen längeren Rest oder wurde mitten in der Antwort unterbrochen */ midSentence?: boolean; held: { itemId: string; buf: Buffer }[]; texts: { itemId: string; text: string }[] };
  /** true = die Antwort auf ein bloßes Geräusch bleibt stumm (bis sie fertig ist oder das Gegenüber wieder spricht) */
  private muteNoiseResponse = false;
  /** Bis zu diesem Zeitpunkt gilt eine neu beginnende Antwort als Antwort auf einen bloßen Zuhör-Laut und bleibt stumm (0 = aus) */
  private muteReplyUntil = 0;
  /** Wie die letzte Antwort endete ('cancelled' = das Gegenüber hat sie unterbrochen) */
  private lastResponseStatus?: string;
  /** Äußerung (Item), deren Transkription über das Auflegen nach der Verabschiedung entscheidet */
  private farewellItemId?: string;
  /** true ab transfer_call, bis die Vermittlung gescheitert ist: Der Stillstandswächter schweigt so lange */
  private transferring = false;
  /** Offene Rückfrage an den Agenten (Tool ask_principal): Bis zur Antwort oder zum Ablauf der Frist schweigt der Stillstandswächter */
  private ask?: { callId: string; timer: NodeJS.Timeout };
  /** Eine Antwort ist gewünscht (Regieanweisung, beantwortete Rückfrage), aber die KI spricht gerade: nach ihrer Antwort anfordern */
  private pendingRespond = false;
  /** Das Gegenüber war vor der Begrüßung zu hören, eine Antwort der KI darauf gibt es aber noch nicht */
  private openingPending = false;
  private openingTimer?: NodeJS.Timeout;
  private speechStartedAt = 0;

  constructor(private opts: RealtimeBridgeOptions) {
    const config: LiveConfig = {
      apiKey: opts.apiKey,
      model: opts.model,
      instructions: opts.instructions,
      voice: opts.voice,
      tools: [END_CALL_TOOL, ...(opts.onTransfer ? [TRANSFER_CALL_TOOL] : []), ...(opts.onFlagSpam ? [FLAG_SPAM_TOOL] : []), ...(opts.onAskAgent ? [ASK_PRINCIPAL_TOOL] : [])],
      allowInterrupt: opts.allowInterrupt,
      vadSilenceMs: opts.vadSilenceMs,
      vadThreshold: opts.vadThreshold ?? 0.6,
      speechSpeed: opts.speechSpeed,
      maxOutputTokens: opts.maxOutputTokens ?? 900,
      transcriptionHints: opts.transcriptionHints ?? [],
      createSocket: opts.createSocket,
    };
    const events: LiveEvents = {
      open: () => log.info(`Realtime: verbunden (${this.opts.model})`),
      ready: () => {
        if (!this.ready) {
          this.ready = true;
          log.info('Realtime: Sitzung bereit');
          this.maybeGreet();
        }
      },
      responseStarted: (id) => this.onResponseStarted(id),
      audio: (itemId, pcm) => this.onAudio(itemId, pcm),
      aiText: (itemId, text, final) => this.onAiText(itemId, text, final),
      partnerText: (itemId, text) => this.onPartnerText(itemId, text),
      speechStarted: (itemId) => this.onSpeechStarted(itemId),
      speechStopped: () => this.onSpeechStopped(),
      toolCall: (name, callId, args) => this.onToolCall(name, callId, args),
      responseDone: (r) => this.onResponseDone(r),
      usage: (u) => this.addUsage(u),
      error: (e) => this.onLiveError(e),
      socketError: (message) => {
        // Nach close() (z. B. Handler beim Umleiten ersetzt, Verbindung noch im Aufbau) geht der Fehler niemanden mehr an
        if (this.closed) return;
        log.error('Realtime-WebSocket:', message);
        opts.onError(message);
      },
      closed: (code, reason) => {
        if (!this.closed) {
          log.warn(`Realtime-Verbindung geschlossen (${code} ${reason})`);
          this.closed = true;
          // Timer mit abräumen: close() kehrt später sofort zurück, und ein laufender Auflege-Timer träfe sonst das nächste Gespräch
          this.clearTimers();
          opts.onError(`Verbindung zu ${this.live.label} beendet`);
        }
      },
    };
    this.live = opts.createLive ? opts.createLive(config, events) : new OpenAiLive(config, events);
    this.toAi = new Resampler(8000, this.live.inputRate);
    this.fromAi = new Resampler(this.live.outputRate, 8000);
  }

  // ---- AudioHandler ----

  onConnected(sampleRate = 8000): void {
    this.connected = true;
    this.opts.onConnected?.();
    this.callRate = sampleRate;
    this.toAi = new Resampler(sampleRate, this.live.inputRate);
    this.fromAi = new Resampler(this.live.outputRate, sampleRate);
    // Erst zuhören: Meldet sich das Gegenüber ("Müller?"), antwortet die KI darauf.
    // Sagt es nichts, begrüßt sie nach der Wartezeit von sich aus.
    setTimeout(() => this.maybeGreet(), this.opts.greetingWaitMs).unref();
  }

  onRemoteAudio(pcm: Int16Array): void {
    if (!this.ready || !this.connected) return;
    const out = this.toAi.process(pcm);
    if (out.length === 0) return;
    this.live.sendAudio(out);
  }

  nextFrame(): Int16Array | undefined {
    if (this.hold) return undefined;
    if (!this.playing) {
      const waited = this.firstQueuedAt ? Date.now() - this.firstQueuedAt : 0;
      if (this.outQueue.length >= PREBUFFER_FRAMES || (this.outQueue.length > 0 && waited >= PREBUFFER_MAX_WAIT_MS)) {
        this.playing = true;
      } else {
        if (this.outQueue.length === 0 && this.endRequested !== undefined && this.goodbye === 'done' && this.connected) this.finishEndCall();
        return undefined;
      }
    }
    const frame = this.outQueue.shift();
    if (!frame) {
      this.playing = false;
      this.firstQueuedAt = 0;
      this.stats.underruns++;
      if (this.endRequested !== undefined && this.goodbye === 'done' && this.connected) this.finishEndCall();
      this.armStall();
      return undefined;
    }
    this.stats.framesPlayed++;
    const head = this.queuedItems[0];
    if (head) {
      if (head.id !== this.playItemId) {
        this.playItemId = head.id;
        this.playedMsForItem = 0;
      }
      if (--head.frames <= 0) this.queuedItems.shift();
    }
    this.playedMsForItem += 20;
    const pcm = frame;
    const g = this.opts.outputGain;
    if (g !== 1) {
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i] * g;
        const a = Math.abs(v);
        if (a <= LIMIT_KNEE) {
          pcm[i] = v;
        } else {
          // Oberhalb des Knies weich in Richtung Vollausschlag stauchen statt abzuschneiden
          this.limitedSamples++;
          const over = (a - LIMIT_KNEE) / (32767 - LIMIT_KNEE);
          const soft = LIMIT_KNEE + (32767 - LIMIT_KNEE) * Math.tanh(over);
          pcm[i] = v < 0 ? -soft : soft;
        }
      }
    }
    return pcm;
  }

  /**
   * Systemanweisung nachreichen (z. B. wenn der Gesprächsplan erst nach dem Verbindungsaufbau fertig ist).
   * Vor dem Aufbau der Sitzung ersetzt die Verbindung nur ihre Vorgabe; danach geht ein Update an den Anbieter.
   */
  updateInstructions(instructions: string, planSteps: string[] = []): void {
    this.opts.instructions = instructions;
    this.planSteps = planSteps;
    if (!this.closed) this.live.update(instructions);
  }

  private clearTimers(): void {
    clearTimeout(this.openingTimer);
    clearTimeout(this.hangupTimer);
    clearTimeout(this.endSafetyTimer);
    clearTimeout(this.farewellDecisionTimer);
    clearTimeout(this.rejectTimer);
    clearTimeout(this.audioWatchdog);
    clearTimeout(this.followUpTimer);
    clearTimeout(this.stallTimer);
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = undefined;
    if (this.ask) clearTimeout(this.ask.timer);
    this.ask = undefined;
  }

  // ---- Steuerung durch einen KI-Agenten (MCP) ----

  /**
   * Der Agent gibt vor, was dem Gegenüber gesagt werden soll. Wartet die KI auf die Antwort einer Rückfrage, ist das
   * die Antwort; sonst kommt der Text als Regieanweisung in den Gesprächsverlauf. `now` fordert sofort eine Antwort an
   * (bzw. gleich nach der laufenden); ohne `now` setzt die KI die Anweisung um, wenn sie das nächste Mal spricht.
   */
  agentSay(text: string, now = false): 'answered' | 'now' | 'next' | 'ending' | 'closed' {
    if (this.closed) return 'closed';
    if (this.endRequested !== undefined || this.goodbye !== 'none') return 'ending';
    if (this.ask) {
      this.resolveAsk(askAnswer(text));
      return 'answered';
    }
    this.live.note(agentNote(text));
    if (!now) return 'next';
    this.requestRespond('Regieanweisung des Agenten');
    return 'now';
  }

  /** Der Agent möchte das Gespräch höflich beenden: Die KI ruft end_call auf und verabschiedet sich wie sonst auch. */
  agentEnd(): 'ending' | 'closed' {
    if (this.closed) return 'closed';
    if (this.endRequested !== undefined || this.goodbye !== 'none') return 'ending';
    // Der Auftraggeber beendet: Die Selbstprüfung gegen den Gesprächsplan („sprich fehlende Schritte jetzt aus“) entfällt
    this.endCallChecked = true;
    if (this.ask) this.resolveAsk(AGENT_END_NOTE);
    else {
      this.live.note(AGENT_END_NOTE);
      this.requestRespond('Beenden durch den Agenten');
      // Noch vor der Begrüßung: Das Beenden nach der Begrüßung anstoßen, statt auf das Gegenüber zu warten
      if (!this.greeted) this.pendingRespond = true;
    }
    return 'ending';
  }

  /** Rückfrage abschließen: Das Ergebnis geht an das Modell, das danach weiterspricht. */
  private resolveAsk(output: string): void {
    const ask = this.ask;
    if (!ask) return;
    clearTimeout(ask.timer);
    this.ask = undefined;
    this.live.toolOutput(ask.callId, ASK_PRINCIPAL_TOOL.name, output);
    this.requestRespond('Antwort auf die Rückfrage');
  }

  /**
   * Antwort anfordern, ohne einer laufenden ins Wort zu fallen: Spricht die KI gerade, folgt die Anforderung nach ihrer
   * Antwort; spricht das Gegenüber, erzeugt der Anbieter nach dessen Satzende ohnehin eine.
   */
  private requestRespond(label: string): void {
    if (this.closed || this.endRequested !== undefined || this.goodbye !== 'none') return;
    // Vor der Begrüßung: Die Begrüßung bzw. die Antwort auf die Meldung des Gegenübers kennt den Hinweis schon
    if (!this.ready || !this.connected || !this.greeted) return;
    // Die KI wartet auf die Antwort einer Rückfrage: Erst die Antwort darauf lässt sie weitersprechen
    if (this.ask) return;
    if (this.partnerSpeaking) return;
    // Eine Antwort läuft oder ist gerade angefordert (Begrüßung, Satzende des Gegenübers; der Wächter läuft noch): danach anfordern
    if (this.activeResponse || this.audioWatchdog) {
      this.pendingRespond = true;
      return;
    }
    this.live.respond();
    this.audioExpected(true, label);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.outQueue = [];
    this.queuedItems = [];
    this.live.close();
  }

  // ---- intern ----

  private onResponseStarted(id?: string): void {
    this.activeResponse = true;
    // Die KI antwortet auf die Meldung des Gegenübers: Das ist die Begrüßung
    this.openingPending = false;
    clearTimeout(this.openingTimer);
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.responseFirstItem = undefined;
    this.droppedItems = [];
    if (this.muteReplyUntil) {
      if (Date.now() < this.muteReplyUntil) this.muteNoiseResponse = true;
      this.muteReplyUntil = 0;
    }
    // Die erste Antwort nach unserer Abschluss-Anforderung ist die Verabschiedung
    if (this.goodbye === 'speaking' && !this.goodbyeResponseId && id) this.goodbyeResponseId = id;
  }

  private onAudio(itemId: string, pcm: Buffer): void {
    if (!this.stats.firstDeltaAt) this.stats.firstDeltaAt = Date.now();
    this.stats.deltas++;
    if (this.awaitingAudioSince) {
      log.info(`Realtime: erstes Audio ${Date.now() - this.awaitingAudioSince} ms nach ${this.awaitingLabel}`);
      this.audioExpected(false);
    }
    if (this.isExtraItem(itemId)) return;
    // Nach der Verabschiedung: Antwort auf ein mögliches Geräusch zurückhalten, bis die Transkription entschieden hat
    if (this.endRequested !== undefined && this.goodbye === 'done') {
      if (this.muteAfterGoodbye) return;
      if (this.farewellDecisionTimer) {
        this.heldAudio.push({ itemId, buf: pcm });
        return;
      }
    }
    if (this.muteNoiseResponse) return;
    if (this.hold) {
      this.hold.held.push({ itemId, buf: pcm });
      return;
    }
    this.enqueueAudio(pcm, itemId);
  }

  private onAiText(itemId: string, text: string, final: boolean): void {
    if (this.isExtraItem(itemId)) return;
    if (!final) {
      if (this.muteNoiseResponse || (this.hold && itemId !== this.currentItemId)) return;
      this.kiLive += text;
      this.opts.onTranscript({ speaker: 'ki', text: this.kiLive, final: false, itemId });
      return;
    }
    if (this.muteNoiseResponse) return;
    if (this.hold && itemId !== this.currentItemId) {
      this.hold.texts.push({ itemId, text });
      return;
    }
    this.kiLive = '';
    this.opts.onTranscript({ speaker: 'ki', text, final: true, itemId });
  }

  private onPartnerText(itemId: string | undefined, text: string): void {
    if (text) this.opts.onTranscript({ speaker: 'partner', text, final: true, itemId: String(itemId) });
    else {
      log.info(`Realtime: Äußerung ${itemId ?? '?'} ohne Text (Geräusch)`);
      // Vor der Begrüßung war es nur ein Geräusch (Abheben, Rascheln): Darauf antwortet kein Modell von selbst
      this.lateGreeting('Geräusch statt Meldung');
    }
    // Nur die Äußerung zählt, die die Prüfung ausgelöst hat – nicht die verspätete Transkription des Satzes davor
    const fits = (expected?: string) => !expected || !itemId || expected === itemId;
    if (this.farewellDecisionTimer) {
      if (!fits(this.farewellItemId)) return;
      if (this.partnerSpeaking && isFarewell(text)) {
        // „Ja …" und das Gegenüber redet schon weiter: erst die nächste Äußerung entscheidet
        this.farewellItemId = undefined;
        clearTimeout(this.farewellDecisionTimer);
        this.farewellDecisionTimer = setTimeout(() => this.decideAfterGoodbye(undefined), FAREWELL_DECISION_MS);
      } else this.decideAfterGoodbye(text);
    } else if (this.hold && fits(this.hold.itemId)) {
      if (this.partnerSpeaking && isBackchannel(text)) this.hold.itemId = undefined;
      else this.resolveHold(text);
    }
  }

  private onSpeechStarted(itemId?: string): void {
    this.partnerSpeaking = true;
    this.speechStartedAt = Date.now();
    clearTimeout(this.openingTimer);
    // Das Gegenüber redet: Die Antwort darauf entsteht von selbst und kennt die Regieanweisung schon
    this.pendingRespond = false;
    this.muteNoiseResponse = false;
    this.muteReplyUntil = 0;
    clearTimeout(this.rejectTimer);
    this.rejectTimer = undefined;
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.stallNudges = 0;
    clearTimeout(this.followUpTimer);
    this.followUpTimer = undefined;
    this.onSpeechAfterGoodbye(itemId);
    if (!this.greeted) {
      this.greeted = true; // Gegenüber hat sich gemeldet, die Antwort des Modells darauf übernimmt die Begrüßung
      this.openingPending = true; // … bleibt sie aus, holt lateGreeting die Begrüßung nach
      log.info('Realtime: Gegenüber spricht zuerst, KI antwortet darauf');
    }
    // Gegenüber spricht: laufende KI-Ausgabe sofort verwerfen – außer in der Verabschiedung:
    // Dort entscheidet erst die Transkription, ob es Sprache war (siehe decideAfterGoodbye)
    if (this.outQueue.length > 0 && this.endRequested !== undefined) {
      log.info(`Realtime: speech_started während der Verabschiedung – ${this.outQueue.length * 20} ms Abschied laufen weiter`);
    } else if (this.hold) {
      // Prüfung läuft schon; das Gegenüber redet weiter
    } else if (this.outQueue.length > 0) {
      const ms = this.outQueue.length * 20;
      if (!this.opts.allowInterrupt) {
        log.info(`Realtime: speech_started – ${ms} ms in der Warteschlange, Unterbrechen aus`);
      } else if (!this.activeResponse && !this.greetingResponse && (ms >= HOLD_MIN_MS || (this.live.answersAfterInterrupt && this.lastResponseStatus === 'cancelled'))) {
        // (Ein Anbieter, der eine Antwort bei einer Unterbrechung selbst abbricht, braucht die Prüfung dann auch bei wenig Rest:
        // Nur sie hält seine Antwort auf einen Zuhör-Laut stumm. War die Antwort dagegen fertig und fast ausgespielt, ist ein
        // „Okay“ die Antwort des Gegenübers, kein Zuhör-Laut.)
        // Antwort liegt vollständig vor: nur pausieren und erst nach der Transkription entscheiden
        log.info(`Realtime: speech_started – ${ms} ms in der Warteschlange, pausiere und prüfe, ob das Gegenüber etwas sagt`);
        this.hold = { timer: setTimeout(() => this.resolveHold(undefined), HOLD_MAX_MS), itemId, midSentence: ms >= HOLD_MIN_MS || this.lastResponseStatus === 'cancelled', held: [], texts: [] };
        this.hold.timer.unref();
      } else {
        log.info(`Realtime: speech_started – ${this.outQueue.length} Frames (${ms} ms) in der Warteschlange, verwerfe`);
        this.discardOutput();
      }
    }
  }

  private onSpeechStopped(): void {
    this.partnerSpeaking = false;
    if (this.speechStartedAt) log.info(`Realtime: Gegenüber war ${Date.now() - this.speechStartedAt} ms zu hören`);
    this.speechStartedAt = 0;
    if (this.openingPending) {
      clearTimeout(this.openingTimer);
      this.openingTimer = setTimeout(() => this.lateGreeting(`${OPENING_REPLY_MS} ms keine Antwort der KI`), OPENING_REPLY_MS);
      this.openingTimer.unref();
    }
    if (this.hold) {
      // Die Transkription kommt kurz nach dem Satzende; bleibt sie aus, gilt das Gesagte als Inhalt
      clearTimeout(this.hold.timer);
      this.hold.timer = setTimeout(() => this.resolveHold(undefined), HOLD_AFTER_SPEECH_MS);
      this.hold.timer.unref();
    }
    // Der Anbieter erzeugt jetzt die Antwort; bleibt sie aus, greift der Wächter
    this.audioExpected(true, 'Satzende des Gegenübers');
  }

  private onToolCall(name: string, callId: string, args: string): void {
    if (this.goodbye !== 'none') {
      this.live.toolOutput(callId, name, 'ok');
      return;
    }
    // Antwort auf ein bloßes Geräusch ist verworfen: Ihr Tool-Aufruf gilt nicht
    if (this.muteNoiseResponse) {
      if (this.live.toolCallsBlock) this.live.toolOutput(callId, name, 'ok');
      return;
    }
    // Das Modell handelt auf das Gesagte hin: Dann war es Inhalt, die Prüfung der Unterbrechung ist entschieden
    if (this.hold) this.resolveHold(undefined);
    this.onFunctionCall(name, callId, args);
  }

  private onResponseDone(r: LiveResponseDone): void {
    this.lastResponseStatus = r.status;
    this.muteNoiseResponse = false;
    this.activeResponse = false;
    if (r.usage) this.addUsage(r.usage);
    const st = this.stats;
    if (st.deltas > 0) {
      const genMs = Date.now() - st.firstDeltaAt;
      const audioMs = (st.framesPlayed + this.outQueue.length) * 20;
      log.info(`Realtime-Antwort: ${st.deltas} Deltas in ${genMs} ms für ${audioMs} ms Audio (${(audioMs / Math.max(genMs, 1)).toFixed(1)}x Echtzeit), Unterläufe ${st.underruns}, max. Puffer ${st.maxQueue * 20} ms, Unterbrechungen ${st.interruptions} (${st.discarded * 20} ms verworfen)`);
      if (r.status === 'incomplete') log.warn(`Realtime-Antwort abgeschnitten: ${JSON.stringify(r.statusDetails ?? {})} – Limit max_output_tokens ${this.opts.maxOutputTokens ?? 900}`);
      if (this.greetingResponse && this.opts.greetingFollowUp && r.status === 'completed') {
        // Begrüßung fertig: Sagt das Gegenüber nach dem Ausspielen nichts, spricht die KI weiter
        const wait = this.outQueue.length * 20 + this.opts.greetingFollowUp.afterMs;
        clearTimeout(this.followUpTimer);
        this.followUpTimer = setTimeout(() => {
          this.followUpTimer = undefined;
          if (this.closed || this.endRequested !== undefined || this.activeResponse) return;
          log.info('Realtime: Gegenüber reagiert nicht auf die Begrüßung – KI stellt sich vor');
          this.live.respond(this.opts.greetingFollowUp!.instruction);
          this.audioExpected(true, 'Nachfassen nach der Begrüßung');
        }, wait);
        this.followUpTimer.unref();
      }
    } else {
      const types = r.outputTypes.join(', ') || 'keine';
      log.info(`Realtime-Antwort ohne Audio: Status ${r.status ?? '?'}, Inhalte: ${types}${r.statusDetails ? ` – ${JSON.stringify(r.statusDetails)}` : ''}`);
    }
    this.greetingResponse = false;
    if (this.limitedSamples > 0 && st.framesPlayed > 0) {
      log.info(`Realtime: Begrenzer griff bei ${((100 * this.limitedSamples) / (st.framesPlayed * samplesPerFrame(this.callRate))).toFixed(1)} % der Samples (AI_OUTPUT_GAIN ${this.opts.outputGain})`);
      this.limitedSamples = 0;
    }
    this.stats = { underruns: 0, maxQueue: 0, framesPlayed: 0, interruptions: 0, discarded: 0, firstDeltaAt: 0, deltas: 0 };
    if (this.goodbye === 'pending') {
      // Die Antwort mit dem Tool-Aufruf ist fertig; jetzt die Abschlussantwort anfordern
      this.goodbye = 'speaking';
      this.goodbyeResponseId = undefined;
      this.live.respond(this.opts.scam ? SCAM_FAREWELL : farewellInstruction(this.opts.formal, this.opts.owner));
    } else if (this.goodbye === 'speaking' && this.goodbyeResponseId && r.id === this.goodbyeResponseId) {
      // Nur das Ende der Verabschiedungs-Antwort zählt, nicht irgendeine andere (z. B. leere Antwort auf ein Geräusch)
      this.goodbye = 'done';
      log.info('Realtime: Abschluss gesprochen, lege auf sobald das Audio ausgespielt ist');
    }
    for (const id of this.droppedItems) {
      log.info(`Realtime: zweite Nachricht in einer Antwort verworfen (${id})`);
      this.live.deleteItem(id);
    }
    this.droppedItems = [];
    // Hat das Gegenüber die Antwort unterbrochen und antwortet der Anbieter darauf von selbst, kommt die Vorgabe dort an:
    // Die Anforderung bleibt vorgemerkt, bis das Gegenüber spricht (dann entfällt sie) oder die nächste Antwort fertig ist
    if (this.pendingRespond && !(r.status === 'cancelled' && this.live.answersAfterInterrupt)) {
      this.pendingRespond = false;
      this.requestRespond('Regieanweisung des Agenten');
    }
    if (!this.playing && this.outQueue.length === 0) this.armStall();
    if (r.status === 'failed') {
      log.error('Realtime-Antwort fehlgeschlagen:', JSON.stringify(r.statusDetails));
      this.opts.onError(`${this.live.label}-Antwort fehlgeschlagen`);
    }
  }

  private onLiveError(e: LiveError): void {
    // Zwei Auslöser wollten gleichzeitig eine Antwort (z. B. Wächter und Spracherkennung): Die laufende Antwort genügt, das Gespräch geht weiter
    if (e.kind === 'busy') {
      log.warn('Realtime: Antwort läuft bereits, zusätzliche Anforderung verworfen');
      if (this.goodbye === 'speaking') {
        // Getroffen hat es die Verabschiedung (das Gegenüber sprach im selben Moment): nach der laufenden Antwort erneut anfordern
        this.goodbye = 'pending';
        this.goodbyeResponseId = undefined;
      }
      return;
    }
    // Abgelehntes Aufräumen (Antwort war schon fertig, Item schon weg, Kürzung hinter dem Ende): das Gespräch läuft weiter
    if (e.kind === 'cleanup') {
      log.warn(`Realtime: Aufräum-Ereignis abgelehnt (${e.code ?? '?'}: ${e.message ?? ''}) – ohne Folgen`);
      return;
    }
    log.error('Realtime-Fehler:', e.code, e.message);
    this.opts.onError(e.message ?? 'Unbekannter Realtime-Fehler');
  }

  /**
   * Stillstandswächter scharf schalten: Die KI hat ausgesprochen (oder eine Antwort ist ohne weiteres Audio
   * fertig). Sagt das Gegenüber in stallMs nichts und entsteht keine neue Antwort, wird die KI angestoßen,
   * ihre angekündigte Frage zu stellen oder nachzufragen. Andere Wächter (Begrüßung, abgelehnter end_call,
   * Verabschiedung) haben Vorrang.
   */
  private armStall(): void {
    if (!this.opts.stallMs || this.closed || !this.connected) return;
    if (this.activeResponse || this.partnerSpeaking || this.goodbye !== 'none' || this.endRequested !== undefined) return;
    if (this.greetingResponse || this.followUpTimer || this.rejectTimer || this.awaitingAudioSince || this.transferring || this.ask) return;
    if (this.stallTimer) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (this.closed || this.activeResponse || this.partnerSpeaking || this.transferring || this.ask || this.goodbye !== 'none' || this.endRequested !== undefined) return;
      if (this.stallNudges >= STALL_MAX_NUDGES) {
        log.warn(`Realtime: Stillstand hält an (${this.stallNudges}x angestoßen, Gegenüber schweigt) – kein weiterer Anstoß`);
        return;
      }
      this.stallNudges++;
      this.pendingRespond = false;
      log.warn(`Realtime: Stillstand – ${this.opts.stallMs} ms nach Ende der KI-Ausgabe weder Sprache des Gegenübers noch neue Antwort, stoße die KI an (${this.stallNudges}/${STALL_MAX_NUDGES})`);
      this.live.respond(this.opts.scam ? SCAM_STALL : STALL_INSTRUCTION);
      this.audioExpected(true, 'Stillstandswächter');
    }, this.opts.stallMs);
    this.stallTimer.unref();
  }

  /** true, wenn das Item in der Begrüßungsantwort nicht das erste Audio-Item ist (nur dort wird verworfen). */
  private isExtraItem(itemId: string): boolean {
    if (!this.responseFirstItem) {
      this.responseFirstItem = itemId;
      return false;
    }
    if (itemId === this.responseFirstItem || !this.greetingResponse) return false;
    if (!this.droppedItems.includes(itemId)) this.droppedItems.push(itemId);
    return true;
  }

  /**
   * Das Gegenüber war vor der Begrüßung zu hören, aber die KI hat darauf nicht geantwortet (ein Geräusch beim Abheben,
   * ein verschlucktes „Hallo"): Die Begrüßung nachholen, statt zu warten, bis das Gegenüber „Hallo? Hallo?" sagt.
   */
  private lateGreeting(why: string): void {
    if (!this.openingPending) return;
    clearTimeout(this.openingTimer);
    // Das Gegenüber redet wieder: Dessen Satzende stellt die Frist neu
    if (this.partnerSpeaking) return;
    this.openingPending = false;
    if (this.closed || this.activeResponse || this.endRequested !== undefined || this.goodbye !== 'none' || this.ask) return;
    log.info(`Realtime: ${why} – KI begrüßt von sich aus`);
    this.greet();
  }

  private maybeGreet(): void {
    if (this.closed || this.greeted || !this.ready || !this.connected) return;
    this.greeted = true;
    log.info('Realtime: Gegenüber schweigt, KI begrüßt von sich aus');
    this.greet();
  }

  private greet(): void {
    this.greetingResponse = true;
    this.live.respond(this.opts.greetingInstruction);
    this.audioExpected(true, 'Begrüßungsanforderung');
  }

  /**
   * Ab jetzt wird Audio der KI erwartet (true) bzw. es ist angekommen (false). Kommt binnen
   * 5 s nichts, wird das protokolliert; existiert dabei nicht einmal eine laufende Antwort,
   * fordert die Brücke selbst eine an, statt den Anrufer in Stille hängen zu lassen.
   */
  private audioExpected(expected: boolean, label = ''): void {
    clearTimeout(this.audioWatchdog);
    this.audioWatchdog = undefined;
    if (!expected) {
      this.awaitingAudioSince = 0;
      return;
    }
    this.awaitingAudioSince = Date.now();
    this.awaitingLabel = label;
    this.audioWatchdog = setTimeout(() => {
      this.audioWatchdog = undefined;
      if (this.closed || !this.awaitingAudioSince) return;
      if (this.activeResponse) {
        log.warn(`Realtime: ${AUDIO_WATCHDOG_MS} ms nach ${label} noch kein Audio – Antwort läuft, aber langsam`);
        return;
      }
      this.awaitingAudioSince = 0;
      // Die KI wartet auf den Agenten (Rückfrage): Stille ist dann gewollt
      if (this.goodbye !== 'none' || this.endRequested !== undefined || this.ask) return;
      log.warn(`Realtime: ${AUDIO_WATCHDOG_MS} ms nach ${label} keine Antwort entstanden – fordere eine an`);
      // Einmal nachfordern; bleibt es danach still, übernimmt der Stillstandswächter (höchstens STALL_MAX_NUDGES Anstöße)
      this.pendingRespond = false;
      this.live.respond();
    }, AUDIO_WATCHDOG_MS);
    this.audioWatchdog.unref();
  }

  private enqueueAudio(data: Buffer, itemId: string): void {
    this.currentItemId = itemId;
    const before = this.outQueue.length;
    if (this.outQueue.length === 0 && !this.playing) this.firstQueuedAt = Date.now();
    // PCM16 LE von der API: ganze Samples herausnehmen, auf die Gesprächsrate bringen, in 20-ms-Frames schneiden
    const bytes = Buffer.concat([this.outRemainder, data]);
    const even = bytes.length - (bytes.length % 2);
    this.outRemainder = Buffer.from(bytes.subarray(even));
    const pcm24 = new Int16Array(even / 2);
    for (let i = 0; i < pcm24.length; i++) pcm24[i] = bytes.readInt16LE(i * 2);
    const resampled = this.fromAi.process(pcm24);
    const all = new Int16Array(this.pcmRemainder.length + resampled.length);
    all.set(this.pcmRemainder);
    all.set(resampled, this.pcmRemainder.length);
    const n = samplesPerFrame(this.callRate);
    let off = 0;
    for (; off + n <= all.length; off += n) this.outQueue.push(all.slice(off, off + n));
    this.pcmRemainder = all.slice(off);
    const added = this.outQueue.length - before;
    const last = this.queuedItems.at(-1);
    if (last?.id === itemId) last.frames += added;
    else if (added > 0) this.queuedItems.push({ id: itemId, frames: added });
    if (this.outQueue.length > this.stats.maxQueue) this.stats.maxQueue = this.outQueue.length;
    if (this.outQueue.length > MAX_OUTPUT_QUEUE) {
      log.warn(`Realtime: Ausgabepuffer über ${MAX_OUTPUT_QUEUE * 20} ms, verwerfe alte Frames`);
      let drop = this.outQueue.length - MAX_OUTPUT_QUEUE;
      this.outQueue.splice(0, drop);
      while (drop > 0 && this.queuedItems.length) {
        const take = Math.min(drop, this.queuedItems[0].frames);
        this.queuedItems[0].frames -= take;
        drop -= take;
        if (this.queuedItems[0].frames <= 0) this.queuedItems.shift();
      }
    }
  }

  private onFunctionCall(name: string, callId: string, args: string): void {
    if (name === 'flag_spam' && this.opts.onFlagSpam) {
      let reason = '';
      try {
        reason = String((JSON.parse(args) as { grund?: string }).grund ?? '');
      } catch {
        // Argument optional
      }
      log.info(`Realtime: flag_spam – ${reason || 'ohne Grund'}; schalte auf Spam-Abwehr um`);
      const instructions = this.opts.onFlagSpam(reason);
      this.opts.instructions = instructions;
      this.opts.scam = true;
      this.planSteps = [];
      // Einmal genügt: Kann ein Anbieter die Tool-Liste nicht kürzen, bleibt ein zweiter Aufruf ohne Wirkung
      this.opts.onFlagSpam = undefined;
      // Neue Rolle, flag_spam ist ab jetzt nicht mehr nötig
      this.live.update(instructions, [END_CALL_TOOL]);
      this.live.toolOutput(callId, name, this.opts.scamDisclose ? FLAG_SPAM_ACK_OPEN : FLAG_SPAM_ACK);
      this.live.respond();
      this.audioExpected(true, 'Spam-Abwehr');
      return;
    }
    if (name === 'transfer_call' && this.opts.onTransfer) {
      this.transferCall(callId).catch((err) => log.error(`Vermittlung: ${(err as Error).message}`));
      return;
    }
    if (name === ASK_PRINCIPAL_TOOL.name && this.opts.onAskAgent) {
      let question = '';
      try {
        question = String((JSON.parse(args) as { frage?: string }).frage ?? '').trim();
      } catch {
        // ohne lesbare Frage gibt es nichts zu fragen
      }
      if (!question) {
        this.live.toolOutput(callId, name, 'Die Frage fehlt. Stell sie in einem Satz oder mach ohne Rückfrage weiter.');
        this.requestRespond('leere Rückfrage');
        return;
      }
      // Eine neue Rückfrage ersetzt die offene (ein Anbieter, der auf Tool-Ergebnisse wartet, braucht für jede eine Antwort)
      if (this.ask) {
        clearTimeout(this.ask.timer);
        this.live.toolOutput(this.ask.callId, name, ASK_REPLACED);
      }
      log.info('Realtime: ask_principal – Rückfrage an den Agenten, warte auf die Antwort');
      clearTimeout(this.stallTimer);
      this.stallTimer = undefined;
      // Bis zur Antwort des Agenten wird kein Audio erwartet und keine weitere Antwort angefordert
      this.audioExpected(false);
      this.pendingRespond = false;
      const timer = setTimeout(() => {
        log.warn(`Realtime: Rückfrage blieb ${ASK_TIMEOUT_MS} ms ohne Antwort des Agenten – KI macht ohne weiter`);
        this.opts.onTranscript({ speaker: 'system', text: 'Rückfrage an den Agenten blieb ohne Antwort', final: true });
        this.resolveAsk(ASK_NO_ANSWER);
      }, ASK_TIMEOUT_MS);
      timer.unref();
      this.ask = { callId, timer };
      this.opts.onTranscript({ speaker: 'system', text: `Rückfrage an den Agenten: ${question}`, final: true });
      this.opts.onAskAgent(question);
      return;
    }
    if (name !== 'end_call') {
      this.live.toolOutput(callId, name, 'Unbekannte Funktion');
      return;
    }
    let outcome: CallOutcome = { result: '', open: '' };
    try {
      const a = JSON.parse(args) as { ergebnis?: string; offen?: string; reason?: string };
      outcome = { result: String(a.ergebnis ?? a.reason ?? '').trim(), open: String(a.offen ?? '').trim() };
    } catch {
      // Argumente optional
    }
    if (this.endRequested !== undefined) {
      // doppelter Aufruf
      if (this.live.toolCallsBlock) this.live.toolOutput(callId, name, 'ok');
      return;
    }
    if (this.stats.deltas > 0) {
      // Gesprochen und im selben Atemzug beendet („ich richte das jetzt aus" + end_call):
      // das Gegenüber bekommt erst die Chance zu antworten, die VAD erzeugt die nächste Antwort.
      log.info('Realtime: end_call zusammen mit Sprache – abgelehnt, Gegenüber darf erst antworten');
      this.live.toolOutput(callId, name, END_CALL_WHILE_SPEAKING);
      // Kommt nichts vom Gegenüber, darf das Gespräch nicht bis zum Limit hängen. Die Frist läuft erst,
      // wenn der Satz ausgespielt ist – er liegt hier noch fast vollständig im Puffer.
      const rejectWait = this.outQueue.length * 20 + REJECT_SILENCE_MS;
      clearTimeout(this.rejectTimer);
      let retries = 0;
      const onSilence = (): void => {
        this.rejectTimer = undefined;
        if (this.endRequested !== undefined || this.closed || this.ask) return;
        // Die KI spricht gerade selbst (ein Anbieter lässt sie nach dem Tool-Ergebnis von sich aus weiterreden):
        // nicht hineinreden, sondern nach ihrem Satz noch einmal nachsehen
        if (this.activeResponse && retries++ < 10) {
          this.rejectTimer = setTimeout(onSilence, 1000);
          this.rejectTimer.unref();
          return;
        }
        log.info('Realtime: Gegenüber schweigt nach abgelehntem end_call – KI soll beenden');
        this.live.respond(END_CALL_AFTER_SILENCE);
      };
      this.rejectTimer = setTimeout(onSilence, rejectWait);
      this.rejectTimer.unref();
      return;
    }
    if (this.planSteps.length && !this.endCallChecked) {
      // Erster end_call mit Plan: Schritte gegen das Gesagte prüfen lassen, dann erst beenden
      this.endCallChecked = true;
      log.info(`Realtime: end_call – Selbstprüfung gegen ${this.planSteps.length} Planschritte angefordert`);
      this.live.toolOutput(callId, name, endCallCheckInstruction(this.planSteps));
      this.live.respond();
      return;
    }
    if (this.ask) {
      // Das Gespräch endet: Die offene Rückfrage braucht keine Antwort mehr
      clearTimeout(this.ask.timer);
      if (this.live.toolCallsBlock) this.live.toolOutput(this.ask.callId, ASK_PRINCIPAL_TOOL.name, 'ok');
      this.ask = undefined;
    }
    const reason = outcome.open ? 'KI hat beendet, Auftrag teilweise offen' : 'KI hat das Gespräch beendet';
    log.info(`Realtime: end_call – Ergebnis: ${outcome.result || '–'}${outcome.open ? ` · offen: ${outcome.open}` : ''}; fordere Verabschiedung an`);
    this.live.toolOutput(callId, name, 'ok – verabschiede dich jetzt');
    this.endRequested = reason;
    this.goodbye = 'pending';
    if (outcome.result) this.opts.onOutcome?.(outcome);
    this.opts.onTranscript({ speaker: 'system', text: `Ergebnis laut KI: ${outcome.result || '–'}${outcome.open ? ` · Offen: ${outcome.open}` : ''}`, final: true });
    // Sicherheitsnetz, falls Abschluss oder Audio ausbleiben (wird bei Abbruch gelöscht)
    clearTimeout(this.endSafetyTimer);
    this.endSafetyTimer = setTimeout(() => {
      this.endSafetyTimer = undefined;
      if (this.endRequested !== undefined && this.goodbye !== 'none') {
        log.warn('Realtime: Abschluss blieb aus – lege nach Sicherheitsfrist auf');
        this.goodbye = 'done';
        this.outQueue = [];
        this.queuedItems = [];
        this.finishEndCall();
      }
    }, 30_000);
    this.endSafetyTimer.unref();
  }

  /**
   * Vermittlung: erst das „Ich verbinde Sie" fertig ausspielen, dann die Box durchstellen lassen.
   * Gelingt es, beendet die Box unser Gespräch; sonst erfährt das Modell den Grund und spricht weiter.
   */
  private async transferCall(callId: string): Promise<void> {
    log.info('Realtime: transfer_call – warte auf Ende der Ansage, dann Vermittlung');
    this.transferring = true;
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    for (let i = 0; i < 100 && (this.outQueue.length > 0 || this.playing) && !this.closed; i++) await new Promise((r) => setTimeout(r, 100));
    if (this.closed) return;
    const result = await this.opts.onTransfer!();
    if (this.closed) return;
    if (result.ok) {
      // transferring bleibt gesetzt: Die Box beendet unser Gespräch gleich, bis dahin stößt kein Wächter die KI an
      log.info('Realtime: Vermittlung erfolgreich – Gespräch geht an die Box über');
      return;
    }
    this.transferring = false;
    log.warn(`Realtime: Vermittlung fehlgeschlagen – ${result.reason}`);
    this.live.toolOutput(callId, TRANSFER_CALL_TOOL.name, `Vermittlung nicht möglich: ${result.reason}. Sag das dem Gesprächspartner in einem Satz und nenne ihm stattdessen die Rückrufnummer.`);
    this.live.respond();
    this.audioExpected(true, 'Vermittlung fehlgeschlagen');
  }

  /** Laufende KI-Ausgabe verwerfen und der API sagen, bis wohin das Gegenüber sie gehört hat. */
  private discardOutput(): void {
    this.stats.interruptions++;
    this.stats.discarded += this.outQueue.length;
    // Je Item in der Warteschlange: das gerade gespielte bis zur gehörten Stelle, noch nicht begonnene ab 0 ms
    for (const q of this.queuedItems) {
      this.live.truncate(q.id, q.id === this.playItemId ? this.playedMsForItem : 0);
    }
    this.queuedItems = [];
    this.outQueue = [];
    this.outRemainder = Buffer.alloc(0);
    this.pcmRemainder = new Int16Array(0);
    this.kiLive = '';
    this.playing = false;
    this.firstQueuedAt = 0;
  }

  /**
   * Entscheidung nach einer Unterbrechung: text = Transkription des Gegenübers (undefined = keine erhalten).
   * Geräusch oder Zuhör-Laut -> die KI spricht ihren Satz zu Ende, die Antwort auf den Laut entfällt.
   * Inhalt -> Rest verwerfen, die neue Antwort wird ausgespielt.
   */
  private resolveHold(text: string | undefined): void {
    const h = this.hold;
    if (!h) return;
    clearTimeout(h.timer);
    this.hold = undefined;
    if (this.closed) return;
    if (text !== undefined && isBackchannel(text)) {
      log.info(`Realtime: ${text.trim() ? `nur ein Zuhör-Laut („${text}")` : 'nur ein Geräusch, keine Sprache'} – KI spricht ihren Satz zu Ende (${this.outQueue.length * 20} ms)`);
      // Was das Modell auf den Laut hin sagen wollte, wird weder gesprochen noch im Verlauf behalten
      if (this.activeResponse) {
        this.muteNoiseResponse = true;
        this.live.cancelResponse();
      } else if (this.live.answersAfterInterrupt && h.midSentence) {
        // Die Antwort auf den Laut entsteht bei diesem Anbieter erst noch: die nächste, die gleich beginnt, bleibt stumm
        this.muteReplyUntil = Date.now() + NOISE_REPLY_MS;
      }
      for (const id of new Set([...h.held.map((x) => x.itemId), ...h.texts.map((x) => x.itemId)])) this.live.deleteItem(id);
      this.audioExpected(false);
      return;
    }
    log.info(`Realtime: Gegenüber hat etwas gesagt${text ? ` („${text.slice(0, 60)}")` : ' (keine Transkription)'} – verwerfe den Rest (${this.outQueue.length * 20} ms)`);
    this.discardOutput();
    for (const x of h.held) this.enqueueAudio(x.buf, x.itemId);
    for (const t of h.texts) this.opts.onTranscript({ speaker: 'ki', text: t.text, final: true, itemId: t.itemId });
  }

  private finishEndCall(): void {
    if (this.endRequested === undefined || this.closed || this.hangupTimer || this.farewellDecisionTimer) return;
    if (this.outQueue.length > 0) return; // noch Audio unterwegs – nextFrame ruft später erneut auf
    clearTimeout(this.endSafetyTimer);
    this.endSafetyTimer = undefined;
    const reason = this.endRequested;
    // Nachhörphase: Sagt das Gegenüber jetzt noch etwas, wird das Auflegen abgebrochen (siehe speech_started)
    log.info(`Realtime: Abschluss ausgespielt, lege in ${this.opts.hangupGraceMs} ms auf, falls das Gegenüber nichts mehr sagt`);
    this.hangupTimer = setTimeout(() => {
      this.hangupTimer = undefined;
      this.endRequested = undefined;
      this.opts.onEndCall(reason);
    }, this.opts.hangupGraceMs);
  }

  /**
   * Gegenüber spricht nach dem end_call noch. Auflegen pausieren und auf die Transkription warten:
   * reine Verabschiedung/Bestätigung („Okay, tschüss") -> sofort auflegen; Inhalt -> Gespräch geht weiter.
   */
  private onSpeechAfterGoodbye(itemId?: string): void {
    if (this.endRequested === undefined || this.farewellDecisionTimer) return;
    clearTimeout(this.hangupTimer);
    this.hangupTimer = undefined;
    // Neue Äußerung, neue Entscheidung: Nach einem früheren Geräusch darf die Antwort auf echte Sprache nicht stumm bleiben
    this.muteAfterGoodbye = false;
    this.farewellItemId = itemId;
    log.info('Realtime: Gegenüber spricht nach der Verabschiedung – warte auf Transkription');
    // Kommt keine Transkription, im Zweifel weitermachen statt jemandem ins Wort aufzulegen
    this.farewellDecisionTimer = setTimeout(() => this.decideAfterGoodbye(undefined), FAREWELL_DECISION_MS);
  }

  private decideAfterGoodbye(text: string | undefined): void {
    clearTimeout(this.farewellDecisionTimer);
    this.farewellDecisionTimer = undefined;
    if (this.endRequested === undefined || this.closed) return;
    if (text !== undefined && isFarewell(text)) {
      // Geräusch (leere Transkription) oder reine Verabschiedung: Der Abschiedssatz wird zu Ende gesprochen, dann wird aufgelegt
      log.info(text.trim() ? `Realtime: Gegenüber verabschiedet sich („${text}") – lege nach dem Abschiedssatz auf` : 'Realtime: nur ein Geräusch, keine Sprache – Verabschiedung läuft weiter');
      // Was die KI auf das Geräusch hin sagen wollte, bleibt stumm
      this.heldAudio = [];
      this.muteAfterGoodbye = true;
      // Nur die Antwort auf das Geräusch abbrechen – läuft noch die Verabschiedung selbst, bleibt sie unangetastet
      if (this.activeResponse && this.goodbye === 'done') this.live.cancelResponse();
      if (this.goodbye === 'done') this.finishEndCall();
      return;
    }
    this.cancelHangup();
  }

  /**
   * Gegenüber hat nach dem end_call noch etwas Inhaltliches gesagt: Beenden komplett zurücknehmen,
   * das Gespräch läuft weiter. Das Modell kann später erneut end_call aufrufen.
   */
  private cancelHangup(): void {
    if (this.endRequested === undefined) return;
    clearTimeout(this.hangupTimer);
    this.hangupTimer = undefined;
    clearTimeout(this.farewellDecisionTimer);
    this.farewellDecisionTimer = undefined;
    clearTimeout(this.endSafetyTimer);
    this.endSafetyTimer = undefined;
    this.endRequested = undefined;
    this.goodbye = 'none';
    this.goodbyeResponseId = undefined;
    this.muteAfterGoodbye = false;
    // Zurückgehaltene Antwort auf das Gesagte jetzt ausspielen
    for (const x of this.heldAudio) this.enqueueAudio(x.buf, x.itemId);
    this.heldAudio = [];
    log.info('Realtime: Gegenüber spricht noch – Auflegen abgebrochen, Gespräch geht weiter');
    this.opts.onTranscript({ speaker: 'system', text: 'Gegenüber hat noch etwas gesagt – Gespräch geht weiter', final: true });
    // Dem Modell den Zustandswechsel klar machen, sonst hängt es in der "ich beende jetzt"-Haltung fest
    this.live.note('Das Gegenüber hat nach deiner Verabschiedung noch etwas gesagt. Das Gespräch läuft ganz normal weiter: Geh auf das Gesagte ein, als wäre nichts beendet worden. Wenn danach alles geklärt ist, rufe erneut end_call auf (ohne dich vorher zu verabschieden).');
  }

  private addUsage(u: Usage): void {
    for (const k of Object.keys(this.usage) as (keyof Usage)[]) this.usage[k] += u[k];
    this.opts.onUsage({ ...this.usage });
  }
}
