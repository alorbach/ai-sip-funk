// Zustandsmaschine der Realtime-Brücke gegen einen nachgestellten WebSocket: Begrüßung, Stillstandswächter,
// Unterbrechungsprüfung, Verabschiedung und Auflegen, Fehlerbehandlung. Ohne Telefon und ohne OpenAI.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { RealtimeBridge, type RealtimeBridgeOptions, type TranscriptEntry } from '../src/ai/realtimeBridge.js';

type Sent = { type: string; event_id?: string; item_id?: string; response?: { instructions?: string }; item?: { type?: string; output?: string; role?: string } };

class FakeSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: Sent[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }
  close(): void {
    this.readyState = 3;
  }
}

function setup(t: TestContext, over: Partial<RealtimeBridgeOptions> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ws = new FakeSocket();
  const transcripts: TranscriptEntry[] = [];
  const errors: string[] = [];
  const ended: string[] = [];
  const bridge = new RealtimeBridge({
    apiKey: 'test',
    model: 'test-model',
    instructions: 'Test',
    voice: 'marin',
    greetingInstruction: 'GRUSS',
    formal: true,
    allowInterrupt: true,
    outputGain: 1,
    speechSpeed: 1,
    vadSilenceMs: 500,
    hangupGraceMs: 1000,
    stallMs: 0,
    greetingWaitMs: 0,
    onTranscript: (e) => transcripts.push(e),
    onUsage: () => undefined,
    onEndCall: (reason) => ended.push(reason),
    onError: (m) => errors.push(m),
    createSocket: () => ws as unknown as WebSocket,
    ...over,
  });
  const server = (ev: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify(ev)));
  const tick = (ms: number) => t.mock.timers.tick(ms);
  /** ms Audio der KI als Delta (PCM16, 24 kHz) */
  const audio = (item: string, ms: number) => server({ type: 'response.output_audio.delta', item_id: item, delta: Buffer.alloc(ms * 48).toString('base64') });
  /** Vollständige Antwort der KI: ms Audio in einem Item */
  const say = (id: string, item: string, ms: number, text = 'Text') => {
    server({ type: 'response.created', response: { id } });
    audio(item, ms);
    server({ type: 'response.output_audio_transcript.done', item_id: item, transcript: text });
    server({ type: 'response.done', response: { id, status: 'completed' } });
  };
  /** Spielt Frames aus, bis die Brücke nichts mehr liefert; liefert die gespielte Dauer in ms */
  const drain = (maxMs = 60_000) => {
    let played = 0;
    tick(500); // Vorpuffer-Wartezeit
    while (played < maxMs && bridge.nextFrame()) played += 20;
    return played;
  };
  const types = () => ws.sent.map((s) => s.type);
  const count = (type: string) => ws.sent.filter((s) => s.type === type).length;
  const creates = () => ws.sent.filter((s) => s.type === 'response.create').map((s) => s.response?.instructions ?? '');

  ws.emit('open');
  server({ type: 'session.updated' });
  bridge.onConnected(8000);
  tick(0); // Begrüßung von sich aus
  return { bridge, ws, server, tick, audio, say, drain, types, count, creates, transcripts, errors, ended };
}

/** Begrüßung abschließen, damit das eigentliche Gespräch beginnt */
function greeted(h: ReturnType<typeof setup>): void {
  h.say('r0', 'i0', 400, 'Hallo?');
  h.drain();
  h.ws.sent.length = 0;
}

/** end_call ohne Sprache -> Verabschiedung angefordert -> gesprochen (Antwort-ID bye) */
function endCall(h: ReturnType<typeof setup>, farewellMs = 1000): void {
  h.server({ type: 'response.created', response: { id: 'tool' } });
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{"ergebnis":"erledigt"}' });
  h.server({ type: 'response.done', response: { id: 'tool', status: 'completed' } });
  h.say('bye', 'ibye', farewellMs, 'Auf Wiederhören');
}

