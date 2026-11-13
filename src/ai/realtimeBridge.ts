// Brücke zwischen Telefon-Audio (PCM16, 8 oder 16 kHz) und dem Live-Sprachmodell eines KI-Anbieters.
// Hier steckt die anbieterunabhängige Gesprächslogik: Begrüßung, Unterbrechung prüfen, Wächter gegen Stille,
// Verabschiedung und Auflegen, Transkript, Tool-Aufrufe. Das Protokoll des Anbieters (OpenAI Realtime, Gemini Live)
// übersetzt eine LiveSession aus ai/providers; zwischen Telefon und deren Abtastrate wird resampelt.
import type WebSocket from 'ws';
import type { AudioHandler } from '../callManager.js';
import { log } from '../log.js';
import { Resampler } from '../rtp/resample.js';
import { samplesPerFrame } from '../rtp/session.js';
import { isBackchannel, isEcho, isFarewell } from './farewell.js';
import { directorNote, END_CALL_AFTER_SILENCE_OPEN, endCallOpenNote, endCallResumeNote, OUTCOME_PREFIX, type CallJudge } from './judge.js';
import { AI_INTRO_CUT, AI_INTRO_MISSING, AI_INTRO_WORD, END_CALL_AFTER_SILENCE, END_CALL_AFTER_SILENCE_CHECK, END_CALL_TOOL, END_CALL_WHILE_SPEAKING, endCallWhileSpeakingCheck, TRANSFER_CALL_TOOL, endCallCheckInstruction, farewellInstruction } from './personas.js';
import { ASK_INSTEAD, dodgesAgentQuestion, endCallOpenDirective, AGENT_END_NOTE, AGENT_END_WITHDRAWN, ASK_NO_ANSWER, INTERRUPTED_ANSWER, INTERRUPTED_DIRECTIVE, RESUME_FOR_DIRECTIVE, ASK_PRINCIPAL_TOOL, ASK_REPLACED, ASK_TIMEOUT_MS, agentNote, askAnswer } from './agentCall.js';
import { isLimitError } from './limits.js';
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
  /** true = die erste Antwort muss erkennen lassen, dass eine KI spricht; fehlt das oder wird sie abgeschnitten, holt die KI es nach */
  requireAiIntro?: boolean;
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
  /** Name, unter dem sich der Agent meldet (z. B. „Codex“): Fragen nach ihm sind Fragen zum Anruf */
  agentName?: string;
  onError: (message: string) => void;
  /** Gespräch ist angenommen (z. B. Start des Spam-Zeitlimits) */
  onConnected?: () => void;
  /** Nur für Tests: liefert statt der Verbindung zum Anbieter einen nachgestellten WebSocket */
  createSocket?: (url: string) => WebSocket;
  /** Baut die Live-Verbindung des gewählten Anbieters auf; ohne Angabe OpenAI Realtime */
  createLive?: (config: LiveConfig, events: LiveEvents) => LiveSession;
  /** Ausweich-Sprachmodelle: Lehnt der Anbieter die Sitzung vor ihrer Bestätigung wegen eines Limits ab, wird mit dem nächsten neu aufgebaut */
  fallbackModels?: readonly string[];
  /** Die Sitzung läuft jetzt mit diesem Ausweichmodell (für Protokoll und Kosten) */
  onModel?: (model: string) => void;
  /**
   * Das Textmodell entscheidet mit (siehe ai/judge.ts): Auflegen oder weiter nach der Verabschiedung (ohne Urteil in der
   * Frist entscheidet die Wortliste) und Auftrag erledigt beim end_call (läuft neben der Verabschiedung her und nimmt das
   * Auflegen zurück, wenn etwas fehlt; die Selbstprüfung der Sprach-KI gegen den Plan entfällt dann).
   */
  judge?: CallJudge;
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
/** Nach einer nachgeholten Begrüßung: Eine Antwort, die so kurz danach von selbst beginnt, ist die zweite Antwort auf denselben Anfang */
const DUP_AFTER_GREETING_MS = 1500;
const MUTED_AFTER_REJECT = 'nach abgelehntem end_call';
/** Ab so viel verworfenem Audio gilt eine Antwort als abgeschnitten (darunter fehlt höchstens ein Wort) */
const INTERRUPT_NOTE_MS = 1000;
const CAUSE_AGENT_SAY = 'Regieanweisung des Agenten';
const CAUSE_ASK_ANSWER = 'Antwort auf die Rückfrage';
const CAUSE_ASK_NUDGE = 'Rückfrage nachholen';
/** So oft je Gespräch wird die KI daran erinnert, beim Agenten nachzufragen, statt „weiß ich nicht" zu sagen */
const ASK_NUDGE_MAX = 2;
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
/** Sprache nach der Verabschiedung: so lange nach dem Ende der Äußerung wird auf die Transkription gewartet (solange das Gegenüber spricht, läuft die Frist nicht ab) */
const FAREWELL_DECISION_MS = 4000;
/**
 * Harte Obergrenze der Endphase: So lange nach dem angenommenen end_call wird spätestens aufgelegt, was auch geschieht (Sprache ohne Ende,
 * flatternde Spracherkennung, ausbleibende Mitschriften, ein wartendes Textmodell, eine Nachhörphase, die immer wieder neu beginnt).
 * Nur das Zurücknehmen des Beendens und das Auflegen selbst stoppen sie (siehe armEndDeadline).
 */
const END_PHASE_MAX_MS = 60_000;
/** end_call ohne Sprache: so lange wartet die Prüfung auf die Mitschrift einer Äußerung des Gegenübers, die schon begann (OpenAI liefert sie oft erst, wenn die KI schon antwortet) */
const TRANSCRIPT_WAIT_MS = 1500;
// Fristen für das Textmodell (siehe opts.judge); danach entscheidet die Regel
// (Gemessen braucht ein Textmodell für so eine Frage rund 2 s, mit Ausreißern. Deshalb entscheidet es nur dort, wo das
// Gespräch diese Zeit hat. Unterbrechungen mitten im Satz bleiben bei der Wortliste: Dort wäre jede Sekunde als Pause zu hören.)
/** Nach der Verabschiedung: Hier ist Zeit, das Auflegen wartet ohnehin */
const JUDGE_FAREWELL_MS = 4000;
/**
 * end_call: Die Prüfung läuft neben der Verabschiedung her. So lange nach dem end_call wartet das Auflegen höchstens auf ihr
 * Urteil; meist ist es da, bevor Abschiedssatz und Nachhörphase vorbei sind (zusammen sechs bis acht Sekunden; im Simulator
 * brauchte die Prüfung meist drei bis vier, vereinzelt acht).
 */
const JUDGE_END_MS = 8000;
/** end_call mit Sprache: Das Gegenüber ist ohnehin erst dran, die Prüfung läuft nebenher */
const JUDGE_END_LATER_MS = 8000;

const STALL_INSTRUCTION =
  'Es ist still geworden: Du hast zuletzt gesprochen, und das Gegenüber hat seitdem nichts gesagt. Habt ihr euch schon verabschiedet oder ist aus deiner Sicht alles gesagt, dann frag nicht weiter nach, sondern rufe end_call auf. Hast du etwas angekündigt („einen Moment", „ich halte das fest") oder eine Frage vorbereitet, dann stell diese Frage jetzt direkt. Sonst knüpf in einem kurzen Satz an das zuletzt Gesagte an (eine kleine Nachfrage dazu); nur wenn dazu nichts passt, frag, ob das Gegenüber noch dran ist. Ein Satz, dann warten.';

/** Das Gegenüber war hörbar, aber die Spracherkennung des Anbieters hat keine Worte gemeldet (Lachen, Räuspern, ein Laut). */
const SOUND_REACTION =
  'Hinweis der Telefon-App: Das Gegenüber hat gerade hörbar reagiert, aber ohne Worte – zum Beispiel mit einem Lachen, einem Räuspern oder einem anderen Laut. Konntest du hören, was es war, geh in einem kurzen Satz natürlich darauf ein (bei einem Lachen freust du dich mit) und mach dann mit dem Gespräch weiter. Frag nicht, ob es noch dran ist. Ein Satz, dann warten.';
/** Ab diesem Pegel (Effektivwert, 16 Bit) gilt das Audio des Gegenübers als hörbarer Laut; Leitungsrauschen liegt weit darunter */
const SOUND_RMS = 700;
/** So lange nach dem letzten lauten Stück gilt das Gegenüber noch als „redet gerade" */
const HEARD_RECENT_MS = 2500;
/** Ablehnung der Angabe, dass die KI auf Tool-Ergebnisse wartet (kennen nicht alle Modelle) */
const TOOL_BEHAVIOR_REJECTED = /BLOCKING function calls are not supported/i;
/** So viel Laut muss zusammenkommen, damit es mehr ist als ein Knacken */
const SOUND_MIN_MS = 350;
/** So lange muss es danach wieder ruhig sein, bevor die KI darauf eingeht (der Laut ist dann zu Ende) */
const SOUND_QUIET_MS = 1200;
/** So lange nach der eigenen Ausgabe zählt nichts: Das wäre das Echo der KI */
const SOUND_ECHO_GUARD_MS = 400;
/** War das Gegenüber in dieser Zeit vor dem Stillstand noch zu hören, wartet der Wächter weiter (höchstens zweimal) */
const STALL_SOUND_MS = 2500;

