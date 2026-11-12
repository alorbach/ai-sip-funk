// Das Textmodell entscheidet im Gespräch mit (ai/judge.ts): die Fragen ans Modell, die Regie im Hintergrund und die
// Stellen in der Brücke, an denen sein Urteil die feste Regel ersetzt – mit Frist und Rückfall auf die Regel.
// Ohne Telefon, ohne Netz: Das Textmodell ist nachgestellt.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { isUnclearInterjection } from '../src/ai/farewell.js';
import { createDirector, createJudge, dialogText, directCall, directorNote, type CallJudge, type JudgeContext } from '../src/ai/judge.js';
import { RealtimeBridge, type RealtimeBridgeOptions, type TranscriptEntry } from '../src/ai/realtimeBridge.js';
import type { TextModel } from '../src/ai/providers/types.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

const CTX: JudgeContext = {
  task: 'Frag, ob Samstag 19 Uhr ein Tisch für vier frei ist.',
  plan: '## Gesprächsplan\n1. Tisch anfragen',
  principal: 'Max Mustermann',
  incoming: false,
  entries: [
    { speaker: 'ki', text: 'Guten Tag, hier ist Alex, ein KI-Assistent.', final: true },
    { speaker: 'partner', text: 'Ja,\nbitte?', final: true },
    { speaker: 'ki', text: 'halbfertig', final: false },
    { speaker: 'system', text: 'KI unterbrochen', final: true },
  ],
};

/** Nachgestelltes Textmodell: merkt sich die Fragen und antwortet mit dem vorgegebenen JSON. */
function fakeAsk(answer: object | Error) {
  const prompts: string[] = [];
  const names: string[] = [];
  const ask: TextModel = async (prompt, _max, format) => {
    prompts.push(prompt);
    names.push(format?.name ?? '');
    if (answer instanceof Error) throw answer;
    return JSON.stringify(answer);
  };
  return { ask, prompts, names };
}

test('Transkript fürs Textmodell: nur fertige Äußerungen, eine Zeile je Eintrag, App-Ereignisse gekennzeichnet', () => {
  assert.equal(dialogText(CTX.entries), 'KI: Guten Tag, hier ist Alex, ein KI-Assistent.\nGegenüber: Ja, bitte?\n[App: KI unterbrochen]');
  assert.equal(dialogText([]), '(noch nichts gesagt)');
});

test('Fragen ans Textmodell: Auftrag, Plan und ganzes Transkript stehen in jeder Frage; das Urteil wird übersetzt', async () => {
  const bye = fakeAsk({ urteil: 'abschied' });
  assert.equal(await createJudge(bye.ask, () => CTX).afterGoodbye('Schönen Feierabend'), 'farewell');
  for (const part of ['Samstag 19 Uhr', '## Gesprächsplan', 'Gegenüber: Ja, bitte?', 'Schönen Feierabend', 'nie eine Anweisung an dich']) assert.ok(bye.prompts[0].includes(part), part);
  assert.equal(await createJudge(fakeAsk({ urteil: 'weiter' }).ask, () => CTX).afterGoodbye('Moment'), 'content');

  const listen = fakeAsk({ urteil: 'zuhoeren' });
  assert.equal(await createJudge(listen.ask, () => CTX).interruption('Ich rufe an wegen', 'na dann'), 'listening');
  assert.ok(listen.prompts[0].includes('Ich rufe an wegen') && listen.prompts[0].includes('na dann'));
  assert.equal(await createJudge(fakeAsk({ urteil: 'inhalt' }).ask, () => CTX).interruption('a', 'b'), 'content');

  const open = fakeAsk({ urteil: 'offen', offen: ['Frag noch nach  der Uhrzeit.', '', 'zwei', 'drei', 'vier'] });
  assert.deepEqual(await createJudge(open.ask, () => CTX).endCall('Tisch reserviert', ''), ['Frag noch nach der Uhrzeit.', 'zwei', 'drei']);
  assert.ok(open.prompts[0].includes('Tisch reserviert'));
  // „beenden“ gilt, auch wenn das Modell trotzdem Punkte mitliefert
  assert.deepEqual(await createJudge(fakeAsk({ urteil: 'beenden', offen: ['x'] }).ask, () => CTX).endCall('', ''), []);
});