test('Begrüßung: KI grüßt von sich aus, eine zweite Nachricht in der Begrüßung wird verworfen', (t) => {
  const h = setup(t);
  assert.deepEqual(h.creates(), ['GRUSS']);
  h.server({ type: 'response.created', response: { id: 'r0' } });
  h.audio('i0', 400);
  h.audio('i1', 400);
  h.server({ type: 'response.done', response: { id: 'r0', status: 'completed' } });
  assert.equal(h.drain(), 400);
  assert.deepEqual(h.ws.sent.filter((s) => s.type === 'conversation.item.delete').map((s) => s.item_id), ['i1']);
  h.bridge.close();
});

test('Begrüßung: Meldet sich das Gegenüber zuerst, grüßt die KI nicht von sich aus', (t) => {
  const h = setup(t, { greetingWaitMs: 2000 });
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.tick(5000);
  assert.deepEqual(h.creates(), []);
  h.bridge.close();
});

test('Begrüßung: Geräusch vor der Begrüßung – die KI begrüßt, sobald feststeht, dass nichts gesagt wurde', (t) => {
  const h = setup(t, { greetingWaitMs: 2000 });
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.tick(500);
  assert.deepEqual(h.creates(), []);
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '' });
  assert.deepEqual(h.creates(), ['GRUSS']);
  h.say('r0', 'i0', 400, 'Guten Tag');
  h.tick(10_000);
  assert.deepEqual(h.creates(), ['GRUSS'], 'nur einmal');
  h.bridge.close();
});

test('Begrüßung: Meldung des Gegenübers ohne Antwort der KI – die KI begrüßt nach kurzer Frist selbst', (t) => {
  const h = setup(t, { greetingWaitMs: 2000 });
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.tick(1900);
  assert.deepEqual(h.creates(), []);
  h.tick(100);
  assert.deepEqual(h.creates(), ['GRUSS']);
  h.bridge.close();
});

test('Begrüßung: Antwortet die KI auf die Meldung des Gegenübers, kommt keine zweite Begrüßung', (t) => {
  const h = setup(t, { greetingWaitMs: 2000 });
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.say('r0', 'i0', 400, 'Guten Tag');
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '' });
  h.tick(10_000);
  assert.deepEqual(h.creates(), []);
  h.bridge.close();
});

test('Stillstandswächter: stößt nach Stille an, höchstens zweimal, nicht solange das Gegenüber spricht', (t) => {
  const h = setup(t, { stallMs: 3000 });
  greeted(h);
  h.tick(3000);
  assert.equal(h.count('response.create'), 1);
  h.say('r1', 'i1', 400);
  h.drain();
  h.tick(3000);
  assert.equal(h.count('response.create'), 2);
  h.say('r2', 'i2', 400);
  h.drain();
  h.tick(10_000);
  assert.equal(h.count('response.create'), 2, 'kein dritter Anstoß');
  // Gegenüber spricht: Zähler zurück, aber kein Anstoß während es redet
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.say('r3', 'i3', 400);
  h.drain();
  h.tick(10_000);
  assert.equal(h.count('response.create'), 2);
  h.bridge.close();
});

test('Unterbrechung: Zuhör-Laut lässt die KI ihren Satz zu Ende sprechen, die Antwort darauf bleibt stumm', (t) => {
  const h = setup(t);
  greeted(h);
  h.say('r1', 'i1', 4000);
  assert.equal(h.drain(1000), 1000);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  assert.equal(h.bridge.nextFrame(), undefined, 'Ausgabe pausiert');
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'response.created', response: { id: 'r2' } });
  h.audio('i2', 600);
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Mhm.' });
  assert.equal(h.count('response.cancel'), 1);
  assert.deepEqual(h.ws.sent.filter((s) => s.type === 'conversation.item.delete').map((s) => s.item_id), ['i2']);
  h.audio('i2', 600); // Rest der abgebrochenen Antwort
  h.server({ type: 'response.done', response: { id: 'r2', status: 'cancelled' } });
  assert.equal(h.drain(), 3000, 'nur der Rest des alten Satzes');
  assert.deepEqual(h.errors, []);
  h.bridge.close();
});