export class RealtimeBridge implements AudioHandler {
  private live: LiveSession;
  /** Baut eine Sitzung mit dem genannten Modell auf (auch erneut, mit einem Ausweichmodell) */
  private connectLive: (model: string) => LiveSession;
  private fallbackModels: string[];
  private primaryModel = '';
  private currentModel = '';
  /** Die laufende Sitzung ist schon ein Ausweichmodell */
  private onFallback = false;
  private primaryRetried = false;
  /** Tools ohne die Angabe zum Ablauf anmelden (das laufende Modell lehnt sie ab) */
  private plainTools = false;
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
  /** Sicherheitsnetz: Bleibt die Verabschiedung selbst aus (kein Abschluss, kein Audio), wird nach 30 s so getan, als wäre sie ausgespielt */
  private endSafetyTimer?: NodeJS.Timeout;
  /** Harte Obergrenze der Endphase (END_PHASE_MAX_MS ab dem angenommenen end_call): Danach wird aufgelegt, egal was sonst noch läuft */
  private endDeadline?: NodeJS.Timeout;
  // Schritte des Gesprächsplans; der erste end_call wird damit zur Selbstprüfung zurückgegeben
  private planSteps: string[] = [];
  private endCallChecked = false;
  // Nach einem abgelehnten end_call (Sprache + Tool): Schweigt das Gegenüber, muss die KI selbst wieder dran
  private rejectTimer?: NodeJS.Timeout;
  /** Nach einem abgelehnten end_call soll die KI schweigen: Was sie von sich aus nachschiebt, bleibt stumm, bis das Gegenüber spricht, die Schweigefrist abläuft, sie ein Tool aufruft, der Agent etwas vorgibt (agentSay) oder das Beenden verlangt (agentEnd) oder ein end_call angenommen wird */
  private muteAfterReject = false;
  /** Die laufende Antwort ist so ein Nachschub; mutedBytes zählt ihr verworfenes Audio (PCM16 in der Rate des Anbieters) */
  private mutedResponse = false;
  private mutedBytes = 0;
  private mutedWhy = '';
  /** Audio der stummen Antwort: Stellt sich heraus, dass das Gegenüber doch gesprochen hat, wird es nachgereicht */
  private mutedHeld: { itemId: string; buf: Buffer }[] = [];
  /**
   * Nachgeholte Begrüßung (siehe lateGreeting): Kommt die Mitschrift des vermeintlichen Geräuschs doch noch, hat das Modell
   * zwei Auslöser und antwortet zweimal. 'greeting' = die Begrüßung ist angefordert oder läuft, 'after' = sie ist fertig;
   * eine Antwort, die bis dupGuardUntil von selbst beginnt, ohne dass das Gegenüber seit Beginn der Begrüßung sprach, bleibt stumm.
   */
  private dupGuard: 'off' | 'greeting' | 'after' = 'off';
  private dupGreetingStarted = false;
  private dupGuardUntil = 0;
  /** Zeitpunkt eines Unterlaufs mitten in einer Antwort, bis die Ausgabe wieder läuft */
  private underrunAt = 0;
  /** Hinweis auf eine abgeschnittene Antwort, der erst nach ihrem Text ins Transkript kommt */
  private interruptNotes: string[] = [];
  private underrunPlayedMs = 0;
  // Messpunkte je Antwort: kam eine Mitschrift, und was hat die Antwort ausgelöst
  private responseHadText = false;
  private lastCause = '';
  /** Auslöser der zuletzt begonnenen Antwort (ihr Audio liegt als Letztes in der Warteschlange) */
  private responseCause = '';
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
  private stats = { underruns: 0, maxQueue: 0, framesPlayed: 0, interruptions: 0, discarded: 0, firstDeltaAt: 0, firstDeltaMs: 0, deltas: 0 };
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
  private hold?: {
    timer: NodeJS.Timeout;
    itemId?: string;
    /** die KI sprach noch einen längeren Rest oder wurde mitten in der Antwort unterbrochen */
    midSentence?: boolean;
    /** die Antwort, die gerade gesprochen wird, entsteht noch: Ihr weiteres Audio gehört in die Warteschlange, nicht zu held */
    spokenActive: boolean;
    /** was die KI in dieser Antwort bis hierher gesagt hat (für die Echo-Prüfung) */
    spoken: string;
    held: { itemId: string; buf: Buffer }[];
    texts: { itemId: string; text: string }[];
  };
  /** Text und Kennung der zuletzt fertig gemeldeten Antwort der KI */
  private lastAiText = '';
  private lastAiItem = '';
  /** Letzte Äußerung des Gegenübers, und die, zu der die Rückfrage an den Agenten schon gestellt oder angemahnt ist */
  private lastPartnerText = '';
  private askHandledFor = '';
  /** Vorgaben des Agenten, die während einer offenen Rückfrage kamen, ohne ihre Antwort zu sein */
  private afterAsk: string[] = [];
  /**
   * Vorgabe des Agenten, für die die KI noch nicht eigens gesprochen hat (sie kam, während das Gegenüber sprach, beim
   * Beenden oder nur „zum Merken"): Das Modell setzt sie nicht zuverlässig um. Ein end_call davor wird einmal abgelehnt.
   */
  private openDirective?: string;
  private directiveGateUsed = false;
  /** Das Gegenüber sprach, als die Vorgabe kam: Die nächste Antwort der KI gilt dann ihm, nicht der Vorgabe */
  private directiveContested = false;
  /** Die Antwort, die beim Eintreffen der Vorgabe schon lief, kennt sie nicht */
  private directiveSkipResponse = false;
  private lastRemoteAt = 0;
  private askNudges = 0;
  // Vorstellung als KI: geprüft an der Mitschrift der ersten Antwort
  private introChecked = false;
  private introItem = '';
  private lastCutItem = '';
  // Laute ohne Worte (Lachen, Räuspern): Die Spracherkennung des Anbieters meldet sie nicht, die App hört am Pegel mit
  private lastAiFrameAt = 0;
  private lastLoudAt = 0;
  /** Zuletzt war das Gegenüber am Pegel zu hören – auch während der Anbieter Sprache meldet */
  private lastHeardAt = 0;
  private soundMs = 0;
  private soundPeak = 0;
  private soundNudges = 0;
  private stallDeferred = 0;
  /** true = die Antwort auf ein bloßes Geräusch bleibt stumm (bis sie fertig ist oder das Gegenüber wieder spricht) */
  private muteNoiseResponse = false;
  /** Bis zu diesem Zeitpunkt gilt eine neu beginnende Antwort als Antwort auf einen bloßen Zuhör-Laut und bleibt stumm (0 = aus) */
  private muteReplyUntil = 0;
  /** Wie die letzte Antwort endete ('cancelled' = das Gegenüber hat sie unterbrochen) */
  private lastResponseStatus?: string;
  /**
   * Äußerungen des Gegenübers (Items), die nach der Verabschiedung begannen (oder beim end_call noch liefen) und deren Mitschrift noch fehlt,
   * in der Reihenfolge ihres Beginns (undefined = Anbieter nennt keine Kennung). Solange eine fehlt, wird nicht aufgelegt: Sie könnte der Anlass sein, weiterzureden.
   */
  private farewellOpen: (string | undefined)[] = [];
  /** Kennung der Äußerung, die das Gegenüber gerade spricht (gilt, solange partnerSpeaking gesetzt ist; undefined = Anbieter nennt keine) */
  private partnerItem?: string;
  /** Äußerungen des Gegenübers (zu jeder Zeit), die begonnen haben und deren Mitschrift noch fehlt; Objekte, weil der Anbieter keine Kennung nennen muss */
  private awaitedTranscripts: { id?: string }[] = [];
  /** Wer auf Mitschriften wartet (siehe untilTranscribed), erfährt von jeder neuen */
  private transcriptListeners = new Set<() => void>();
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
  /** Die Prüfung beim end_call läuft noch (Textmodell, neben der Verabschiedung her): Das Auflegen wartet auf ihr Urteil */
  private endCheck?: NodeJS.Timeout;
  /** Die Prüfung nebenher (end_call mit Sprache) hat offene Punkte gemeldet; turns = Stand der Äußerungen des Gegenübers, auf dem das beruht */
  private endOpenFound?: { open: string[]; turns: number };
  /** Prüfung, die nach einem end_call mit Sprache nebenher läuft; ein neuer end_call ersetzt sie durch eine frische */
  private endCheckLater?: NodeJS.Timeout;
  /** Wie oft das Gegenüber angesetzt bzw. etwas Fertiges gesagt hat: Eine Prüfung, die davor begann, kennt die Antwort nicht */
  private partnerTurns = 0;
  /** Der Agent hat das Beenden verlangt: Das Textmodell prüft es nicht und nimmt es nicht zurück */
  private endByAgent = false;
  /** Die KI hat die Aufforderung des Agenten zu beenden (AGENT_END_NOTE) wirklich bekommen: Nur dann braucht sie den Widerruf, wenn er es zurücknimmt */
  private agentEndNoted = false;
  /** Worte nach der Verabschiedung, über die das Textmodell gerade urteilt (undefined = es urteilt nicht) */
  private farewellJudging?: string;
  /** Worte nach der Verabschiedung, die noch nicht entschieden sind, weil das Gegenüber weiterredet: zählen mit der nächsten Äußerung zusammen ('' = ein Geräusch) */
  private farewellPrior?: string;
  private lastPartnerAt = 0;

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
      // (ohne Audio vom Telefon gibt es keinen Pegel: Dann gilt die feste Frist des Anbieters)
      partnerAudible: () => (Date.now() - this.lastRemoteAt > 1000 ? undefined : this.lastHeardAt > 0 && Date.now() - this.lastHeardAt < HEARD_RECENT_MS),
    };
    const events: LiveEvents = {
      open: () => log.info(`Realtime: verbunden (${config.model})`),
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
    this.fallbackModels = [...(opts.fallbackModels ?? [])];
    this.primaryModel = opts.model;
    this.connectLive = (model) => {
      config.model = model;
      config.plainTools = this.plainTools;
      this.currentModel = model;
      // Die Anweisungen können sich bis hierher geändert haben (Gesprächsplan)
      config.instructions = this.opts.instructions;
      // Meldungen einer abgelösten Sitzung (ihr „geschlossen“ nach dem Wechsel) gehen niemanden mehr an
      const own: LiveEvents = {
        ...events,
        socketError: (message) => { if (session === this.live && !this.switchModel(message)) events.socketError(message); },
        closed: (code, reason) => { if (session === this.live && !this.switchModel(`${code} ${reason}`)) events.closed(code, reason); },
      };
      const session: LiveSession = opts.createLive ? opts.createLive({ ...config }, own) : new OpenAiLive({ ...config }, own);
      return session;
    };
    this.live = this.connectLive(opts.model);
    this.toAi = new Resampler(8000, this.live.inputRate);
    this.fromAi = new Resampler(this.live.outputRate, 8000);
  }

  /**
   * Der Anbieter hat die Sitzung abgelehnt oder geschlossen, bevor sie stand: neu aufbauen, solange es einen Weg gibt.
   * Liefert false, wenn das nicht geht – dann gilt der Fehler. Die Wege der Reihe nach:
   * - Das Modell lehnt die Angabe zum Ablauf der Tools ab: dasselbe Modell ohne sie.
   * - Das Hauptmodell meldet ein Limit (Kontingent, Überlast): das nächste Ausweichmodell. Ein Ausweichmodell, das
   *   scheitert, macht dem nächsten Platz, gleich aus welchem Grund – es darf den Anruf nicht kosten.
   * - Kein Ausweichmodell mehr: einmal noch das Hauptmodell (ein Limit ist oft nach einem Augenblick vorbei).
   * Nach der Bestätigung der Sitzung wird nicht mehr gewechselt: Das Gespräch hinge am alten Verlauf.
   */
  private switchModel(reason: string): boolean {
    if (this.closed || this.ready) return false;
    let next: string;
    let how: string;
    if (!this.plainTools && TOOL_BEHAVIOR_REJECTED.test(reason)) {
      this.plainTools = true;
      next = this.currentModel;
      how = `baue sie mit ${next} ohne die Angabe zum Ablauf der Tools neu auf`;
    } else if (!this.onFallback && !isLimitError(reason)) {
      return false;
    } else if (this.fallbackModels.length) {
      next = this.fallbackModels.shift()!;
      this.onFallback = true;
      this.plainTools = false;
      how = `baue sie mit dem Ausweichmodell ${next} neu auf`;
    } else if (this.onFallback && !this.primaryRetried) {
      this.primaryRetried = true;
      this.plainTools = false;
      next = this.primaryModel;
      how = `kein weiteres Ausweichmodell, versuche es noch einmal mit ${next}`;
    } else {
      return false;
    }
    log.warn(`Realtime: ${this.live.label} lehnt die Sitzung ab (${reason.replace(/\s+/g, ' ').slice(0, 80)}) – ${how}`);
    const old = this.live;
    this.live = this.connectLive(next);
    try {
      old.close();
    } catch {
      /* war schon zu */
    }
    this.opts.onModel?.(next);
    return true;
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
    this.lastRemoteAt = Date.now();
    this.listenForSound(pcm);
    const out = this.toAi.process(pcm);
    if (out.length === 0) return;
    this.live.sendAudio(out);
  }

  /**
   * Pegel des Gegenübers mithören: Ein deutlicher Laut, den der Anbieter nicht als Sprache meldet (Lachen nach einem Witz),
   * ist trotzdem eine Reaktion. Ist er vorbei, bekommt die KI einen Hinweis, statt sechs Sekunden später „Bist du noch dran?" zu fragen.
   */
  private listenForSound(pcm: Int16Array): void {
    const now = Date.now();
    const echo = this.playing || now - this.lastAiFrameAt < SOUND_ECHO_GUARD_MS;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    if (!echo && rms >= SOUND_RMS) this.lastHeardAt = now;
    // Solange die KI spricht (und kurz danach) oder der Anbieter Sprache meldet bzw. schon antwortet, ist nichts zu tun
    if (echo || this.partnerSpeaking || this.activeResponse) {
      this.soundMs = 0;
      this.soundPeak = 0;
      return;
    }
    if (rms >= SOUND_RMS) {
      this.soundMs += pcm.length / (this.callRate / 1000);
      this.soundPeak = Math.max(this.soundPeak, rms);
      this.lastLoudAt = now;
      return;
    }
    if (this.soundMs === 0 || now - this.lastLoudAt < SOUND_QUIET_MS) return;
    const ms = Math.round(this.soundMs);
    const peak = Math.round(this.soundPeak);
    this.soundMs = 0;
    this.soundPeak = 0;
    if (ms < SOUND_MIN_MS) return;
    if (this.closed || !this.greeted || this.opts.scam || this.hold || this.ask || this.transferring || this.rejectTimer || this.followUpTimer || this.awaitingAudioSince) return;
    if (this.goodbye !== 'none' || this.endRequested !== undefined || this.soundNudges >= 2) return;
    this.soundNudges++;
    log.info(`Realtime: Laut ohne Worte vom Gegenüber (${ms} ms, Pegel ${peak}) – KI soll darauf eingehen`);
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.pendingRespond = false;
    this.event('Das Gegenüber war zu hören, aber ohne Worte (Lachen, Räuspern, ein Laut) – die KI soll darauf eingehen');
    this.live.respond(SOUND_REACTION);
    this.audioExpected(true, 'Laut ohne Worte');
  }

  nextFrame(): Int16Array | undefined {
    if (this.hold) return undefined;
    if (!this.playing) {
      const waited = this.firstQueuedAt ? Date.now() - this.firstQueuedAt : 0;
      if (this.outQueue.length >= PREBUFFER_FRAMES || (this.outQueue.length > 0 && waited >= PREBUFFER_MAX_WAIT_MS)) {
        this.playing = true;
        if (this.underrunAt) {
          // Erst jetzt steht fest, dass es ein Aussetzer war und kein Satzende: Es kam noch Audio derselben Antwort nach
          log.warn(`Realtime: Aussetzer mitten in der Antwort – Puffer leer nach ${this.underrunPlayedMs} ms, Lücke ${Date.now() - this.underrunAt} ms, erstes Stück hatte ${this.stats.firstDeltaMs} ms`);
          this.underrunAt = 0;
        }
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
      // Die Antwort entsteht noch (und ist zu hören): möglicherweise ein Aussetzer. Gemeldet wird er erst, wenn Audio nachkommt
      if (this.activeResponse && !this.mutedResponse && !this.underrunAt) {
        this.underrunAt = Date.now();
        this.underrunPlayedMs = this.stats.framesPlayed * 20;
      }
      if (this.endRequested !== undefined && this.goodbye === 'done' && this.connected) this.finishEndCall();
      this.armStall();
      return undefined;
    }
    this.stats.framesPlayed++;
    this.lastAiFrameAt = Date.now();
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
    clearTimeout(this.endDeadline);
    clearTimeout(this.farewellDecisionTimer);
    clearTimeout(this.rejectTimer);
    clearTimeout(this.audioWatchdog);
    clearTimeout(this.followUpTimer);
    clearTimeout(this.stallTimer);
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = undefined;
    if (this.ask) clearTimeout(this.ask.timer);
    this.ask = undefined;
    clearTimeout(this.endCheck);
    this.endCheck = undefined;
    clearTimeout(this.endCheckLater);
    this.endCheckLater = undefined;
    this.farewellJudging = undefined;
  }

  /** Ereignis der App ins Transkript: Das lesen der Betreiber, das Textmodell und bei Agenten-Anrufen der Agent mit. */
  private event(text: string): void {
    this.opts.onTranscript({ speaker: 'system', text, final: true });
  }

  /**
   * Frage ans Textmodell mit Frist. Kommt das Urteil rechtzeitig, gilt es; bei Fehler oder nach `ms` wird `decide`
   * ohne Urteil aufgerufen, dann entscheidet die Regel. Die Rückgabe ist der Frist-Timer: Wer ihn ablegt und später
   * ersetzt oder löscht, macht die Frage damit ungültig (`current` prüft das).
   */
  private askJudge<T>(what: string, question: Promise<T>, ms: number, current: (timer: NodeJS.Timeout) => boolean, decide: (verdict: T | undefined) => void): NodeJS.Timeout {
    const started = Date.now();
    const timer: NodeJS.Timeout = setTimeout(() => {
      if (this.closed || !current(timer)) return;
      log.warn(`Realtime: Textmodell (${what}) antwortet nicht in ${ms} ms – die Regel entscheidet`);
      decide(undefined);
    }, ms);
    timer.unref();
    question.then(
      (verdict) => {
        if (this.closed || !current(timer)) return;
        clearTimeout(timer);
        log.info(`Realtime: Textmodell (${what}) nach ${Date.now() - started} ms: ${Array.isArray(verdict) ? `${verdict.length} offen` : String(verdict)}`);
        decide(verdict);
      },
      (err: unknown) => {
        if (this.closed || !current(timer)) return;
        clearTimeout(timer);
        log.warn(`Realtime: Textmodell (${what}) fehlgeschlagen (${String((err as Error)?.message ?? err).slice(0, 120)}) – die Regel entscheidet`);
        decide(undefined);
      },
    );
    return timer;
  }

  /** Lage im Gespräch in einem Satz: für die Regie im Hintergrund und für den Agenten (wait_for_events). */
  situation(): string {
    if (this.closed) return 'Gespräch beendet';
    if (!this.connected) return 'noch nicht verbunden';
    if (this.endRequested !== undefined || this.goodbye !== 'none') return 'die KI verabschiedet sich und legt gleich auf';
    if (this.ask) return 'die KI wartet auf die Antwort des Agenten (Rückfrage), das Gegenüber wartet';
    if (this.transferring) return 'Vermittlung läuft';
    if (this.partnerSpeaking) return 'das Gegenüber spricht gerade';
    if (this.playing || this.outQueue.length > 0 || this.activeResponse) return 'die KI spricht gerade';
    const last = Math.max(this.lastAiFrameAt, this.lastPartnerAt);
    if (!last) return 'verbunden, noch hat niemand gesprochen';
    return `Stille seit ${Math.round((Date.now() - last) / 1000)} s; zuletzt sprach ${this.lastAiFrameAt >= this.lastPartnerAt ? 'die KI' : 'das Gegenüber'}`;
  }

  /**
   * Hinweis der Regie im Hintergrund (Textmodell) an die Sprach-KI. Er fordert keine Antwort an: Die KI setzt ihn um,
   * wenn sie das nächste Mal spricht. Liefert false, wenn er nicht mehr ankommt (Gespräch endet, Spam-Abwehr).
   */
  directorHint(text: string): boolean {
    if (this.closed || !this.connected || this.opts.scam || this.endRequested !== undefined || this.goodbye !== 'none') return false;
    this.live.note(directorNote(text));
    this.event(`Hinweis der Regie an die KI: ${text}`);
    return true;
  }

  // ---- Steuerung durch einen KI-Agenten (MCP) ----

  /**
   * Der Agent gibt vor, was dem Gegenüber gesagt werden soll. Wartet die KI auf die Antwort einer Rückfrage, ist das
   * die Antwort; sonst kommt der Text als Regieanweisung in den Gesprächsverlauf. `now` fordert sofort eine Antwort an
   * (bzw. gleich nach der laufenden); ohne `now` setzt die KI die Anweisung um, wenn sie das nächste Mal spricht.
   */
  agentSay(text: string, now = false, answer = true): 'answered' | 'now' | 'next' | 'resumed' | 'ending' | 'closed' {
    if (this.closed) return 'closed';
    // Die Vorgabe kommt in der Schweigefrist nach einem abgelehnten end_call: Die Frist gilt nicht mehr. Kein Anstoß „sagt nichts mehr, rufe end_call auf“
    // (die KI beendete sonst ohne die Vorgabe), und was die KI auf die Vorgabe hin sagt, ist zu hören und steht im Transkript
    const rejectOpen = this.rejectTimer !== undefined;
    this.endRejectWindow();
    if (this.endRequested !== undefined) {
      // Das Beenden läuft schon (Verabschiedung angefordert, gesprochen oder ausgespielt), aufgelegt ist noch nicht:
      // Eine Vorgabe des Agenten (meist eine Richtigstellung) geht vor
      this.cancelHangup('agent');
      this.live.note(agentNote(text));
      this.noteDirective(text);
      this.requestRespond(CAUSE_AGENT_SAY);
      return 'resumed';
    }
    if (this.goodbye !== 'none') return 'ending';
    // Der Agent hat das Beenden verlangt, die KI aber noch nicht end_call aufgerufen, und gibt jetzt etwas anderes vor: Das Beenden gilt nicht mehr,
    // der nächste end_call der KI wird wie jeder andere geprüft (wie bei einer Vorgabe während des Beendens, siehe cancelHangup).
    // Die KI erfährt es auch: Sonst beendet sie nur wegen der alten Aufforderung (AGENT_END_NOTE steht noch in ihrem Verlauf).
    // Hat sie die Aufforderung nie bekommen (agentEnd kam, als sie sich schon verabschiedete), gibt es nichts zu widerrufen
    const withdrawn = this.endByAgent;
    if (withdrawn) {
      this.endByAgent = false;
      this.endCallChecked = false;
    }
    const tell = withdrawn && this.agentEndNoted;
    this.agentEndNoted = false;
    if (this.ask && !answer) {
      // Der Agent kennt die Rückfrage noch nicht (seine Vorgabe und sie haben sich gekreuzt): Die Vorgabe ist keine Antwort
      // darauf. Sie geht mit dem Ergebnis der Rückfrage an die KI – ein Hinweis dazwischen stört einen Anbieter, der darauf wartet
      this.afterAsk.push(...(tell ? [AGENT_END_WITHDRAWN] : []), agentNote(text));
      this.noteDirective(text);
      return 'next';
    }
    if (this.ask) {
      // (Eine offene Rückfrage hat ein Tool-Ergebnis zu bekommen, kein Hinweis dazwischen: Der Widerruf geht mit der Antwort)
      this.resolveAsk(tell ? `${AGENT_END_WITHDRAWN}\n${askAnswer(text)}` : askAnswer(text));
      return 'answered';
    }
    if (tell) this.live.note(AGENT_END_WITHDRAWN);
    this.live.note(agentNote(text));
    this.noteDirective(text);
    if (!now) {
      // (Der Stillstandswächter war wegen der Schweigefrist nicht scharf: Ohne ihn bliebe die Vorgabe liegen, bis das Gegenüber etwas sagt)
      if (rejectOpen) this.armStall();
      return 'next';
    }
    this.requestRespond(CAUSE_AGENT_SAY);
    return 'now';
  }

  /**
   * Die Schweigefrist nach einem abgelehnten end_call ist vorbei, weil das Gespräch anders weitergeht (Vorgabe des Agenten, angenommener end_call):
   * kein Anstoß „sagt nichts mehr“ mehr, und die Antwort der KI bleibt nicht stumm.
   */
  private endRejectWindow(): void {
    clearTimeout(this.rejectTimer);
    this.rejectTimer = undefined;
    this.muteAfterReject = false;
  }

  /** Der Agent möchte das Gespräch höflich beenden: Die KI ruft end_call auf und verabschiedet sich wie sonst auch. */
  agentEnd(): 'ending' | 'closed' {
    if (this.closed) return 'closed';
    // Das Beenden löst die Schweigefrist eines abgelehnten end_call ab (wie eine Vorgabe, siehe agentSay): Die Antwort der KI darauf bleibt nicht stumm
    this.endRejectWindow();
    // Der Auftraggeber beendet: Die Selbstprüfung gegen den Gesprächsplan („sprich fehlende Schritte jetzt aus“) entfällt,
    // und das Textmodell prüft nicht nach (auch keine Prüfung, die nebenher oder neben der Verabschiedung noch läuft: Ihr Urteil verfällt).
    // Das gilt auch, wenn die KI sich schon von selbst verabschiedet: Der Wunsch des Agenten geht vor, die Prüfung nähme ihn sonst zurück
    this.endCallChecked = true;
    this.endByAgent = true;
    clearTimeout(this.endCheckLater);
    this.endCheckLater = undefined;
    clearTimeout(this.endCheck);
    this.endCheck = undefined;
    this.endOpenFound = undefined;
    if (this.endRequested !== undefined || this.goodbye !== 'none') return 'ending';
    // (Nur ab hier hat die KI die Aufforderung im Verlauf, siehe agentSay)
    this.agentEndNoted = true;
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
    const extra = this.afterAsk.splice(0);
    this.live.toolOutput(ask.callId, ASK_PRINCIPAL_TOOL.name, [output, ...extra].join('\n\n'));
    this.requestRespond(CAUSE_ASK_ANSWER);
  }

  private noteDirective(text: string): void {
    this.directiveContested = (this.openDirective !== undefined && this.directiveContested) || this.partnerSpeaking;
    this.directiveSkipResponse = this.activeResponse;
    this.openDirective = this.openDirective ? `${this.openDirective} – ${text.trim()}` : text.trim();
    this.directiveGateUsed = false;
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
    this.responseHadText = false;
    this.responseCause = this.lastCause;
    this.mutedResponse = this.muteAfterReject;
    this.mutedWhy = MUTED_AFTER_REJECT;
    this.mutedBytes = 0;
    this.mutedHeld = [];
    if (this.dupGuard === 'greeting') this.dupGreetingStarted = true;
    else if (this.dupGuard === 'after') {
      this.dupGuard = 'off';
      if (Date.now() <= this.dupGuardUntil) {
        this.mutedResponse = true;
        this.mutedWhy = 'als zweite Antwort auf den Gesprächsbeginn';
      }
    }
    if (this.muteReplyUntil) {
      if (Date.now() < this.muteReplyUntil) this.muteNoiseResponse = true;
      this.muteReplyUntil = 0;
    }
    // Die erste Antwort nach unserer Abschluss-Anforderung ist die Verabschiedung
    if (this.goodbye === 'speaking' && !this.goodbyeResponseId && id) this.goodbyeResponseId = id;
  }

  private onAudio(itemId: string, pcm: Buffer): void {
    if (this.mutedResponse) {
      this.mutedBytes += pcm.length;
      this.mutedHeld.push({ itemId, buf: pcm });
      return;
    }
    if (!this.stats.firstDeltaAt) {
      this.stats.firstDeltaAt = Date.now();
      this.stats.firstDeltaMs = Math.round(pcm.length / 2 / (this.live.outputRate / 1000));
    }
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
      // Weiteres Audio der Antwort, die gerade gesprochen wird, gehört hinter den pausierten Rest
      if (this.hold.spokenActive && itemId === this.currentItemId) this.enqueueAudio(pcm, itemId);
      else this.hold.held.push({ itemId, buf: pcm });
      return;
    }
    this.enqueueAudio(pcm, itemId);
  }

  private onAiText(itemId: string, text: string, final: boolean): void {
    if (text) this.responseHadText = true;
    // Nicht zu hören, also auch nicht im Transkript
    if (this.mutedResponse) return;
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
    this.lastAiText = text;
    this.lastAiItem = itemId;
    if (this.opts.requireAiIntro && !this.introChecked) {
      this.introChecked = true;
      if (!AI_INTRO_WORD.test(text)) {
        log.warn('Realtime: Die erste Antwort nennt die KI nicht – Nachholen angefordert');
        this.live.note(AI_INTRO_MISSING);
        // (kommt hinter den Text der Antwort ins Transkript, wie die Hinweise auf Unterbrechungen)
        this.interruptNotes.push('Die KI hat sich in der Begrüßung nicht als KI vorgestellt – sie holt das im nächsten Redebeitrag nach');
      } else if (itemId === this.lastCutItem) {
        log.warn('Realtime: Die Vorstellung als KI wurde abgeschnitten – Nachholen angefordert');
        this.live.note(AI_INTRO_CUT);
      } else this.introItem = itemId;
    }
    this.opts.onTranscript({ speaker: 'ki', text, final: true, itemId });
    this.checkDodge(text);
  }

  /**
   * Agenten-Anruf: Die KI sagt auf eine Frage zum Agenten oder zum Anruf „das weiß ich nicht", obwohl sie nachfragen
   * könnte (die Regel dazu befolgt das Sprachmodell nicht zuverlässig). Dann holt sie die Rückfrage gleich im Anschluss nach.
   */
  private checkDodge(text: string): void {
    if (!this.opts.onAskAgent || this.ask || this.askNudges >= ASK_NUDGE_MAX) return;
    if (this.endRequested !== undefined || this.goodbye !== 'none') return;
    const question = this.lastPartnerText;
    if (!question || question === this.askHandledFor || !dodgesAgentQuestion(text, question, this.opts.agentName)) return;
    this.askHandledFor = question;
    this.askNudges++;
    log.info(`Realtime: KI weicht einer Frage zum Agenten aus („${text.slice(0, 60)}") – Rückfrage wird nachgeholt`);
    this.live.note(ASK_INSTEAD);
    this.requestRespond(CAUSE_ASK_NUDGE);
  }

  private onPartnerText(itemId: string | undefined, text: string): void {
    // Die Mitschrift ist da (auch ein leerer Text: dann war es ein Geräusch): Wer darauf wartet, kann weitermachen
    const awaited = this.awaitedTranscripts.findIndex((u) => u.id === itemId);
    if (awaited >= 0) {
      this.awaitedTranscripts.splice(awaited, 1);
      for (const listener of [...this.transcriptListeners]) listener();
    }
    if (text) {
      this.partnerTurns++;
      this.lastPartnerText = text;
      this.opts.onTranscript({ speaker: 'partner', text, final: true, itemId: String(itemId) });
      // Das Gegenüber hat doch etwas gesagt (die Mitschrift kam ohne „Sprache beginnt“, z. B. als Nachtrag):
      // Was die KI darauf antwortet, ist kein Nachschub nach dem abgelehnten end_call
      this.muteAfterReject = false;
      if (this.mutedResponse && this.mutedWhy === MUTED_AFTER_REJECT) {
        log.info('Realtime: Mitschrift des Gegenübers trifft ein – die stumm gehaltene Antwort ist doch zu hören');
        this.mutedResponse = false;
        const held = this.mutedHeld;
        this.mutedHeld = [];
        for (const h of held) this.onAudio(h.itemId, h.buf);
      }
    } else {
      log.info(`Realtime: Äußerung ${itemId ?? '?'} ohne Text (Geräusch)`);
      // Vor der Begrüßung war es nur ein Geräusch (Abheben, Rascheln): Darauf antwortet kein Modell von selbst
      this.lateGreeting('Geräusch statt Meldung');
    }
    // Nur die Äußerung zählt, die die Prüfung ausgelöst hat – nicht die verspätete Transkription des Satzes davor
    const fits = (expected?: string) => !expected || !itemId || expected === itemId;
    if (this.farewellDecisionTimer) {
      // Nur Äußerungen zählen, die nach der Verabschiedung begannen – nicht die verspätete Transkription des Satzes davor
      if (!this.takeFarewellItem(itemId)) return;
      // Kommt die Mitschrift einer weiteren Äußerung, während das Textmodell noch über die Worte davor urteilt, ist das Urteil überholt
      if (this.farewellJudging !== undefined) this.awaitMoreAfterGoodbye(this.farewellJudging);
      this.decideAfterGoodbye(text);
    } else if (this.hold && fits(this.hold.itemId)) {
      if (this.partnerSpeaking && isBackchannel(text)) this.hold.itemId = undefined;
      else this.resolveHold(text);
    }
  }

  private onSpeechStarted(itemId?: string): void {
    this.partnerSpeaking = true;
    this.partnerItem = itemId;
    this.partnerTurns++;
    if (itemId === undefined || !this.awaitedTranscripts.some((u) => u.id === itemId)) this.awaitedTranscripts.push({ id: itemId });
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
    // Das Gegenüber reagiert: Die Antwort darauf soll wieder zu hören sein
    this.muteAfterReject = false;
    this.soundNudges = 0;
    // Spricht es, seit die nachgeholte Begrüßung läuft, ist die nächste Antwort keine Dopplung mehr
    if (this.dupGreetingStarted) this.dupGuard = 'off';
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
      } else if (
        !this.greetingResponse &&
        (this.activeResponse
          ? // Die Antwort entsteht noch: Der Anbieter bricht sie selbst ab; was schon vorliegt, wartet auf die Mitschrift.
            // So fällt ein Echo der eigenen Stimme auf, bevor der halbe Satz verworfen ist
            Boolean(this.live.answersAfterInterrupt) && ms >= HOLD_MIN_MS
          : ms >= HOLD_MIN_MS || (this.live.answersAfterInterrupt && this.lastResponseStatus === 'cancelled'))
      ) {
        // (Ein Anbieter, der eine Antwort bei einer Unterbrechung selbst abbricht, braucht die Prüfung dann auch bei wenig Rest:
        // Nur sie hält seine Antwort auf einen Zuhör-Laut stumm. War die Antwort dagegen fertig und fast ausgespielt, ist ein
        // „Okay“ die Antwort des Gegenübers, kein Zuhör-Laut.)
        // Antwort liegt vollständig vor: nur pausieren und erst nach der Transkription entscheiden
        log.info(`Realtime: speech_started – ${ms} ms in der Warteschlange, pausiere und prüfe, ob das Gegenüber etwas sagt`);
        this.hold = {
          timer: setTimeout(() => this.resolveHold(undefined), HOLD_MAX_MS),
          itemId,
          midSentence: ms >= HOLD_MIN_MS || this.lastResponseStatus === 'cancelled',
          spokenActive: this.activeResponse,
          spoken: this.kiLive || this.lastAiText,
          held: [],
          texts: [],
        };
        this.hold.timer.unref();
      } else {
        log.info(`Realtime: speech_started – ${this.outQueue.length} Frames (${ms} ms) in der Warteschlange, verwerfe`);
        this.discardOutput();
      }
    }
  }

  private onSpeechStopped(): void {
    this.partnerSpeaking = false;
    this.lastPartnerAt = Date.now();
    if (this.speechStartedAt) log.info(`Realtime: Gegenüber war ${Date.now() - this.speechStartedAt} ms zu hören`);
    this.speechStartedAt = 0;
    // Nach der Verabschiedung zählt die Frist für die Mitschrift ab dem Sprachende, nicht ab dem Beginn: Eine lange Äußerung darf sie nicht aufbrauchen
    // (läuft das Textmodell gerade, ist der Timer dessen Frist und bleibt)
    if (this.endRequested !== undefined && this.farewellDecisionTimer && this.farewellJudging === undefined) this.armFarewellTimer();
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
    this.muteAfterReject = false;
    this.lastCause = 'Tool-Ergebnis';
    this.onFunctionCall(name, callId, args);
  }

  private onResponseDone(r: LiveResponseDone): void {
    // Die KI hat nach der Vorgabe des Agenten gesprochen (nicht stumm, nicht abgebrochen): Sie gilt als umgesetzt. Sprach das
    // Gegenüber, als die Vorgabe kam, antwortet die KI zuerst ihm – dann zählt nur eine Antwort, die eigens für die Vorgabe entstand
    if (this.openDirective && this.directiveSkipResponse) this.directiveSkipResponse = false;
    else if (this.openDirective && !this.mutedResponse && r.status !== 'cancelled' && this.stats.deltas > 0) {
      if (!this.directiveContested || this.responseCause === CAUSE_AGENT_SAY || this.responseCause === CAUSE_ASK_ANSWER) this.openDirective = undefined;
    }
    this.lastResponseStatus = r.status;
    this.muteNoiseResponse = false;
    this.activeResponse = false;
    if (r.usage) this.addUsage(r.usage);
    this.mutedHeld = [];
    if (this.mutedResponse) {
      this.mutedResponse = false;
      log.info(`Realtime: Antwort ${r.id ?? '?'} ${this.mutedWhy} stumm gelassen (${Math.round(this.mutedBytes / 2 / (this.live.outputRate / 1000))} ms Audio, Mitschrift ${this.responseHadText ? 'ja' : 'nein'})`);
    }
    // Ohne neue Stücke kommt nichts mehr nach: Ein späterer Leerlauf ist das Satzende, kein Aussetzer
    this.underrunAt = 0;
    for (const note of this.interruptNotes.splice(0)) this.opts.onTranscript({ speaker: 'system', text: note, final: true });
    // Die gesprochene Antwort ist zu Ende (auch: vom Anbieter abgebrochen); was jetzt noch entsteht, ist die Antwort auf das Gehörte
    if (this.hold) this.hold.spokenActive = false;
    if (this.dupGuard === 'greeting' && this.dupGreetingStarted) {
      this.dupGuard = 'after';
      this.dupGuardUntil = Date.now() + DUP_AFTER_GREETING_MS;
    }
    const st = this.stats;
    if (st.deltas > 0) {
      const genMs = Date.now() - st.firstDeltaAt;
      const audioMs = (st.framesPlayed + this.outQueue.length) * 20;
      log.info(`Realtime-Antwort: ${st.deltas} Deltas in ${genMs} ms für ${audioMs} ms Audio (${(audioMs / Math.max(genMs, 1)).toFixed(1)}x Echtzeit), Unterläufe ${st.underruns}, max. Puffer ${st.maxQueue * 20} ms, Unterbrechungen ${st.interruptions} (${st.discarded * 20} ms verworfen); Antwort ${r.id ?? '?'}, Mitschrift ${this.responseHadText ? 'ja' : 'nein'}, Auslöser: ${this.lastCause || 'unbekannt'}`);
      if (!this.responseHadText) log.warn(`Realtime: Antwort ${r.id ?? '?'} hat Audio ohne Mitschrift – im Transkript fehlt, was die KI hier gesagt hat`);
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
    this.stats = { underruns: 0, maxQueue: 0, framesPlayed: 0, interruptions: 0, discarded: 0, firstDeltaAt: 0, firstDeltaMs: 0, deltas: 0 };
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
    // Der Wächter (audioExpected) lief ab, während diese Antwort noch lief („langsam“), und sie endet ohne Audio: Die Erwartung bleibt offen, und armStall
    // (wie der Laut-Wächter) bliebe bis zur nächsten Äußerung des Gegenübers gesperrt. Der Wächter wird neu gestellt: Entsteht nichts mehr, fordert er eine Antwort an
    if (st.deltas === 0 && this.awaitingAudioSince && !this.audioWatchdog) this.audioExpected(true, this.awaitingLabel);
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
    // Die KI spricht noch (ihr Audio liegt im Puffer): Die Frist zählt erst ab dem Ende der Ausgabe, nextFrame stellt sie dann
    if (this.playing || this.outQueue.length > 0) return;
    if (this.stallTimer) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (this.closed || this.activeResponse || this.partnerSpeaking || this.transferring || this.ask || this.goodbye !== 'none' || this.endRequested !== undefined) return;
      // Eben war noch etwas zu hören (Nebengeräusch, ein Laut ohne Ende): kein Stillstand, weiter warten
      const sinceLoud = this.lastLoudAt ? Date.now() - this.lastLoudAt : Infinity;
      if (sinceLoud < STALL_SOUND_MS && this.stallDeferred < 2) {
        this.stallDeferred++;
        log.info(`Realtime: Stillstand – das Gegenüber war vor ${sinceLoud} ms noch zu hören, warte weiter (${this.stallDeferred}/2)`);
        this.armStall();
        return;
      }
      this.stallDeferred = 0;
      if (this.stallNudges >= STALL_MAX_NUDGES) {
        log.warn(`Realtime: Stillstand hält an (${this.stallNudges}x angestoßen, Gegenüber schweigt) – kein weiterer Anstoß`);
        return;
      }
      this.stallNudges++;
      this.pendingRespond = false;
      log.warn(`Realtime: Stillstand – ${this.opts.stallMs} ms nach Ende der KI-Ausgabe weder Sprache des Gegenübers noch neue Antwort, stoße die KI an (${this.stallNudges}/${STALL_MAX_NUDGES})`);
      if (!this.opts.scam) this.event(`Stille: Seit ${Math.round(this.opts.stallMs / 1000)} s sagt niemand etwas – die KI wurde angestoßen (${this.stallNudges}/${STALL_MAX_NUDGES})`);
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
    this.dupGuard = 'greeting';
    this.dupGreetingStarted = false;
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
    this.lastCause = label;
    // Die App fordert selbst eine Antwort an (Regieanweisung, Wächter): Die ist gewollt und keine Dopplung
    if (this.dupGuard === 'after') this.dupGuard = 'off';
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
      this.askHandledFor = this.lastPartnerText;
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
    if (this.openDirective && !this.endByAgent) {
      if (!this.directiveGateUsed) {
        // Die Vorgabe des Agenten ist noch nicht gesprochen (sie kam z. B., während das Gegenüber eine neue Frage stellte):
        // erst sie, dann beenden. Einmal – ignoriert die KI auch das, endet das Gespräch, und das Transkript hält es fest
        this.directiveGateUsed = true;
        log.info('Realtime: end_call abgelehnt – eine Vorgabe des Agenten ist noch nicht gesprochen');
        this.event('Vorgabe des Agenten noch nicht gesprochen – Auflegen zurückgestellt');
        this.live.toolOutput(callId, name, endCallOpenDirective(this.openDirective));
        this.requestRespond(CAUSE_AGENT_SAY);
        return;
      }
      log.warn('Realtime: Gespräch endet, ohne dass die Vorgabe des Agenten gesprochen wurde');
      this.event('Eine Vorgabe des Agenten wurde nicht mehr gesprochen');
      this.openDirective = undefined;
    }
    // Punkte, die die Prüfung nebenher beim letzten end_call gemeldet hat, gelten, bis sie gebraucht werden (end_call ohne Sprache, unten)
    // oder das Gegenüber seitdem etwas gesagt hat („Fehlt der eben genannte Punkt …" nach dem Schweigen wäre sonst falsch, wenn er
    // längst beantwortet ist). Ein end_call mit Sprache wird abgelehnt und verbraucht sie nicht
    if (this.endOpenFound && this.endOpenFound.turns !== this.partnerTurns) this.endOpenFound = undefined;
    // Das Textmodell prüft einmal je Gespräch am ganzen Transkript, ob vom Auftrag noch etwas fehlt (nicht in der Spam-Abwehr,
    // nicht beim Beenden durch den Agenten).
    // Läuft die Prüfung vom end_call mit Sprache noch, ist sie überholt (das Gegenüber hat inzwischen geantwortet): neu prüfen
    const overtaken = this.endCheckLater !== undefined;
    clearTimeout(this.endCheckLater);
    this.endCheckLater = undefined;
    const judge = !this.opts.scam && !this.endByAgent && (!this.endCallChecked || overtaken) ? this.opts.judge : undefined;
    if (this.stats.deltas > 0) {
      // Gesprochen und im selben Atemzug beendet („ich richte das jetzt aus" + end_call):
      // das Gegenüber bekommt erst die Chance zu antworten, die VAD erzeugt die nächste Antwort.
      // Mit Gesprächsplan kommt die Prüfung der Schritte gleich mit: Sonst käme sie erst beim nächsten end_call,
      // und eine vergessene Frage fiele der KI ein, nachdem sich beide schon verabschiedet haben
      const check = !judge && this.planSteps.length > 0 && !this.endCallChecked;
      if (check || judge) this.endCallChecked = true;
      if (judge) {
        // Das Gegenüber ist ohnehin erst dran: Die Prüfung läuft nebenher, Fehlendes kommt als Hinweis nach
        const turns = this.partnerTurns;
        this.endCheckLater = this.askJudge('Auflegen, nebenher', judge.endCall(), JUDGE_END_LATER_MS, (t) => this.endCheckLater === t, (open) => {
          this.endCheckLater = undefined;
          // Das Gegenüber hat seit Beginn der Prüfung etwas gesagt: Sie kannte die Antwort nicht, das Urteil gilt nicht.
          // Der nächste end_call wird frisch geprüft
          if (this.partnerTurns !== turns) {
            this.endCallChecked = false;
            return;
          }
          if (!open?.length) return;
          // (Beendet die KI inzwischen mit einem end_call ohne Sprache, hat der Handler diese Prüfung abgelöst: Das Urteil kommt hier nur an, solange sie nicht beendet)
          this.endOpenFound = { open, turns };
          this.event(`Prüfung vor dem Auflegen: noch offen – ${open.join(' · ')}`);
          this.live.note(endCallOpenNote(open));
        });
      }
      log.info(`Realtime: end_call zusammen mit Sprache – abgelehnt, Gegenüber darf erst antworten${check ? `; Selbstprüfung gegen ${this.planSteps.length} Planschritte gleich mitgegeben` : ''}`);
      this.live.toolOutput(callId, name, check ? endCallWhileSpeakingCheck(this.planSteps) : END_CALL_WHILE_SPEAKING);
      this.muteAfterReject = true;
      // Kommt nichts vom Gegenüber, darf das Gespräch nicht bis zum Limit hängen. Die Frist läuft erst,
      // wenn der Satz ausgespielt ist – er liegt hier noch fast vollständig im Puffer.
      const rejectWait = this.outQueue.length * 20 + REJECT_SILENCE_MS;
      clearTimeout(this.rejectTimer);
      let retries = 0;
      // Das Gegenüber redet schon (sein speech_started kam vor dem Tool-Ereignis, rejectTimer wurde also nicht abgeräumt): partnerTurns merkt sich den Stand,
      // um zu sehen, ob die Mitschrift dieser Äußerung Inhalt brachte
      const straddle = this.partnerSpeaking ? this.partnerTurns : undefined;
      const onSilence = (): void => {
        this.rejectTimer = undefined;
        if (this.endRequested !== undefined || this.closed) return;
        // Die KI wartet auf die Antwort einer Rückfrage: kein Anstoß. Die Frist ist aber vorbei – die Antwort darauf (oder das Ausbleiben der Antwort) darf nicht stumm bleiben
        if (this.ask) {
          this.muteAfterReject = false;
          return;
        }
        // Nicht hineinreden, sondern nach dem Satz noch einmal nachsehen: wenn das Gegenüber redet (der Anstoß wäre ein „sagt nichts mehr“ mitten in
        // seinen Satz), wenn die KI selbst spricht (ein Anbieter lässt sie nach dem Tool-Ergebnis von sich aus weiterreden) und – wenn das Gegenüber schon
        // redete – kurz auf die Mitschrift seiner Äußerung (war es nur ein Geräusch, kommt der Anstoß, hatte es Inhalt, nicht)
        const awaitsText = straddle !== undefined && this.awaitedTranscripts.length > 0 && Date.now() - this.lastPartnerAt < TRANSCRIPT_WAIT_MS;
        if ((this.partnerSpeaking || this.activeResponse || awaitsText) && retries++ < 10) {
          this.rejectTimer = setTimeout(onSilence, 1000);
          this.rejectTimer.unref();
          return;
        }
        // Das Gegenüber hat reagiert (es redet seit über zehn Sekunden, oder seine Mitschrift hatte Inhalt): Die Antwort darauf entsteht von selbst und
        // ist kein Nachschub mehr (wie bei einem speech_started nach der Ablehnung). Kein Anstoß „sagt nichts mehr“, aber auch keine Stummschaltung auf Dauer;
        // der Stillstandswächter (der bis hierher wegen des Timers nicht scharf war) übernimmt wieder
        if (this.partnerSpeaking || (straddle !== undefined && this.partnerTurns !== straddle)) {
          this.muteAfterReject = false;
          this.armStall();
          return;
        }
        log.info(`Realtime: Gegenüber schweigt nach abgelehntem end_call – KI soll ${check ? 'Fehlendes ansprechen oder beenden' : 'beenden'}`);
        this.muteAfterReject = false;
        this.lastCause = 'Schweigen nach abgelehntem end_call';
        this.live.respond(check ? END_CALL_AFTER_SILENCE_CHECK : this.endOpenFound ? END_CALL_AFTER_SILENCE_OPEN : END_CALL_AFTER_SILENCE);
      };
      this.rejectTimer = setTimeout(onSilence, rejectWait);
      this.rejectTimer.unref();
      return;
    }
    // Ein end_call ohne Sprache löst die Schweigefrist eines früheren, abgelehnten ab. Ihr Anstoß „sagt nichts mehr, rufe end_call auf“ käme sonst
    // auch dann noch, wenn das Gespräch inzwischen weitergeht (die Prüfung meldet Offenes und nimmt das Auflegen zurück, siehe resumeForOpen)
    this.endRejectWindow();
    if (judge) {
      // Erster end_call: Das Textmodell prüft den Auftrag gegen das ganze Transkript – neben der Verabschiedung her, damit
      // vor dem Abschied keine Pause entsteht. Fehlt etwas, nimmt das Urteil das Auflegen zurück (resumeForOpen).
      // Die Selbstprüfung der Sprach-KI gegen den Plan entfällt dann
      this.endCallChecked = true;
      log.info('Realtime: end_call – Prüfung gegen den Auftrag durch das Textmodell läuft neben der Verabschiedung');
      // Die Mitschrift der letzten Antwort des Gegenübers kommt oft erst jetzt: Ohne sie meldete die Prüfung eine beantwortete Frage als offen.
      // Das Warten zählt zur Frist; wurde die Prüfung inzwischen abgelöst oder zurückgenommen, wird das Textmodell nicht mehr gefragt
      const question = this.awaitedTranscripts.length ? this.untilTranscribed().then(() => (this.endCheck === check ? judge.endCall() : [])) : judge.endCall();
      const check: NodeJS.Timeout = this.askJudge('Auflegen', question, JUDGE_END_MS, (t) => this.endCheck === t, (open) => {
        this.endCheck = undefined;
        if (open?.length) this.resumeForOpen(open);
      });
      this.endCheck = check;
    } else if (this.planSteps.length && !this.endCallChecked) {
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
    this.armEndDeadline();
    if (outcome.result) this.opts.onOutcome?.(outcome);
    this.opts.onTranscript({ speaker: 'system', text: `${OUTCOME_PREFIX} ${outcome.result || '–'}${outcome.open ? ` · Offen: ${outcome.open}` : ''}`, final: true });
    // Sicherheitsnetz, falls Abschluss oder Audio ausbleiben (wird bei Abbruch gelöscht; die harte Obergrenze der Endphase ist davon unabhängig)
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
    // Das Gegenüber setzte schon vor dem end_call an und redet noch: Seine Äußerung zählt wie eine nach der Verabschiedung, auch wenn sie endet und
    // mitgeschrieben wird, bevor der Abschied ausgespielt ist (sonst wäre sie danach nie ausgewertet worden). Die Frist ist die übliche, ab dem Sprachende.
    // Äußerungen, die schon zu Ende waren, bleiben außen: Darauf antwortet die KI mit dem end_call, ihre verspätete Mitschrift entscheidet nichts
    if (this.partnerSpeaking) this.onSpeechAfterGoodbye(this.partnerItem);
    // Die Prüfung nebenher hatte Punkte gemeldet, und die KI beendet, ohne dass das Gegenüber seitdem etwas gesagt hat (ihre Antwort war schon
    // unterwegs, als der Hinweis kam): so, als hätte die Prüfung beim end_call selbst sie gefunden. Einmal – sie sind jetzt verbraucht
    // (ob das Gegenüber seitdem etwas gesagt hat, entschied schon der Anfang des Handlers)
    const found = this.endOpenFound;
    this.endOpenFound = undefined;
    if (found) this.resumeForOpen(found.open);
  }

  /**
   * Wartet auf die Mitschriften der Äußerungen des Gegenübers, die schon begannen (OpenAI liefert sie oft erst, wenn die KI bereits
   * antwortet), höchstens TRANSCRIPT_WAIT_MS. Was bis dahin nicht kam, gilt als ausgefallen und wird nicht noch einmal abgewartet.
   */
  private untilTranscribed(): Promise<void> {
    const waitFor = [...this.awaitedTranscripts];
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.transcriptListeners.delete(listener);
        this.awaitedTranscripts = this.awaitedTranscripts.filter((u) => !waitFor.includes(u));
        resolve();
      };
      const listener = (): void => {
        if (!waitFor.some((u) => this.awaitedTranscripts.includes(u))) finish();
      };
      const timer = setTimeout(finish, TRANSCRIPT_WAIT_MS);
      timer.unref();
      this.transcriptListeners.add(listener);
      log.info(`Realtime: end_call – warte bis zu ${TRANSCRIPT_WAIT_MS} ms auf die Mitschrift der letzten Äußerung des Gegenübers, bevor das Textmodell das Gespräch liest`);
    });
  }

  /**
   * Die Prüfung beim end_call meldet offene Punkte, während die Verabschiedung läuft oder schon gesprochen ist: Das Auflegen
   * zurücknehmen und die KI den Punkt noch ansprechen lassen (wie bei einer Vorgabe des Agenten während des Beendens).
   */
  private resumeForOpen(open: string[]): void {
    if (this.endRequested === undefined || this.closed) return;
    log.info(`Realtime: Prüfung beim end_call – laut Textmodell noch ${open.length} Punkt(e) offen, Auflegen zurückgenommen`);
    this.cancelHangup('check');
    this.event(`Prüfung vor dem Auflegen: noch offen – ${open.join(' · ')} – Gespräch geht weiter`);
    this.live.note(endCallResumeNote(open));
    this.requestRespond('Prüfung vor dem Auflegen');
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
    const lostMs = this.outQueue.length * 20;
    if (lostMs >= INTERRUPT_NOTE_MS) {
      this.lastCutItem = this.playItemId ?? '';
      if (this.introItem && this.introItem === this.playItemId) {
        this.introItem = '';
        log.warn('Realtime: Die Vorstellung als KI wurde abgeschnitten – Nachholen angefordert');
        this.live.note(AI_INTRO_CUT);
      }
      // Die Mitschrift der KI nennt den ganzen Satz, auch wenn er abgeschnitten wurde: im Transkript und für den Agenten festhalten
      // Welche Antwort betroffen ist: ihr Anfang, soweit er vorliegt (die Mitschrift nennt sonst den ganzen Satz als gesagt)
      // Steht ihr Text schon im Transkript (verworfen wird oft erst, wenn feststeht, was das Gegenüber sagte), ist sie fertig
      const textOut = this.lastAiItem !== '' && this.lastAiItem === this.playItemId;
      const said = (textOut ? this.lastAiText : this.kiLive).trim();
      const which = said ? `, die mit „${said.slice(0, 40)}${said.length > 40 ? ' …' : ''}“ begann,` : '';
      const note = `KI unterbrochen: etwa ${(lostMs / 1000).toFixed(1).replace('.', ',')} s ihrer Antwort${which} wurden nicht mehr gesprochen`;
      // Der Text der Antwort kommt erst, wenn sie endet: Der Hinweis gehört dahinter, nicht davor. Jede Unterbrechung bekommt ihren eigenen.
      // Ist er schon da, kommt der Hinweis sofort – sonst stünde er erst hinter der nächsten Antwort, die gerade läuft
      if (this.activeResponse && !textOut) this.interruptNotes.push(note);
      else this.opts.onTranscript({ speaker: 'system', text: note, final: true });
      // Das Modell hält den Satz sonst für gesagt und erklärt sich die Rückfrage des Gegenübers mit einer Verbindungsstörung.
      // Eine Vorgabe des Agenten, die so unterging, ist nicht erledigt. Beim Beenden bleibt es dabei.
      if (this.endRequested === undefined && this.goodbye === 'none') {
        this.live.note(this.responseCause === CAUSE_AGENT_SAY || this.responseCause === CAUSE_ASK_ANSWER ? INTERRUPTED_DIRECTIVE : INTERRUPTED_ANSWER);
      }
    }
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
    if (this.closed) {
      this.hold = undefined;
      return;
    }
    this.hold = undefined;
    const echo = text !== undefined && !isBackchannel(text) && isEcho(text, h.spoken);
    if (text !== undefined && (echo || isBackchannel(text))) {
      log.info(`Realtime: ${echo ? `Echo der eigenen Stimme („${text}" steht in der laufenden Antwort)` : text.trim() ? `nur ein Zuhör-Laut („${text}")` : 'nur ein Geräusch, keine Sprache'} – KI spricht ihren Satz zu Ende (${this.outQueue.length * 20} ms)`);
      // Was das Modell auf den Laut hin sagen wollte, wird weder gesprochen noch im Verlauf behalten
      if (this.activeResponse && !h.spokenActive) {
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
    // (Eine Äußerung, die noch läuft, ist hier längst eingetragen: der end_call-Handler und speech_started tragen jede ein – siehe onSpeechAfterGoodbye)
    clearTimeout(this.endSafetyTimer);
    this.endSafetyTimer = undefined;
    const reason = this.endRequested;
    // Nachhörphase: Sagt das Gegenüber jetzt noch etwas, wird das Auflegen abgebrochen (siehe speech_started)
    log.info(`Realtime: Abschluss ausgespielt, lege in ${this.opts.hangupGraceMs} ms auf, falls das Gegenüber nichts mehr sagt`);
    const hangUp = (): void => {
      // Das Urteil der Prüfung steht noch aus: kurz warten (askJudge beendet das spätestens nach JUDGE_END_MS)
      if (this.endCheck) {
        this.hangupTimer = setTimeout(hangUp, 250);
        return;
      }
      this.hangupTimer = undefined;
      // Aufgelegt: Die Obergrenze der Endphase hat nichts mehr zu tun
      clearTimeout(this.endDeadline);
      this.endDeadline = undefined;
      this.endRequested = undefined;
      this.opts.onEndCall(reason);
    };
    this.hangupTimer = setTimeout(hangUp, this.opts.hangupGraceMs);
  }

  /**
   * Gegenüber spricht nach dem end_call noch. Auflegen pausieren und auf die Transkription warten:
   * reine Verabschiedung/Bestätigung („Okay, tschüss") -> sofort auflegen; Inhalt -> Gespräch geht weiter.
   * Jede Äußerung, die nach der Verabschiedung beginnt, zählt – auch eine, die ansetzt, bevor die Mitschrift der vorigen da ist.
   */
  private onSpeechAfterGoodbye(itemId?: string): void {
    if (this.endRequested === undefined) return;
    if (!itemId || !this.farewellOpen.includes(itemId)) this.farewellOpen.push(itemId);
    if (this.farewellDecisionTimer) {
      // Das Gegenüber redet weiter, während die Mitschrift davor aussteht oder das Textmodell über die Worte davor urteilt:
      // Das Urteil ist überholt, beide Äußerungen zählen zusammen (sonst würde mitten in den neuen Satz aufgelegt)
      if (this.farewellJudging !== undefined) this.awaitMoreAfterGoodbye(this.farewellJudging);
      else this.armFarewellTimer();
      return;
    }
    clearTimeout(this.hangupTimer);
    this.hangupTimer = undefined;
    // Neue Äußerung, neue Entscheidung: Nach einem früheren Geräusch darf die Antwort auf echte Sprache nicht stumm bleiben
    this.muteAfterGoodbye = false;
    log.info('Realtime: Gegenüber spricht nach der Verabschiedung – warte auf Transkription');
    this.armFarewellTimer();
  }

  /**
   * Frist für die Mitschrift: Sie wird mit jeder neuen Äußerung und mit jedem Sprachende neu gestellt (onSpeechStopped) und läuft nicht ab,
   * solange das Gegenüber spricht – sonst entschiede sie mitten im Satz (Auflegen in eine Frage hinein, oder „Gegenüber spricht noch“ bei einem
   * langen Abschiedssatz). Läuft sie ab, entscheiden die Worte, die schon gesagt waren (sie werden nicht verworfen); gab es keine, geht das
   * Gespräch weiter, statt jemandem ins Wort aufzulegen. Hängt die Spracherkennung oder flattert sie, endet das Warten spätestens mit der
   * harten Obergrenze der Endphase (armEndDeadline).
   */
  private armFarewellTimer(): void {
    clearTimeout(this.farewellDecisionTimer);
    this.farewellDecisionTimer = setTimeout(() => {
      if (this.partnerSpeaking && !this.closed) {
        this.armFarewellTimer();
        return;
      }
      this.decideAfterGoodbye(undefined);
    }, FAREWELL_DECISION_MS);
  }

  /**
   * Harte Obergrenze der Endphase, gestellt beim angenommenen end_call: Nach END_PHASE_MAX_MS wird aufgelegt, solange das Beenden gilt – ohne
   * Textmodell zu fragen oder auf Sprache und Mitschriften zu warten. Die Verabschiedung steht, zurückgehaltenes Audio der KI bleibt stumm.
   * Gelöscht wird sie nur vom Zurücknehmen des Beendens (cancelHangup), vom Auflegen selbst (hangUp in finishEndCall) und beim Schließen –
   * nicht von Entscheidungen, Sprache oder dem Ausspielen der Verabschiedung. Der endSafetyTimer (Verabschiedung kommt nie zu Ende) läuft unabhängig davon und früher.
   */
  private armEndDeadline(): void {
    clearTimeout(this.endDeadline);
    this.endDeadline = setTimeout(() => {
      this.endDeadline = undefined;
      if (this.endRequested === undefined || this.closed) return;
      log.warn(`Realtime: ${END_PHASE_MAX_MS / 1000} s seit dem end_call – lege jetzt auf (die Verabschiedung gilt, auf weitere Sprache oder Mitschriften wird nicht mehr gewartet)`);
      const reason = this.endRequested;
      // Was noch wartet, verfällt: Nachhörphase, Frist für die Mitschrift, Frage ans Textmodell, Sicherheitsnetz
      clearTimeout(this.hangupTimer);
      this.hangupTimer = undefined;
      clearTimeout(this.farewellDecisionTimer);
      this.farewellDecisionTimer = undefined;
      this.farewellJudging = undefined;
      clearTimeout(this.endCheck);
      this.endCheck = undefined;
      clearTimeout(this.endSafetyTimer);
      this.endSafetyTimer = undefined;
      this.endRequested = undefined;
      this.opts.onEndCall(reason);
    }, END_PHASE_MAX_MS);
    this.endDeadline.unref();
  }

  /** Das Gegenüber redet noch oder hat neu angesetzt, und die Mitschrift davon fehlt: Es kommt gleich mehr. */
  private moreAfterGoodbye(): boolean {
    return this.partnerSpeaking || this.farewellOpen.length > 0;
  }

  /**
   * Die Mitschrift einer Äußerung nach der Verabschiedung ist da: Sie ist nicht mehr offen. false = die verspätete Mitschrift des
   * Satzes davor (oder ein Nachtrag), die hier nichts entscheidet.
   */
  private takeFarewellItem(itemId?: string): boolean {
    let i = itemId ? this.farewellOpen.indexOf(itemId) : 0;
    if (i < 0) i = this.farewellOpen.indexOf(undefined);
    // (Ohne Kennung zählt die erste offene; ist keine offen, kann es nur der Satz davor sein)
    if (i < 0 || i >= this.farewellOpen.length) return false;
    this.farewellOpen.splice(i, 1);
    return true;
  }

  /** Auf die nächste Mitschrift warten; `words` sind die Worte davor, die dann mitzählen. */
  private awaitMoreAfterGoodbye(words: string): void {
    log.info('Realtime: Gegenüber redet nach der Verabschiedung weiter – die nächste Äußerung entscheidet mit');
    this.farewellJudging = undefined;
    this.farewellPrior = this.farewellPrior === undefined ? words : `${this.farewellPrior} ${words}`.trim();
    this.armFarewellTimer();
  }

  /** text = Mitschrift der Äußerung; undefined = die Frist ist abgelaufen, ohne dass eine kam. */
  private decideAfterGoodbye(text: string | undefined): void {
    clearTimeout(this.farewellDecisionTimer);
    this.farewellDecisionTimer = undefined;
    this.farewellJudging = undefined;
    const prior = this.farewellPrior;
    this.farewellPrior = undefined;
    if (text === undefined) {
      // Keine Mitschrift mehr zu erwarten. Was das Gegenüber vorher gesagt hat, gilt trotzdem: Es wird nicht verworfen
      this.farewellOpen = [];
      text = prior;
    } else if (prior !== undefined) text = `${prior} ${text}`.trim();
    if (this.endRequested === undefined || this.closed) return;
    // Nur ein Abschied, aber das Gegenüber redet schon weiter: erst die nächste Äußerung entscheidet, das Textmodell muss nicht fragen
    if (text !== undefined && this.moreAfterGoodbye() && isFarewell(text)) {
      this.awaitMoreAfterGoodbye(text);
      return;
    }
    const judge = this.opts.scam ? undefined : this.opts.judge;
    if (judge && text?.trim()) {
      const words = text;
      this.farewellJudging = words;
      // Worte nach der Verabschiedung: Das Textmodell kennt das ganze Gespräch und entscheidet, ob noch etwas kommt.
      // Solange der Timer läuft, bleibt alles wie während des Wartens auf die Mitschrift (Audio zurückgehalten, kein Auflegen)
      this.farewellDecisionTimer = this.askJudge('nach der Verabschiedung', judge.afterGoodbye(words), JUDGE_FAREWELL_MS, (t) => this.farewellDecisionTimer === t, (verdict) => {
        clearTimeout(this.farewellDecisionTimer);
        this.farewellDecisionTimer = undefined;
        this.farewellJudging = undefined;
        const farewell = verdict ? verdict === 'farewell' : isFarewell(words);
        // Es spricht gerade wieder oder hat neu angesetzt: nicht mitten hinein auflegen, die nächste Mitschrift entscheidet mit
        if (farewell && this.moreAfterGoodbye()) this.awaitMoreAfterGoodbye(words);
        else this.applyAfterGoodbye(words, farewell);
      });
      return;
    }
    this.applyAfterGoodbye(text, text !== undefined && isFarewell(text));
  }

  /** farewell = nur Geräusch, Abschied oder Bestätigung: auflegen; sonst geht das Gespräch weiter. */
  private applyAfterGoodbye(text: string | undefined, farewell: boolean): void {
    if (this.endRequested === undefined || this.closed) return;
    if (text !== undefined && farewell) {
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
  private cancelHangup(why: 'partner' | 'agent' | 'check' = 'partner'): void {
    if (this.endRequested === undefined) return;
    // Läuft die Prüfung beim end_call noch, ist sie mit dem Weitergehen hinfällig; beim nächsten end_call wird neu geprüft.
    // Geht das Gespräch weiter, weil das Gegenüber etwas sagt, gilt das auch nach einem Urteil „nichts offen“: Es kam Neues dazu.
    // (Ohne Textmodell bleibt die Selbstprüfung gegen den Plan einmal je Gespräch; ein Beenden durch den Agenten wird nie geprüft,
    // auch nicht, wenn das Gegenüber danach weiterspricht: der Agent wollte beenden. Nur seine eigene Vorgabe nimmt das zurück, siehe unten)
    if (!this.endByAgent && ((why === 'partner' && this.opts.judge) || (this.endCheck && why !== 'check'))) this.endCallChecked = false;
    clearTimeout(this.endCheck);
    this.endCheck = undefined;
    clearTimeout(this.hangupTimer);
    this.hangupTimer = undefined;
    clearTimeout(this.farewellDecisionTimer);
    this.farewellDecisionTimer = undefined;
    this.farewellJudging = undefined;
    this.farewellPrior = undefined;
    this.farewellOpen = [];
    clearTimeout(this.endSafetyTimer);
    this.endSafetyTimer = undefined;
    // Das Beenden ist zurückgenommen: Die Obergrenze der Endphase entfällt (ein neuer end_call stellt eine frische)
    clearTimeout(this.endDeadline);
    this.endDeadline = undefined;
    this.endRequested = undefined;
    this.goodbye = 'none';
    this.goodbyeResponseId = undefined;
    this.muteAfterGoodbye = false;
    // Zurückgehaltene Antwort auf das Gesagte jetzt ausspielen
    for (const x of this.heldAudio) this.enqueueAudio(x.buf, x.itemId);
    this.heldAudio = [];
    // Die Prüfung beim end_call meldet selbst, was fehlt (resumeForOpen)
    if (why === 'check') return;
    if (why === 'agent') {
      // Hat der Agent das Beenden selbst verlangt und nimmt es mit seiner Vorgabe zurück, entscheidet die KI wieder selbst:
      // Ihr nächster end_call wird wie jeder andere geprüft (bliebe es beim Agenten-Ende, würde nie wieder geprüft)
      if (this.endByAgent) {
        this.endByAgent = false;
        this.endCallChecked = false;
        this.agentEndNoted = false; // (der Widerruf ist RESUME_FOR_DIRECTIVE unten)
      }
      log.info('Realtime: Vorgabe des Agenten während des Beendens – Auflegen abgebrochen, Gespräch geht weiter');
      this.opts.onTranscript({ speaker: 'system', text: 'Vorgabe des Agenten während des Beendens – Gespräch geht weiter', final: true });
      this.live.note(RESUME_FOR_DIRECTIVE);
      return;
    }
    log.info('Realtime: Gegenüber spricht noch – Auflegen abgebrochen, Gespräch geht weiter');
    this.opts.onTranscript({ speaker: 'system', text: 'Gegenüber hat noch etwas gesagt – Gespräch geht weiter', final: true });
    // Dem Modell den Zustandswechsel klar machen, sonst hängt es in der "ich beende jetzt"-Haltung fest
    this.live.note('Das Gegenüber hat nach deiner Verabschiedung noch etwas gesagt. Das Gespräch läuft ganz normal weiter: Geh auf das Gesagte ein, als wäre nichts beendet worden. Wenn danach alles geklärt ist, rufe erneut end_call auf (ohne dich vorher zu verabschieden).');
    // Der Wächter vom Satzende des Gegenübers (audioExpected) verfiel still, solange das Beenden galt, und der Anbieter hat auf die Äußerung
    // nichts Hörbares geantwortet (nur ein weiterer end_call, nichts): Ohne Antwort, ohne Ausgabe und mit schweigendem Gegenüber käme von selbst nichts mehr.
    // Läuft eine Antwort oder der Wächter noch, übernehmen deren Wege (onResponseDone/armStall, Wächter); liegt Audio an, ist die Antwort schon da
    if (!this.activeResponse && !this.audioWatchdog && !this.playing && this.outQueue.length === 0 && !this.partnerSpeaking) this.requestRespond('Weiter nach dem Abschied');
  }

  private addUsage(u: Usage): void {
    for (const k of Object.keys(this.usage) as (keyof Usage)[]) this.usage[k] += u[k];
    this.opts.onUsage({ ...this.usage });
  }
}
