// Live-Verbindung zur Gemini Live API (WebSocket, Schlüssel aus Google AI Studio): übersetzt zwischen deren
// Nachrichten und der anbieterunabhängigen Schnittstelle der Brücke. Zur API geht PCM16 mit 16 kHz, zurück kommt
// PCM16 mit 24 kHz. Stand der Dokumentation: 11.11.2026 (aistudio.google.com/docs/live-api).
//
// Was die Live API anders macht als OpenAI Realtime, und wie es hier abgebildet ist:
// - Keine Anweisung je Antwort und kein „Antwort anfordern“: Soll die KI von sich aus sprechen (Begrüßung, Wächter,
//   Verabschiedung), bekommt sie einen Text-Zug, der als Regieanweisung der App gekennzeichnet ist.
// - Systemanweisung und Tools stehen für die ganze Verbindung fest: Neue Anweisungen (Gesprächsplan, Wechsel in die
//   Spam-Abwehr) werden als Regieanweisung nachgereicht. Das wirkt schwächer als eine echte Systemanweisung.
// - Nach einem Tool-Ergebnis spricht das Modell von selbst weiter: Ergebnis und die Anweisung für die nächste
//   Antwort gehen deshalb zusammen als Tool-Antwort hinaus.
// - Keine Kennungen je Äußerung, kein Kürzen, Löschen oder Abbrechen: Die Befehle dafür bleiben ohne Wirkung.
//   Bei einer Unterbrechung entscheidet der Server selbst, was im Verlauf bleibt.
// - Transkription kommt in Stücken ohne Abschluss-Kennzeichen: Eine Äußerung des Gegenübers gilt als fertig, wenn
//   kurz kein Stück mehr kommt. Dass das Gegenüber zu sprechen beginnt, zeigt die Unterbrechung des Servers oder
//   das erste Stück Transkription.
import WebSocket from 'ws';
import { log } from '../../log.js';
import { EMPTY_USAGE, type LiveConfig, type LiveEvents, type LiveSession, type LiveTool, type Usage } from './types.js';

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
/** So lange nach dem letzten Stück Transkription gilt die Äußerung des Gegenübers als fertig */
const UTTERANCE_GAP_MS = 700;
/** Der Server meldete Sprache, aber es kommt keine Transkription: dann war es ein Geräusch */
const UTTERANCE_EMPTY_MS = 2000;
/**
 * Meldet der Server das Ende der Sprache selbst (ACTIVITY_END), zählt die Frist oben erst ab dort: Die Mitschrift kommt
 * erst nach dem Satzende, und ein Satz von mehr als zwei Sekunden galt sonst mitten im Reden als Geräusch.
 * So lange darf eine Äußerung dann höchstens offen bleiben, falls das Ende doch einmal ausbleibt.
 */
const UTTERANCE_OPEN_MS = 12000;

/**
 * Mitschrift der KI bereinigen: Für eine Antwort ohne Sprache liefert die Live API Platzhalter wie „<no speech>“,
 * „{pause}“ oder nur „...“. Solche Marken sind nichts Gesagtes und gehören nicht ins Transkript; bleibt danach
 * kein Buchstabe und keine Ziffer übrig, ist der Text leer.
 */
export function spokenText(text: string): string {
  const t = text.replace(/<[^<>]{1,40}>|\{[^{}]{1,40}\}/g, ' ').replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

/** Kennzeichen für Texte der App an das Modell; die Systemanweisung erklärt es (siehe REGIE_RULES). */
export const REGIE = '[Regie]';

const REGIE_RULES = [
  '## Regieanweisungen der Telefon-App',
  `Nachrichten, die mit ${REGIE} beginnen, stammen von der Telefon-App und nicht vom Gesprächspartner; er hört sie nicht. Befolge sie sofort. Lies sie nie vor, wiederhole sie nicht und erwähne sie nicht. Dasselbe gilt für Ergebnisse von Tool-Aufrufen.`,
  'Sprich ausschließlich Deutsch.',
].join('\n');

/** Die Live API kennt kein Sprechtempo; ein deutlich abweichender Wert wird wenigstens als Hinweis mitgegeben. */
function paceHint(speed: number): string {
  if (speed <= 0.9) return '\nSprich ruhig und eher langsam.';
  if (speed >= 1.15) return '\nSprich zügig.';
  return '';
}

export function geminiSystemText(config: Pick<LiveConfig, 'instructions' | 'speechSpeed'>): string {
  return `${config.instructions}\n\n${REGIE_RULES}${paceHint(config.speechSpeed)}`;
}

/** Tool-Definitionen ins Format der Gemini API; Funktionen ohne Parameter bekommen kein (leeres) Schema. */
export function geminiTools(tools: readonly LiveTool[]): object[] {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const props = (t.parameters as { properties?: object }).properties;
        const hasParams = props && Object.keys(props).length > 0;
        // BLOCKING: Das Modell wartet auf das Ergebnis, statt währenddessen weiterzusprechen
        return { name: t.name, description: t.description, ...(hasParams ? { parameters: t.parameters } : {}), behavior: 'BLOCKING' };
      }),
    },
  ];
}