test('Unterbrechung: Inhalt verwirft den Rest, die neue Antwort wird gespielt', (t) => {
  const h = setup(t);
  greeted(h);
  h.say('r1', 'i1', 4000);
  h.drain(1000);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'response.created', response: { id: 'r2' } });
  h.audio('i2', 600);
  // Verspätete Transkription des Satzes davor entscheidet nicht
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u0', transcript: 'Mhm.' });
  assert.equal(h.bridge.nextFrame(), undefined, 'Prüfung läuft noch');
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Nein, Moment bitte.' });
  const trunc = h.ws.sent.find((s) => s.type === 'conversation.item.truncate');
  assert.equal(trunc?.item_id, 'i1');
  h.server({ type: 'response.done', response: { id: 'r2', status: 'completed' } });
  assert.equal(h.drain(), 600);
  h.bridge.close();
});

test('Unterbrechung: gehörte Länge wird je Nachricht gemeldet – die laufende bis zur Stelle, die noch nicht begonnene ab 0', (t) => {
  const h = setup(t);
  greeted(h);
  h.server({ type: 'response.created', response: { id: 'r1' } });
  h.audio('i1', 1000);
  h.audio('i2', 3000);
  h.server({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  assert.equal(h.drain(600), 600);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Halt, das stimmt so nicht.' });
  const trunc = h.ws.sent.filter((s) => s.type === 'conversation.item.truncate') as (Sent & { audio_end_ms?: number })[];
  assert.deepEqual(trunc.map((s) => [s.item_id, s.audio_end_ms]), [['i1', 600], ['i2', 0]]);
  h.bridge.close();
});

test('Unterbrechung: ohne Transkription gilt das Gesagte nach 3 s als Inhalt', (t) => {
  const h = setup(t);
  greeted(h);
  h.say('r1', 'i1', 4000);
  h.drain(1000);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.tick(3000);
  assert.equal(h.count('conversation.item.truncate'), 1);
  assert.equal(h.drain(), 0);
  h.bridge.close();
});

test('Unterbrechung und end_call zugleich: Der Tool-Aufruf entscheidet die Prüfung, die Verabschiedung wird nicht abgebrochen', (t) => {
  const h = setup(t);
  greeted(h);
  h.say('r1', 'i1', 4000);
  h.drain(1000);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'response.created', response: { id: 'tool' } });
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{}' });
  h.server({ type: 'response.done', response: { id: 'tool', status: 'completed' } });
  assert.equal(h.count('conversation.item.truncate'), 1, 'Rest des alten Satzes verworfen');
  assert.equal(h.count('response.create'), 1, 'Verabschiedung angefordert');
  h.server({ type: 'response.created', response: { id: 'bye' } });
  h.audio('ibye', 1000);
  // Die Transkription kommt erst jetzt und ist nur ein Laut: Sie darf die Verabschiedung nicht mehr abbrechen
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Mhm.' });
  assert.equal(h.count('response.cancel'), 0);
  h.server({ type: 'response.done', response: { id: 'bye', status: 'completed' } });
  assert.equal(h.drain(), 1000);
  h.bridge.nextFrame();
  h.tick(1000);
  assert.equal(h.ended.length, 1);
  h.bridge.close();
});

test('Auflegen: end_call -> Verabschiedung -> ausgespielt -> Nachhörphase -> onEndCall', (t) => {
  const h = setup(t);
  greeted(h);
  endCall(h);
  assert.equal(h.ws.sent.filter((s) => s.item?.type === 'function_call_output').length, 1);
  assert.equal(h.count('response.create'), 1);
  assert.equal(h.drain(), 1000);
  h.bridge.nextFrame();
  h.tick(999);
  assert.deepEqual(h.ended, []);
  h.tick(1);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('Auflegen: Geräusch in der Nachhörphase ändert nichts, die Antwort darauf bleibt stumm', (t) => {
  const h = setup(t);
  greeted(h);
  endCall(h);
  h.drain();
  h.bridge.nextFrame();
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'response.created', response: { id: 'r2' } });
  h.audio('i2', 800);
  h.tick(2000);
  assert.deepEqual(h.ended, [], 'wartet auf die Transkription');
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '' });
  assert.equal(h.count('response.cancel'), 1);
  h.server({ type: 'response.done', response: { id: 'r2', status: 'cancelled' } });
  assert.equal(h.drain(), 0);
  h.tick(1000);
  assert.equal(h.ended.length, 1);
  h.bridge.close();
});

