// Anbieter-Schicht: Was SIPFunk von einem KI-Anbieter braucht – Live-Sprachgespräch, Textmodell, Modell-Liste,
// Schlüsselprüfung, Hörprobe. Die Gesprächslogik (Unterbrechung, Verabschiedung, Wächter, Transkript, Tool-Aufrufe)
// steckt anbieterunabhängig in der Brücke (realtimeBridge.ts); ein Anbieter übersetzt nur zwischen den Ereignissen
// und Befehlen hier und seinem eigenen Protokoll.
import type WebSocket from 'ws';
import type { ModelLists } from '../models.js';

export type ProviderId = 'openai' | 'gemini';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  cachedTokens: number;
}

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0, inputTextTokens: 0, outputTextTokens: 0, cachedTokens: 0 };

export interface CheckResult {
  ok: boolean;
  error?: string;
}

/** Tool-Definition, wie sie Brücke und Simulator führen (Format der OpenAI-Realtime-API); Anbieter setzen sie um. */
export interface LiveTool {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
}

/** Was eine Live-Verbindung beim Aufbau wissen muss. */
export interface LiveConfig {
  apiKey: string;
  model: string;
  instructions: string;
  voice: string;
  tools: readonly LiveTool[];
  /** false = Gegenüber kann die KI nicht unterbrechen */
  allowInterrupt: boolean;
  /** Stille in ms bis Satzende (Spracherkennung des Anbieters) */
  vadSilenceMs: number;
  /** Schwelle der Spracherkennung 0–1: höher = unempfindlicher */
  vadThreshold: number;
  /** Sprechgeschwindigkeit (1 = normal); nicht jeder Anbieter kann sie einstellen */
  speechSpeed: number;
  /** Obergrenze je Antwort; nicht jeder Anbieter kennt sie */
  maxOutputTokens: number;
  /** Namen, die die Transkription kennen soll */
  transcriptionHints: string[];
  /** Nur für Tests: liefert statt der echten Verbindung einen nachgestellten WebSocket */
  createSocket?: (url: string) => WebSocket;
}

/** Ende einer Antwort der KI. */
export interface LiveResponseDone {
  id?: string;
  /** 'completed' | 'incomplete' | 'cancelled' | 'failed' */
  status?: string;
  statusDetails?: unknown;
  /** Verbrauch dieser Antwort (wird von der Brücke aufsummiert) */
  usage?: Usage;
  /** Arten der Inhalte (nur fürs Log, wenn kein Audio kam) */
  outputTypes: string[];
}

export interface LiveError {
  /**
   * 'busy' = es läuft schon eine Antwort, die zusätzliche Anforderung ist verworfen;
   * 'cleanup' = ein Aufräum-Befehl (kürzen, löschen, abbrechen) wurde abgelehnt – ohne Folgen;
   * 'fatal' = das Gespräch kann so nicht weitergehen.
   */
  kind: 'busy' | 'cleanup' | 'fatal';
  code?: string;
  message?: string;
}

/** Ereignisse der Live-Verbindung an die Brücke. itemId kennzeichnet eine zusammenhängende Äußerung. */
export interface LiveEvents {
  /** Verbindung steht (vor der Konfiguration) */
  open(): void;
  /** Sitzung ist konfiguriert: Audio und Anforderungen werden angenommen */
  ready(): void;
  responseStarted(id?: string): void;
  /** Audio der KI: PCM16 LE in der Abtastrate `outputRate` der Sitzung */
  audio(itemId: string, pcm: Buffer): void;
  /** Text der KI: final=false liefert das nächste Stück, final=true den ganzen Text der Äußerung */
  aiText(itemId: string, text: string, final: boolean): void;
  /** Fertige Transkription einer Äußerung des Gegenübers ('' = nur ein Geräusch) */
  partnerText(itemId: string | undefined, text: string): void;
  speechStarted(itemId?: string): void;
  speechStopped(): void;
  /** Tool-Aufruf der KI; args als JSON-Text */
  toolCall(name: string, callId: string, args: string): void;
  responseDone(r: LiveResponseDone): void;
  error(e: LiveError): void;
  /** Fehler der Verbindung selbst */
  socketError(message: string): void;
  closed(code: number, reason: string): void;
}

