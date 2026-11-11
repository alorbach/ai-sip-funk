// KI-Verbindungen: Liste aus den Einstellungen, Übernahme der früheren Einstellungen, Schlüssel-Variablen,
// Prüfung beim Speichern und was daraus für ein Gespräch folgt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanConnections, connectionKeyEnv, connectionsFrom, parseConnections, type AiConnection } from '../src/ai/connections.js';
import { resolveAi } from '../src/ai/providers/index.js';

const list = (items: Partial<AiConnection>[]) => JSON.stringify(items);

test('Verbindungen: ohne gespeicherte Liste gibt es je Anbieter eine, die alten Einstellungen gehen darin auf', () => {
  const a = connectionsFrom({ aiProvider: 'openai', model: 'gpt-realtime-2.1-mini', summaryModel: 'gpt-6-sol' });
  assert.deepEqual(a.list, [
    { id: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: 'gpt-6-sol' },
    { id: 'gemini', name: 'Google Gemini', provider: 'gemini', model: '', textModel: '' },
  ]);
  assert.equal(a.active.id, 'openai');
  const g = connectionsFrom({ aiProvider: 'gemini', model: 'gpt-realtime-2.1', summaryModel: '' });
  assert.equal(g.active.id, 'gemini');
  assert.equal(g.list[0].model, '', 'das alte Modell gehörte zum damals gewählten Anbieter');
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
    { id: 'openai', name: 'Privat', provider: 'openai', model: '', textModel: '' },
    { id: 'c1', name: 'Firma', provider: 'openai', model: 'gpt-realtime-2.1-mini', textModel: 'gpt-6-sol' },
    { id: 'c2', name: 'Gemini bezahlt', provider: 'gemini', model: '', textModel: '' },
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
  const current: AiConnection[] = [{ id: 'openai', name: 'OpenAI', provider: 'openai', model: '', textModel: '' }];
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
  assert.throws(() => cleanConnections([], current), /Mindestens eine/);
  assert.throws(() => cleanConnections([{ id: 'openai', name: ' ', provider: 'openai' }], current), /Namen/);
  assert.throws(() => cleanConnections([{ name: 'x', provider: 'constructor' }], current), /Unbekannter KI-Anbieter/);
  assert.throws(() => cleanConnections('nix', current), /Liste/);
  assert.throws(() => cleanConnections(Array.from({ length: 13 }, (_, i) => ({ name: `v${i}`, provider: 'openai' })), current), /Höchstens 12/);
});
