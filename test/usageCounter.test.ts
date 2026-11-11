// Monatsverbrauch: fortgeschriebener Zähler je Monat und Anbieter, und der Abruf der Kosten bei OpenAI (nachgestellt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanAdminKey, fetchOpenAiMonthCosts, monthKey, UsageCounter } from '../src/usageCounter.js';

test('Monatszähler: summiert je Monat und Anbieter, übersteht eine defekte Datei, behält 13 Monate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-usage-'));
  try {
    const file = join(dir, 'usage.json');
    let now = new Date(2026, 10, 11, 12);
    const c = new UsageCounter(file, () => now);
    assert.equal(c.empty, true);
    assert.deepEqual(c.month(), {});
    c.add('openai', 61.4, 0.25);
    c.add('openai', 30, 0.1);
    c.add('gemini', 120, 0.02);
    c.add('openai', 10, 0.5, new Date(2026, 9, 31, 23, 59));
    assert.equal(c.empty, false);
    assert.deepEqual(c.month(), { openai: { calls: 2, seconds: 91, costUsd: 0.35 }, gemini: { calls: 1, seconds: 120, costUsd: 0.02 } });
    assert.deepEqual(c.month('2026-10'), { openai: { calls: 1, seconds: 10, costUsd: 0.5 } });
    now = new Date(2026, 11, 1);
    assert.deepEqual(c.month(), {}, 'neuer Monat beginnt bei null');
    assert.equal(monthKey(now), '2026-12');
    for (let m = 0; m < 20; m++) c.add('openai', 1, 0.01, new Date(2027, m, 1));
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).months).length, 13);
    writeFileSync(file, '{kaputt');
    assert.deepEqual(c.month(), {});
    c.add('openai', 5, 0.01);
    assert.equal(c.month().openai.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Admin-Schlüssel: nur „sk-admin-…“ wird angenommen', () => {
  assert.equal(cleanAdminKey(' sk-admin-0123456789abcdefghij '), 'sk-admin-0123456789abcdefghij');
  assert.throws(() => cleanAdminKey('sk-proj-0123456789abcdefghij'), /kein Admin-Schlüssel/);
  assert.throws(() => cleanAdminKey(''), /fehlt/);
  assert.throws(() => cleanAdminKey('sk-admin- mit leerzeichen 0123'), /Admin-Schlüssel/);
});

test('Kosten laut OpenAI: Monatsanfang in UTC, Seiten zusammengezählt, Schlüssel in keiner Meldung', async () => {
  const KEY = 'sk-admin-0123456789abcdefghij';
  const urls: string[] = [];
  const pages = [
    { data: [{ results: [{ amount: { value: 1.25, currency: 'usd' } }, { amount: { value: 0.5, currency: 'usd' } }] }, { results: [] }], has_more: true, next_page: 'p2' },
    { data: [{ results: [{ amount: { value: 2.004, currency: 'usd' } }, { amount: { value: 9, currency: 'eur' } }] }], has_more: false },
  ];
  const impl = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${KEY}`);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  }) as typeof fetch;
  assert.equal(await fetchOpenAiMonthCosts(KEY, impl, new Date(Date.UTC(2026, 10, 11, 9))), 3.75);
  assert.equal(urls[0], `https://api.openai.com/v1/organization/costs?start_time=${Date.UTC(2026, 10, 1) / 1000}&limit=31`);
  assert.ok(urls[1].endsWith('&page=p2'));
  const fail = (status: number) => (async () => new Response('{}', { status })) as typeof fetch;
  await assert.rejects(fetchOpenAiMonthCosts(KEY, fail(403)), (e: Error) => /Admin-Schlüssel abgelehnt/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(fetchOpenAiMonthCosts(KEY, fail(500)), /Status 500/);
  await assert.rejects(fetchOpenAiMonthCosts(KEY, (async () => { throw new Error(`ECONNRESET ${KEY}`); }) as typeof fetch), (e: Error) => /nicht erreichbar/.test(e.message) && !e.message.includes(KEY));
});
