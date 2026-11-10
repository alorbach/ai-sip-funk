import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore, type CallRecord } from '../src/transcripts.js';

function record(id: string): CallRecord {
  return {
    id,
    startedAt: '2026-11-06T09:00:00.000Z',
    endedAt: '2026-11-06T09:01:00.000Z',
    target: '**610',
    mode: 'ai',
    durationSec: 60,
    endReason: 'KI: erledigt',
    task: 'Testen',
    entries: [
      { speaker: 'ki', text: 'Hallo', final: true },
      { speaker: 'partner', text: 'Hi', final: true },
      { speaker: 'ki', text: 'Zwischen', final: false },
    ],
    summary: '**Ergebnis:** erledigt',
    costUsd: 0.0123,
  };
}

test('Protokoll speichern, lesen, auflisten, löschen und aufräumen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-'));
  try {
    const store = new TranscriptStore(dir, 7);
    const id = TranscriptStore.makeId(new Date('2026-11-06T09:00:00Z'), '**610');
    assert.equal(id, '2026-11-06T09-00-00_int610');
    store.save(record(id));
    store.save(record('old'));

    const md = readFileSync(join(dir, `${id}.md`), 'utf8');
    assert.match(md, /## Zusammenfassung/);
    assert.match(md, /\*\*KI:\*\* Hallo/);
    assert.doesNotMatch(md, /Zwischen/);

    assert.equal(store.list().length, 2);
    assert.equal(store.list()[0].id, 'old' < id ? id : 'old');
    assert.equal(store.read(id)?.costUsd, 0.0123);
    assert.equal(store.read('../x'), undefined);

    // "old" künstlich altern lassen
    const past = new Date(Date.now() - 8 * 86_400_000);
    utimesSync(join(dir, 'old.json'), past, past);
    utimesSync(join(dir, 'old.md'), past, past);
    assert.equal(store.cleanup(), 2);
    assert.deepEqual(store.list().map((c) => c.id), [id]);

    assert.equal(store.delete(id), true);
    assert.equal(store.delete(id), false);
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
