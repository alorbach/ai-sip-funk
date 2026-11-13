// Gemini als Anbieter gegen einen nachgestellten WebSocket und nachgestellte Abrufe: Aufbau der Sitzung, Übersetzung
// der Nachrichten, Zusammenspiel mit der Brücke (Begrüßung, Unterbrechung, end_call), Textmodell, Modell-Liste,
// Schlüsselprüfung und Verbindungstest. Ohne Telefon, ohne Netz, ohne echten Schlüssel.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { RealtimeBridge, type RealtimeBridgeOptions, type Usage } from '../src/ai/realtimeBridge.js';
import { checkGeminiKey, classifyGeminiModels, cleanGeminiKey, fetchGeminiModels, gemini, geminiText } from '../src/ai/providers/gemini.js';
import { REGIE, spokenText } from '../src/ai/providers/geminiLive.js';
import { openai } from '../src/ai/providers/openai.js';
import { resolveAi } from '../src/ai/providers/index.js';
import { testConnection } from '../src/ai/connectionTest.js';
import { estimateCostUsd } from '../src/ai/pricing.js';

const KEY = 'AIza-test-0123456789abcdefghijklmnop';

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: any[] = [];
  url = '';
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; }
}

function setup(t: TestContext, over: Partial<RealtimeBridgeOptions> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ws = new FakeSocket();
  const texts: string[] = [];
  const errors: string[] = [];
  const ended: string[] = [];
  let usage: Usage | undefined;
  const bridge = new RealtimeBridge({
    apiKey: KEY, model: 'gemini-3.8-live', instructions: 'ANWEISUNG', voice: 'Kore', greetingInstruction: 'GRUSS', formal: true,
    allowInterrupt: true, outputGain: 1, speechSpeed: 1, vadSilenceMs: 800, hangupGraceMs: 1000, stallMs: 0, greetingWaitMs: 0,
    onTranscript: (e) => { if (e.final) texts.push(`${e.speaker}: ${e.text}`); },
    onUsage: (u) => { usage = u; },
    onEndCall: (r) => ended.push(r),
    onError: (m) => errors.push(m),
    createLive: (config, events) => gemini.createLive(config, events),
    createSocket: (url) => { ws.url = url; return ws as unknown as WebSocket; },
    ...over,
  });
  const server = (msg: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  /** ms Audio der KI (PCM16, 24 kHz) */
  const audio = (ms: number) => server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(ms * 48).toString('base64') } }] } } });
  const say = (ms: number, text: string) => { audio(ms); server({ serverContent: { outputTranscription: { text } } }); server({ serverContent: { turnComplete: true } }); };
  const drain = (maxMs = 60_000) => { let ms = 0; t.mock.timers.tick(500); while (ms < maxMs && bridge.nextFrame()) ms += 20; return ms; };
  const regie = () => ws.sent.filter((m) => m.clientContent).map((m) => ({ text: m.clientContent.turns[0].parts[0].text as string, go: m.clientContent.turnComplete as boolean }));
  const start = () => { ws.emit('open'); server({ setupComplete: {} }); bridge.onConnected(8000); t.mock.timers.tick(0); };
  return { bridge, ws, server, audio, say, drain, regie, start, texts, errors, ended, usage: () => usage, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('Gemini: Aufbau der Sitzung – Modell, Stimme, Systemanweisung, Tools und Spracherkennung', (t) => {
  const h = setup(t, { onTransfer: async () => ({ ok: false, reason: 'besetzt' }), allowInterrupt: false, vadThreshold: 0.4, speechSpeed: 0.8 });
  h.ws.emit('open');
  assert.match(h.ws.url, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\/.+BidiGenerateContent\?key=/);
  const s = h.ws.sent[0].setup;
  assert.equal(s.model, 'models/gemini-3.8-live');
  assert.deepEqual(s.generationConfig, { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } });
  const sys = s.systemInstruction.parts[0].text as string;
  assert.ok(sys.startsWith('ANWEISUNG'));
  assert.ok(sys.includes(REGIE) && sys.includes('eher langsam'), 'Regie-Regel und Hinweis zum Tempo');
  const fns = s.tools[0].functionDeclarations;
  assert.deepEqual(fns.map((f: any) => [f.name, f.behavior]), [['end_call', 'BLOCKING'], ['transfer_call', 'BLOCKING']]);
  assert.ok(fns[0].parameters.properties.ergebnis);
  assert.equal('parameters' in fns[1], false, 'Funktion ohne Parameter bekommt kein leeres Schema');
  assert.deepEqual(s.realtimeInputConfig, { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', silenceDurationMs: 800 }, activityHandling: 'NO_INTERRUPTION' });
  assert.deepEqual(s.inputAudioTranscription, { languageCodes: ['de'] });
  assert.deepEqual(s.outputAudioTranscription, {});
  h.bridge.close();
});

test('Gemini: Begrüßung als Regieanweisung, Audio wird von 24 kHz auf die Leitung umgetastet, Telefon-Audio geht mit 16 kHz hinaus', (t) => {
  const h = setup(t);
  h.start();
  assert.deepEqual(h.regie(), [{ text: `${REGIE} GRUSS`, go: true }]);
  h.say(400, 'Hallo?');
  assert.equal(h.drain(), 400);
  assert.deepEqual(h.texts, ['ki: Hallo?']);
  // 20 ms mit 8 kHz vom Telefon werden zu 16 kHz für die API
  for (let i = 0; i < 5; i++) h.bridge.onRemoteAudio(new Int16Array(160));
  const chunks = h.ws.sent.filter((m) => m.realtimeInput).map((m) => m.realtimeInput.audio);
  assert.equal(chunks[0].mimeType, 'audio/pcm;rate=16000');
  assert.equal(chunks.reduce((n, c) => n + Buffer.from(c.data, 'base64').length / 2, 0), 5 * 320);
  h.bridge.close();
});

test('Gemini: Vor dem Aufbau ersetzt ein neuer Gesprächsplan die Systemanweisung, danach kommt er als Regieanweisung', async (t) => {
  const h = setup(t);
  h.bridge.updateInstructions('MIT PLAN', ['Schritt']);
  h.start();
  assert.ok((h.ws.sent[0].setup.systemInstruction.parts[0].text as string).startsWith('MIT PLAN'));
  h.bridge.updateInstructions('NEUER PLAN', ['Schritt']);
  await Promise.resolve();
  const note = h.regie().at(-1)!;
  assert.ok(note.text.includes('NEUER PLAN') && note.go === false, 'nachgereicht, ohne eine Antwort auszulösen');
  h.bridge.close();
});

test('Gemini: Transkription des Gegenübers wird gesammelt und nach kurzer Pause als eine Äußerung gemeldet', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.server({ serverContent: { inputTranscription: { text: 'Guten Tag, ' } } });
  h.server({ serverContent: { inputTranscription: { text: 'hier ist Schmidt.' } } });
  h.audio(400);
  h.server({ serverContent: { outputTranscription: { text: 'Guten Tag Frau Schmidt.' } } });
  h.tick(700);
  h.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(h.texts, ['ki: Hallo?', 'partner: Guten Tag, hier ist Schmidt.', 'ki: Guten Tag Frau Schmidt.']);
  h.bridge.close();
});

test('Gemini: Unterbrechung mit Inhalt verwirft den Rest, ein Zuhör-Laut lässt die KI ausreden', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  // Lange Antwort, das Gegenüber redet mit Inhalt hinein
  h.audio(4000);
  assert.equal(h.drain(1000), 1000);
  h.server({ serverContent: { interrupted: true } });
  h.server({ serverContent: { turnComplete: true } });
  assert.equal(h.bridge.nextFrame(), undefined, 'Ausgabe pausiert, bis klar ist, was gesagt wurde');
  h.server({ serverContent: { inputTranscription: { text: 'Moment, ich habe eine Frage.' } } });
  h.tick(700);
  assert.equal(h.drain(), 0, 'Rest verworfen');
  // Nächste lange Antwort, diesmal nur ein „Mhm"
  h.audio(4000);
  h.server({ serverContent: { turnComplete: true } });
  assert.equal(h.drain(1000), 1000);
  h.server({ serverContent: { inputTranscription: { text: 'Mhm.' } } });
  assert.equal(h.bridge.nextFrame(), undefined);
  h.tick(700);
  assert.equal(h.drain(), 3000, 'KI spricht ihren Satz zu Ende');
  h.bridge.close();
});