test('Auflegen: Inhalt in der Nachhörphase nimmt das Beenden zurück und spielt die Antwort', (t) => {
  const h = setup(t);
  greeted(h);
  endCall(h);
  h.drain();
  h.bridge.nextFrame();
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'response.created', response: { id: 'r2' } });
  h.audio('i2', 800);
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Eine Frage habe ich noch zur Rechnung.' });
  h.server({ type: 'response.done', response: { id: 'r2', status: 'completed' } });
  assert.equal(h.drain(), 800);
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  assert.ok(h.ws.sent.some((s) => s.item?.role === 'system'), 'Modell erfährt, dass es weitergeht');
  h.bridge.close();
});

test('Auflegen: erst Geräusch, dann echte Sprache – die Antwort auf die Sprache wird nicht verschluckt', (t) => {
  const h = setup(t);
  greeted(h);
  endCall(h);
  h.drain();
  h.bridge.nextFrame();
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '' });
  h.tick(500);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u2' });
  h.server({ type: 'response.created', response: { id: 'r2' } });
  h.audio('i2', 800);
  h.server({ type: 'response.done', response: { id: 'r2', status: 'completed' } });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'Halt, wann kommt der Techniker?' });
  assert.equal(h.drain(), 800);
  assert.deepEqual(h.ended, []);
  h.bridge.close();
});

test('Auflegen: „Ja" und das Gegenüber redet weiter – erst die nächste Äußerung entscheidet', (t) => {
  const h = setup(t);
  greeted(h);
  endCall(h);
  h.drain();
  h.bridge.nextFrame();
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Ja.' });
  h.tick(1500);
  assert.deepEqual(h.ended, [], 'nicht mitten im Satz auflegen');
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u2' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'Danke, tschüss.' });
  h.tick(1000);
  assert.equal(h.ended.length, 1);
  h.bridge.close();
});

test('Auflegen: Geräusch während die Verabschiedung noch entsteht bricht sie nicht ab (Unterbrechen aus)', (t) => {
  const h = setup(t, { allowInterrupt: false });
  greeted(h);
  h.server({ type: 'response.created', response: { id: 'tool' } });
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{}' });
  h.server({ type: 'response.done', response: { id: 'tool', status: 'completed' } });
  h.server({ type: 'response.created', response: { id: 'bye' } });
  h.audio('ibye', 500);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '' });
  assert.equal(h.count('response.cancel'), 0);
  h.audio('ibye', 500);
  h.server({ type: 'response.done', response: { id: 'bye', status: 'completed' } });
  assert.equal(h.drain(), 1000);
  h.bridge.nextFrame();
  h.tick(1000);
  assert.equal(h.ended.length, 1);
  h.bridge.close();
});

test('Auflegen: abgelehnte Verabschiedungs-Anforderung wird nach der laufenden Antwort wiederholt', (t) => {
  const h = setup(t);
  greeted(h);
  h.server({ type: 'response.created', response: { id: 'tool' } });
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{}' });
  h.server({ type: 'response.done', response: { id: 'tool', status: 'completed' } });
  assert.equal(h.count('response.create'), 1);
  // Die Server-VAD war schneller: ihre Antwort läuft, unsere Anforderung wird abgelehnt
  h.server({ type: 'response.created', response: { id: 'vad' } });
  h.server({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'x' } });
  h.server({ type: 'response.done', response: { id: 'vad', status: 'completed' } });
  assert.equal(h.count('response.create'), 2, 'Verabschiedung erneut angefordert');
  h.say('bye', 'ibye', 1000);
  h.drain();
  h.bridge.nextFrame();
  h.tick(1000);
  assert.equal(h.ended.length, 1);
  assert.deepEqual(h.errors, []);
  h.bridge.close();
});

