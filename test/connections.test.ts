// KI-Verbindungen: Liste aus den Einstellungen, Übernahme der früheren Einstellungen, Schlüssel-Variablen,
// Prüfung beim Speichern und was daraus für ein Gespräch folgt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callVoice, cleanConnections, connectionKeyEnv, connectionVoice, connectionsFrom, mergeConnections, parseConnections, pickVoice, type AiConnection } from '../src/ai/connections.js';
import { gemini } from '../src/ai/providers/gemini.js';
import { openai } from '../src/ai/providers/openai.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { resolveAi } from '../src/ai/providers/index.js';

const list = (items: Partial<AiConnection>[]) => JSON.stringify(items);

test('Verbindungen: ohne gespeicherte Liste gibt es je Anbieter eine, die alten Einstellungen gehen darin auf', () => {
  const a = connectionsFrom({ aiProvider: 'openai', model: 'gpt-realtime-2.1-mini', summaryModel: 'gpt-6-sol' }, {});
  assert.deepEqual(a.list, [
    { id: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: 'gpt-6-sol', voice: '' },
    { id: 'gemini', name: 'Google Gemini', provider: 'gemini', model: '', textModel: '', voice: '' },
  ]);
  assert.equal(a.active.id, 'openai');
  const g = connectionsFrom({ aiProvider: 'gemini', model: 'gpt-realtime-2.1', summaryModel: '' });
  assert.equal(g.active.id, 'gemini');
  assert.equal(g.list[0].model, '', 'das alte Modell gehörte zum damals gewählten Anbieter');
  // Was nur die Vorgabe wiederholt (eingebaut oder aus der .env), wird nicht festgeschrieben
  const d = connectionsFrom({ aiProvider: 'openai', model: 'gpt-realtime-2.1', summaryModel: 'gpt-text-eigen' }, { OPENAI_SUMMARY_MODEL: 'gpt-text-eigen' });
  assert.deepEqual([d.list[0].model, d.list[0].textModel], ['', '']);
});

test('Verbindungen: gespeicherte Liste, aktive Verbindung, ungültige Einträge entfallen', () => {
  const json = list([
    { id: 'openai', name: 'Privat', provider: 'openai', model: 'gpt-realtime-2.1', textModel: '' },
    { id: 'c1', name: '  Firma   günstig ', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: 'gemini-3.8-flash' },
    { id: 'c1', name: 'doppelt', provider: 'openai' },
    { id: 'Böse/../Id', name: 'x', provider: 'openai' },
    { id: 'c2', name: 'x', provider: 'constructor' as never },
  ]);
  const parsed = parseConnections(json);
  assert.deepEqual(parsed.map((c) => c.id), ['openai', 'c1']);
  assert.equal(parsed[1].name, 'Firma günstig');
  assert.equal(parsed[1].textModel, '', 'Modell eines anderen Anbieters gilt nicht');
  assert.equal(connectionsFrom({ aiConnections: json, aiConnection: 'c1' }).active.id, 'c1');
  assert.equal(connectionsFrom({ aiConnections: json, aiConnection: 'weg' }).active.id, 'openai', 'unbekannte Kennung = erste Verbindung');
  assert.equal(connectionsFrom({ aiConnections: '{kaputt', aiProvider: 'gemini' }).active.id, 'gemini');
});

