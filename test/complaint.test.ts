import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComplaintPrompt, complaintFacts } from '../src/ai/complaint.js';
import type { CallRecord } from '../src/transcripts.js';

const record: CallRecord = {
  id: 'x',
  startedAt: '2026-11-07T14:05:00.000Z',
  endedAt: '2026-11-07T14:06:10.000Z',
  target: '08005551234',
  called: '23125100',
  mode: 'ai',
  durationSec: 70,
  endReason: 'KI hat aufgelegt',
  spam: true,
  outcome: { result: 'Stromtarif der „Energieberatung Deutschland“, wollte Zählernummer und ein Ja', open: '' },
  entries: [
    { speaker: 'ki', text: 'Hallo?', final: true },
    { speaker: 'partner', text: 'Guten Tag, Müller von der Energieberatung Deutschland, Sie können 40 Prozent sparen.', final: true },
    { speaker: 'system', text: 'Spam-Abwehr: Stromtarif-Werbung', final: true },
    { speaker: 'ki', text: 'Nein danke, kein Interesse.', final: false },
    { speaker: 'ki', text: 'Nein danke, kein Interesse. Bitte streichen Sie die Nummer.', final: true },
  ],
};

test('Beschwerde: Fakten aus dem Protokoll', () => {
  const facts = complaintFacts(record, 'Stromwerbung');
  assert.ok(facts.some((f) => f.startsWith('Datum: 07.11.2026')));
  assert.ok(facts.some((f) => f.includes('08005551234') && f.includes('Stromwerbung')));
  assert.ok(facts.some((f) => f.includes('Angerufene Rufnummer: 23125100')));
  assert.ok(facts.some((f) => f.includes('70 Sekunden')));
  assert.ok(facts.some((f) => f.includes('nicht erteilt')));
  assert.ok(facts.some((f) => f.includes('Energieberatung')));
});

test('Beschwerde: unterdrückte Nummer und Prompt-Inhalt', () => {
  const facts = complaintFacts({ ...record, target: '', called: undefined });
  assert.ok(facts.some((f) => f.includes('unterdrückt')));
  assert.ok(facts.some((f) => f.includes('eigener Anschluss')));
  const prompt = buildComplaintPrompt(record);
  assert.ok(prompt.includes('Bundesnetzagentur'));
  assert.ok(prompt.includes('§ 7 UWG'));
  assert.ok(prompt.includes('automatischen Telefonassistenten'));
  assert.ok(prompt.includes('Anrufer: Guten Tag, Müller'));
  assert.ok(prompt.includes('System: Spam-Abwehr'));
  // Zwischenstände der KI bleiben draußen, finale Zeile drin
  assert.ok(!prompt.includes('Nein danke, kein Interesse.\n'));
  assert.ok(prompt.includes('Bitte streichen Sie die Nummer.'));
});