test('Auflegen: bleibt die Verabschiedung aus, legt das Sicherheitsnetz nach 30 s auf', (t) => {
  const h = setup(t);
  greeted(h);
  h.server({ type: 'response.created', response: { id: 'tool' } });
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{}' });
  h.server({ type: 'response.done', response: { id: 'tool', status: 'completed' } });
  h.tick(30_000);
  h.tick(1000);
  assert.equal(h.ended.length, 1);
  h.bridge.close();
});

test('end_call zusammen mit Sprache: abgelehnt; die Schweigefrist läuft erst nach dem Ausspielen des Satzes', (t) => {
  const h = setup(t);
  greeted(h);
  h.server({ type: 'response.created', response: { id: 'r1' } });
  h.audio('i1', 6000);
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{}' });
  h.server({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  assert.match(h.ws.sent.find((s) => s.item?.type === 'function_call_output')?.item?.output ?? '', /Nicht beendet/);
  h.tick(2500);
  assert.equal(h.count('response.create'), 0, 'der Satz läuft noch');
  h.tick(6000);
  assert.equal(h.count('response.create'), 1);
  h.bridge.close();
});

test('Fehler: abgelehntes Aufräumen und doppelte Antwortanforderung beenden das Gespräch nicht, echte Fehler schon', (t) => {
  const h = setup(t);
  greeted(h);
  h.say('r1', 'i1', 4000);
  h.drain(1000);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Stopp, das stimmt nicht.' });
  const trunc = h.ws.sent.find((s) => s.type === 'conversation.item.truncate');
  assert.match(trunc?.event_id ?? '', /^opt_/);
  h.server({ type: 'error', error: { code: 'invalid_value', message: 'Audio content already shorter', event_id: trunc?.event_id } });
  h.server({ type: 'error', error: { code: 'response_cancel_not_active', message: 'x' } });
  h.server({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'x' } });
  assert.deepEqual(h.errors, []);
  h.server({ type: 'error', error: { code: 'session_expired', message: 'Sitzung abgelaufen' } });
  assert.deepEqual(h.errors, ['Sitzung abgelaufen']);
  h.bridge.close();
});

test('Audio-Wächter: fordert nach 5 s Stille einmal eine Antwort an, nicht in einer Schleife', (t) => {
  const h = setup(t);
  greeted(h);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.tick(5000);
  assert.equal(h.count('response.create'), 1);
  h.tick(60_000);
  assert.equal(h.count('response.create'), 1);
  h.bridge.close();
});

test('close(): danach feuert kein Timer mehr und ein Verbindungsfehler meldet nichts', (t) => {
  const h = setup(t, { stallMs: 3000 });
  greeted(h);
  h.say('r1', 'i1', 4000);
  h.drain(1000);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.bridge.close();
  h.ws.emit('error', new Error('WebSocket was closed before the connection was established'));
  h.ws.emit('close', 1006, Buffer.alloc(0));
  h.tick(120_000);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.ended, []);
  assert.equal(h.ws.sent.length, 0);
  assert.equal(h.bridge.nextFrame(), undefined);
});