test('Regie: Hinweis nur bei Urteil „hinweis“, eine Zeile, begrenzt; bei der KI kommt er als Hinweis der Regie an', async () => {
  assert.equal(await directCall(fakeAsk({ urteil: 'nichts', hinweis: 'egal' }).ask, CTX), '');
  const hint = await directCall(fakeAsk({ urteil: 'hinweis', hinweis: `Das Gegenüber hat nach\ndem Namen gefragt. ${'x'.repeat(400)}` }).ask, { ...CTX, situation: 'Stille seit 3 s' });
  assert.ok(hint.startsWith('Das Gegenüber hat nach dem Namen gefragt.'));
  assert.equal(hint.length, 300);
  assert.match(directorNote('Nenn den Namen.'), /^Hinweis der Gesprächsregie .*Grundregeln gelten unverändert.*Nenn den Namen\.$/);
  const seen = fakeAsk({ urteil: 'nichts', hinweis: '' });
  await directCall(seen.ask, { ...CTX, situation: 'Stille seit 3 s' });
  assert.ok(seen.prompts[0].includes('Lage gerade: Stille seit 3 s'));
});

test('Regie: fragt erst, wenn das Gegenüber etwas gesagt hat; immer nur eine Frage; ein überholter Hinweis verfällt', async () => {
  const hints: string[] = [];
  const entries: JudgeContext['entries'][number][] = [{ speaker: 'ki', text: 'Hallo', final: true }];
  let release: (v: string) => void = () => undefined;
  let asked = 0;
  const ask: TextModel = () => {
    asked++;
    return new Promise((r) => (release = r));
  };
  const d = createDirector(ask, () => ({ ...CTX, entries }), (h) => (hints.push(h), true));
  d.onAiTurn();
  await flush();
  assert.equal(asked, 0, 'noch keine Äußerung des Gegenübers');
  entries.push({ speaker: 'partner', text: 'Wer ist da?', final: true });
  d.onAiTurn();
  d.onAiTurn(); // das Gespräch ist schon einen Redebeitrag weiter
  await flush();
  assert.equal(asked, 1, 'nur eine Frage gleichzeitig');
  release(JSON.stringify({ urteil: 'hinweis', hinweis: 'alt' }));
  await flush();
  assert.deepEqual(hints, [], 'der Hinweis zum alten Stand verfällt');
  assert.equal(asked, 2, 'der neue Stand wird angesehen');
  release(JSON.stringify({ urteil: 'hinweis', hinweis: 'Nenn deinen Namen.' }));
  await flush();
  assert.deepEqual(hints, ['Nenn deinen Namen.']);
  d.stop();
  d.onAiTurn();
  await flush();
  assert.equal(asked, 2, 'nach stop() keine Frage mehr');
});

test('Regie: Ein Fehler des Textmodells wird gemeldet und stört das Gespräch nicht', async () => {
  const errors: string[] = [];
  const d = createDirector(fakeAsk(new Error('überlastet')).ask, () => CTX, () => true, (m) => errors.push(m));
  d.onAiTurn();
  await flush();
  assert.deepEqual(errors, ['überlastet']);
});

test('Unklarer Einwurf: kurz, keine Frage, keine Zahl, nicht nur Antwortwörter', () => {
  for (const s of ['na dann ist ja gut', 'ach so ist das', 'ja genau so']) assert.equal(isUnclearInterjection(s), true, s);
  for (const s of ['', 'Nein', 'Stopp, Moment', 'Wie bitte?', 'Um 15 Uhr', 'Das ist jetzt aber wirklich ein viel zu langer Einwurf']) assert.equal(isUnclearInterjection(s), false, s);
});

// ---- Brücke mit Textmodell ----

type Sent = { type: string; item_id?: string; response?: { instructions?: string }; item?: { type?: string; output?: string; role?: string; content?: { text?: string }[] } };

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Sent[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }
  close(): void {
    this.readyState = 3;
  }
}

/** Urteile des Textmodells von Hand auslösen: jede Frage liefert ein Versprechen, das der Test erfüllt. */
function manualJudge() {
  const asked: { kind: string; args: string[]; resolve: (v: never) => void; reject: (e: Error) => void }[] = [];
  const q = (kind: string, args: string[]) => new Promise<never>((resolve, reject) => asked.push({ kind, args, resolve, reject }));
  const judge: CallJudge = {
    afterGoodbye: (u) => q('afterGoodbye', [u]),
    interruption: (s, u) => q('interruption', [s, u]),
    endCall: (r, o) => q('endCall', [r, o]),
  };
  return { judge, asked };
}

const mocked = new WeakSet<TestContext>();