/** Erste Nachricht der Verbindung. */
export function geminiSetup(config: LiveConfig): object {
  return {
    setup: {
      model: `models/${config.model.replace(/^models\//, '')}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } },
      },
      systemInstruction: { parts: [{ text: geminiSystemText(config) }] },
      tools: geminiTools(config.tools),
      realtimeInputConfig: {
        automaticActivityDetection: {
          // Telefon: lieber etwas unempfindlicher, damit Rascheln und Atmen nicht als Sprache gelten
          startOfSpeechSensitivity: config.vadThreshold >= 0.5 ? 'START_SENSITIVITY_LOW' : 'START_SENSITIVITY_HIGH',
          silenceDurationMs: config.vadSilenceMs,
        },
        activityHandling: config.allowInterrupt ? 'START_OF_ACTIVITY_INTERRUPTS' : 'NO_INTERRUPTION',
      },
      inputAudioTranscription: { languageCodes: ['de'] },
      outputAudioTranscription: {},
    },
  };
}

interface Details { modality?: string; tokenCount?: number }

function usageFrom(u: Record<string, unknown>): Usage {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const by = (list: unknown, modality: string) => (Array.isArray(list) ? (list as Details[]).filter((d) => d.modality === modality).reduce((n, d) => n + num(d.tokenCount), 0) : 0);
  return {
    inputTokens: num(u.promptTokenCount),
    outputTokens: num(u.responseTokenCount) + num(u.thoughtsTokenCount),
    inputAudioTokens: by(u.promptTokensDetails, 'AUDIO'),
    inputTextTokens: by(u.promptTokensDetails, 'TEXT'),
    outputAudioTokens: by(u.responseTokensDetails, 'AUDIO'),
    outputTextTokens: by(u.responseTokensDetails, 'TEXT') + num(u.thoughtsTokenCount),
    cachedTokens: num(u.cachedContentTokenCount),
  };
}

export class GeminiLive implements LiveSession {
  readonly label = 'Google Gemini';
  readonly inputRate = INPUT_RATE;
  readonly outputRate = OUTPUT_RATE;
  readonly toolCallsBlock = true;
  readonly answersAfterInterrupt = true;
  private ws: WebSocket;
  private closed = false;
  private configured = false;
  /** Der Server hat die Sitzung bestätigt: Erst dann nimmt er weitere Nachrichten an */
  private setupDone = false;
  // ---- Antwort der KI: ein „Zug" des Modells bekommt eine eigene Kennung ----
  private turn = 0;
  private turnOpen = false;
  private outText = '';
  /** Was vom laufenden Zug schon als Zwischenstand gemeldet ist (bereinigt) */
  private liveSent = '';
  private lateOut = '';
  /** Verbrauch, der in diesem Zug schon gemeldet wurde (die API kann ihn je Zug mehrfach und aufsummiert schicken) */
  private turnUsage: Usage = { ...EMPTY_USAGE };
  // ---- Äußerung des Gegenübers ----
  private utterance = 0;
  private partnerActive = false;
  private stoppedSent = false;
  private inText = '';
  private lateText = '';
  /** Bis dahin zählt Transkription als Nachtrag zur gerade abgeschlossenen Äußerung */
  private lateUntil = 0;
  private utteranceTimer?: NodeJS.Timeout;
  /** Der Server hat in dieser Sitzung schon einmal ACTIVITY_END geschickt: Dann ist auf das Sprachende Verlass */
  private sawActivityEnd = false;
  // ---- Was noch hinaus muss ----
  private pendingTools: { id: string; name: string; output: string }[] = [];
  private pendingUpdate?: string;
  private dispatching = false;

  constructor(private config: LiveConfig, private events: LiveEvents) {
    // Der Schlüssel steht in der Adresse (so verlangt es die API): Sie darf in keiner Meldung und keinem Log auftauchen
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.apiKey)}`;
    this.ws = config.createSocket ? config.createSocket(url) : new WebSocket(url);
    this.ws.on('open', () => {
      this.events.open();
      this.configured = true;
      this.send(geminiSetup(this.config));
    });
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('error', (err) => events.socketError(err.message.replace(/key=[^&\s]+/g, 'key=…')));
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      clearTimeout(this.utteranceTimer);
      events.closed(code, reason.toString());
    });
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.dispatching = true;
    try {
      this.dispatch(msg);
    } catch (err) {
      // Eine Nachricht in unerwarteter Form darf nicht den ganzen Prozess beenden: verwerfen, das Gespräch läuft weiter
      log.warn(`Gemini: Nachricht nicht verarbeitet (${(err as Error).message})`);
    } finally {
      this.dispatching = false;
    }
    // Tool-Ergebnisse, auf die keine eigene Anforderung folgte: jetzt abschicken, das Modell wartet darauf
    this.flushTools();
    this.flushUpdate();
  }

  private dispatch(msg: Record<string, unknown>): void {
    const e = this.events;
    if (msg.setupComplete) {
      this.setupDone = true;
      e.ready();
    }
    const va = msg.voiceActivity as { type?: string } | undefined;
    if (va?.type === 'ACTIVITY_START') this.startUtterance();
    if (va?.type === 'ACTIVITY_END') {
      this.sawActivityEnd = true;
      if (this.partnerActive) {
        this.stopSpeech('Sprachende laut Gemini');
        // Ab jetzt muss die Mitschrift kommen; bleibt sie aus, war es ein Geräusch
        if (!this.inText) this.armUtterance(UTTERANCE_EMPTY_MS);
      }
    }
    const sc = msg.serverContent as Record<string, unknown> | undefined;
    if (sc) {
      const heard = (sc.inputTranscription as { text?: string } | undefined)?.text;
      if (heard) this.onHeard(heard);
      const parts = (sc.modelTurn as { parts?: { inlineData?: { data?: string }; text?: string }[] } | undefined)?.parts ?? [];
      for (const p of parts) {
        if (!p?.inlineData?.data) continue;
        this.beginTurn();
        e.audio(this.itemId(), Buffer.from(p.inlineData.data, 'base64'));
      }
      const said = (sc.outputTranscription as { text?: string } | undefined)?.text;
      if (said && this.turnOpen) {
        this.outText += said;
        // Zwischenstand ohne Platzhalter („<no speech>“, „...“); ein angefangener Platzhalter („<no“) wartet auf sein Ende
        const clean = spokenText(this.outText.replace(/[<{][^<>{}]*$/, ''));
        if (clean.length > this.liveSent.length && clean.startsWith(this.liveSent)) {
          e.aiText(this.itemId(), clean.slice(this.liveSent.length), false);
          this.liveSent = clean;
        }
      } else if (said) {
        // Nachzügler der vorigen Antwort (die Reihenfolge ist nicht garantiert): kommt als Nachtrag ins Transkript
        this.lateOut += said;
      }
    }
    if (msg.usageMetadata) this.onUsage(usageFrom(msg.usageMetadata as Record<string, unknown>));
    const calls = (msg.toolCall as { functionCalls?: { id?: string; name?: string; args?: unknown }[] } | undefined)?.functionCalls;
    if (calls?.length) {
      // Das Modell hat reagiert, die Äußerung des Gegenübers ist also zu Ende: erst sie ins Transkript, dann der
      // Aufruf. Sonst stünde z. B. „Ergebnis laut KI“ vor dem Satz, auf den es sich bezieht.
      if (this.partnerActive && spokenText(this.inText)) {
        this.finishUtterance();
        // Stücke desselben Satzes, die erst jetzt kommen, sind ein Nachtrag und keine neue Äußerung
        this.lateUntil = Date.now() + UTTERANCE_GAP_MS;
      }
      this.beginTurn();
      for (const c of calls) if (c && typeof c === 'object') e.toolCall(String(c.name), String(c.id), JSON.stringify(c.args ?? {}));
      // Das Modell wartet jetzt auf das Ergebnis: Für die Brücke ist diese Antwort damit zu Ende
      this.endTurn('completed', ['function_call']);
    }
    if (sc?.interrupted) {
      // Der Server hat Sprache erkannt und die Antwort abgebrochen. Erst die Antwort beenden, dann die Sprache
      // melden: So kann die Brücke prüfen, ob es nur ein Zuhör-Laut war, statt den Rest sofort zu verwerfen.
      this.endTurn('cancelled', []);
      this.startUtterance();
    }
    if (sc?.turnComplete) {
      this.endTurn('completed', []);
      this.flushLateOut();
    }
    const away = msg.goAway as { timeLeft?: unknown } | undefined;
    if (away) log.warn(`Gemini: Der Server kündigt das Ende der Verbindung an (noch ${String(away.timeLeft ?? '?')})`);
    const cancelled = (msg.toolCallCancellation as { ids?: string[] } | undefined)?.ids;
    if (cancelled?.length) this.pendingTools = this.pendingTools.filter((t) => !cancelled.includes(t.id));
  }

  private itemId(): string {
    return `g${this.turn}`;
  }

  private beginTurn(): void {
    if (this.turnOpen) return;
    // Das Modell antwortet: Das Gegenüber hat also aufgehört zu sprechen
    if (this.partnerActive) {
      this.stopSpeech('die KI antwortet');
      // Noch keine Transkription, aber das Modell antwortet: Dann war es Sprache; die Brücke entscheidet nach ihrer eigenen Frist
      if (!this.inText) this.armUtterance(2 * UTTERANCE_EMPTY_MS);
    }
    this.flushLateOut();
    this.turn++;
    this.turnOpen = true;
    this.outText = '';
    this.liveSent = '';
    this.turnUsage = { ...EMPTY_USAGE };
    this.events.responseStarted(this.itemId());
  }

  private endTurn(status: string, outputTypes: string[]): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const id = this.itemId();
    const text = spokenText(this.outText);
    if (text) this.events.aiText(id, text, true);
    this.outText = '';
    this.events.responseDone({ id, status, outputTypes });
  }

  private flushLateOut(): void {
    const text = spokenText(this.lateOut);
    this.lateOut = '';
    if (text && this.turn > 0) this.events.aiText(this.itemId(), text, true);
  }

  /** Verbrauch melden: nur, was in diesem Zug noch nicht gemeldet wurde. */
  private onUsage(u: Usage): void {
    const delta = { ...EMPTY_USAGE };
    let any = false;
    for (const k of Object.keys(u) as (keyof Usage)[]) {
      delta[k] = Math.max(0, u[k] - this.turnUsage[k]);
      if (delta[k] > 0) any = true;
      this.turnUsage[k] = Math.max(u[k], this.turnUsage[k]);
    }
    if (any) this.events.usage?.(delta);
  }

  // ---- Äußerung des Gegenübers ----

  private startUtterance(): void {
    if (!this.partnerActive) {
      this.partnerActive = true;
      this.stoppedSent = false;
      this.inText = '';
      this.utterance++;
      this.events.speechStarted(`u${this.utterance}`);
    }
    this.armUtterance(this.inText ? UTTERANCE_GAP_MS : this.sawActivityEnd ? UTTERANCE_OPEN_MS : UTTERANCE_EMPTY_MS);
  }

  private stopSpeech(cause: string): void {
    if (this.stoppedSent) return;
    this.stoppedSent = true;
    log.info(`Gemini: Äußerung u${this.utterance} endet (${cause})`);
    this.events.speechStopped();
  }

  private onHeard(text: string): void {
    if (!this.partnerActive && (this.turnOpen || Date.now() < this.lateUntil)) {
      // Nachzügler der vorigen Äußerung, während die KI schon antwortet: nur ins Transkript, keine neue Sprache
      this.lateText += text;
      this.armUtterance(UTTERANCE_GAP_MS);
      return;
    }
    if (!this.partnerActive) this.startUtterance();
    this.inText += text;
    this.armUtterance(UTTERANCE_GAP_MS);
  }

  private armUtterance(ms: number): void {
    clearTimeout(this.utteranceTimer);
    this.utteranceTimer = setTimeout(() => this.finishUtterance(), ms);
    this.utteranceTimer.unref();
  }

  private finishUtterance(): void {
    clearTimeout(this.utteranceTimer);
    this.utteranceTimer = undefined;
    if (this.closed) return;
    if (this.partnerActive) {
      this.stopSpeech(this.inText ? 'Pause nach der Mitschrift' : 'Frist ohne Mitschrift');
      this.partnerActive = false;
      // Platzhalter der Transkription („<noise>“) sind nichts Gesagtes: Die Äußerung gilt dann als Geräusch
      this.events.partnerText(`u${this.utterance}`, spokenText(this.inText));
      this.inText = '';
    }
    if (spokenText(this.lateText)) this.events.partnerText(`u${this.utterance}n`, spokenText(this.lateText));
    this.lateText = '';
  }

  // ---- Befehle der Brücke ----

  sendAudio(pcm: Int16Array): void {
    this.send({ realtimeInput: { audio: { data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } });
  }

  update(instructions: string): void {
    this.config.instructions = instructions;
    if (!this.configured) return;
    // Die Systemanweisung lässt sich nicht mehr ändern: als Regieanweisung nachreichen (mit dem nächsten Tool-Ergebnis oder allein)
    this.pendingUpdate = `Ab jetzt gelten diese Anweisungen; sie ersetzen deine bisherigen vollständig:\n\n${instructions}`;
    if (!this.dispatching) queueMicrotask(() => this.flushUpdate());
  }

  respond(instructions?: string): void {
    if (this.pendingTools.length) return this.flushTools(instructions);
    const update = this.takeUpdate();
    const text = [update, instructions ?? 'Sprich jetzt weiter: Reagiere kurz auf das zuletzt Gesagte.'].filter(Boolean).join('\n\n');
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `${REGIE} ${text}` }] }], turnComplete: true } });
  }

  toolOutput(callId: string, name: string, output: string): void {
    this.pendingTools.push({ id: callId, name, output });
    // Außerhalb einer Servernachricht (z. B. nach einer gescheiterten Vermittlung): gleich abschicken,
    // sofern nicht unmittelbar eine Anforderung folgt, die das Ergebnis mitnimmt
    if (!this.dispatching) queueMicrotask(() => this.flushTools());
  }

  note(text: string): void {
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `${REGIE} ${text}` }] }], turnComplete: false } });
  }

  truncate(): void {
    // Kann die Live API nicht: Der Server geht davon aus, dass sein Audio in Echtzeit gehört wurde
  }

  deleteItem(): void {
    // Kann die Live API nicht
  }

  cancelResponse(): void {
    // Kann die Live API nicht; die Brücke lässt die Antwort stumm
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.utteranceTimer);
    try {
      this.ws.close();
    } catch {
      // bereits zu
    }
  }

  private takeUpdate(): string | undefined {
    const u = this.pendingUpdate;
    this.pendingUpdate = undefined;
    return u;
  }

  /** Wartende Tool-Ergebnisse abschicken; neue Anweisungen und die Anweisung für die nächste Antwort hängen am letzten. */
  private flushTools(instructions?: string): void {
    if (!this.pendingTools.length) return;
    const tools = this.pendingTools;
    this.pendingTools = [];
    const extra = [this.takeUpdate(), instructions].filter(Boolean).join('\n\n');
    this.send({
      toolResponse: {
        functionResponses: tools.map((t, i) => ({ id: t.id, name: t.name, response: { result: i === tools.length - 1 && extra ? `${t.output}\n\n${extra}` : t.output } })),
      },
    });
  }

  private flushUpdate(): void {
    // Vor der Bestätigung der Sitzung bleibt die Anweisung liegen; die Bestätigung selbst löst das Nachreichen aus
    if (!this.setupDone) return;
    const u = this.takeUpdate();
    if (u) this.note(u);
  }

  private send(obj: unknown): void {
    if (this.closed) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}
