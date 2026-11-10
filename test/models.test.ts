// Modell-Liste von OpenAI: Trennung nach Verwendung, Reihenfolge, Zwischenspeicher und Fehlerfälle.
// OpenAI wird nie wirklich gefragt: Jeder Abruf läuft über ein eingesetztes fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModels, fetchModels, ModelCatalog } from '../src/ai/models.js';
import { responsesText } from '../src/ai/summary.js';
import { realtimeModel, tuningFrom, type FormSettings } from '../src/settings.js';

const KEY = 'sk-test-0000000000000000';

/** Antwort wie GET /v1/models; zählt die Abrufe und merkt sich den zuletzt gesendeten Schlüssel */
function fakeOpenAi(models: { id: string; created?: number }[], status = 200) {
  const calls = { count: 0, auth: '', url: '' };
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.count += 1;
    calls.url = String(url);
    calls.auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    return new Response(JSON.stringify(status === 200 ? { object: 'list', data: models.map((m) => ({ object: 'model', owned_by: 'openai', ...m })) } : { error: { message: `abgelehnt ${KEY}` } }), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const SAMPLE = [
  { id: 'gpt-realtime-2.1', created: 300 },
  { id: 'gpt-realtime-2.1-mini', created: 300 },
  { id: 'gpt-realtime', created: 200 },
  { id: 'gpt-realtime-2026-08-28', created: 200 },
  { id: 'gpt-4o-realtime-preview-2024-12-17', created: 100 },
  { id: 'gpt-realtime-transcribe', created: 310 },
  { id: 'gpt-6-luna', created: 400 },
  { id: 'gpt-6', created: 390 },
  { id: 'gpt-5-mini', created: 250 },
  { id: 'o4-mini', created: 240 },
  { id: 'gpt-5-2025-08-07', created: 245 },
  { id: 'gpt-4-0613', created: 50 },
  { id: 'ft:gpt-5-mini:acme::abc123', created: 260 },
  { id: 'text-embedding-3-large', created: 120 },
  { id: 'gpt-image-1', created: 230 },
  { id: 'gpt-4o-audio-preview', created: 110 },
  { id: 'gpt-4o-mini-tts', created: 115 },
  { id: 'gpt-4o-transcribe', created: 116 },
  { id: 'gpt-4o-search-preview', created: 117 },
  { id: 'gpt-3.5-turbo-instruct', created: 60 },
  { id: 'gpt-5-codex', created: 255 },
  { id: 'omni-moderation-latest', created: 130 },
  { id: 'whisper-1', created: 10 },
  { id: 'dall-e-3', created: 20 },
  { id: 'sora-2', created: 280 },
  { id: 'computer-use-preview', created: 150 },
  { id: 'o4-mini-deep-research', created: 241 },
];

test('Modelle: Realtime- und Textmodelle getrennt, alles andere ausgefiltert', () => {
  const { realtime, text } = classifyModels(SAMPLE);
  assert.deepEqual(realtime.map((m) => m.id), ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime', 'gpt-realtime-2026-08-28', 'gpt-4o-realtime-preview-2024-12-17']);
  assert.deepEqual(text.map((m) => m.id), ['gpt-6-luna', 'gpt-6', 'ft:gpt-5-mini:acme::abc123', 'gpt-5-mini', 'o4-mini', 'gpt-5-2025-08-07', 'gpt-4-0613']);
});

test('Modelle: laufende Namen vor datierten Versionen, darin das neueste zuerst, bei Gleichstand nach Name', () => {
  const { realtime, text } = classifyModels([...SAMPLE].reverse());
  assert.deepEqual(realtime.map((m) => m.snapshot), [false, false, false, true, true]);
  assert.deepEqual(realtime.slice(0, 2).map((m) => m.id), ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini']); // gleiches Datum
  assert.deepEqual(text.filter((m) => m.snapshot).map((m) => m.id), ['gpt-5-2025-08-07', 'gpt-4-0613']);
});

test('Modelle: unbrauchbare und doppelte Einträge der Liste werden übergangen', () => {
  const odd = [{ id: 'gpt-6' }, { id: 'gpt-6', created: 5 }, { id: 42 }, {}, null, { id: 'gpt-x&voice=y' }, { id: ' gpt-realtime-next ' }, { id: 'gpt-' + 'a'.repeat(70) }] as { id?: unknown }[];
  const { realtime, text } = classifyModels(odd);
  assert.deepEqual(text.map((m) => m.id), ['gpt-6']);
  assert.deepEqual(realtime.map((m) => m.id), ['gpt-realtime-next']);
  // Jede angebotene ID besteht auch die Prüfung beim Speichern
  for (const m of [...classifyModels(SAMPLE).realtime, ...classifyModels(SAMPLE).text]) assert.equal(realtimeModel(m.id, 'vorgabe'), m.id);
});

test('Modelle: Abruf geht mit dem Schlüssel nur an api.openai.com', async () => {
  const { impl, calls } = fakeOpenAi(SAMPLE);
  const lists = await fetchModels(KEY, impl);
  assert.equal(calls.url, 'https://api.openai.com/v1/models');
  assert.equal(calls.auth, `Bearer ${KEY}`);
  assert.equal(lists.realtime.length, 5);
});

test('Modelle: Fehlermeldungen sind verständlich und enthalten den Schlüssel nicht', async () => {
  const cases: [typeof fetch, RegExp][] = [
    [fakeOpenAi([], 401).impl, /abgelehnt/],
    [fakeOpenAi([], 429).impl, /Kontingent/],
    [fakeOpenAi([], 500).impl, /Status 500/],
    [(async () => { throw new Error(`ECONNREFUSED ${KEY}`); }) as typeof fetch, /nicht erreichbar/],
    [(async () => new Response('<html>Proxy</html>', { status: 200 })) as typeof fetch, /nicht erreichbar/],
    [(async () => new Response('{"data":"nichts"}', { status: 200 })) as typeof fetch, /keine Modell-Liste/],
  ];
  for (const [impl, expected] of cases) {
    await assert.rejects(fetchModels(KEY, impl), (err: Error) => {
      assert.match(err.message, expected);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  }
});

test('Katalog: ohne Schlüssel kein Abruf, sondern eine Meldung und leere Listen', async () => {
  const { impl, calls } = fakeOpenAi(SAMPLE);
  const state = await new ModelCatalog(() => undefined, impl).get(true);
  assert.equal(calls.count, 0);
  assert.match(state.error ?? '', /Schlüssel fehlt/);
  assert.deepEqual([state.realtime, state.text, state.fetchedAt], [[], [], null]);
});

test('Katalog: zwischengespeichert bis zum Ablauf, „Aktualisieren“ fragt sofort neu', async () => {
  const { impl, calls } = fakeOpenAi(SAMPLE);
  let now = 1_000_000;
  const catalog = new ModelCatalog(() => KEY, impl, 60_000, () => now);
  const first = await catalog.get();
  assert.equal(first.error, undefined);
  assert.equal(first.fetchedAt, new Date(now).toISOString());
  await catalog.get();
  now += 59_000;
  await catalog.get();
  assert.equal(calls.count, 1);
  await catalog.get(true);
  assert.equal(calls.count, 2);
  now += 61_000;
  await catalog.get();
  assert.equal(calls.count, 3);
  // Gleichzeitige Anfragen teilen sich einen Abruf
  await Promise.all([catalog.get(true), catalog.get(true), catalog.get(true)]);
  assert.equal(calls.count, 4);
});

test('Katalog: scheitert das Aktualisieren, bleibt der letzte Stand mit Meldung erhalten', async () => {
  let fail = false;
  const ok = fakeOpenAi(SAMPLE).impl;
  const impl = (async (...args: Parameters<typeof fetch>) => { if (fail) throw new Error('offline'); return ok(...args); }) as typeof fetch;
  const catalog = new ModelCatalog(() => KEY, impl);
  const good = await catalog.get();
  fail = true;
  const stale = await catalog.get(true);
  assert.match(stale.error ?? '', /nicht erreichbar/);
  assert.deepEqual(stale.realtime, good.realtime);
  assert.equal(stale.fetchedAt, good.fetchedAt);
  // Der nächste gewöhnliche Abruf kommt wieder aus dem Speicher, ohne Meldung
  assert.equal((await catalog.get()).error, undefined);
});

test('Katalog: neuer Schlüssel leert den Speicher', async () => {
  const { impl, calls } = fakeOpenAi(SAMPLE);
  const catalog = new ModelCatalog(() => KEY, impl);
  await catalog.get();
  catalog.clear();
  await catalog.get();
  assert.equal(calls.count, 2);
});

test('Gespeichertes Modell bleibt gültig, auch wenn es in keiner geladenen Liste steht', () => {
  const lists = classifyModels(SAMPLE);
  const saved = 'gpt-realtime-eigenes-2027';
  assert.ok(!lists.realtime.some((m) => m.id === saved));
  assert.equal(realtimeModel(saved, 'vorgabe'), saved);
  // Textmodell: der gespeicherte Wert gilt unverändert, leer bleibt beim bisherigen Standard
  const base = { maxCallSeconds: '300', retentionDays: '7', stallMs: '6000', vadSilenceMs: '900', vadThreshold: '0.6', hangupGraceMs: '2000', greetingWaitMs: '2500', speechSpeed: '1.05', outputGain: '1.5', allowInterrupt: 'on' };
  assert.equal(tuningFrom({ ...base, summaryModel: 'gpt-nicht-gelistet' } as FormSettings).summaryModel, 'gpt-nicht-gelistet');
  assert.equal(tuningFrom({ ...base, summaryModel: '' } as FormSettings).summaryModel, 'gpt-6-luna');
});

test('Textmodell ohne Reasoning: die abgelehnte Angabe wird einmal weggelassen', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return body.reasoning
      ? new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." } }), { status: 400 })
      : new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 });
  });
  assert.equal(await responsesText(KEY, 'gpt-ohne-reasoning', 'Hallo', 100), 'ok');
  assert.equal(bodies.length, 2);
  assert.deepEqual([Boolean(bodies[0].reasoning), Boolean(bodies[1].reasoning)], [true, false]);
});

test('Textmodell: andere Fehler werden nicht wiederholt', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }));
  await assert.rejects(responsesText(KEY, 'gibt-es-nicht', 'Hallo', 100), /404/);
  assert.equal(fetchMock.mock.callCount(), 1);
});
