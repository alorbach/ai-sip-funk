import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildInstructions, defaultIncomingTask, greetingInstruction, incomingFollowUpInstruction, loadPersonas } from '../src/ai/personas.js';

const personas = loadPersonas(fileURLToPath(new URL('../personas/', import.meta.url)));

test('Persona-Presets werden geladen', () => {
  assert.deepEqual(
    personas.map((p) => p.id),
    ['professionell', 'locker', 'formell', 'herzlich'],
  );
  assert.equal(personas[0].label, 'Professionell');
  assert.ok(personas[0].text.length > 20);
});

test('Systemanweisung enthält Grundregeln, Persona und Auftrag', () => {
  const input = {
    persona: personas[1],
    extra: 'kurze Sätze',
    formal: false,
    aiName: 'Alex',
    principalName: 'Max',
    task: 'Frag nach den Öffnungszeiten.',
    maxCallSeconds: 300,
  };
  const text = buildInstructions(input);
  assert.match(text, /Du bist Alex, ein KI-Telefonassistent, und telefonierst im Auftrag von Max/);
  assert.match(text, /Verschweige nie, dass du eine KI bist/);
  assert.match(text, /mit „Du" an/);
  assert.match(text, /Entspannt, natürlich/);
  assert.match(text, /Zusätzliche Hinweise: kurze Sätze/);
  assert.match(text, /Frag nach den Öffnungszeiten\./);
  assert.match(text, /5 Minuten/);
  assert.match(text, /im Sinne des Auftrags verbindlich zusagen/);
  assert.doesNotMatch(text, /Rückrufnummer/);
  assert.match(buildInstructions({ ...input, callbackNumber: '0171234' }), /Rückrufnummer 0 1 7 1 2 3 4/);
  assert.match(greetingInstruction(input), /du heißt Alex.*im Auftrag von Max/);
});

test('Inhabernummer bei einem Agenten-Anruf: Vorstellung als KI-Assistent, im eigenen Auftrag', () => {
  const input = { persona: personas[0], formal: false, aiName: 'Lara', principalName: 'Max', task: 'Frag nach der Uhrzeit.', owner: true, agent: true, maxCallSeconds: 300 };
  assert.match(buildInstructions(input), /„Hi Max, Lara hier, dein KI-Assistent" – dass du eine KI bist, sagst du in der Begrüßung ausdrücklich/);
  assert.match(buildInstructions(input), /du rufst in seinem eigenen Auftrag an, nicht im Auftrag des Agenten/);
  assert.match(greetingInstruction(input), /sag dabei, dass du sein KI-Assistent bist/);
  assert.doesNotMatch(greetingInstruction(input), /keine KI-Erklärung/);
});

test('Ausgewichene Frage: einmal erneut stellen, dann als offen festhalten', () => {
  const text = buildInstructions({ persona: personas[0], formal: true, aiName: 'Alex', principalName: 'Max', task: 'x', maxCallSeconds: 300 });
  assert.match(text, /Weicht das Gegenüber einer Frage aus dem Auftrag aus .* stell deine Frage danach einmal freundlich erneut – bevor du ans Beenden denkst\. Lehnt es ab oder weicht es noch einmal aus, lass es gut sein/);
});

test('Identitätsfrage: Name und Auftraggeber, keine erfundene Herkunft', () => {
  const base = { persona: personas[0], formal: true, aiName: 'Alex', principalName: 'Max', task: 'x', maxCallSeconds: 300 };
  assert.match(buildInstructions(base), /wer du bist oder wer dich gemacht hat: Du bist Alex, ein KI-Telefonassistent im Auftrag von Max\. Wer dich entwickelt hat .* erfinde dazu nichts/);
  assert.match(buildInstructions({ ...base, incoming: true }), /Du bist der KI-Telefonassistent von Max\./);
  const agent = buildInstructions({ ...base, agent: true, agentName: 'Codex' });
  assert.match(agent, /Er hat diesen Anruf über SIPFunk gestartet und dir den Auftrag unten im Namen deines Auftraggebers mitgegeben; entwickelt hat er dich nicht/);
  assert.match(agent, /was der Agent wollte oder wozu der Anruf dient, nennst du den Auftrag in einem Satz/);
});

test('Inhabernummer: Vorstellung als Agent ohne KI-Erklärung', () => {
  const input = { persona: personas[0], formal: false, aiName: 'Salve', principalName: 'Max', task: 'x', owner: true, maxCallSeconds: 300 };
  const text = buildInstructions(input);
  assert.match(text, /Du sprichst mit Max selbst – das ist dein Chef/);
  assert.match(text, /Hi Max, Salve hier/);
  assert.doesNotMatch(text, /Verschweige nie, dass du eine KI bist, auch nicht auf Nachfrage/);
  assert.match(greetingInstruction(input), /Hi Max, Salve hier/);
  // Verlangt der Auftrag die Vorstellung als KI ausdrücklich (Testanruf über einen Agenten), geht er vor
  assert.match(text, /verlangt dein Auftrag ausdrücklich, dass du dich als KI vorstellst, tust du es in der Begrüßung trotzdem/);
  assert.match(greetingInstruction(input), /keine KI-Erklärung, außer dein Auftrag verlangt sie ausdrücklich/);
  assert.match(buildInstructions({ ...input, owner: false }), /Verschweige nie/);
});

test('Anrufbeantworter: erst nur „Hallo?", Vorstellung erst auf Reaktion des Anrufers', () => {
  const input = { persona: personas[0], formal: true, aiName: 'Cäsar', principalName: 'Max', task: 'x', incoming: true, owner: true, maxCallSeconds: 300 };
  assert.match(greetingInstruction(input), /Sag nur „Hallo\?"/);
  assert.doesNotMatch(greetingInstruction(input), /Assistent/);
  const text = buildInstructions(input);
  assert.match(text, /nur mit „Hallo\?" angenommen/);
  assert.match(text, /KI-Assistent von Max/);
  assert.doesNotMatch(text, /Cäsar/); // beim Anrufbeantworter keinen eigenen Namen nennen
  assert.match(text, /Max gerade nicht da ist/);
  assert.match(text, /geh ZUERST in einem Satz darauf ein/);
  assert.doesNotMatch(text, /\$\{p\./); // kein vergessener Platzhalter
  assert.doesNotMatch(text, /dein Agent/); // Inhaber-Logik gilt nur für ausgehende Anrufe
  assert.match(incomingFollowUpInstruction(input), /nicht reagiert.*KI-Assistent von Max/);
  assert.doesNotMatch(incomingFollowUpInstruction(input), /Cäsar/);
});

test('Anrufbeantworter-Auftrag: angezeigte Nummer nur bestätigen, anonym nachfragen', () => {
  assert.match(defaultIncomingTask('Max', '01713920012'), /gilt automatisch als Rückrufnummer/);
  assert.doesNotMatch(defaultIncomingTask('Max', '01713920012'), /01713920012/);
  assert.match(defaultIncomingTask('Max', 'anonymous'), /unterdrückt.*Frag nach einer Rückrufnummer/);
  assert.match(defaultIncomingTask('Max'), /unterdrückt/);
});

test('Anrufbeantworter: Vorstellung nur einmal, Firma anders formuliert, Inhaber per Du', async () => {
  const { buildInstructions, defaultIncomingTask, firstName, loadPersonas } = await import('../src/ai/personas.js');
  const { fileURLToPath } = await import('node:url');
  const persona = loadPersonas(fileURLToPath(new URL('../personas/', import.meta.url)))[0];
  const base = { persona, formal: true, aiName: 'Alex', principalName: 'Mustermann IT Service', task: 'x', maxCallSeconds: 300 };
  const inc = buildInstructions({ ...base, incoming: true, principalKind: 'company' });
  assert.match(inc, /genau EINMAL/);
  assert.match(inc, /bei Mustermann IT Service gerade niemand erreichbar/);
  assert.match(defaultIncomingTask('Mustermann IT Service', '030', 'company'), /jemand von Mustermann IT Service zurückrufen/);
  assert.match(defaultIncomingTask('Max Mustermann', '030'), /Max Mustermann zurückrufen/);
  const own = buildInstructions({ ...base, formal: false, owner: true, principalName: 'Max' });
  assert.match(own, /Hi Max, Alex hier/);
  assert.match(own, /Du duzt ihn/);
  assert.equal(firstName('Max (Handy)'), 'Max');
  assert.equal(firstName('Max Mustermann'), 'Max');
});

test('Rückruf an den Inhaber: Begrüßung enthält den Auftrag und fragt nicht, worum es geht', () => {
  const g = greetingInstruction({ persona: personas[0], formal: false, aiName: 'Alex', principalName: 'Max', task: 'Sag Max Bescheid: Anruf von Herrn Müller.', owner: true, maxCallSeconds: 300 });
  assert.match(g, /Hi Max, Alex hier/);
  assert.match(g, /DU hast ihn angerufen/);
  assert.match(g, /Frag NICHT, worum es geht/);
  assert.match(g, /Dein Auftrag: Sag Max Bescheid: Anruf von Herrn Müller\./);
});