test('Vermittlung: Während die Box verbindet, stößt der Stillstandswächter die KI nicht an', async (t) => {
  let finish: (r: { ok: boolean; reason: string }) => void = () => undefined;
  const h = setup(t, { stallMs: 3000, onTransfer: () => new Promise((r) => (finish = r)) });
  greeted(h);
  h.server({ type: 'response.created', response: { id: 'r1' } });
  h.server({ type: 'response.function_call_arguments.done', name: 'transfer_call', call_id: 'c1', arguments: '{}' });
  h.server({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  await new Promise((r) => setImmediate(r));
  h.tick(20_000);
  assert.equal(h.count('response.create'), 0);
  finish({ ok: false, reason: 'besetzt' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.count('response.create'), 1, 'Modell erfährt den Fehlschlag');
  h.bridge.close();
});

test('Echo-Erkennung: dieselben Wörter in derselben Reihenfolge; Fragen, Zahlen und Antwortwörter sind Inhalt', async () => {
  const { isEcho } = await import('../src/ai/farewell.js');
  const spoken = 'Ich soll Ihnen schöne Grüße von André ausrichten, direkt aus seiner Sitzung. Ich wünsche Ihnen einen schönen Tag, ja?';
  assert.equal(isEcho('von', spoken), true);
  assert.equal(isEcho('Ich wünsche Ihnen', spoken), true);
  assert.equal(isEcho('Grüße von André', spoken), true);
  assert.equal(isEcho('Ja.', spoken), false, 'ein Antwortwort ist nie ein Echo');
  assert.equal(isEcho('Von André?', spoken), false, 'eine Frage ist Inhalt');
  assert.equal(isEcho('Grüße an André', spoken), false, 'andere Wortfolge');
  assert.equal(isEcho('Das war abgebrochen', spoken), false);
  assert.equal(isEcho('', spoken), false);
  assert.equal(isEcho('von', ''), false);
});

test('Laut ohne Worte: Nach einem deutlichen Laut und Ruhe geht die KI darauf ein; ein Knacken oder Sprache zählt nicht', (t) => {
  const h = setup(t);
  greeted(h);
  const frame = (level: number) => { h.tick(20); h.bridge.onRemoteAudio(new Int16Array(160).fill(level)); };
  // kurz nach der eigenen Ausgabe zählt nichts (Echo), danach 600 ms Lachen, dann Ruhe
  for (let i = 0; i < 25; i++) frame(0);
  for (let i = 0; i < 30; i++) frame(4000);
  for (let i = 0; i < 59; i++) frame(20);
  assert.equal(h.count('response.create'), 0, 'noch nicht lange genug ruhig');
  for (let i = 0; i < 3; i++) frame(20);
  assert.equal(h.count('response.create'), 1);
  assert.match(h.creates()[0], /hörbar reagiert, aber ohne Worte/);
  h.say('r1', 'i1', 400, 'Schön, dass er dir gefällt!');
  h.drain();
  h.ws.sent.length = 0;
  // ein Knacken von 100 ms: nichts
  for (let i = 0; i < 25; i++) frame(0);
  for (let i = 0; i < 5; i++) frame(4000);
  for (let i = 0; i < 80; i++) frame(20);
  assert.equal(h.count('response.create'), 0);
  // der Anbieter meldet Sprache: Das ist kein Laut ohne Worte
  for (let i = 0; i < 10; i++) frame(4000);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  for (let i = 0; i < 30; i++) frame(4000);
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'response.created', response: { id: 'r2' } });
  for (let i = 0; i < 80; i++) frame(20);
  assert.equal(h.count('response.create'), 0);
  h.bridge.close();
});

test('Stillstandswächter: War das Gegenüber eben noch zu hören, wartet er weiter', (t) => {
  const h = setup(t, { stallMs: 3000 });
  greeted(h);
  const frame = (level: number) => { h.tick(20); h.bridge.onRemoteAudio(new Int16Array(160).fill(level)); };
  // anhaltendes Nebengeräusch: nie lange genug ruhig für „Laut ohne Worte", aber auch kein Stillstand
  for (let i = 0; i < 150; i++) frame(4000);
  assert.equal(h.count('response.create'), 0, 'nach 3 s kein Anstoß, das Gegenüber ist zu hören');
  for (let i = 0; i < 400; i++) frame(4000);
  assert.equal(h.count('response.create'), 1, 'nach zweimal Warten stößt der Wächter doch an');
  h.bridge.close();
});

test('Stillstandswächter: Die Anweisung lässt der KI die Wahl, das Gespräch zu beenden, statt in jedem Fall nachzufragen', (t) => {
  const h = setup(t, { stallMs: 3000 });
  greeted(h);
  h.tick(3000);
  assert.equal(h.count('response.create'), 1);
  assert.match(h.creates()[0], /Habt ihr euch schon verabschiedet oder ist aus deiner Sicht alles gesagt, dann frag nicht weiter nach, sondern rufe end_call auf/);
  h.bridge.close();
});