test('Gemini: Geräusch ohne Transkription gilt zwei Sekunden nach dem Sprachende als Geräusch', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.audio(4000);
  h.server({ serverContent: { generationComplete: true } });
  assert.equal(h.drain(1000), 1000);
  h.server({ serverContent: { interrupted: true } });
  assert.equal(h.bridge.nextFrame(), undefined);
  h.tick(3000);
  assert.equal(h.bridge.nextFrame(), undefined, 'solange der Server kein Sprachende meldet, bleibt die Äußerung offen');
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.tick(2000);
  assert.equal(h.drain(), 3000);
  h.bridge.close();
});

test('Gemini: Meldet der Server das Sprachende, gilt ein langer Satz nicht mitten im Reden als Geräusch', (t) => {
  const ids: string[] = [];
  const h = setup(t, { onTranscript: (e) => { if (e.final && e.speaker === 'partner') ids.push(`${e.itemId}: ${e.text}`); } });
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.server({ serverContent: { inputTranscription: { text: 'Ja, hallo.' } } });
  h.tick(700);
  // Zweiter Satz: fünf Sekunden Reden, die Mitschrift kommt erst nach dem Sprachende
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.tick(5000);
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.tick(300);
  h.server({ serverContent: { inputTranscription: { text: 'Das war ein langer Satz.' } } });
  h.tick(700);
  assert.deepEqual(ids, ['u1: Ja, hallo.', 'u2: Das war ein langer Satz.']);
  // Sprachende ohne Mitschrift: nach zwei Sekunden ein Geräusch, die nächste Äußerung zählt neu
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.tick(2000);
  h.server({ serverContent: { inputTranscription: { text: 'Noch da?' } } });
  h.tick(700);
  assert.equal(ids[2], 'u4: Noch da?');
  h.bridge.close();
});

test('Gemini: Wird die Umsetzung einer Vorgabe des Agenten abgeschnitten, steht das im Transkript und die Vorgabe wird wieder fällig', (t) => {
  const h = setup(t);
  h.tick(1); // die nachgestellte Uhr beginnt bei 0, und 0 gilt dem Wächter als „nichts erwartet“
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  assert.equal(h.bridge.agentSay('Stell klar, dass der Termin um 19 Uhr ist.', true), 'now');
  h.audio(4000);
  h.server({ serverContent: { outputTranscription: { text: 'Der Termin ist um 19 Uhr.' } } });
  assert.equal(h.drain(500), 500);
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  assert.equal(h.bridge.nextFrame(), undefined, 'pausiert, bis feststeht, was das Gegenüber sagt');
  h.server({ serverContent: { interrupted: true } });
  assert.equal(h.texts.some((x) => /KI unterbrochen/.test(x)), false, 'noch nichts verworfen');
  h.server({ serverContent: { inputTranscription: { text: 'Moment, das stimmt nicht.' } } });
  h.tick(700);
  assert.equal(h.bridge.nextFrame(), undefined, 'der Rest ist verworfen');
  assert.deepEqual(h.texts.slice(-3), ['ki: Der Termin ist um 19 Uhr.', 'partner: Moment, das stimmt nicht.', 'system: KI unterbrochen: etwa 3,5 s ihrer Antwort, die mit „Der Termin ist um 19 Uhr.“ begann, wurden nicht mehr gesprochen']);
  const last = h.regie().at(-1)!;
  assert.match(last.text, /unterbrochen und ist bei ihm nicht angekommen/);
  assert.equal(last.go, false, 'nur ein Hinweis, keine zusätzliche Antwort');
  h.bridge.close();
});

test('Gemini: Echo der eigenen Stimme – die KI spricht ihren Satz zu Ende, die Antwort auf das Echo bleibt stumm', (t) => {
  const h = setup(t);
  h.tick(1);
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  h.audio(4000);
  h.server({ serverContent: { outputTranscription: { text: 'Ich soll Ihnen schöne Grüße von Max ausrichten, direkt aus seiner Sitzung.' } } });
  assert.equal(h.drain(1500), 1500);
  // Das Telefon der Gegenseite wirft ihre Stimme zurück: Gemini meldet Sprache und bricht die Antwort ab
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.server({ serverContent: { interrupted: true } });
  assert.equal(h.bridge.nextFrame(), undefined, 'pausiert');
  h.server({ serverContent: { inputTranscription: { text: 'Grüße von' } } });
  // Gemini antwortet auf das vermeintlich Gesagte
  h.audio(1000);
  h.server({ serverContent: { outputTranscription: { text: 'aus seiner Sitzung.' } } });
  h.server({ serverContent: { turnComplete: true } });
  h.tick(700);
  assert.equal(h.drain(), 2500, 'der Rest des Satzes, ohne die Antwort auf das Echo');
  assert.equal(h.texts.some((x) => /KI unterbrochen/.test(x)), false);
  assert.equal(h.texts.includes('ki: aus seiner Sitzung.'), false);
  assert.equal(h.regie().some((r) => /abgeschnitten/.test(r.text)), false, 'kein Hinweis an die KI: Es wurde nichts abgeschnitten');
  h.bridge.close();
});

test('Gemini: Ein echter Einwurf verwirft den Rest, die KI erfährt davon; ein einzelnes „Nein" ist nie ein Echo', (t) => {
  const h = setup(t);
  h.tick(1);
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  h.audio(4000);
  h.server({ serverContent: { outputTranscription: { text: 'Passt Ihnen Freitag, ja oder nein, oder lieber Samstag?' } } });
  assert.equal(h.drain(1500), 1500);
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.server({ serverContent: { interrupted: true } });
  h.server({ serverContent: { inputTranscription: { text: 'Nein.' } } });
  h.tick(700);
  assert.equal(h.bridge.nextFrame(), undefined, 'der Rest ist verworfen');
  assert.ok(h.texts.some((x) => /^system: KI unterbrochen: etwa 2,5 s ihrer Antwort, die mit „Passt Ihnen Freitag/.test(x)), h.texts.join(' | '));
  const note = h.regie().at(-1)!;
  assert.match(note.text, /Deine letzte Antwort wurde abgeschnitten, weil das Gegenüber gleichzeitig zu hören war/);
  assert.match(note.text, /Die Verbindung war nicht gestört/);
  assert.equal(note.go, false);
  h.bridge.close();
});

