import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { formatPlan } from '../src/ai/plan.js';
import { buildInstructions, farewellInstruction, loadPersonas } from '../src/ai/personas.js';

const personas = loadPersonas(fileURLToPath(new URL('../personas/', import.meta.url)));

test('Gesprächsplan wird nummeriert in die Systemanweisung übernommen', () => {
  const plan = formatPlan({
    gegenueber: 'Max’ Frau, Name unbekannt',
    einstieg: 'Max hat mich gebeten, kurz zu fragen, wie es dir geht.',
    schritte: ['Fragen, wie es ihr geht.', ' Ausrichten, dass Max sie liebt. ', ''],
    hinweise: 'Privat und warm; „hahaha" nicht vorlesen.',
  });
  assert.match(plan, /^## Gesprächsplan\n/);
  assert.match(plan, /1\. Fragen, wie es ihr geht\.\n2\. Ausrichten, dass Max sie liebt\.\n/);
  assert.doesNotMatch(plan, /\n3\./);
  const text = buildInstructions({ persona: personas[1], formal: false, aiName: 'Salve', principalName: 'Max', task: 'Frag meine Frau, wie es ihr geht.', plan, maxCallSeconds: 300 });
  assert.match(text, /## Dein Auftrag für dieses Gespräch\nFrag meine Frau/);
  assert.match(text, /## Gesprächsplan\nGegenüber: Max’ Frau/);
  assert.match(text, /## Gesprächsführung/);
  assert.match(text, /Erfinde keinen allgemeinen Grund/);
});

test('Verabschiedung hält die Anrede und verbietet Meta-Sätze', () => {
  assert.match(farewellInstruction(false), /weiter mit „Du"/);
  assert.match(farewellInstruction(true), /weiter mit „Sie"/);
  assert.match(farewellInstruction(true), /Keine Meta-Sätze/);
});