test('Verbindungen: Schlüssel liegen je Verbindung in einer eigenen Variablen der .env', () => {
  assert.equal(connectionKeyEnv({ id: 'openai', provider: 'openai' }), 'OPENAI_API_KEY');
  assert.equal(connectionKeyEnv({ id: 'gemini', provider: 'gemini' }), 'GEMINI_API_KEY');
  assert.equal(connectionKeyEnv({ id: 'c1a2b3', provider: 'openai' }), 'AI_KEY_C1A2B3');
  const json = list([
    { id: 'openai', name: 'Privat', provider: 'openai', model: '', textModel: '', voice: '' },
    { id: 'c1', name: 'Firma', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: 'gpt-6-sol' },
    { id: 'c2', name: 'Gemini bezahlt', provider: 'gemini', model: '', textModel: '', voice: '' },
  ]);
  const env = { OPENAI_API_KEY: 'sk-privat', AI_KEY_C1: 'sk-firma', OPENAI_MODEL: 'gpt-realtime-eigen' };
  const privat = resolveAi({ aiConnections: json, aiConnection: 'openai' }, env);
  assert.equal(privat.key, 'sk-privat');
  assert.equal(privat.realtimeModel(), 'gpt-realtime-eigen', 'ohne Modell an der Verbindung gilt die Vorgabe aus der .env');
  const firma = resolveAi({ aiConnections: json, aiConnection: 'c1' }, env);
  assert.equal(firma.key, 'sk-firma');
  assert.equal(firma.connection.name, 'Firma');
  assert.equal(firma.realtimeModel(), 'gpt-realtime-2.1-mini');
  assert.equal(firma.realtimeModel('gpt-realtime-2.1'), 'gpt-realtime-2.1', 'ein Anruf kann ein eigenes Modell nennen');
  assert.equal(firma.realtimeModel('gemini-3.8-live'), 'gpt-realtime-2.1-mini', 'aber keines eines anderen Anbieters');
  assert.equal(firma.textModel, 'gpt-6-sol');
  const g = resolveAi({ aiConnections: json, aiConnection: 'openai' }, env, 'c2');
  assert.equal(g.provider.id, 'gemini');
  assert.equal(g.key, undefined, 'der Schlüssel einer anderen Verbindung gilt nicht');
  assert.equal(g.callLimit(3600), 540);
});

test('Verbindungen speichern: neue bekommen eine Kennung, der Anbieter bleibt fest, eine muss bleiben', () => {
  const current: AiConnection[] = [{ id: 'openai', name: 'OpenAI', provider: 'openai', model: '', textModel: '', voice: '' }];
  let n = 0;
  const ids = () => ['gemini', 'gemini', 'x1', 'x2'][n++];
  const saved = cleanConnections(
    [
      { id: 'openai', name: 'Privat', provider: 'openai', model: 'gpt-realtime-2.1' },
      { name: 'Neu A', provider: 'gemini', model: 'gemini-3.8-live' },
      { id: 'erfunden', name: 'Neu B', provider: 'openai' },
    ],
    current,
    ids,
  );
  assert.deepEqual(saved.map((c) => [c.id, c.name, c.provider]), [['openai', 'Privat', 'openai'], ['cgemini', 'Neu A', 'gemini'], ['cx1', 'Neu B', 'openai']]);
  assert.equal(connectionKeyEnv(saved[1]), 'AI_KEY_CGEMINI', 'eine neue Verbindung erbt nie die Variable eines Anbieters');
  assert.throws(() => cleanConnections([{ id: 'openai', name: 'x', provider: 'gemini' }], current), /Anbieter einer Verbindung/);
  assert.throws(() => cleanConnections([{ id: 'openai', name: ' ', provider: 'openai' }], current), /Namen/);
  assert.throws(() => cleanConnections([{ name: 'x', provider: 'constructor' }], current), /Unbekannter KI-Anbieter/);
  assert.throws(() => cleanConnections('nix', current), /Liste/);
  assert.throws(() => cleanConnections(Array.from({ length: 13 }, (_, i) => ({ name: `v${i}`, provider: 'openai' })), current), /Höchstens 12/);
});