test('Gemini: Die erste Antwort ohne Hinweis auf die KI – Nachholen angefordert; mit Hinweis nicht', (t) => {
  for (const [text, expected] of [['Hi Max, Lara hier. Wie spät ist es?', true], ['Hi Max, Lara hier, deine KIAssistentin. Wie spät ist es?', false], ['Guten Tag, ich bin ein KI-Assistent.', false]] as const) {
    const h = setup(t, { requireAiIntro: true });
    h.tick(1);
    h.start();
    h.say(800, text);
    assert.equal(h.regie().some((r) => /nicht gesagt, dass du eine KI bist/.test(r.text)), expected, text);
    h.say(600, 'Danke.');
    assert.equal(h.regie().filter((r) => /nicht gesagt, dass du eine KI bist/.test(r.text)).length, expected ? 1 : 0, 'nur die erste Antwort wird geprüft');
    h.bridge.close();
    t.mock.timers.reset();
  }
});

test('Gemini: Lehnt der Server die Sitzung beim Aufbau wegen des Kontingents ab, wird sie mit dem Ausweichmodell neu aufgebaut', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sockets: FakeSocket[] = [];
  const errors: string[] = [];
  const models: string[] = [];
  const bridge = new RealtimeBridge({
    apiKey: KEY, model: 'gemini-3.8-live', instructions: 'ANWEISUNG', voice: 'Kore', greetingInstruction: 'GRUSS', formal: true,
    allowInterrupt: true, outputGain: 1, speechSpeed: 1, vadSilenceMs: 800, hangupGraceMs: 1000, stallMs: 0, greetingWaitMs: 0,
    onTranscript: () => undefined, onUsage: () => undefined, onEndCall: () => undefined,
    onError: (m) => errors.push(m),
    createLive: (config, events) => gemini.createLive(config, events),
    createSocket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws as unknown as WebSocket; },
    fallbackModels: ['gemini-3.7-live'],
    onModel: (m) => models.push(m),
  });
  sockets[0].emit('open');
  assert.equal(sockets[0].sent[0].setup.model, 'models/gemini-3.8-live');
  sockets[0].emit('close', 1011, Buffer.from('Resource has been exhausted (e.g. check quota).'));
  assert.equal(sockets.length, 2, 'zweite Sitzung aufgebaut');
  assert.deepEqual(models, ['gemini-3.7-live']);
  assert.deepEqual(errors, [], 'kein Fehler für das Gespräch');
  sockets[1].emit('open');
  assert.equal(sockets[1].sent[0].setup.model, 'models/gemini-3.7-live');
  // Das Ausweichmodell kennt die Angabe „BLOCKING“ nicht: dasselbe Modell noch einmal, ohne sie
  assert.equal(sockets[1].sent[0].setup.tools[0].functionDeclarations[0].behavior, 'BLOCKING');
  sockets[1].emit('close', 1007, Buffer.from('BLOCKING function calls are not supported for this model.'));
  assert.equal(sockets.length, 3);
  sockets[2].emit('open');
  assert.equal(sockets[2].sent[0].setup.model, 'models/gemini-3.7-live');
  assert.equal('behavior' in sockets[2].sent[0].setup.tools[0].functionDeclarations[0], false);
  // Es scheitert trotzdem, aus einem anderen Grund, und es gibt kein weiteres: einmal noch das Hauptmodell
  sockets[2].emit('close', 1007, Buffer.from('Request contains an invalid argument.'));
  assert.equal(sockets.length, 4);
  sockets[3].emit('open');
  assert.equal(sockets[3].sent[0].setup.model, 'models/gemini-3.8-live');
  assert.equal(sockets[3].sent[0].setup.tools[0].functionDeclarations[0].behavior, 'BLOCKING');
  assert.deepEqual(models, ['gemini-3.7-live', 'gemini-3.7-live', 'gemini-3.8-live']);
  assert.deepEqual(errors, []);
  // Auch das ist wieder am Limit: Jetzt gilt der Fehler
  sockets[3].emit('close', 1011, Buffer.from('Resource has been exhausted (e.g. check quota).'));
  assert.equal(sockets.length, 4);
  assert.equal(errors.length, 1);
  bridge.close();
});

test('Gemini: Ein langer Satz bleibt über die Sicherungsfrist hinaus offen, solange das Gegenüber zu hören ist', (t) => {
  const h = setup(t);
  h.tick(1);
  h.start();
  h.say(400, 'Wie spät ist es?');
  h.drain();
  h.tick(1000);
  const frame = (level: number) => { h.tick(20); h.bridge.onRemoteAudio(new Int16Array(160).fill(level)); };
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  for (let i = 0; i < 600; i++) frame(4000);
  assert.equal(h.texts.some((x) => /^partner:/.test(x)), false, 'nach 12 s Reden noch offen');
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.server({ serverContent: { inputTranscription: { text: 'Wir haben zehn Uhr dreiundfünfzig, nein, vierundfünfzig.' } } });
  h.tick(700);
  assert.equal(h.texts.at(-1), 'partner: Wir haben zehn Uhr dreiundfünfzig, nein, vierundfünfzig.');
  h.bridge.close();
});

test('Gemini: Antwortet die KI schon auf den Einwurf, steht der Hinweis auf die abgeschnittene Antwort trotzdem gleich im Transkript', (t) => {
  const h = setup(t);
  h.tick(1);
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  h.audio(4000);
  h.server({ serverContent: { outputTranscription: { text: 'Zehn Uhr vierundfünfzig also. Wie läuft es bei dir heute?' } } });
  assert.equal(h.drain(500), 500);
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.server({ serverContent: { interrupted: true } });
  h.server({ serverContent: { inputTranscription: { text: 'Kannst du mir noch was erzählen?' } } });
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  // die nächste Antwort läuft schon, wenn der Rest der vorigen verworfen wird
  h.audio(2000);
  h.server({ serverContent: { outputTranscription: { text: 'Klar, gern.' } } });
  h.tick(700);
  assert.deepEqual(h.texts.slice(-2), ['partner: Kannst du mir noch was erzählen?', 'system: KI unterbrochen: etwa 3,5 s ihrer Antwort, die mit „Zehn Uhr vierundfünfzig also. Wie läuft  …“ begann, wurden nicht mehr gesprochen']);
  h.server({ serverContent: { turnComplete: true } });
  assert.equal(h.texts.at(-1), 'ki: Klar, gern.');
  h.bridge.close();
});

test('Gemini: Kein Wechsel des Sprachmodells bei einem anderen Fehler und nicht mehr, wenn die Sitzung steht', (t) => {
  for (const scenario of ['key', 'ready'] as const) {
    const sockets: FakeSocket[] = [];
    const errors: string[] = [];
    const h = setup(t, { fallbackModels: ['gemini-3.7-live'], onError: (m) => errors.push(m), createSocket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws as unknown as WebSocket; } });
    sockets[0].emit('open');
    if (scenario === 'ready') sockets[0].emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    sockets[0].emit('close', scenario === 'key' ? 1007 : 1011, Buffer.from(scenario === 'key' ? 'API key not valid. Please pass a valid API key.' : 'Resource has been exhausted (e.g. check quota).'));
    assert.equal(sockets.length, 1, scenario);
    assert.equal(errors.length, 1, scenario);
    h.bridge.close();
    t.mock.timers.reset();
  }
});

test('Gemini: Geräusch gleich nach dem Abheben – die KI begrüßt trotzdem von sich aus', (t) => {
  const h = setup(t, { greetingWaitMs: 2500 });
  h.start();
  h.tick(1400);
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.tick(400);
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.tick(1999);
  assert.deepEqual(h.regie(), [], 'noch offen, ob etwas gesagt wurde');
  h.tick(1);
  assert.deepEqual(h.regie().map((r) => r.go), [true]);
  assert.ok(h.regie()[0].text.includes('GRUSS'));
  h.say(400, 'Guten Tag');
  h.tick(10_000);
  assert.equal(h.regie().length, 1, 'nur eine Begrüßung');
  h.bridge.close();
});