function setup(t: TestContext, over: Partial<RealtimeBridgeOptions> = {}) {
  // Mehrere Brücken in einem Test teilen sich die nachgestellte Uhr
  if (!mocked.has(t)) t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  mocked.add(t);
  const ws = new FakeSocket();
  const transcripts: TranscriptEntry[] = [];
  const ended: string[] = [];
  const j = manualJudge();
  const bridge = new RealtimeBridge({
    apiKey: 'test', model: 'test-model', instructions: 'Test', voice: 'marin', greetingInstruction: 'GRUSS', formal: true,
    allowInterrupt: true, outputGain: 1, speechSpeed: 1, vadSilenceMs: 500, hangupGraceMs: 1000, stallMs: 0, greetingWaitMs: 0,
    onTranscript: (e) => transcripts.push(e),
    onUsage: () => undefined,
    onEndCall: (reason) => ended.push(reason),
    onError: () => undefined,
    createSocket: () => ws as unknown as WebSocket,
    judge: j.judge,
    ...over,
  });
  const server = (ev: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify(ev)));
  const tick = (ms: number) => t.mock.timers.tick(ms);
  const audio = (item: string, ms: number) => server({ type: 'response.output_audio.delta', item_id: item, delta: Buffer.alloc(ms * 48).toString('base64') });
  const say = (id: string, item: string, ms: number, text = 'Text') => {
    server({ type: 'response.created', response: { id } });
    audio(item, ms);
    server({ type: 'response.output_audio_transcript.done', item_id: item, transcript: text });
    server({ type: 'response.done', response: { id, status: 'completed' } });
  };
  const drain = (maxMs = 60_000) => {
    let played = 0;
    tick(500);
    while (played < maxMs && bridge.nextFrame()) played += 20;
    return played;
  };
  const creates = () => ws.sent.filter((s) => s.type === 'response.create').map((s) => s.response?.instructions ?? '');
  const outputs = () => ws.sent.filter((s) => s.item?.type === 'function_call_output').map((s) => s.item?.output ?? '');
  const notes = () => ws.sent.filter((s) => s.item?.role === 'system').map((s) => s.item?.content?.[0]?.text ?? '');
  const system = () => transcripts.filter((e) => e.speaker === 'system').map((e) => e.text);
  /** end_call ohne Sprache */
  const toolEnd = (callId = 'c1', args = '{"ergebnis":"erledigt"}') => {
    server({ type: 'response.created', response: { id: `tool-${callId}` } });
    server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: callId, arguments: args });
    server({ type: 'response.done', response: { id: `tool-${callId}`, status: 'completed' } });
  };
  const partner = (item: string, text: string) => {
    server({ type: 'input_audio_buffer.speech_started', item_id: item });
    server({ type: 'input_audio_buffer.speech_stopped', item_id: item });
    server({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: text });
  };
  ws.emit('open');
  server({ type: 'session.updated' });
  bridge.onConnected(8000);
  tick(0);
  say('r0', 'i0', 400, 'Hallo, hier ist ein KI-Assistent.');
  drain();
  ws.sent.length = 0;
  return { bridge, ws, server, tick, audio, say, drain, creates, outputs, notes, system, toolEnd, partner, transcripts, ended, asked: j.asked };
}