test('Verbindungen ändern: nur Genanntes wird ersetzt, entfernt wird nur ausdrücklich', () => {
  const current: AiConnection[] = [
    { id: 'openai', name: 'OpenAI', provider: 'openai', model: '', textModel: '', voice: '' },
    { id: 'c1', name: 'Firma', provider: 'openai', model: '', textModel: '', voice: '' },
  ];
  // Ein veraltetes Fenster kennt „Firma“ nicht und ändert nur „OpenAI“: „Firma“ bleibt
  const a = mergeConnections(current, [{ id: 'openai', name: 'Privat', provider: 'openai', model: 'gpt-realtime-2.1-mini' }], undefined);
  assert.deepEqual(a.next.map((c) => [c.id, c.name, c.model]), [['openai', 'Privat', 'gpt-realtime-2.1-mini'], ['c1', 'Firma', '']]);
  assert.deepEqual(a.removed, []);
  const b = mergeConnections(current, [{ name: 'Neu', provider: 'gemini' }], ['c1'], () => 'x9');
  assert.deepEqual(b.next.map((c) => c.id), ['openai', 'cx9']);
  assert.deepEqual(b.removed.map((c) => c.id), ['c1']);
  assert.deepEqual(mergeConnections(current, undefined, undefined).next, current, 'nur umschalten ändert die Liste nicht');
  assert.throws(() => mergeConnections(current, [], ['openai', 'c1']), /Mindestens eine/);
  assert.throws(() => mergeConnections(current, [{ id: 'c1', name: 'Firma', provider: 'gemini' }], undefined), /Anbieter einer Verbindung/);
  assert.throws(() => mergeConnections(current, Array.from({ length: 11 }, (_, i) => ({ name: `v${i}`, provider: 'openai' })), undefined), /Höchstens 12/);
});

test('Einstellungen: Die Liste der Verbindungen lässt sich nicht über das Formular setzen, umschalten nur auf Bekannte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-conn-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const list = JSON.stringify([{ id: 'c1', name: 'Firma', provider: 'openai', model: '', textModel: '', voice: '' }]);
    saveSettings({}, { aiConnections: list, aiConnection: 'c1' });
    // Versuch, der Verbindung einen anderen Anbieter unterzuschieben (ihr Schlüssel ginge dann an Google)
    const forged = saveSettings({ aiConnections: list.replace('"openai"', '"gemini"'), aiConnection: 'gibt-es-nicht' });
    assert.equal(forged.aiConnections, list);
    assert.equal(forged.aiConnection, 'c1');
    assert.equal(loadSettings().aiProvider, 'openai');
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Verbindungen: Das Modell der Verbindung gilt, auch wenn noch ein altes Modell in den Einstellungen steht', () => {
  const s = { aiConnections: list([{ id: 'c1', name: 'Günstig', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: '' }]), aiConnection: 'c1', model: 'gpt-realtime-2.1', summaryModel: 'gpt-6-sol' };
  const r = resolveAi(s, {});
  assert.equal(r.realtimeModel(), 'gpt-realtime-2.1-mini');
  assert.equal(r.realtimeModel(undefined), 'gpt-realtime-2.1-mini');
  assert.equal(r.textModel, 'gpt-6-luna', 'das alte Textmodell der Einstellungen gilt nicht mehr');
});

