// Anbieter-Schicht: Auswahl des Anbieters samt Schlüssel und Modellen, und die Brücke gegen eine nachgestellte
// Live-Verbindung (ohne Protokoll eines bestimmten Anbieters). Ohne Netz.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeBridge } from '../src/ai/realtimeBridge.js';
import { knownProvider, providerById, resolveAi } from '../src/ai/providers/index.js';
import type { LiveConfig, LiveEvents, LiveSession, LiveTool } from '../src/ai/providers/types.js';

test('Anbieter: unbekannte Kennung fällt auf OpenAI zurück', () => {
  assert.equal(providerById('gibt-es-nicht').id, 'openai');
  assert.equal(providerById(undefined).id, 'openai');
  // Namen, die jedes Objekt kennt, sind kein Anbieter
  assert.equal(providerById('constructor').id, 'openai');
  assert.equal(knownProvider('constructor'), undefined);
  assert.equal(knownProvider('gemini')?.id, 'gemini');
});

test('Anbieter: Schlüssel und Modelle kommen aus Einstellungen und Umgebung', async () => {
  const none = resolveAi({ aiProvider: 'openai', model: '', summaryModel: '' }, {});
  assert.equal(none.key, undefined);
  assert.equal(none.realtimeModel(), 'gpt-realtime-2.1');
  assert.equal(none.textModel, 'gpt-6-luna');
  await assert.rejects(none.ask('Hallo', 10), /OpenAI-Schlüssel fehlt/);

  const env = { OPENAI_API_KEY: ' sk-test ', OPENAI_MODEL: 'gpt-realtime-eigen', OPENAI_SUMMARY_MODEL: 'gpt-text-eigen' };
  const own = resolveAi({ aiProvider: 'openai', model: 'gpt-realtime-2.1-mini', summaryModel: '' }, env);
  assert.equal(own.key, 'sk-test');
  assert.equal(own.realtimeModel(), 'gpt-realtime-2.1-mini');
  assert.equal(own.realtimeModel(''), 'gpt-realtime-2.1-mini', 'leer = Modell der Verbindung');
  assert.equal(own.realtimeModel('böse/../id'), 'gpt-realtime-2.1-mini', 'unzulässige Zeichen = Modell der Verbindung');
  assert.equal(resolveAi({ aiProvider: 'openai', model: '' }, env).realtimeModel(), 'gpt-realtime-eigen', 'nichts eingestellt = Vorgabe aus der .env');
  assert.equal(own.textModel, 'gpt-text-eigen');
  assert.equal(own.callLimit(3600), 3600, 'OpenAI hat keine eigene Grenze');
});

/** Nachgestellte Live-Verbindung: merkt sich die Befehle der Brücke */
class FakeLive implements LiveSession {
  readonly label = 'Testanbieter';
  readonly inputRate = 16000;
  readonly outputRate = 16000;
  calls: unknown[][] = [];
  constructor(readonly config: LiveConfig, readonly events: LiveEvents) {}
  sendAudio(pcm: Int16Array): void { this.calls.push(['audio', pcm.length]); }
  update(instructions: string, tools?: readonly LiveTool[]): void { this.calls.push(['update', instructions, tools?.map((t) => t.name)]); }
  respond(instructions?: string): void { this.calls.push(['respond', instructions]); }
  toolOutput(callId: string, name: string, output: string): void { this.calls.push(['toolOutput', callId, name, output]); }
  note(text: string): void { this.calls.push(['note', text]); }
  truncate(itemId: string, ms: number): void { this.calls.push(['truncate', itemId, ms]); }
  deleteItem(itemId: string): void { this.calls.push(['delete', itemId]); }
  cancelResponse(): void { this.calls.push(['cancel']); }
  close(): void { this.calls.push(['close']); }
  named(name: string): unknown[][] { return this.calls.filter((c) => c[0] === name); }
}

