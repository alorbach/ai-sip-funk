// Das Textmodell entscheidet im Gespräch mit (ai/judge.ts): die Fragen ans Modell, die Regie im Hintergrund und die
// Stellen in der Brücke, an denen sein Urteil die feste Regel ersetzt – mit Frist und Rückfall auf die Regel.
// Ohne Telefon, ohne Netz: Das Textmodell ist nachgestellt.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
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

  const open = fakeAsk({ punkte: [{ punkt: 'Uhrzeit', stand: 'offen' }], offen: ['Frag noch nach  der Uhrzeit.', '', 'zwei', 'drei', 'vier'] });
  assert.deepEqual(await createJudge(open.ask, () => ({ ...CTX, instructions: 'GRUNDREGELN DER KI' })).endCall(), ['Frag noch nach der Uhrzeit.', 'zwei', 'drei']);
  assert.ok(!open.prompts[0].includes('GRUNDREGELN DER KI'), 'die Prüfung beim Auflegen bleibt schlank');
  assert.deepEqual(await createJudge(fakeAsk({ punkte: [{ punkt: 'Tisch', stand: 'erledigt' }], offen: [] }).ask, () => CTX).endCall(), []);
});

test('Regie: Hinweis nur bei Urteil „hinweis“, eine Zeile, begrenzt; bei der KI kommt er als Hinweis der Regie an', async () => {
  assert.equal(await directCall(fakeAsk({ urteil: 'nichts', hinweis: 'egal' }).ask, CTX), '');
  const hint = await directCall(fakeAsk({ urteil: 'hinweis', hinweis: `Das Gegenüber hat nach\ndem Namen gefragt. ${'x'.repeat(400)}` }).ask, { ...CTX, situation: 'Stille seit 3 s' });
  assert.ok(hint.startsWith('Das Gegenüber hat nach dem Namen gefragt.'));
  assert.equal(hint.length, 300);
  assert.match(directorNote('Nenn den Namen.'), /^Hinweis der Gesprächsregie .*Grundregeln gelten unverändert.*Nenn den Namen\.$/);
  const seen = fakeAsk({ urteil: 'nichts', hinweis: '' });
  await directCall(seen.ask, { ...CTX, situation: 'Stille seit 3 s', instructions: 'GRUNDREGELN DER KI' });
  assert.ok(seen.prompts[0].includes('Lage gerade: Stille seit 3 s'));
  assert.ok(seen.prompts[0].includes('GRUNDREGELN DER KI'), 'die Regie kennt die vollständigen Anweisungen der Sprach-KI');
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
    endCall: () => q('endCall', []),
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
  // Die nachgestellte Uhr beginnt bei 0: Der Audio-Wächter der Begrüßung hält sich dadurch für noch offen. Ablaufen lassen
  if (!over.stallMs) tick(5000);
  ws.sent.length = 0;
  return { bridge, ws, server, tick, audio, say, drain, creates, outputs, notes, system, toolEnd, partner, transcripts, ended, asked: j.asked };
}

/** Verabschiedung sprechen und ausspielen; danach läuft die Nachhörphase (1000 ms) */
function farewell(h: ReturnType<typeof setup>): void {
  h.say('bye', 'ibye', 1000, 'Auf Wiederhören');
  h.drain();
  h.bridge.nextFrame();
}

test('end_call: Die KI verabschiedet sich sofort, die Prüfung läuft nebenher – auch mit Gesprächsplan ohne Selbstprüfung', async (t) => {
  const h = setup(t);
  h.bridge.updateInstructions('MIT PLAN', ['Tisch anfragen']);
  h.toolEnd();
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall']);
  assert.deepEqual(h.outputs(), ['ok – verabschiede dich jetzt'], 'keine Pause vor dem Abschied, keine Selbstprüfung');
  assert.match(h.creates()[0], /Verabschiede dich/);
  farewell(h);
  h.tick(1000);
  assert.deepEqual(h.ended, [], 'das Auflegen wartet auf das Urteil');
  h.asked[0].resolve([] as never);
  await flush();
  h.tick(250);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('end_call: Kommt das Urteil vor dem Ende der Nachhörphase, wird ohne Verzögerung aufgelegt', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  h.tick(999);
  assert.deepEqual(h.ended, []);
  h.tick(1);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('end_call: Meldet das Textmodell offene Punkte, wird das Auflegen zurückgenommen und die KI spricht sie noch an', async (t) => {
  const h = setup(t);
  h.toolEnd();
  farewell(h);
  h.asked[0].resolve(['Frag noch, auf welchen Namen reserviert wird.'] as never);
  await flush();
  assert.ok(h.notes().some((n) => /Das Beenden ist zurückgenommen[\s\S]*1\. Frag noch, auf welchen Namen reserviert wird\.[\s\S]*Eine Sache noch/.test(n)));
  assert.equal(h.creates().at(-1), '', 'die KI ist wieder dran');
  assert.ok(h.system().some((x) => x.startsWith('Prüfung vor dem Auflegen: noch offen – Frag noch')), 'steht im Transkript (und damit beim Agenten)');
  h.tick(60_000);
  assert.deepEqual(h.ended, [], 'nicht aufgelegt');
  h.say('r2', 'i2', 800, 'Eine Sache noch: Auf welchen Namen darf ich reservieren?');
  h.drain();
  h.toolEnd('c2');
  assert.equal(h.asked.length, 1, 'nach einer Rücknahme durch die Prüfung wird nicht noch einmal geprüft');
  assert.equal(h.outputs().at(-1), 'ok – verabschiede dich jetzt');
  h.bridge.close();
});

test('end_call: Antwortet das Textmodell nicht, wird nach der Frist aufgelegt, wie die Sprach-KI entschieden hat', async (t) => {
  const h = setup(t);
  h.toolEnd();
  farewell(h);
  h.tick(5000);
  assert.deepEqual(h.ended, [], 'bis 8 s nach dem end_call wartet das Auflegen');
  // (in kleinen Schritten: Die nachgestellte Uhr plant einen Timer, der sich selbst neu stellt, sonst hinter das Ende des Sprungs)
  for (let i = 0; i < 9; i++) h.tick(250);
  assert.deepEqual(h.ended, []);
  for (let i = 0; i < 3; i++) h.tick(250);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  // Ein verspätetes Urteil ändert nichts mehr
  h.asked[0].resolve(['zu spät'] as never);
  await flush();
  assert.equal(h.notes().length, 0);
  h.bridge.close();

  const failed = setup(t);
  failed.toolEnd();
  failed.asked[0].reject(new Error('überlastet'));
  await flush();
  farewell(failed);
  failed.tick(1000);
  assert.deepEqual(failed.ended, ['KI hat das Gespräch beendet']);
  failed.bridge.close();
});

test('end_call: Geht das Gespräch weiter, weil das Gegenüber noch etwas sagt, wird beim nächsten end_call neu geprüft', async (t) => {
  let checks = 0;
  const j = { afterGoodbye: async () => 'content' as const, endCall: () => (checks++, new Promise<string[]>(() => undefined)) };
  const g = setup(t, { judge: j });
  g.toolEnd();
  farewell(g);
  g.partner('u1', 'Ach, eine Frage habe ich noch zur Rechnung.');
  await flush();
  assert.ok(g.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  g.say('r2', 'i2', 600, 'Gern, welche?');
  g.drain();
  g.toolEnd('c2');
  assert.equal(checks, 2, 'die erste Prüfung kannte die neue Frage noch nicht');
  g.bridge.close();
});

test('end_call durch den Agenten: Der Auftraggeber beendet, das Textmodell prüft nicht', (t) => {
  const h = setup(t, { onAskAgent: () => undefined });
  assert.equal(h.bridge.agentEnd(), 'ending');
  h.toolEnd();
  assert.equal(h.asked.length, 0);
  assert.deepEqual(h.outputs(), ['ok – verabschiede dich jetzt']);
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
  slow.tick(3999);
  assert.deepEqual(slow.ended, []);
  slow.tick(1);
  slow.bridge.nextFrame();
  slow.tick(1000);
  assert.deepEqual(slow.ended, ['KI hat das Gespräch beendet']);
  slow.bridge.close();
});

test('Einwurf mitten im Satz: bleibt bei der Wortliste – das Textmodell wird nicht gefragt, es entsteht keine Pause', (t) => {
  const h = setup(t);
  h.say('r1', 'i1', 4000, 'Ich rufe an, weil der Termin am Dienstag verschoben werden soll.');
  h.drain(1000);
  h.partner('u1', 'Das passt mir gar nicht.');
  assert.equal(h.asked.length, 0);
  assert.ok(h.ws.sent.some((s) => s.type === 'conversation.item.truncate' && s.item_id === 'i1'), 'Rest sofort verworfen');
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

test('Fragen ans Textmodell: Die Prüfung beim Auflegen bekommt knapp 8 s, sieht die Ergebnismeldung der KI nicht und entfällt ohne Auftrag', async () => {
  const timeouts: (number | undefined)[] = [];
  const prompts: string[] = [];
  const ask: TextModel = async (prompt, _max, format, timeoutMs) => {
    prompts.push(prompt);
    timeouts.push(timeoutMs);
    return JSON.stringify(format?.name === 'auflegen_pruefen' ? { punkte: [], offen: [] } : { urteil: 'abschied' });
  };
  const ctx: JudgeContext = { ...CTX, entries: [...CTX.entries, { speaker: 'system', text: 'Ergebnis laut KI: Gruß ausgerichtet', final: true }] };
  const judge = createJudge(ask, () => ctx);
  await judge.endCall();
  await judge.afterGoodbye('Tschüss');
  assert.deepEqual(timeouts, [7500, 3500], 'knapp unter den Fristen der Brücke (8 s, 4 s), damit beide nicht gleichzeitig ablaufen');
  assert.ok(!prompts[0].includes('Gruß ausgerichtet'), 'die Ergebnismeldung zählt auch nach einem zurückgenommenen Auflegen nicht mit');
  assert.ok(prompts[0].includes('[App: KI unterbrochen]'));
  assert.deepEqual(await createJudge(ask, () => ({ ...CTX, task: ' ' })).endCall(), []);
  assert.equal(prompts.length, 2, 'ohne Auftrag keine Frage');
});

test('Nach der Verabschiedung: Redet das Gegenüber weiter, während das Textmodell urteilt, zählen beide Äußerungen zusammen', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  h.partner('u1', 'Ja danke, Ihnen auch einen schönen Feierabend.');
  assert.equal(h.asked[1].kind, 'afterGoodbye');
  h.partner('u2', 'Ach, eine Frage noch zur Rechnung.');
  // Das Urteil über die erste Äußerung allein ist überholt
  h.asked[1].resolve('farewell' as never);
  await flush();
  h.bridge.nextFrame();
  h.tick(2000);
  assert.deepEqual(h.ended, [], 'nicht mitten in den neuen Satz aufgelegt');
  assert.equal(h.asked[2].kind, 'afterGoodbye');
  assert.match(h.asked[2].args[0], /schönen Feierabend\. Ach, eine Frage noch/);
  h.asked[2].resolve('content' as never);
  await flush();
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  assert.ok(h.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  h.bridge.close();
});

test('Nach der Verabschiedung: Spricht das Gegenüber gerade wieder, wenn das Urteil „Abschied“ kommt, wird nicht aufgelegt', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  h.server({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Ja danke, Ihnen auch einen schönen Feierabend.' });
  assert.equal(h.asked[1].kind, 'afterGoodbye');
  h.asked[1].resolve('farewell' as never);
  await flush();
  h.bridge.nextFrame();
  h.tick(2000);
  assert.deepEqual(h.ended, [], 'das Gegenüber spricht noch');
  h.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u2' });
  h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'Und grüßen Sie bitte Herrn Mustermann.' });
  assert.match(h.asked[2].args[0], /Feierabend\. Und grüßen Sie/);
  h.bridge.close();
});

test('end_call zusammen mit Sprache: Kommt der nächste end_call vor dem Urteil, wird frisch geprüft und das Auflegen wartet darauf', async (t) => {
  const h = setup(t);
  h.server({ type: 'response.created', response: { id: 'r1' } });
  h.audio('i1', 1000);
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c1', arguments: '{"ergebnis":"reserviert"}' });
  h.server({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  h.drain();
  h.tick(3500);
  assert.match(h.creates().at(-1) ?? '', /Rufe jetzt end_call auf/, 'nichts gemeldet: kein „eben genannter Punkt“');
  assert.doesNotMatch(h.creates().at(-1) ?? '', /eben genannte Punkt/);
  h.toolEnd('c2');
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall', 'endCall'], 'die erste Prüfung ist überholt');
  assert.equal(h.outputs().at(-1), 'ok – verabschiede dich jetzt');
  h.asked[0].resolve(['veraltet'] as never);
  await flush();
  assert.ok(!h.notes().some((n) => n.includes('veraltet')));
  farewell(h);
  h.tick(1000);
  assert.deepEqual(h.ended, [], 'das Auflegen wartet auf die frische Prüfung');
  h.asked[1].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  assert.ok(h.notes().some((n) => /Das Beenden ist zurückgenommen[\s\S]*vier Personen/.test(n)));
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  h.bridge.close();
});

// ---- Nachbesserungen aus der Durchsicht ----

/** Die KI spricht und ruft im selben Atemzug end_call auf (abgelehnt, die Prüfung läuft nebenher) */
function endWithSpeech(h: ReturnType<typeof setup>, response: string, item: string, callId: string, ms = 1000): void {
  h.server({ type: 'response.created', response: { id: response } });
  h.audio(item, ms);
  h.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: callId, arguments: '{"ergebnis":"reserviert"}' });
  h.server({ type: 'response.done', response: { id: response, status: 'completed' } });
}

const speechStarted = (h: ReturnType<typeof setup>, item: string) => h.server({ type: 'input_audio_buffer.speech_started', item_id: item });
const speechStopped = (h: ReturnType<typeof setup>, item: string) => h.server({ type: 'input_audio_buffer.speech_stopped', item_id: item });
const transcribed = (h: ReturnType<typeof setup>, item: string, transcript: string) => h.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript });

test('Nach der Verabschiedung: Setzt das Gegenüber an, bevor die Mitschrift der ersten Äußerung da ist, zählt auch die zweite – das Urteil „Abschied“ über die erste legt nicht auf', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  speechStarted(h, 'u1');
  speechStopped(h, 'u1');
  speechStarted(h, 'u2');
  transcribed(h, 'u1', 'Ja danke, Ihnen auch einen schönen Feierabend.');
  assert.equal(h.asked[1].kind, 'afterGoodbye');
  speechStopped(h, 'u2');
  transcribed(h, 'u2', 'Ach, eine Frage noch zur Rechnung.');
  assert.equal(h.asked.length, 3, 'die zweite Äußerung wird nicht verschluckt: Beide zusammen gehen noch einmal ans Textmodell');
  assert.match(h.asked[2].args[0], /Feierabend\. Ach, eine Frage noch/);
  // Das Urteil über die erste Äußerung allein ist überholt
  h.asked[1].resolve('farewell' as never);
  await flush();
  h.bridge.nextFrame();
  h.tick(2000);
  assert.deepEqual(h.ended, [], 'nicht aufgelegt');
  h.asked[2].resolve('content' as never);
  await flush();
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  assert.ok(h.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  h.bridge.close();
});

test('Nach der Verabschiedung: Ein „Abschied“ über die erste Äußerung legt nicht auf, solange die Mitschrift der zweiten fehlt', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  // Die zweite Äußerung beginnt und endet, bevor die Mitschrift der ersten da ist; ihre Mitschrift kommt erst nach dem Urteil
  speechStarted(h, 'u1');
  speechStopped(h, 'u1');
  speechStarted(h, 'u2');
  speechStopped(h, 'u2');
  transcribed(h, 'u1', 'Ja danke, Ihnen auch einen schönen Feierabend.');
  assert.equal(h.asked[1].kind, 'afterGoodbye');
  h.asked[1].resolve('farewell' as never);
  await flush();
  h.bridge.nextFrame();
  h.tick(2000);
  assert.deepEqual(h.ended, [], 'u2 ist noch nicht gehört');
  transcribed(h, 'u2', 'Und grüßen Sie bitte Herrn Mustermann.');
  assert.match(h.asked[2].args[0], /Feierabend\. Und grüßen Sie/);
  h.bridge.close();
});

test('Nach der Verabschiedung ohne Textmodell: Eine zweite Äußerung, die vor der Mitschrift der ersten begann und endete, geht nicht verloren', (t) => {
  const h = setup(t, { judge: undefined });
  h.toolEnd();
  farewell(h);
  speechStarted(h, 'u1');
  speechStopped(h, 'u1');
  speechStarted(h, 'u2');
  speechStopped(h, 'u2');
  transcribed(h, 'u1', 'Tschüss!');
  h.bridge.nextFrame();
  h.tick(2000);
  assert.deepEqual(h.ended, [], 'u2 ist noch nicht gehört');
  transcribed(h, 'u2', 'Moment, eine Frage hätte ich noch.');
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  assert.ok(h.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  h.bridge.close();
});

test('Nach der Verabschiedung: Bleibt die Mitschrift der weiteren Äußerung aus, entscheidet nach der Frist, was schon gesagt war – es wird nicht verworfen', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  speechStarted(h, 'u1');
  speechStopped(h, 'u1');
  speechStarted(h, 'u2'); // nur ein Geräusch: Seine Mitschrift kommt nie
  transcribed(h, 'u1', 'Ja danke, Ihnen auch einen schönen Feierabend.');
  h.asked[1].resolve('farewell' as never);
  await flush();
  speechStopped(h, 'u2');
  h.tick(4000);
  assert.equal(h.asked.length, 3, 'die Worte davor werden noch einmal beurteilt, statt dass die KI ohne Anlass weitermacht');
  assert.match(h.asked[2].args[0], /schönen Feierabend/);
  h.asked[2].resolve('farewell' as never);
  await flush();
  h.bridge.nextFrame();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('end_call zusammen mit Sprache: Hat das Gegenüber seit Beginn der Prüfung gesprochen, verfällt ihr Urteil, und der nächste end_call wird frisch geprüft', async (t) => {
  const h = setup(t);
  endWithSpeech(h, 'r1', 'i1', 'c1');
  h.drain();
  assert.equal(h.asked.length, 1);
  h.partner('u1', 'Ja, vier Personen.');
  h.asked[0].resolve(['Frag noch nach dem Namen.'] as never);
  await flush();
  assert.ok(!h.notes().some((n) => /noch etwas fehlt/.test(n)), 'die Prüfung kannte die Antwort nicht');
  assert.ok(!h.system().some((x) => x.startsWith('Prüfung vor dem Auflegen')));
  h.say('r2', 'i2', 500, 'Gut, dann ist alles klar.');
  h.drain();
  h.toolEnd('c2');
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall', 'endCall'], 'frisch geprüft, mit der Antwort');
  h.bridge.close();
});

test('end_call zusammen mit Sprache: Kommt das Urteil nach dem Anstoß zum Beenden und beendet die KI trotzdem, wird das Auflegen zurückgenommen – einmal', async (t) => {
  const h = setup(t);
  endWithSpeech(h, 'r1', 'i1', 'c1');
  h.drain();
  h.tick(3500);
  assert.match(h.creates().at(-1) ?? '', /Rufe jetzt end_call auf/, 'beim Anstoß war noch nichts gemeldet');
  // Das Urteil kommt erst jetzt, die Antwort der KI auf den Anstoß ist schon unterwegs
  h.asked[0].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  assert.ok(h.notes().some((n) => /noch etwas fehlt[\s\S]*vier Personen/.test(n)));
  h.toolEnd('c2');
  assert.equal(h.asked.length, 1, 'der Hinweis ist die Prüfung: keine neue Frage');
  assert.ok(h.notes().some((n) => /Das Beenden ist zurückgenommen[\s\S]*vier Personen/.test(n)), 'das Auflegen ist zurückgenommen');
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  // Beim nächsten end_call ist der Punkt verbraucht
  h.say('r3', 'i3', 600, 'Eine Sache noch: Es sind vier Personen.');
  h.drain();
  h.toolEnd('c3');
  assert.equal(h.outputs().at(-1), 'ok – verabschiede dich jetzt');
  farewell(h);
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();

  // Hat das Gegenüber dazwischen geantwortet, ist der Punkt Sache der KI
  const g = setup(t);
  endWithSpeech(g, 'r1', 'i1', 'c1');
  g.asked[0].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  g.drain();
  g.partner('u1', 'Ja, und?');
  g.say('r2', 'i2', 500, 'Es sind vier Personen.');
  g.drain();
  g.toolEnd('c2');
  assert.equal(g.outputs().at(-1), 'ok – verabschiede dich jetzt');
  assert.ok(!g.notes().some((n) => /Das Beenden ist zurückgenommen/.test(n)));
  g.bridge.close();
});

test('end_call zusammen mit Sprache: Ein beantworteter Punkt wird beim Anstoß nach dem Schweigen nicht mehr „eben genannt“', async (t) => {
  const h = setup(t);
  endWithSpeech(h, 'r1', 'i1', 'c1');
  h.asked[0].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  h.drain();
  h.partner('u1', 'Ja, vier Personen passt.');
  endWithSpeech(h, 'r2', 'i2', 'c2');
  h.drain();
  h.tick(3500);
  assert.match(h.creates().at(-1) ?? '', /Rufe jetzt end_call auf/);
  assert.doesNotMatch(h.creates().at(-1) ?? '', /eben genannte Punkt/);
  h.bridge.close();
});

test('end_call durch den Agenten: Läuft noch eine Prüfung nebenher, wird nicht frisch geprüft, und ihr Urteil nimmt nichts zurück', async (t) => {
  const h = setup(t);
  endWithSpeech(h, 'r1', 'i1', 'c1');
  assert.equal(h.asked.length, 1);
  assert.equal(h.bridge.agentEnd(), 'ending');
  h.drain();
  h.toolEnd('c2');
  assert.equal(h.asked.length, 1, 'der Auftraggeber beendet: Das Textmodell prüft nicht');
  assert.equal(h.outputs().at(-1), 'ok – verabschiede dich jetzt');
  h.asked[0].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  farewell(h);
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  assert.ok(!h.notes().some((n) => /zurückgenommen/.test(n)));
  h.bridge.close();
});

test('end_call: Sagt das Gegenüber nach einem Urteil „nichts offen“ doch noch etwas, wird beim nächsten end_call neu geprüft', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  h.partner('u1', 'Moment, eine Frage hätte ich noch zur Rechnung.');
  h.asked[1].resolve('content' as never);
  await flush();
  assert.ok(h.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  h.say('r2', 'i2', 600, 'Gern, welche?');
  h.drain();
  h.toolEnd('c2');
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall', 'afterGoodbye', 'endCall'], 'das Neue aus dem Gespräch kannte die erste Prüfung nicht');
  h.bridge.close();
});

test('Regie: Hat das Gegenüber während der Frage etwas gesagt, verfällt der Hinweis – auch wenn die KI nicht gesprochen hat', async () => {
  const hints: string[] = [];
  const entries: JudgeContext['entries'][number][] = [
    { speaker: 'ki', text: 'Hallo', final: true },
    { speaker: 'partner', text: 'Wer ist da?', final: true },
  ];
  let release: (v: string) => void = () => undefined;
  let asked = 0;
  const ask: TextModel = () => {
    asked++;
    return new Promise((r) => (release = r));
  };
  const d = createDirector(ask, () => ({ ...CTX, entries }), (h) => (hints.push(h), true));
  d.onAiTurn();
  await flush();
  entries.push({ speaker: 'partner', text: 'Ach so, einen Moment.', final: true });
  release(JSON.stringify({ urteil: 'hinweis', hinweis: 'Nenn deinen Namen.' }));
  await flush();
  assert.deepEqual(hints, [], 'der Hinweis kennt die neue Äußerung nicht');
  assert.equal(asked, 1);
  d.onAiTurn();
  await flush();
  release(JSON.stringify({ urteil: 'hinweis', hinweis: 'Nenn deinen Namen.' }));
  await flush();
  assert.deepEqual(hints, ['Nenn deinen Namen.'], 'beim nächsten Redebeitrag der KI sieht die Regie den neuen Stand');
});

// ---- Review-Runde 3 ----

test('Nach der Verabschiedung: Die Frist für die Mitschrift läuft nicht ab, solange das Gegenüber spricht – eine lange Frage nach „Ja, tschüss!“ wird nicht überhört', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  speechStarted(h, 'u1'); // „Ja, tschüss!“
  h.tick(1000);
  speechStopped(h, 'u1');
  h.tick(600);
  speechStarted(h, 'u2'); // die Frage dauert über vier Sekunden
  h.tick(400);
  transcribed(h, 'u1', 'Ja, tschüss!'); // die Mitschrift der ersten kommt, während die zweite läuft
  // (einzeln: Timer, die sich neu stellen, laufen in der nachgestellten Uhr sonst erst am Ende des Sprungs)
  for (let i = 0; i < 6; i++) h.tick(1000);
  h.bridge.nextFrame();
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall'], 'mitten in der Frage wird nichts entschieden');
  assert.deepEqual(h.ended, [], 'nicht in die Frage hinein aufgelegt');
  speechStopped(h, 'u2');
  transcribed(h, 'u2', 'Ach, eine Frage noch: Kommt die Rechnung per Post?');
  assert.match(h.asked[1].args[0], /Ja, tschüss! Ach, eine Frage noch/, 'beide Äußerungen zusammen');
  h.asked[1].resolve('content' as never);
  await flush();
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  assert.ok(h.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  h.bridge.close();
});

test('Nach der Verabschiedung: Ein langer Abschiedssatz und eine Mitschrift, die nach dem Satzende noch dauert, setzen das Gespräch nicht fort – die Frist zählt ab dem Sprachende', (t) => {
  const h = setup(t, { judge: undefined });
  h.toolEnd();
  farewell(h);
  speechStarted(h, 'u1');
  for (let i = 0; i < 5; i++) h.tick(1000); // ein Satz von fünf Sekunden: die Frist von vier wäre mittendrin abgelaufen
  assert.deepEqual(h.system().filter((x) => x.startsWith('Gegenüber hat noch etwas gesagt')), [], 'nicht umsonst fortgesetzt');
  speechStopped(h, 'u1');
  for (let i = 0; i < 3; i++) h.tick(1000); // und die Mitschrift braucht nach dem Satzende noch einen Moment
  assert.deepEqual(h.ended, []);
  transcribed(h, 'u1', 'Ja, vielen Dank, Ihnen auch einen schönen Abend, tschüss!');
  h.bridge.nextFrame();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  assert.ok(!h.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  h.bridge.close();

  // Bleibt die Mitschrift nach dem Satzende ganz aus, entscheidet trotzdem nach der Frist (ohne Worte geht das Gespräch weiter)
  const g = setup(t, { judge: undefined });
  g.toolEnd();
  farewell(g);
  speechStarted(g, 'u1');
  for (let i = 0; i < 5; i++) g.tick(1000);
  speechStopped(g, 'u1');
  for (let i = 0; i < 4; i++) g.tick(1000);
  assert.ok(g.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'), 'vier Sekunden nach dem Sprachende ist die Frist um');
  g.bridge.close();
});

test('Nach der Verabschiedung: Die verspätete Mitschrift des Satzes vor der Verabschiedung entscheidet nichts, solange die Frist läuft', (t) => {
  const h = setup(t, { judge: undefined });
  speechStarted(h, 'u0'); // die letzte Antwort vor dem Abschied; ihre Mitschrift ist noch unterwegs
  speechStopped(h, 'u0');
  h.toolEnd();
  farewell(h);
  speechStarted(h, 'u1'); // „Tschüss“ nach der Verabschiedung
  transcribed(h, 'u0', 'Ja, Samstag um 19 Uhr passt, aber wir sind fünf Personen. Geht das?');
  assert.deepEqual(h.system().filter((x) => x.startsWith('Gegenüber hat noch etwas gesagt')), [], 'zählt nicht als Äußerung nach der Verabschiedung');
  speechStopped(h, 'u1');
  transcribed(h, 'u1', 'Tschüss!');
  h.bridge.nextFrame();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('Nach der Verabschiedung: Eine Mitschrift ohne Kennung, wenn keine Äußerung mehr offen ist, ist ein Nachtrag und entscheidet nichts', async (t) => {
  const h = setup(t);
  h.toolEnd();
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  h.partner('u1', 'Okay, danke, schönen Abend.');
  assert.equal(h.asked[1].kind, 'afterGoodbye');
  // Der Anbieter nennt hier keine Kennung: Offen ist nichts mehr, also kann es nur der Satz davor sein
  h.server({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Moment, noch eine Frage?' });
  assert.equal(h.asked.length, 2, 'das Urteil über u1 wird nicht überholt');
  h.asked[1].resolve('farewell' as never);
  await flush();
  h.bridge.nextFrame();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();
});

test('Nach der Verabschiedung: Das Zurücknehmen des Beendens vergisst offene Äußerungen – beim nächsten Abschied wird nicht auf eine alte Mitschrift gewartet', (t) => {
  const h = setup(t, { judge: undefined });
  h.toolEnd();
  farewell(h);
  speechStarted(h, 'u1'); // seine Mitschrift kommt nie
  speechStopped(h, 'u1');
  assert.equal(h.bridge.agentSay('Sag noch, dass wir um 19 Uhr kommen.'), 'resumed');
  h.say('r2', 'i2', 600, 'Eine Sache noch: Wir kommen um 19 Uhr.');
  h.drain();
  h.toolEnd('c2');
  farewell(h);
  h.partner('u2', 'Tschüss!');
  h.bridge.nextFrame();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet'], 'u1 ist vergessen: kein Warten auf die Frist');
  h.bridge.close();
});

test('end_call ohne Sprache: Fehlt die Mitschrift der letzten Antwort des Gegenübers noch, fragt die Prüfung erst, wenn sie da ist – oder nach einer kurzen Frist', async (t) => {
  const h = setup(t);
  speechStarted(h, 'u1'); // „Ja, Samstag um 19 Uhr passt.“ – die Mitschrift kommt erst nach dem end_call
  speechStopped(h, 'u1');
  h.toolEnd();
  await flush();
  assert.equal(h.asked.length, 0, 'ohne die Antwort würde die Frage als offen gemeldet');
  transcribed(h, 'u1', 'Ja, Samstag um 19 Uhr passt.');
  await flush();
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall']);
  h.asked[0].resolve([] as never);
  await flush();
  farewell(h);
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet']);
  h.bridge.close();

  // Kommt sie nicht, wird nach kurzer Zeit trotzdem geprüft
  const late = setup(t);
  speechStarted(late, 'u1');
  speechStopped(late, 'u1');
  late.toolEnd();
  late.tick(1499);
  await flush();
  assert.equal(late.asked.length, 0);
  late.tick(1);
  await flush();
  assert.deepEqual(late.asked.map((a) => a.kind), ['endCall']);
  late.bridge.close();

  // Ist die Mitschrift schon da, entsteht keine Verzögerung
  const done = setup(t);
  done.partner('u1', 'Ja, Samstag um 19 Uhr passt.');
  done.toolEnd();
  assert.deepEqual(done.asked.map((a) => a.kind), ['endCall'], 'sofort, noch im selben Atemzug');
  done.bridge.close();
});

test('end_call: Wird das Beenden zurückgenommen, während die Prüfung auf eine Mitschrift wartet, fragt sie das Textmodell nicht mehr', async (t) => {
  const h = setup(t);
  speechStarted(h, 'u1');
  speechStopped(h, 'u1');
  h.toolEnd();
  farewell(h);
  // Das Gegenüber redet nach der Verabschiedung weiter: Das Beenden ist zurückgenommen, die wartende Prüfung hinfällig
  speechStarted(h, 'u2');
  speechStopped(h, 'u2');
  transcribed(h, 'u2', 'Moment, eine Frage hätte ich noch zur Rechnung.');
  assert.deepEqual(h.asked.map((a) => a.kind), ['afterGoodbye']);
  h.asked[0].resolve('content' as never);
  await flush();
  h.tick(2000);
  await flush();
  assert.deepEqual(h.asked.map((a) => a.kind), ['afterGoodbye'], 'keine Prüfung für ein Beenden, das nicht mehr gilt');
  h.bridge.close();
});

test('end_call durch den Agenten: Nimmt der Agent das Beenden mit einer Vorgabe zurück, wird der nächste end_call der KI wieder geprüft', (t) => {
  const h = setup(t);
  assert.equal(h.bridge.agentEnd(), 'ending');
  h.toolEnd();
  assert.equal(h.asked.length, 0, 'der Agent wollte beenden: nicht geprüft');
  assert.equal(h.bridge.agentSay('Sag noch, dass wir zu fünft kommen.'), 'resumed');
  h.say('r2', 'i2', 600, 'Eine Sache noch: Wir kommen zu fünft.');
  h.drain();
  h.toolEnd('c2');
  assert.deepEqual(h.asked.map((a) => a.kind), ['endCall'], 'jetzt beendet die KI von sich aus: geprüft');
  h.bridge.close();
});

test('end_call durch den Agenten: Verabschiedet sich die KI schon von selbst, während ihre Prüfung läuft, nimmt deren Urteil das Beenden des Agenten nicht zurück', async (t) => {
  const h = setup(t);
  h.toolEnd();
  assert.equal(h.asked.length, 1);
  assert.equal(h.bridge.agentEnd(), 'ending');
  farewell(h);
  h.asked[0].resolve(['Frag noch nach dem Namen.'] as never);
  await flush();
  h.tick(1000);
  assert.deepEqual(h.ended, ['KI hat das Gespräch beendet'], 'das Auflegen wartet nicht mehr auf die Prüfung und wird nicht zurückgenommen');
  assert.ok(!h.notes().some((n) => /zurückgenommen/.test(n)));
  h.bridge.close();

  // Sagt das Gegenüber nach dem Abschied noch etwas, geht das Gespräch weiter, und der nächste end_call der KI wird weiter nicht geprüft
  const g = setup(t);
  g.toolEnd();
  assert.equal(g.bridge.agentEnd(), 'ending');
  farewell(g);
  g.partner('u1', 'Moment, eine Frage hätte ich noch zur Rechnung.');
  g.asked[1].resolve('content' as never);
  await flush();
  assert.ok(g.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  g.say('r2', 'i2', 600, 'Gern, welche?');
  g.drain();
  g.toolEnd('c2');
  assert.deepEqual(g.asked.map((a) => a.kind), ['endCall', 'afterGoodbye'], 'keine neue Prüfung');
  g.bridge.close();
});

test('end_call zusammen mit Sprache: Ein weiterer end_call mit Sprache verbraucht den gemeldeten Punkt nicht – der folgende end_call ohne Sprache nimmt das Auflegen zurück', async (t) => {
  const h = setup(t);
  endWithSpeech(h, 'r1', 'i1', 'c1');
  h.asked[0].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  h.drain();
  h.tick(3500); // das Gegenüber schweigt: Die KI soll den Punkt ansprechen oder beenden (danach ist sie nicht mehr stumm gestellt)
  endWithSpeech(h, 'r2', 'i2', 'c2'); // spricht und beendet im selben Atemzug: wieder abgelehnt, das Gegenüber ist dran
  h.drain();
  assert.match(h.outputs().at(-1) ?? '', /^Nicht beendet/);
  h.toolEnd('c3');
  assert.equal(h.asked.length, 1, 'der Hinweis ist die Prüfung: keine neue Frage');
  assert.ok(h.notes().some((n) => /Das Beenden ist zurückgenommen[\s\S]*vier Personen/.test(n)), 'der Punkt wurde noch nicht angesprochen');
  h.bridge.close();

  // Hat das Gegenüber dazwischen etwas gesagt, ist es Sache der KI – auch nach einem end_call mit Sprache dazwischen
  const g = setup(t);
  endWithSpeech(g, 'r1', 'i1', 'c1');
  g.asked[0].resolve(['Sag noch, dass es vier Personen sind.'] as never);
  await flush();
  g.drain();
  g.tick(3500);
  endWithSpeech(g, 'r2', 'i2', 'c2');
  g.drain();
  g.partner('u1', 'Ja, und?');
  g.toolEnd('c3');
  assert.ok(!g.notes().some((n) => /Das Beenden ist zurückgenommen/.test(n)));
  g.bridge.close();
});

test('Das Gegenüber setzte schon vor dem end_call an und redet noch: Es wird nicht mitten in den Satz aufgelegt, die Mitschrift entscheidet', (t) => {
  const h = setup(t, { judge: undefined });
  speechStarted(h, 'u1'); // setzt an, bevor die KI end_call aufruft
  h.toolEnd();
  farewell(h);
  for (let i = 0; i < 5; i++) h.tick(1000);
  h.bridge.nextFrame();
  assert.deepEqual(h.ended, [], 'das Gegenüber redet noch');
  speechStopped(h, 'u1');
  transcribed(h, 'u1', 'Moment, eine Frage hätte ich noch zur Rechnung.');
  h.tick(60_000);
  assert.deepEqual(h.ended, []);
  assert.ok(h.system().includes('Gegenüber hat noch etwas gesagt – Gespräch geht weiter'));
  h.bridge.close();

  // War es nur ein Abschied, wird danach aufgelegt
  const g = setup(t, { judge: undefined });
  speechStarted(g, 'u1');
  g.toolEnd();
  farewell(g);
  g.tick(3000);
  speechStopped(g, 'u1');
  transcribed(g, 'u1', 'Ja, tschüss!');
  g.bridge.nextFrame();
  g.tick(1000);
  assert.deepEqual(g.ended, ['KI hat das Gespräch beendet']);
  g.bridge.close();
});