test('Einstellungen: Eine nicht lesbare settings.json bleibt beim Speichern als .defekt erhalten', async () => {
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-set-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync('settings.json', '{"principal": "Max Mustermann",}');
    saveSettings({ aiName: 'Alex' });
    assert.equal(readFileSync('settings.json.defekt', 'utf8'), '{"principal": "Max Mustermann",}');
    assert.equal(loadSettings().aiName, 'Alex');
    // Eine lesbare Datei wird nicht noch einmal gesichert
    writeFileSync('settings.json.defekt', 'alt');
    saveSettings({ aiName: 'Robin' });
    assert.equal(readFileSync('settings.json.defekt', 'utf8'), 'alt');
    assert.ok(existsSync('settings.json'));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Standardstimme je Verbindung: gespeichert wird nur eine Stimme des Anbieters, Bestehendes bleibt unverändert', () => {
  // Liste aus der Zeit vor der Standardstimme: lesbar wie bisher, ohne eigene Stimme
  const old = parseConnections(JSON.stringify([{ id: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: 'gpt-6-sol' }]));
  assert.deepEqual(old, [{ id: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: 'gpt-6-sol', voice: '' }]);
  const current: AiConnection[] = [
    { id: 'openai', name: 'OpenAI', provider: 'openai', model: '', textModel: '', voice: 'cedar' },
    { id: 'gemini', name: 'Google Gemini', provider: 'gemini', model: '', textModel: '', voice: '' },
  ];
  // Jede Verbindung speichert ihre eigene Stimme; die andere bleibt, wie sie ist
  const a = mergeConnections(current, [{ id: 'gemini', name: 'Google Gemini', provider: 'gemini', model: '', textModel: '', voice: 'Puck' }], undefined);
  assert.deepEqual(a.next.map((c) => [c.id, c.voice]), [['openai', 'cedar'], ['gemini', 'Puck']]);
  // Eine Stimme des anderen Anbieters wird nicht gespeichert
  const b = mergeConnections(current, [{ id: 'gemini', name: 'Google Gemini', provider: 'gemini', voice: 'cedar' }], undefined);
  assert.equal(b.next[1].voice, '');
  // Ein veraltetes Fenster schickt keine Stimme: Die gespeicherte bleibt, das Modell wird trotzdem geändert
  const c = mergeConnections(current, [{ id: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: '' }], undefined);
  assert.deepEqual([c.next[0].model, c.next[0].voice], ['gpt-realtime-2.1-mini', 'cedar']);
  // Ausdrücklich leer = wieder die Vorgabe
  const d = mergeConnections(current, [{ id: 'openai', name: 'OpenAI', provider: 'openai', voice: '' }], undefined);
  assert.equal(d.next[0].voice, '');
});

test('Rangfolge der Stimme: Spam-Rolle, Anruf, Verbindung, alte Einstellung, erste Stimme des Anbieters', () => {
  const oa = { provider: 'openai' as const, voice: 'cedar' };
  const plain = { provider: 'openai' as const, voice: '' };
  const g = { provider: 'gemini' as const, voice: 'Puck' };
  assert.equal(callVoice(oa, { scam: 'ash', call: 'sage', legacy: 'marin' }), 'ash', 'Spam-Rolle zuerst');
  assert.equal(callVoice(oa, { call: 'sage', legacy: 'marin' }), 'sage', 'dann die Stimme des Anrufs (Dashboard, Kontakt, Profil)');
  assert.equal(callVoice(oa, { call: '', legacy: 'marin' }), 'cedar', 'dann die Standardstimme der Verbindung');
  assert.equal(callVoice(plain, { legacy: 'marin' }), 'marin', 'ohne eigene Stimme gilt die alte allgemeine Einstellung');
  assert.equal(callVoice(plain, {}), openai.voices[0], 'zuletzt die erste Stimme des Anbieters');
  // Stimmen des anderen Anbieters zählen auf keiner Stufe
  assert.equal(callVoice(g, { scam: 'ash', call: 'sage', legacy: 'marin' }), 'Puck');
  assert.equal(callVoice({ provider: 'gemini', voice: '' }, { call: 'marin', legacy: 'marin' }), gemini.voices[0]);
  assert.equal(callVoice(g, { scam: 'Charon', call: 'Kore' }), 'Charon');
  assert.equal(connectionVoice(g, 'marin'), 'Puck');
  assert.equal(pickVoice(['a', 'b'], undefined, ' ', 'x', 'b'), 'b');
});

test('Ausweichmodelle: nur gültige Modelle des Anbieters, jedes einmal; ein Fenster ohne das Feld löscht sie nicht', () => {
  const [c] = parseConnections(list([{ id: 'c1', name: 'G', provider: 'gemini', model: '', textModel: '', textFallbacks: ['gemini-3.5-flash', 'gpt-6-luna', 'gemini-3.5-flash', 'nicht erlaubt!', 'gemini-3.5-pro'] } as Partial<AiConnection>]));
  assert.deepEqual(c.textFallbacks, ['gemini-3.5-flash', 'gemini-3.5-pro']);
  assert.equal('modelFallbacks' in c, false, 'ohne Einträge gibt es das Feld nicht');
  const kept = cleanConnections([{ id: 'c1', name: 'G', provider: 'gemini', model: '', textModel: '' }], [c]);
  assert.deepEqual(kept[0].textFallbacks, ['gemini-3.5-flash', 'gemini-3.5-pro']);
  const cleared = cleanConnections([{ id: 'c1', name: 'G', provider: 'gemini', model: '', textModel: '', textFallbacks: [] }], [c]);
  assert.equal('textFallbacks' in cleared[0], false, 'eine leere Liste entfernt sie');
});