test('Gemini: end_call – Ergebnis und Abschiedsanweisung gehen zusammen als Tool-Antwort, danach wird aufgelegt', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.ws.sent.length = 0;
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'Termin passt' } }] } });
  const responses = h.ws.sent.filter((m) => m.toolResponse);
  assert.equal(responses.length, 1);
  const r = responses[0].toolResponse.functionResponses[0];
  assert.equal(r.id, 'f1');
  assert.equal(r.name, 'end_call');
  assert.match(r.response.result, /^ok – verabschiede dich jetzt\n\nDas Gespräch wird jetzt beendet\./);
  assert.equal(h.regie().length, 0, 'kein zusätzlicher Text-Zug, der das Modell unterbräche');
  h.say(800, 'Auf Wiederhören.');
  assert.equal(h.drain(), 800);
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  assert.ok(h.texts.includes('system: Ergebnis laut KI: Termin passt'));
});

test('Gemini: end_call zusammen mit Sprache wird abgelehnt, das Tool-Ergebnis geht allein hinaus', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.ws.sent.length = 0;
  h.audio(600);
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'x' } }] } });
  const r = h.ws.sent.filter((m) => m.toolResponse)[0].toolResponse.functionResponses[0];
  assert.match(r.response.result, /^Nicht beendet/);
  assert.deepEqual(h.ended, []);
  h.bridge.close();
});

test('Gemini: Kommt die Mitschrift nach der nachgeholten Begrüßung doch noch, bleibt die zweite Antwort stumm', (t) => {
  const h = setup(t, { greetingWaitMs: 2500 });
  h.start();
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.tick(2000);
  assert.equal(h.regie().length, 1, 'Begrüßung nachgeholt');
  // 300 ms später trifft die Mitschrift ein: Es war doch Sprache, das Modell hat jetzt zwei Auslöser
  h.tick(300);
  h.server({ serverContent: { inputTranscription: { text: 'Ja, hallo?' } } });
  h.say(1000, 'Hi, Lara hier. Wie spät ist es?');
  h.tick(500);
  h.say(800, 'Kein Problem, wie spät ist es?');
  assert.equal(h.drain(), 1000, 'nur die Begrüßung geht auf die Leitung');
  assert.deepEqual(h.texts.filter((x) => x.startsWith('ki:')), ['ki: Hi, Lara hier. Wie spät ist es?']);
  // Die Antwort des Gegenübers wird ganz normal beantwortet
  h.tick(1000);
  h.server({ serverContent: { inputTranscription: { text: 'Kurz vor zwölf.' } } });
  h.tick(700);
  h.say(600, 'Danke dir!');
  assert.equal(h.drain(), 600);
  h.bridge.close();
});

test('Gemini: Antwortet das Gegenüber gleich nach der nachgeholten Begrüßung, ist die Antwort der KI zu hören', (t) => {
  const h = setup(t, { greetingWaitMs: 2500 });
  h.start();
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.tick(2000);
  h.say(1000, 'Hi, Lara hier. Wie spät ist es?');
  assert.equal(h.drain(), 1000);
  h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.server({ serverContent: { inputTranscription: { text: 'Zwölf.' } } });
  h.say(600, 'Danke dir!');
  assert.equal(h.drain(), 600);
  h.bridge.close();
});

test('Gemini: Was die KI nach einem abgelehnten end_call von sich aus nachschiebt, bleibt stumm; der Abschied ist wieder zu hören', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  // Dank und end_call in einer Antwort: abgelehnt
  h.audio(1000);
  h.server({ serverContent: { outputTranscription: { text: 'Danke dir!' } } });
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'erledigt' } }] } });
  // Das Modell redet trotz „Sag jetzt nichts mehr“ weiter, ohne Mitschrift
  h.audio(2000);
  h.server({ serverContent: { turnComplete: true } });
  assert.equal(h.drain(), 1000, 'nur der Dank geht auf die Leitung');
  assert.deepEqual(h.texts.filter((x) => x.startsWith('ki:')), ['ki: Guten Tag.', 'ki: Danke dir!']);
  // Das Gegenüber schweigt: Die KI soll beenden, und ihr Abschied ist zu hören
  h.tick(3000);
  assert.match(h.regie().at(-1)!.text, /Rufe jetzt end_call auf/);
  h.server({ toolCall: { functionCalls: [{ id: 'f2', name: 'end_call', args: { ergebnis: 'erledigt' } }] } });
  h.say(800, 'Bis dann!');
  assert.equal(h.drain(), 800);
  h.bridge.close();
});

test('Gemini: Kommt nach einem abgelehnten end_call die Mitschrift des Gegenübers als Nachtrag, ist die Antwort ganz zu hören', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  h.audio(1000);
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'erledigt' } }] } });
  // Die KI antwortet schon, die Mitschrift der Frage kommt erst währenddessen und ohne „Sprache beginnt“
  h.audio(400);
  h.server({ serverContent: { inputTranscription: { text: 'Wer hat dich gestartet?' } } });
  h.tick(700);
  h.audio(400);
  h.server({ serverContent: { outputTranscription: { text: 'Das war Codex.' } } });
  h.server({ serverContent: { turnComplete: true } });
  assert.equal(h.drain(), 1800, 'Dank und die ganze Antwort, auch ihr Anfang');
  assert.ok(h.texts.includes('ki: Das war Codex.'));
  h.bridge.close();
});

test('Gemini: Nach einem abgelehnten end_call ist die Antwort auf das Gegenüber wieder zu hören', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  h.audio(1000);
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'erledigt' } }] } });
  assert.equal(h.drain(), 1000);
  h.server({ serverContent: { inputTranscription: { text: 'Moment, eine Frage noch.' } } });
  h.tick(700);
  h.say(600, 'Klar, welche?');
  assert.equal(h.drain(), 600);
  h.bridge.close();
});

test('Gemini: Eine Vorgabe des Agenten während der Verabschiedung nimmt das Auflegen zurück', (t) => {
  const h = setup(t);
  h.tick(1);
  h.start();
  h.say(400, 'Guten Tag.');
  h.drain();
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'erledigt' } }] } });
  h.say(800, 'Bis dann!');
  assert.equal(h.drain(), 800);
  // Abschied ist ausgespielt, in einer Sekunde würde aufgelegt
  assert.equal(h.bridge.agentSay('Stell richtig: Der Termin ist am Freitag.', true), 'resumed');
  h.tick(5000);
  assert.deepEqual(h.ended, [], 'nicht aufgelegt');
  assert.ok(h.texts.includes('system: Vorgabe des Agenten während des Beendens – Gespräch geht weiter'));
  const sent = h.regie().map((r) => r.text);
  assert.ok(sent.some((x) => /Beenden ist zurückgenommen/.test(x)));
  assert.ok(sent.some((x) => /Stell richtig: Der Termin ist am Freitag\./.test(x)));
  h.say(900, 'Eine Sache noch: Der Termin ist am Freitag.');
  assert.equal(h.drain(), 900);
  // Danach beendet die KI wie gewohnt
  h.server({ toolCall: { functionCalls: [{ id: 'f2', name: 'end_call', args: { ergebnis: 'richtiggestellt' } }] } });
  h.say(600, 'Tschüss!');
  h.drain();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
});

