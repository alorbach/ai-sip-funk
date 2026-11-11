// Gemini als Anbieter gegen einen nachgestellten WebSocket und nachgestellte Abrufe: Aufbau der Sitzung, Übersetzung
// der Nachrichten, Zusammenspiel mit der Brücke (Begrüßung, Unterbrechung, end_call), Textmodell, Modell-Liste,
// Schlüsselprüfung und Verbindungstest. Ohne Telefon, ohne Netz, ohne echten Schlüssel.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { RealtimeBridge, type RealtimeBridgeOptions, type Usage } from '../src/ai/realtimeBridge.js';
import { checkGeminiKey, classifyGeminiModels, cleanGeminiKey, fetchGeminiModels, gemini, geminiText } from '../src/ai/providers/gemini.js';
import { REGIE } from '../src/ai/providers/geminiLive.js';
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

test('Gemini: Geräusch ohne Transkription gilt nach zwei Sekunden als Geräusch', (t) => {
  const h = setup(t);
  h.start();
  h.say(400, 'Hallo?');
  h.drain();
  h.audio(4000);
  h.server({ serverContent: { generationComplete: true } });
  assert.equal(h.drain(1000), 1000);
  h.server({ serverContent: { interrupted: true } });
  assert.equal(h.bridge.nextFrame(), undefined);
  h.tick(2000);
  assert.equal(h.drain(), 3000);
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