function setup(t: TestContext, over: Partial<ConstructorParameters<typeof RealtimeBridge>[0]> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let live!: FakeLive;
  const errors: string[] = [];
  const ended: string[] = [];
  const texts: string[] = [];
  const bridge = new RealtimeBridge({
    apiKey: 'test', model: 'test-model', instructions: 'Test', voice: 'v', greetingInstruction: 'GRUSS', formal: true,
    allowInterrupt: true, outputGain: 1, speechSpeed: 1, vadSilenceMs: 500, hangupGraceMs: 1000, stallMs: 0, greetingWaitMs: 0,
    onTranscript: (e) => { if (e.final) texts.push(`${e.speaker}: ${e.text}`); },
    onUsage: () => undefined,
    onEndCall: (r) => ended.push(r),
    onError: (m) => errors.push(m),
    createLive: (config, events) => (live = new FakeLive(config, events)),
    ...over,
  });
  live.events.open();
  live.events.ready();
  bridge.onConnected(16000);
  t.mock.timers.tick(0);
  const drain = () => { let ms = 0; t.mock.timers.tick(500); while (bridge.nextFrame()) ms += 20; return ms; };
  return { bridge, live, errors, ended, texts, drain, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('Brücke über die Schicht: Begrüßung, Audio in der Rate der Sitzung, Tools nach Bedarf', (t) => {
  const h = setup(t, { onTransfer: async () => ({ ok: true, reason: '' }) });
  assert.deepEqual(h.live.config.tools.map((x) => x.name), ['end_call', 'transfer_call']);
  assert.deepEqual(h.live.named('respond'), [['respond', 'GRUSS']]);
  // 16 kHz vom Telefon, 16 kHz zur Sitzung: 20 ms bleiben 320 Samples
  h.bridge.onRemoteAudio(new Int16Array(320));
  assert.deepEqual(h.live.named('audio'), [['audio', 320]]);
  // 400 ms Audio der KI (16 kHz, PCM16) werden zu 20 Frames
  h.live.events.responseStarted('r0');
  h.live.events.audio('i0', Buffer.alloc(400 * 32));
  h.live.events.responseDone({ id: 'r0', status: 'completed', outputTypes: [] });
  assert.equal(h.drain(), 400);
  h.bridge.close();
  assert.deepEqual(h.live.calls.at(-1), ['close']);
});

test('Brücke über die Schicht: end_call führt zu Verabschiedung und Auflegen, Meldungen nennen den Anbieter', (t) => {
  const h = setup(t);
  h.live.events.responseStarted('r0');
  h.live.events.audio('i0', Buffer.alloc(400 * 32));
  h.live.events.aiText('i0', 'Hallo?', true);
  h.live.events.responseDone({ id: 'r0', status: 'completed', outputTypes: [] });
  h.drain();
  h.live.events.responseStarted('tool');
  h.live.events.toolCall('end_call', 'c1', '{"ergebnis":"erledigt"}');
  assert.deepEqual(h.live.named('toolOutput'), [['toolOutput', 'c1', 'end_call', 'ok – verabschiede dich jetzt']]);
  h.live.events.responseDone({ id: 'tool', status: 'completed', outputTypes: ['function_call'] });
  assert.equal(h.live.named('respond').length, 2, 'Verabschiedung angefordert');
  h.live.events.responseStarted('bye');
  h.live.events.audio('ibye', Buffer.alloc(600 * 32));
  h.live.events.responseDone({ id: 'bye', status: 'completed', outputTypes: [] });
  assert.equal(h.drain(), 600);
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  assert.ok(h.texts.includes('ki: Hallo?'));
  h.live.events.closed(1006, '');
  assert.deepEqual(h.errors, ['Verbindung zu Testanbieter beendet']);
});

test('Brücke über die Schicht: flag_spam wechselt Anweisung und Tools und wirkt nur einmal', (t) => {
  let flagged = 0;
  const h = setup(t, { onFlagSpam: () => { flagged++; return 'SPAMROLLE'; } });
  h.live.events.responseStarted('r1');
  h.live.events.toolCall('flag_spam', 'c1', '{"grund":"Werbung"}');
  assert.deepEqual(h.live.named('update'), [['update', 'SPAMROLLE', ['end_call']]]);
  h.live.events.responseDone({ id: 'r1', status: 'completed', outputTypes: [] });
  h.live.events.responseStarted('r2');
  h.live.events.toolCall('flag_spam', 'c2', '{"grund":"noch mal"}');
  assert.equal(flagged, 1);
  assert.deepEqual(h.live.named('toolOutput').at(-1), ['toolOutput', 'c2', 'flag_spam', 'Unbekannte Funktion']);
  h.bridge.close();
});