test('Gemini: end_call mit Sprache und Gesprächsplan – die Prüfung der Schritte kommt gleich mit, nicht erst nach dem Abschied', (t) => {
  const h = setup(t);
  h.tick(1);
  h.start();
  h.bridge.updateInstructions('ANWEISUNG MIT PLAN', ['Frag nach der Uhrzeit.', 'Bedanke dich.']);
  h.say(400, 'Guten Tag.');
  h.drain();
  h.ws.sent.length = 0;
  h.audio(1000);
  h.server({ serverContent: { outputTranscription: { text: 'Dann beende ich das jetzt.' } } });
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'erledigt' } }] } });
  const first = h.ws.sent.filter((m) => m.toolResponse)[0].toolResponse.functionResponses[0].response.result as string;
  assert.match(first, /^Nicht beendet: Du hast in dieser Antwort noch gesprochen\./);
  assert.match(first, /1\. Frag nach der Uhrzeit\.\n2\. Bedanke dich\./);
  assert.match(first, /bring ihn in deiner nächsten Antwort an/);
  assert.equal(h.drain(), 1000);
  // Das Gegenüber schweigt: Fehlendes ansprechen oder beenden
  h.tick(3000);
  assert.match(h.regie().at(-1)!.text, /Fehlt noch ein Schritt des Gesprächsplans, sprich ihn jetzt direkt aus/);
  // Die KI holt die Frage nach, bekommt die Antwort und beendet: Jetzt wird nicht noch einmal geprüft
  h.say(900, 'Wie spät ist es gerade?');
  assert.equal(h.drain(), 900);
  h.server({ serverContent: { inputTranscription: { text: 'Kurz nach zwei.' } } });
  h.tick(700);
  h.ws.sent.length = 0;
  h.server({ toolCall: { functionCalls: [{ id: 'f2', name: 'end_call', args: { ergebnis: 'Uhrzeit genannt' } }] } });
  assert.match(h.ws.sent.filter((m) => m.toolResponse)[0].toolResponse.functionResponses[0].response.result, /^ok – verabschiede dich jetzt/);
  h.bridge.close();
});

test('Gemini: flag_spam reicht die neue Rolle mit dem Tool-Ergebnis nach', (t) => {
  const h = setup(t, { onFlagSpam: () => 'SPAMROLLE' });
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.ws.sent.length = 0;
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'flag_spam', args: { grund: 'Werbung' } }] } });
  const result = h.ws.sent.filter((m) => m.toolResponse)[0].toolResponse.functionResponses[0].response.result as string;
  assert.ok(result.startsWith('Verstanden.') && result.includes('SPAMROLLE'));
  assert.equal(h.regie().length, 0);
  h.bridge.close();
});

test('Gemini: Verbrauch wird je Zug nur einmal gezählt und nach Audio und Text getrennt', (t) => {
  const h = setup(t);
  h.start();
  const meta = (p: number, r: number) => ({ usageMetadata: { promptTokenCount: p, responseTokenCount: r, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: p - 10 }, { modality: 'TEXT', tokenCount: 10 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: r }] } });
  h.audio(400);
  h.server(meta(100, 20));
  h.server(meta(100, 50)); // derselbe Zug, aufsummiert gemeldet
  h.server({ serverContent: { turnComplete: true } });
  h.audio(400);
  h.server(meta(200, 30));
  h.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(h.usage(), { inputTokens: 300, outputTokens: 80, inputAudioTokens: 280, outputAudioTokens: 80, inputTextTokens: 20, outputTextTokens: 0, cachedTokens: 0 });
  assert.ok(Math.abs(estimateCostUsd('gemini-3.8-live', h.usage()!) - (280 * 3 + 80 * 12 + 20 * 0.75) / 1e6) < 1e-12);
  h.bridge.close();
});

test('Gemini: Fehler der Verbindung nennen den Schlüssel nicht; ein Ende der Verbindung beendet das Gespräch', (t) => {
  const h = setup(t);
  h.start();
  h.ws.emit('error', new Error(`Unexpected server response: 403 (wss://host/x?key=${KEY})`));
  assert.equal(h.errors.length, 1);
  assert.ok(!h.errors[0].includes(KEY));
  h.ws.emit('close', 1007, Buffer.from('Invalid setup'));
  assert.equal(h.errors[1], 'Verbindung zu Google Gemini beendet');
});

// ---- Abrufe (REST) ----

type Call = { url: string; init?: RequestInit };
const fake = (handler: (c: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => { const c = { url: String(url), init }; calls.push(c); return handler(c); }) as typeof fetch;
  return { impl, calls };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Gemini: Schlüssel – Form, Prüfung bei Google, keine Schlüssel in Meldungen', async () => {
  assert.equal(cleanGeminiKey(`  ${KEY} `), KEY);
  assert.throws(() => cleanGeminiKey('kurz'), /Google AI Studio/);
  assert.throws(() => cleanGeminiKey('sk-proj-0123456789abcdefghij'), /Schlüssel von OpenAI/);
  assert.throws(() => openai.cleanKey(KEY), /Schlüssel von Google/);
  assert.throws(() => cleanGeminiKey('AIza mit leerzeichen 0123456789'), /Google AI Studio/);
  const ok = fake(() => json({ models: [] }));
  assert.deepEqual(await checkGeminiKey(KEY, ok.impl), { ok: true });
  assert.equal(new Headers(ok.calls[0].init?.headers).get('x-goog-api-key'), KEY);
  assert.ok(!ok.calls[0].url.includes(KEY), 'Schlüssel steht im Kopf, nicht in der Adresse');
  const denied = await checkGeminiKey(KEY, fake(() => json({ error: { message: `API key not valid: ${KEY}` } }, 400)).impl);
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /abgelehnt/);
  const offline = await checkGeminiKey(KEY, fake(() => { throw new Error(`ECONNREFUSED ${KEY}`); }).impl);
  assert.match(offline.error!, /nicht erreichbar/);
  for (const r of [denied, offline]) assert.ok(!r.error!.includes(KEY));
});

test('Gemini: Modell-Liste nach Verwendung getrennt, Standard-Sprachmodell immer dabei', async () => {
  const lists = classifyGeminiModels([
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-live-extended-thinking', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/gemini-3.5-live-translate-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.1-flash-lite-preview-09-2026', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/imagen-5', supportedGenerationMethods: ['predict'] },
    { name: 42 },
  ]);
  assert.deepEqual(lists.realtime.map((m) => m.id), ['gemini-3.8-live-extended-thinking', 'gemini-3.8-live']);
  assert.deepEqual(lists.text, [{ id: 'gemini-3.8-flash', snapshot: false }, { id: 'gemini-3.5-flash-lite', snapshot: false }, { id: 'gemini-3.1-flash-lite-preview-09-2026', snapshot: true }]);
  await assert.rejects(fetchGeminiModels(KEY, fake(() => json({}, 429)).impl), /Kontingent/);
  assert.equal((await fetchGeminiModels(KEY, fake(() => json({ models: [] })).impl)).realtime[0].id, 'gemini-3.8-live');
});

