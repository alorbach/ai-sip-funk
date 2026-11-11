// Live-Verbindung zur OpenAI-Realtime-API (WebSocket): übersetzt zwischen deren Ereignissen und der
// anbieterunabhängigen Schnittstelle der Brücke. PCM16 mit 24 kHz in beide Richtungen.
import WebSocket from 'ws';
import type { LiveConfig, LiveEvents, LiveSession, LiveTool, Usage } from './types.js';

/** Abtastrate von und zur Realtime-API (PCM16) */
const AI_RATE = 24000;

export class OpenAiLive implements LiveSession {
  readonly label = 'OpenAI';
  readonly inputRate = AI_RATE;
  readonly outputRate = AI_RATE;
  private ws: WebSocket;
  private closed = false;
  private configured = false;
  private optSeq = 0;

  constructor(private config: LiveConfig, private events: LiveEvents) {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`;
    this.ws = config.createSocket ? config.createSocket(url) : new WebSocket(url, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('error', (err) => events.socketError(err.message));
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      events.closed(code, reason.toString());
    });
  }

  private onOpen(): void {
    this.events.open();
    const c = this.config;
    this.configured = true;
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: c.instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AI_RATE },
            // Telefonhörer am Ohr: Rauschfilter für nahe Mikrofone, damit Rascheln und Klappern nicht als Sprache gelten
            noise_reduction: { type: 'near_field' },
            turn_detection: { type: 'server_vad', create_response: true, interrupt_response: c.allowInterrupt, silence_duration_ms: c.vadSilenceMs, threshold: c.vadThreshold },
            transcription: {
              model: 'gpt-transcribe',
              language: 'de',
              // Namen als Hinweis, damit eine Meldung mit Nachnamen beim Abnehmen richtig ankommt
              prompt: `Deutsches Telefongespräch. Namen: ${c.transcriptionHints.filter(Boolean).join(', ') || '–'}.`,
            },
          },
          output: { format: { type: 'audio/pcm', rate: AI_RATE }, voice: c.voice, speed: c.speechSpeed },
        },
        tools: c.tools,
        tool_choice: 'auto',
        // Notbremse gegen Monologe (Audio kostet ~40 Token/s, 900 ≈ 22 s). Die eigentliche Kürze kommt aus dem Prompt;
        // Gespräche mit gewollt langem Bericht (Rückruf an den Inhaber) heben das Limit an.
        max_output_tokens: c.maxOutputTokens,
      },
    });
  }

  private onMessage(raw: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    const e = this.events;
    switch (String(ev.type)) {
      case 'session.updated':
        e.ready();
        break;
      case 'response.created':
        e.responseStarted((ev.response as { id?: string } | undefined)?.id);
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        e.audio(String(ev.item_id), Buffer.from(String(ev.delta), 'base64'));
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        e.aiText(String(ev.item_id), String(ev.delta), false);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        e.aiText(String(ev.item_id), String(ev.transcript), true);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        e.partnerText(typeof ev.item_id === 'string' ? ev.item_id : undefined, String(ev.transcript ?? '').trim());
        break;
      case 'input_audio_buffer.speech_started':
        e.speechStarted(typeof ev.item_id === 'string' ? ev.item_id : undefined);
        break;
      case 'input_audio_buffer.speech_stopped':
        e.speechStopped();
        break;
      case 'response.function_call_arguments.done':
        e.toolCall(String(ev.name), String(ev.call_id), String(ev.arguments));
        break;
      case 'response.done': {
        const r = ev.response as { id?: string; usage?: Record<string, unknown>; status?: string; status_details?: unknown; output?: { type?: string }[] } | undefined;
        e.responseDone({ id: r?.id, status: r?.status, statusDetails: r?.status_details, usage: r?.usage ? usageFrom(r.usage) : undefined, outputTypes: (r?.output ?? []).map((o) => o.type ?? '?') });
        break;
      }
      case 'error': {
        const err = ev.error as { message?: string; code?: string; event_id?: string } | undefined;
        // Zwei Auslöser wollten gleichzeitig eine Antwort (z. B. Wächter und Server-VAD)
        if (err?.code === 'conversation_already_has_active_response') e.error({ kind: 'busy', code: err.code, message: err.message });
        // Abgelehntes Aufräumen (Antwort war schon fertig, Item schon weg, Kürzung hinter dem Ende)
        else if (err?.code === 'response_cancel_not_active' || String(err?.event_id ?? '').startsWith('opt_')) e.error({ kind: 'cleanup', code: err?.code, message: err?.message });
        else e.error({ kind: 'fatal', code: err?.code, message: err?.message });
        break;
      }
      default:
        break;
    }
  }

  sendAudio(pcm: Int16Array): void {
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
  }

  update(instructions: string, tools?: readonly LiveTool[]): void {
    this.config.instructions = instructions;
    if (tools) this.config.tools = tools;
    // Vor dem Aufbau genügt es, die Vorgabe zu ersetzen; danach geht ein Update an die API
    if (this.configured) this.send({ type: 'session.update', session: { type: 'realtime', instructions, ...(tools ? { tools } : {}) } });
  }

  respond(instructions?: string): void {
    this.send(instructions === undefined ? { type: 'response.create' } : { type: 'response.create', response: { instructions } });
  }

  toolOutput(callId: string, _name: string, output: string): void {
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
  }

  note(text: string): void {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
  }

  truncate(itemId: string, audioEndMs: number): void {
    this.sendOptional({ type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: audioEndMs });
  }

  deleteItem(itemId: string): void {
    this.sendOptional({ type: 'conversation.item.delete', item_id: itemId });
  }

  cancelResponse(): void {
    this.sendOptional({ type: 'response.cancel' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // bereits zu
    }
  }

  /** Aufräum-Ereignis (cancel, truncate, delete): Lehnt die API es ab, ist das kein Grund aufzulegen (kind 'cleanup'). */
  private sendOptional(obj: Record<string, unknown>): void {
    this.send({ ...obj, event_id: `opt_${++this.optSeq}` });
  }

  private send(obj: unknown): void {
    if (this.closed) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}

function usageFrom(u: Record<string, unknown>): Usage {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const inD = (u.input_token_details ?? {}) as Record<string, unknown>;
  const outD = (u.output_token_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    inputAudioTokens: num(inD.audio_tokens),
    inputTextTokens: num(inD.text_tokens),
    cachedTokens: num(inD.cached_tokens),
    outputAudioTokens: num(outD.audio_tokens),
    outputTextTokens: num(outD.text_tokens),
  };
}