test('Ausweichmodelle: Bei einem Limit antwortet das nächste Textmodell, bei anderen Fehlern nicht', async () => {
  const json = list([{ id: 'gemini', name: 'G', provider: 'gemini', model: '', textModel: 'gemini-3.5-flash-lite', textFallbacks: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-pro'], modelFallbacks: ['gemini-3.8-live', 'gemini-3.7-live'] } as Partial<AiConnection>]);
  const r = resolveAi({ aiConnections: json, aiConnection: 'gemini' }, { GEMINI_API_KEY: 'AIza-test-0123456789abcdefghijklmnop' });
  assert.deepEqual(r.textFallbacks, ['gemini-3.5-flash', 'gemini-3.5-pro'], 'das eingestellte Modell steht nicht noch einmal in der Liste');
  assert.deepEqual(r.realtimeFallbacks(), ['gemini-3.7-live']);
  const original = gemini.text;
  const asked: string[] = [];
  try {
    gemini.text = async (_key, model) => {
      asked.push(model);
      if (model === 'gemini-3.5-flash-lite') throw new Error('Textmodell fehlgeschlagen: 503 {"error":{"status":"UNAVAILABLE"}}');
      if (model === 'gemini-3.5-flash') throw new Error('Textmodell fehlgeschlagen: 429 Resource has been exhausted (e.g. check quota).');
      return 'ok von ' + model;
    };
    assert.equal(await r.ask('Frage', 100), 'ok von gemini-3.5-pro');
    assert.deepEqual(asked, ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-pro']);
    asked.length = 0;
    gemini.text = async (_key, model) => { asked.push(model); throw new Error('Textmodell fehlgeschlagen: 400 API key not valid'); };
    await assert.rejects(r.ask('Frage', 100), /400 API key not valid/);
    assert.deepEqual(asked, ['gemini-3.5-flash-lite'], 'kein Ausweichen bei einem Fehler, der jedes Modell träfe');
    asked.length = 0;
    gemini.text = async (_key, model) => { asked.push(model); throw new Error('Textmodell fehlgeschlagen: 503 überlastet'); };
    await assert.rejects(r.ask('Frage', 100), /503/);
    assert.equal(asked.length, 3, 'alle drei versucht, der letzte Fehler gilt');
  } finally {
    gemini.text = original;
  }
});

test('Ausweichmodelle: Antwortet das Textmodell nicht in der gesetzten Zeit, ist das nächste dran', async () => {
  const json = list([{ id: 'gemini', name: 'G', provider: 'gemini', model: '', textModel: 'gemini-3.5-flash-lite', textFallbacks: ['gemini-3.5-flash'] } as Partial<AiConnection>]);
  const r = resolveAi({ aiConnections: json, aiConnection: 'gemini' }, { GEMINI_API_KEY: 'AIza-test-0123456789abcdefghijklmnop' });
  const original = gemini.text;
  const asked: string[] = [];
  try {
    gemini.text = (_key, model) => {
      asked.push(model);
      return model === 'gemini-3.5-flash-lite' ? new Promise<string>(() => undefined) : Promise.resolve('ok von ' + model);
    };
    assert.equal(await r.ask('Frage', 100, undefined, 20), 'ok von gemini-3.5-flash');
    assert.deepEqual(asked, ['gemini-3.5-flash-lite', 'gemini-3.5-flash']);
  } finally {
    gemini.text = original;
  }
});