test('Gemini: Textmodell – JSON nach Schema, Rückfall ohne Denk-Vorgabe und ohne Schema, leere Antwort ist ein Fehler', async () => {
  const bodies: any[] = [];
  const f = fake((c) => {
    const body = JSON.parse(String(c.init?.body));
    bodies.push(body);
    if (body.generationConfig.thinkingConfig) return json({ error: { message: 'thinkingConfig is not supported' } }, 400);
    if (body.generationConfig.responseJsonSchema) return json({ error: { message: 'Invalid JSON schema' } }, 400);
    return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'gedacht', thought: true }, { text: ' {"a":1} ' }] } }] });
  });
  assert.equal(await geminiText(KEY, 'gemini-3.5-flash-lite', 'Hallo', 100, { name: 'x', schema: { type: 'object' } }, f.impl), '{"a":1}');
  assert.equal(bodies.length, 3);
  assert.match(f.calls[0].url, /\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(bodies[2].generationConfig.responseMimeType, 'application/json');
  assert.equal(bodies[0].contents[0].parts[0].text, 'Hallo');
  await assert.rejects(geminiText(KEY, 'm', 'Hallo', 100, undefined, fake(() => json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] })).impl), /Antwort leer \(Status MAX_TOKENS\)/);
  await assert.rejects(geminiText(KEY, 'gibt-es-nicht', 'Hallo', 100, undefined, fake(() => json({ error: {} }, 404)).impl), /404/);
});

test('Gemini als gewählter Anbieter: eigener Schlüssel, eigene Modelle, Gesprächslimit neun Minuten', () => {
  const env = { OPENAI_API_KEY: 'sk-openai', GEMINI_API_KEY: KEY };
  const a = resolveAi({ aiProvider: 'gemini', model: 'gpt-realtime-2.1', summaryModel: 'gpt-6-luna' }, env);
  assert.equal(a.provider.id, 'gemini');
  assert.equal(a.key, KEY);
  assert.equal(a.realtimeModel(), 'gemini-3.8-live', 'ein OpenAI-Modell in den Einstellungen gilt nicht');
  assert.equal(a.textModel, 'gemini-3.5-flash-lite');
  assert.equal(a.callLimit(3600), 540);
  assert.equal(a.callLimit(300), 300);
  assert.equal(resolveAi({ aiProvider: 'gemini', model: 'gemini-3.8-live-extended-thinking' }, env).realtimeModel(), 'gemini-3.8-live-extended-thinking');
  assert.equal(resolveAi({ aiProvider: 'openai', model: 'gemini-3.8-live' }, env).realtimeModel(), 'gpt-realtime-2.1');
});

// ---- Verbindungstest ----

test('Verbindungstest: drei Schritte, mit beiden Anbietern, ohne echte Verbindung', async () => {
  const models = fake(() => json({ models: [{ name: 'models/gemini-3.8-live' }] }));
  const sockets: FakeSocket[] = [];
  const socket = (answer: (ws: FakeSocket) => void) => (url: string) => {
    const ws = new FakeSocket();
    ws.url = url;
    sockets.push(ws);
    setImmediate(() => { ws.emit('open'); answer(ws); });
    return ws as unknown as WebSocket;
  };
  const good = await testConnection(gemini, KEY, 'gemini-3.8-live', { fetchImpl: models.impl, createSocket: socket((ws) => ws.emit('message', Buffer.from('{"setupComplete":{}}'))) });
  assert.equal(good.ok, true);
  assert.deepEqual(good.steps.map((s) => [s.id, s.ok]), [['key', true], ['model', true], ['live', true]]);
  assert.equal(sockets[0].sent.length, 1, 'nur der Aufbau, kein Audio, keine Anforderung');
  assert.equal(sockets[0].readyState, 3, 'Verbindung wieder geschlossen');

  const refused = await testConnection(gemini, KEY, 'gemini-gibt-es-nicht', { fetchImpl: models.impl, createSocket: socket((ws) => ws.emit('close', 1008, Buffer.from('Model not found'))) });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.steps.map((s) => [s.id, s.ok]), [['key', true], ['model', false], ['live', false]]);
  assert.match(refused.steps[2].text, /Model not found/);

  const badKey = await testConnection(gemini, KEY, 'gemini-3.8-live', { fetchImpl: fake(() => json({}, 403)).impl });
  assert.deepEqual(badKey.steps.map((s) => [s.id, s.ok, Boolean(s.skipped)]), [['key', false, false], ['model', false, true], ['live', false, true]]);
  const noKey = await testConnection(gemini, undefined, 'gemini-3.8-live');
  assert.equal(noKey.steps[0].ok, false);
  for (const r of [good, refused, badKey, noKey]) assert.ok(!JSON.stringify(r).includes(KEY));

  const oa = await testConnection(openai, 'sk-test-0123456789abcdefghij', 'gpt-realtime-2.1', {
    fetchImpl: fake(() => json({ data: [{ id: 'gpt-realtime-2.1', created: 1 }] })).impl,
    createSocket: socket((ws) => ws.emit('message', Buffer.from('{"type":"session.updated"}'))),
  });
  assert.equal(oa.ok, true);
  const silent = await testConnection(openai, 'sk-test-0123456789abcdefghij', 'gpt-realtime-2.1', { fetchImpl: fake(() => json({ data: [{ id: 'gpt-realtime-2.1', created: 1 }] })).impl, createSocket: socket(() => undefined), timeoutMs: 20 });
  assert.match(silent.steps[2].text, /keine Antwort/);
});

test('Gemini: Eine Anweisung zwischen Verbindungsaufbau und Bestätigung der Sitzung wartet auf die Bestätigung', async (t) => {
  const h = setup(t);
  h.ws.emit('open');
  h.bridge.updateInstructions('SPAETER PLAN', ['Schritt']);
  await Promise.resolve();
  assert.equal(h.ws.sent.length, 1, 'nur der Aufbau ist hinausgegangen');
  h.server({ setupComplete: {} });
  const note = h.regie().find((r) => r.text.includes('SPAETER PLAN'));
  assert.ok(note && note.go === false);
  h.bridge.close();
});

test('Gemini: Ein zweiter end_call bekommt eine Antwort, damit das Modell nicht auf ein Ergebnis wartet', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'x' } }] } });
  h.ws.sent.length = 0;
  h.server({ toolCall: { functionCalls: [{ id: 'f2', name: 'end_call', args: { ergebnis: 'x' } }] } });
  const r = h.ws.sent.filter((m) => m.toolResponse).flatMap((m) => m.toolResponse.functionResponses);
  assert.deepEqual(r.map((x: any) => [x.id, x.response.result]), [['f2', 'ok']]);
  h.bridge.close();
});

test('Gemini: Die Antwort auf einen bloßen Zuhör-Laut bleibt stumm, auch wenn sie erst nach der Entscheidung beginnt', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.audio(4000);
  assert.equal(h.drain(1000), 1000);
  h.server({ serverContent: { interrupted: true } });
  h.server({ serverContent: { inputTranscription: { text: 'Mhm.' } } });
  h.tick(700);
  // Jetzt erst antwortet das Modell auf das „Mhm": nicht hörbar, der eigene Satz läuft zu Ende
  h.say(1500, 'Ja?');
  assert.equal(h.drain(), 3000);
  assert.ok(!h.texts.includes('ki: Ja?'));
  // Die Antwort auf echte Sprache danach ist wieder zu hören
  h.server({ serverContent: { inputTranscription: { text: 'Wann genau?' } } });
  h.say(600, 'Um zehn.');
  assert.equal(h.drain(), 600);
  h.bridge.close();
});