test('end_call: Sagt das Textmodell „nichts offen“, folgt sofort die Verabschiedung – auch mit Gesprächsplan ohne Selbstprüfung', async (t) => {
  const h = setup(t);
  h.bridge.updateInstructions('MIT PLAN', ['Tisch anfragen']);
  h.toolEnd();
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall']);
  assert.deepEqual(h.asked[0].args, ['erledigt', '']);
  assert.deepEqual(h.outputs(), [], 'der Aufruf bleibt bis zum Urteil offen');
  assert.match(h.bridge.situation(), /Prüfung gegen den Auftrag/);
  h.asked[0].resolve([] as never);
  await flush();
  assert.deepEqual(h.outputs(), ['ok – verabschiede dich jetzt']);
  assert.equal(h.creates().length, 1, 'Verabschiedung angefordert');
  assert.match(h.creates()[0], /Verabschiede dich/);
  h.say('bye', 'ibye', 1000, 'Auf Wiederhören');
  h.drain();
  h.bridge.nextFrame();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('end_call: Meldet das Textmodell offene Punkte, spricht die KI sie an; der zweite end_call beendet ohne neue Prüfung', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve(['Frag noch, auf welchen Namen reserviert wird.'] as never);
  await flush();
  assert.match(h.outputs()[0], /Noch nicht beendet[\s\S]*1\. Frag noch, auf welchen Namen reserviert wird\./);
  assert.deepEqual(h.creates(), [''], 'die KI ist wieder dran');
  assert.ok(h.system().some((s) => s.startsWith('Prüfung vor dem Auflegen: noch offen – Frag noch')), 'steht im Transkript (und damit beim Agenten)');
  assert.deepEqual(h.ended, []);
  h.say('r2', 'i2', 800, 'Auf welchen Namen darf ich reservieren?');
  h.drain();
  h.toolEnd('c2');
  assert.equal(h.asked.length, 1, 'nur eine Prüfung je Gespräch');
  assert.equal(h.outputs().at(-1), 'ok – verabschiede dich jetzt');
  h.bridge.close();
});

test('end_call: Antwortet das Textmodell nicht, gilt nach der Frist die alte Regel (mit Plan die Selbstprüfung, ohne Plan das Beenden)', async (t) => {
  const withPlan = setup(t);
  withPlan.bridge.updateInstructions('MIT PLAN', ['Tisch anfragen']);
  withPlan.toolEnd();
  withPlan.tick(2999);
  assert.deepEqual(withPlan.outputs(), []);
  withPlan.tick(1);
  assert.match(withPlan.outputs()[0], /Prüfe zuerst jeden Schritt des Gesprächsplans[\s\S]*1\. Tisch anfragen/);
  // Ein verspätetes Urteil ändert nichts mehr
  withPlan.asked[0].resolve([] as never);
  await flush();
  assert.equal(withPlan.outputs().length, 1);
  withPlan.bridge.close();

  const noPlan = setup(t);
  noPlan.toolEnd();
  noPlan.asked[0].reject(new Error('überlastet'));
  await flush();
  assert.deepEqual(noPlan.outputs(), ['ok – verabschiede dich jetzt']);
  noPlan.bridge.close();
});

test('end_call: Spricht das Gegenüber während der Prüfung weiter, wird nicht mitten hinein verabschiedet', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u5' });
  h.asked[0].resolve([] as never);
  await flush();
  assert.match(h.outputs()[0], /Nicht beendet: Inzwischen ist noch etwas dazugekommen/);
  assert.deepEqual(h.creates(), [], 'das Gegenüber spricht noch: Der Anbieter antwortet danach von selbst');
  assert.deepEqual(h.ended, []);
  h.bridge.close();
});