/** Befehle der Brücke an die Live-Verbindung. */
export interface LiveSession {
  /** Name des Anbieters für Meldungen („Verbindung zu … beendet“) */
  readonly label: string;
  /** Abtastrate, in der die Sitzung Audio erwartet bzw. liefert (PCM16) */
  readonly inputRate: number;
  readonly outputRate: number;
  sendAudio(pcm: Int16Array): void;
  /** Anweisungen (und optional die Tool-Liste) im laufenden Gespräch ersetzen */
  update(instructions: string, tools?: readonly LiveTool[]): void;
  /** Antwort anfordern; instructions gelten nur für diese eine Antwort */
  respond(instructions?: string): void;
  /** Ergebnis eines Tool-Aufrufs; erzeugt allein noch keine Antwort (dafür respond) */
  toolOutput(callId: string, name: string, output: string): void;
  /** Hinweis der App in den Gesprächsverlauf legen, ohne eine Antwort anzufordern */
  note(text: string): void;
  /** Aufräumen (darf der Anbieter ablehnen oder gar nicht können): Äußerung auf das Gehörte kürzen */
  truncate(itemId: string, audioEndMs: number): void;
  deleteItem(itemId: string): void;
  cancelResponse(): void;
  close(): void;
}

/** Textmodell des gewählten Anbieters, fertig gebunden an Schlüssel und Modell. */
export type TextModel = (prompt: string, maxOutputTokens: number, format?: { name: string; schema: object }) => Promise<string>;

export interface VoiceSampleAudio {
  data: Buffer;
  /** Dateiendung für den Zwischenspeicher */
  ext: string;
  mime: string;
}

export interface AiProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Name der Variablen in der .env, in der der Schlüssel liegt */
  readonly keyEnv: string;
  /** Seite, auf der man den Schlüssel bekommt */
  readonly keyUrl: string;
  readonly voices: readonly string[];
  /** Stimmen, die nach einem Mann klingen (für die Spam-Rolle) */
  readonly maleVoices: readonly string[];
  /** Modelle, wenn nichts eingestellt ist; `known` dient als Auswahl, solange die Liste nicht geladen ist */
  readonly defaults: { realtime: string; text: string; known: readonly string[] };
  /** Längstes Gespräch in Sekunden, das die Live-Verbindung trägt (undefined = keine eigene Grenze) */
  readonly maxCallSeconds?: number;
  /** Was der Anbieter nicht kann; die Oberfläche benennt es */
  readonly supports: { speechSpeed: boolean; maxOutputTokens: boolean; updateInstructions: boolean };
  /** true, wenn die Modell-ID zu diesem Anbieter gehört */
  ownsModel(id: string): boolean;
  /** Form des Schlüssels grob prüfen; wirft mit Meldung */
  cleanKey(input: unknown): string;
  /** Schlüssel beim Anbieter prüfen; der Schlüssel geht nur dorthin und steht in keiner Meldung */
  checkKey(key: string, fetchImpl?: typeof fetch): Promise<CheckResult>;
  fetchModels(key: string, fetchImpl?: typeof fetch): Promise<ModelLists>;
  /** Textantwort (optional als JSON nach Schema); wirft bei Fehler oder leerer Antwort */
  text(key: string, model: string, prompt: string, maxOutputTokens: number, format?: { name: string; schema: object }, fetchImpl?: typeof fetch): Promise<string>;
  createLive(config: LiveConfig, events: LiveEvents): LiveSession;
  voiceSample(key: string, voice: string, text: string, fetchImpl?: typeof fetch): Promise<VoiceSampleAudio>;
  /** Kennung des Hörproben-Modells (Teil des Cache-Namens) */
  readonly sampleModel: string;
}