test('Gemini: Auch bei wenig Rest bleibt die Antwort auf einen Zuhör-Laut stumm; eine Nachricht in falscher Form beendet nichts', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.audio(1500);
  assert.equal(h.drain(1000), 1000);
  h.server({ serverContent: { interrupted: true } });
  h.server({ serverContent: { inputTranscription: { text: 'Mhm.' } } });
  h.tick(700);
  h.say(1500, 'Ja?');
  assert.equal(h.drain(), 500, 'nur der Rest des eigenen Satzes');
  assert.doesNotThrow(() => h.server({ serverContent: { modelTurn: { parts: [null] } }, toolCall: { functionCalls: [null] } }));
  assert.deepEqual(h.errors, []);
  h.bridge.close();
});

test('Gemini: Nach einer fertigen, fast ausgespielten Antwort ist ein „Okay“ die Antwort des Gegenübers und wird beantwortet', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.say(1500, 'Passt Ihnen Donnerstag?');
  assert.equal(h.drain(1000), 1000);
  h.server({ serverContent: { inputTranscription: { text: 'Okay.' } } });
  h.tick(700);
  h.say(800, 'Gut, dann Donnerstag.');
  assert.equal(h.drain(), 800, 'die Antwort ist zu hören');
  assert.ok(h.texts.includes('ki: Gut, dann Donnerstag.'));
  h.bridge.close();
});

test('Gemini: Platzhalter der Mitschrift („<no speech>“, „{pause}“, „...“) kommen nicht ins Transkript', (t) => {
  assert.equal(spokenText('<no speech>{pause}'), '');
  assert.equal(spokenText(' ... '), '');
  assert.equal(spokenText('Alles klar, <noise> bis dann!'), 'Alles klar, bis dann!');
  assert.equal(spokenText('0 17 – 3 9 6'), '0 17 – 3 9 6');
  const all: string[] = [];
  const h = setup(t, { onTranscript: (e) => all.push(`${e.final ? 'fertig' : 'läuft'}: ${e.text}`) });
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  // Antwort ohne Sprache: Die Live API schreibt dafür einen Platzhalter mit
  h.audio(20);
  h.server({ serverContent: { outputTranscription: { text: '<no speech>' } } });
  h.server({ serverContent: { outputTranscription: { text: '{pause}' } } });
  h.server({ serverContent: { turnComplete: true } });
  h.say(20, '...');
  h.say(400, 'Alles klar, <noise> bis dann!');
  assert.deepEqual(all.filter((l) => l.startsWith('fertig')), ['fertig: Hallo?', 'fertig: Alles klar, bis dann!']);
  assert.ok(!all.some((l) => /no speech|pause|: \.\.\.$/.test(l)), 'auch kein Zwischenstand mit Platzhalter');
  h.bridge.close();
});

test('Gemini: end_call gleich nach dem Satz des Gegenübers – der Satz steht im Transkript vor dem Ergebnis', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Unter welcher Nummer?');
  h.drain();
  h.server({ serverContent: { inputTranscription: { text: 'Unter dieser Nummer.' } } });
  // Das Modell beendet sofort, noch bevor die Pause nach der Transkription abgelaufen ist
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'Rückruf gewünscht' } }] } });
  h.tick(700);
  assert.deepEqual(h.texts, ['ki: Unter welcher Nummer?', 'partner: Unter dieser Nummer.', 'system: Ergebnis laut KI: Rückruf gewünscht']);
  h.bridge.close();
});

test('Gemini: Nachzügler nach end_call sind ein Nachtrag, geteilte und fremde Platzhalter bleiben draußen', (t) => {
  const all: string[] = [];
  const h = setup(t, { onTranscript: (e) => all.push(`${e.final ? 'fertig' : 'läuft'} ${e.speaker}: ${e.text}`) });
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  // Platzhalter über zwei Stücke verteilt: kein Zwischenstand „<no“
  h.audio(20);
  h.server({ serverContent: { outputTranscription: { text: 'Gut. <no' } } });
  h.server({ serverContent: { outputTranscription: { text: ' speech>' } } });
  h.server({ serverContent: { turnComplete: true } });
  h.drain();
  // Geräusch, das die Transkription als Platzhalter meldet: kein Beitrag des Gegenübers
  h.server({ serverContent: { inputTranscription: { text: '<noise>' } } });
  h.tick(700);
  // Satz, end_call, dann der Rest des Satzes
  h.server({ serverContent: { inputTranscription: { text: 'Unter dieser' } } });
  const before = all.length;
  h.server({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { ergebnis: 'Rückruf' } }] } });
  h.server({ serverContent: { inputTranscription: { text: ' Nummer.' } } });
  h.tick(700);
  assert.deepEqual(all.slice(before), ['fertig partner: Unter dieser', 'fertig system: Ergebnis laut KI: Rückruf', 'fertig partner: Nummer.']);
  assert.ok(!all.some((l) => /<no|noise|speech/.test(l)), all.join(' | '));
  assert.ok(all.includes('fertig ki: Gut.'));
  h.say(600, 'Auf Wiederhören.');
  h.drain();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet'], 'der Nachtrag hält das Auflegen nicht auf');
  h.bridge.close();
});

// ---- Agenten-Anruf: Rückfrage an den Agenten, wenn das Gegenüber etwas über ihn wissen will ----

function agentCall(t: TestContext) {
  const asked: string[] = [];
  const h = setup(t, { onAskAgent: (q) => asked.push(q), agentName: 'Codex' });
  h.tick(1);
  h.start();
  h.say(400, 'Hi Max, Lara hier, dein KI-Assistent. Wie spät ist es?');
  h.drain();
  const heard = (text: string) => {
    h.server({ voiceActivity: { type: 'ACTIVITY_START' } });
    h.server({ serverContent: { inputTranscription: { text } } });
    h.server({ voiceActivity: { type: 'ACTIVITY_END' } });
    h.tick(700);
  };
  const nudges = () => h.regie().filter((r) => /Du hast dem Gegenüber eben gesagt, dass du etwas über den Agenten/.test(r.text)).length;
  const answers = () => h.ws.sent.filter((m) => m.toolResponse).map((m) => JSON.stringify(m.toolResponse));
  return { ...h, asked, heard, nudges, answers };
}

test('Agenten-Anruf: Weicht die KI einer Frage zum Agenten aus, holt sie die Rückfrage nach; die Antwort des Agenten kommt an', (t) => {
  const h = agentCall(t);
  h.heard('Und was hat Codex vorher gemacht?');
  h.say(1500, 'Das kann ich dir leider nicht genau sagen, dazu liegen mir keine weiteren Informationen vor.');
  assert.equal(h.nudges(), 1);
  assert.equal(h.regie().at(-1)!.go, true, 'die KI spricht gleich im Anschluss weiter');
  // Die KI kündigt die Rückfrage an und stellt sie
  h.audio(800);
  h.server({ serverContent: { outputTranscription: { text: 'Ich frage aber gern kurz nach, einen Moment.' } } });
  h.server({ toolCall: { functionCalls: [{ id: 'a1', name: 'ask_principal', args: { frage: 'Was hat Codex vor dem Anruf gemacht?' } }] } });
  assert.deepEqual(h.asked, ['Was hat Codex vor dem Anruf gemacht?']);
  assert.equal(h.answers().length, 0, 'die KI wartet auf den Agenten');
  assert.equal(h.bridge.agentSay('Er hat einen Prompt für die Analyse erstellt.'), 'answered');
  assert.equal(h.answers().length, 1);
  assert.match(h.answers()[0], /Antwort deines Auftraggebers: Er hat einen Prompt für die Analyse erstellt\./);
  // Sie gibt die Antwort weiter; dass sie darüber hinaus nichts weiß, löst keine zweite Rückfrage zur selben Frage aus
  h.say(2000, 'Codex hat davor einen Prompt für die Analyse erstellt. Mehr weiß ich dazu nicht.');
  assert.equal(h.nudges(), 1);
  assert.deepEqual(h.texts.filter((x) => /^ki:/.test(x)).slice(-3), ['ki: Das kann ich dir leider nicht genau sagen, dazu liegen mir keine weiteren Informationen vor.', 'ki: Ich frage aber gern kurz nach, einen Moment.', 'ki: Codex hat davor einen Prompt für die Analyse erstellt. Mehr weiß ich dazu nicht.']);
  h.bridge.close();
});