test('end_call zusammen mit Sprache: Die Prüfung läuft nebenher, Fehlendes kommt als Hinweis nach', async (t) => {
  const h = setup(t);
  h.bridge.updateInstructions('MIT PLAN', ['Tisch anfragen']);
  h.server({ type: 'response.created', response: { id: 'r1' } });
  h.audio('i1', 1000);
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{"ergebnis":"reserviert"}' });
  h.server({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  assert.match(h.outputs()[0], /^Nicht beendet: Du hast in dieser Antwort noch gesprochen/);
  assert.doesNotMatch(h.outputs()[0], /Gesprächsplans/, 'die Schritte prüft das Textmodell, nicht die Sprach-KI');
  h.asked[0].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  assert.ok(h.notes().some((n) => /noch etwas fehlt[\s\S]*vier Personen/.test(n)));
  // Schweigt das Gegenüber danach, soll die KI den Punkt ansprechen statt nur aufzulegen
  h.drain();
  h.tick(3500);
  assert.match(h.creates().at(-1) ?? '', /Fehlt der eben genannte Punkt wirklich noch/);
  h.bridge.close();
});

test('Nach der Verabschiedung: Das Textmodell erkennt einen Abschied, den die Wortliste nicht kennt', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  h.say('bye', 'ibye', 1000, 'Auf Wiederhören');
  h.drain();
  h.bridge.nextFrame();
  h.partner('u1', 'Ja danke, Ihnen auch einen schönen Feierabend.');
  assert.equal(h.asked[1].kind, 'afterGoodbye');
  h.tick(2000);
  assert.deepEqual(h.ended, [], 'wartet auf das Urteil');
  h.asked[1].resolve('farewell' as never);
  await flush();
  h.bridge.nextFrame();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('Nach der Verabschiedung: „weiter“ nimmt das Beenden zurück; ohne Urteil entscheidet nach der Frist die Wortliste', async (t) => {
  const go = setup(t);
  go.toolEnd();
  go.asked[0].resolve([] as never);
  await flush();
  go.say('bye', 'ibye', 1000, 'Auf Wiederhören');
  go.drain();
  go.bridge.nextFrame();
  go.partner('u1', 'Okay, gut.'); // für die Wortliste ein Abschied
  go.asked[1].resolve('content' as never);
  await flush();
  go.tick(60_000);
  assert.deepEqual(go.ended, []);
  assert.ok(go.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  go.bridge.close();

  const slow = setup(t);
  slow.toolEnd();
  slow.asked[0].resolve([] as never);
  await flush();
  slow.say('bye', 'ibye', 1000, 'Auf Wiederhören');
  slow.drain();
  slow.bridge.nextFrame();
  slow.partner('u1', 'Tschüss!');
  slow.tick(2500);
  slow.bridge.nextFrame();
  slow.tick(1000);
  assert.deepEqual(slow.ended, ['KI hat das Gespräch beendet']);
  slow.bridge.close();
});

test('Einwurf mitten im Satz: Unklares entscheidet das Textmodell, Klares sofort die Wortliste', async (t) => {
  const h = setup(t);
  h.say('r1', 'i1', 4000, 'Ich rufe an, weil der Termin am Dienstag verschoben werden soll.');
  assert.equal(h.drain(1000), 1000);
  h.partner('u1', 'Na dann ist ja gut.');
  assert.deepEqual(h.asked.map((a) => a.kind), ['interruption']);
  assert.deepEqual(h.asked[0].args, ['Ich rufe an, weil der Termin am Dienstag verschoben werden soll.', 'Na dann ist ja gut.']);
  assert.equal(h.bridge.nextFrame(), undefined, 'die KI pausiert bis zum Urteil');
  h.asked[0].resolve('listening' as never);
  await flush();
  assert.equal(h.drain(), 3000, 'die KI spricht ihren Satz zu Ende');

  h.say('r2', 'i2', 4000, 'Passt Ihnen Donnerstag?');
  h.drain(1000);
  h.partner('u2', 'Nein.');
  assert.equal(h.asked.length, 1, 'ein klares „Nein“ geht nicht ans Textmodell');
  assert.ok(h.ws.sent.some((s) => s.type === 'conversation.item.truncate' && s.item_id === 'i2'), 'Rest verworfen');
  h.bridge.close();
});

test('Einwurf mitten im Satz: Ohne Urteil gilt er nach der Frist als Inhalt', async (t) => {
  const h = setup(t);
  h.say('r1', 'i1', 4000, 'Ich rufe an wegen des Termins.');
  h.drain(1000);
  h.partner('u1', 'Das passt mir gar nicht.');
  assert.equal(h.asked.length, 1);
  h.tick(1500);
  assert.ok(h.ws.sent.some((s) => s.type === 'conversation.item.truncate' && s.item_id === 'i1'));
  h.asked[0].resolve('listening' as never);
  await flush();
  assert.equal(h.drain(), 0, 'das späte Urteil holt den verworfenen Rest nicht zurück');
  h.bridge.close();
});

test('Regie-Hinweis: kommt als Hinweis bei der KI an und steht im Transkript; nicht mehr beim Beenden oder in der Spam-Abwehr', async (t) => {
  const h = setup(t);
  assert.equal(h.bridge.directorHint('Das Gegenüber hat nach dem Namen gefragt, nenn ihn.'), true);
  assert.match(h.notes()[0], /^Hinweis der Gesprächsregie/);
  assert.deepEqual(h.creates(), [], 'der Hinweis fordert keine Antwort an');
  assert.deepEqual(h.system(), ['Hinweis der Regie an die KI: Das Gegenüber hat nach dem Namen gefragt, nenn ihn.']);
  h.toolEnd();
  assert.equal(h.bridge.directorHint('zu spät'), false);
  h.bridge.close();
  const scam = setup(t, { scam: true });
  assert.equal(scam.bridge.directorHint('x'), false);
  scam.toolEnd();
  assert.equal(scam.asked.length, 0, 'in der Spam-Abwehr prüft das Textmodell das Auflegen nicht');
  scam.bridge.close();
});

test('Lage und Ereignisse: Stille, Anstoß und wer zuletzt sprach sind für Regie und Agent sichtbar', (t) => {
  const h = setup(t, { stallMs: 3000, judge: undefined });
  h.say('r1', 'i1', 600, 'Passt Ihnen Donnerstag?');
  assert.equal(h.bridge.situation(), 'die KI spricht gerade');
  h.drain();
  h.bridge.nextFrame();
  h.tick(2000);
  assert.match(h.bridge.situation(), /^Stille seit \d+ s; zuletzt sprach die KI$/);
  h.tick(1000);
  assert.deepEqual(h.system(), ['Stille: Seit 3 s sagt niemand etwas – die KI wurde angestoßen (1/2)']);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  assert.equal(h.bridge.situation(), 'das Gegenüber spricht gerade');
  h.bridge.close();
  assert.equal(h.bridge.situation(), 'Gespräch beendet');
});