test('Agenten-Anruf: Fragt die KI von selbst nach und der Agent antwortet nicht, macht sie ohne weiter – ohne zweite Rückfrage', (t) => {
  const h = agentCall(t);
  h.heard('Woran arbeitet der Agent gerade?');
  h.audio(800);
  h.server({ serverContent: { outputTranscription: { text: 'Einen Moment bitte, ich frage kurz nach.' } } });
  h.server({ toolCall: { functionCalls: [{ id: 'a1', name: 'ask_principal', args: { frage: 'Woran arbeitest du gerade?' } }] } });
  assert.equal(h.asked.length, 1);
  h.tick(24_999);
  assert.equal(h.answers().length, 0);
  h.tick(1);
  assert.equal(h.answers().length, 1);
  assert.match(h.answers()[0], /nicht rechtzeitig geantwortet/);
  assert.ok(h.texts.includes('system: Rückfrage an den Agenten blieb ohne Antwort'));
  h.say(2000, 'Das kann ich dir gerade leider nicht sagen, ich habe keine Antwort bekommen. Dein Agent meldet sich dazu.');
  assert.equal(h.nudges(), 0);
  assert.equal(h.asked.length, 1);
  h.bridge.close();
});

test('Agenten-Anruf: Gewöhnliche Fragen bleiben ohne Rückfrage; ohne Agenten gibt es die Sicherung nicht', (t) => {
  const h = agentCall(t);
  h.heard('Wie wird denn das Wetter morgen?');
  h.say(1200, 'Das weiß ich leider nicht.');
  h.heard('Und wer hat den Anruf gestartet?');
  h.say(1200, 'Ein KI-Agent namens Codex hat ihn über SIPFunk gestartet.');
  h.heard('Alles klar, danke.');
  h.say(800, 'Gern.');
  assert.equal(h.nudges(), 0);
  assert.equal(h.asked.length, 0);
  h.bridge.close();
  t.mock.timers.reset();
  const plain = setup(t);
  plain.tick(1);
  plain.start();
  plain.say(400, 'Guten Tag.');
  plain.drain();
  plain.server({ voiceActivity: { type: 'ACTIVITY_START' } });
  plain.server({ serverContent: { inputTranscription: { text: 'Wer hat den Anruf gestartet?' } } });
  plain.server({ voiceActivity: { type: 'ACTIVITY_END' } });
  plain.tick(700);
  plain.say(1200, 'Das weiß ich leider nicht.');
  assert.equal(plain.regie().some((r) => /ask_principal/.test(r.text)), false);
  plain.bridge.close();
});

test('Agenten-Anruf: Die Sicherung greift nicht während des Beendens und höchstens zweimal je Gespräch', (t) => {
  const h = agentCall(t);
  for (const q of ['Was hat Codex vorher gemacht?', 'Und woran arbeitet der Agent sonst?', 'Und was macht Codex danach?']) {
    h.heard(q);
    h.say(1200, 'Dazu habe ich keine Informationen.');
    h.drain();
  }
  assert.equal(h.nudges(), 2);
  h.bridge.close();
});

test('Ausweichen bei Fragen zum Agenten: „weiß ich nicht" zählt nur, wenn die Frage den Agenten, den Anruf oder den Auftrag betraf', async () => {
  const { dodgesAgentQuestion } = await import('../src/ai/agentCall.js');
  const q = 'Cool, und was hat Codex vorher gemacht?';
  assert.equal(dodgesAgentQuestion('Das kann ich dir leider nicht genau sagen, da mir dazu keine weiteren Informationen vorliegen.', q, 'Codex'), true);
  assert.equal(dodgesAgentQuestion('Darüber liegen mir keine Informationen vor.', 'Was hat er davor gemacht, der Agent?'), true);
  assert.equal(dodgesAgentQuestion('Mehr kann ich dir dazu gar nicht sagen.', 'Warum wurde ich angerufen?'), true);
  assert.equal(dodgesAgentQuestion('Das weiß ich leider nicht.', 'Wie wird das Wetter?', 'Codex'), false);
  assert.equal(dodgesAgentQuestion('Codex hat den Anruf gestartet.', q, 'Codex'), false);
  assert.equal(dodgesAgentQuestion('Das weiß ich nicht.', q), false, 'ohne bekannten Agentennamen ist „Codex" kein Hinweis');
});

test('Agenten-Anruf: Lehnt die KI eine Auskunft ab, bleibt es dabei – die Sicherung drängt sie nicht zur Rückfrage', async (t) => {
  const h = agentCall(t);
  h.heard('Kannst du Codex fragen, ob er meine Kundennummer hat?');
  h.say(1500, 'Dazu habe ich leider keine Informationen und darf solche sensiblen Daten auch nicht weitergeben.');
  assert.equal(h.nudges(), 0);
  h.heard('Und was hat Codex vorher gemacht?');
  h.say(1200, 'Aus Datenschutzgründen kann ich dir dazu nichts sagen.');
  assert.equal(h.nudges(), 0);
  h.bridge.close();
  const { dodgesAgentQuestion } = await import('../src/ai/agentCall.js');
  assert.equal(dodgesAgentQuestion('Das darf ich dir nicht sagen, dazu habe ich keine Informationen.', 'Was hat der Agent gemacht?'), false);
  assert.equal(dodgesAgentQuestion('Dazu habe ich keine Informationen.', 'Was hat der Agent gemacht?'), true);
});

test('Agenten-Anruf: Eine Vorgabe, die keine Antwort auf die offene Rückfrage ist, geht erst mit deren Ergebnis an die KI', (t) => {
  const h = agentCall(t);
  h.heard('Woran arbeitet der Agent gerade?');
  h.audio(800);
  h.server({ serverContent: { outputTranscription: { text: 'Einen Moment bitte, ich frage kurz nach.' } } });
  h.server({ toolCall: { functionCalls: [{ id: 'a1', name: 'ask_principal', args: { frage: 'Woran arbeitest du gerade?' } }] } });
  const regieBefore = h.regie().length;
  assert.equal(h.bridge.agentSay('Sag bitte noch, dass der Test gleich endet.', true, false), 'next');
  assert.equal(h.answers().length, 0, 'die Rückfrage bleibt offen');
  assert.equal(h.regie().length, regieBefore, 'kein Hinweis dazwischen');
  // Bleibt die Antwort aus, kommt die Vorgabe mit dem Ergebnis „keine Antwort" an
  h.tick(25_000);
  assert.equal(h.answers().length, 1);
  assert.match(h.answers()[0], /nicht rechtzeitig geantwortet/);
  assert.match(h.answers()[0], /Regieanweisung deines Auftraggebers[^"]*Sag bitte noch, dass der Test gleich endet\./);
  h.bridge.close();
});
