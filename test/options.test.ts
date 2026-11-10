// Einstellungen, die das Gespräch verändern: Verhalten in Stufen, Familien-AB, KI-Kennung der Spam-Abwehr, Modellwahl.
// Geprüft wird, dass jede Einstellung in der Anweisung an das Modell ankommt und dass der Standard nichts verändert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { behaviorHints, buildInstructions, defaultIncomingTask, incomingFollowUpInstruction, loadPersonas, type PromptInput } from '../src/ai/personas.js';
import { buildScamInstructions, FLAG_SPAM_ACK, FLAG_SPAM_ACK_OPEN, scamGreeting, SCAM_GREETING_OPEN } from '../src/ai/scam.js';
import { parseProfiles, realtimeModel, REALTIME_MODELS, scamActive, scamAllowed, type FormSettings } from '../src/settings.js';

const personas = loadPersonas(fileURLToPath(new URL('../personas/', import.meta.url)));
const base: PromptInput = { persona: personas[0], formal: true, aiName: 'Alex', principalName: 'Max Mustermann', task: 'Frag nach den Öffnungszeiten.', maxCallSeconds: 300 };

test('Verhalten: ohne Vorgabe bleibt die Anweisung, wie sie war', () => {
  assert.deepEqual(behaviorHints(), []);
  assert.deepEqual(behaviorHints({ length: '', pace: '', confirm: '', smalltalk: '' }), []);
  assert.deepEqual(behaviorHints({ pace: 'unsinn', confirm: 'x', smalltalk: 'vielleicht' }), []);
  const plain = buildInstructions(base);
  assert.equal(buildInstructions({ ...base, behavior: { length: '', pace: '', confirm: '', smalltalk: '' } }), plain);
  assert.match(plain, /höchstens zwei kurze Sätze lang \(unter 10 Sekunden\)/);
  assert.doesNotMatch(plain, /Vorgaben deines Auftraggebers zum Verhalten/);
});

test('Verhalten: jede Stufe steht als eigener Satz in der Anweisung', () => {
  const short = buildInstructions({ ...base, behavior: { length: 'knapp', pace: 'zuegig', confirm: 'selten', smalltalk: 'nein' } });
  assert.match(short, /WICHTIG: Jeder Redebeitrag von dir ist so knapp wie möglich/);
  assert.doesNotMatch(short, /höchstens zwei kurze Sätze lang/);
  assert.match(short, /Vorgaben deines Auftraggebers zum Verhalten/);
  assert.match(short, /Komm ohne Umschweife zur Sache/);
  assert.match(short, /Wiederhole Angaben des Gegenübers nicht zur Bestätigung/);
  assert.match(short, /Kein Small Talk/);
  const long = buildInstructions({ ...base, extra: 'Meinen Vornamen nicht nennen.', behavior: { length: 'ausfuehrlich', pace: 'geduldig', confirm: 'immer', smalltalk: 'ja' } });
  assert.match(long, /höchstens drei Sätze lang \(unter 15 Sekunden\)/);
  assert.match(long, /Nimm dir Zeit/);
  assert.match(long, /wiederholst du einmal kurz zur Bestätigung/);
  assert.match(long, /Small Talk sind willkommen/);
  // Reihenfolge im Abschnitt „Stil": Persona, Vorgaben, freier Text – und die Ein-Frage-Regel bleibt bestehen
  assert.ok(long.indexOf(personas[0].text) < long.indexOf('Vorgaben deines Auftraggebers'));
  assert.ok(long.indexOf('Vorgaben deines Auftraggebers') < long.indexOf('Zusätzliche Hinweise: Meinen Vornamen nicht nennen.'));
  assert.match(long, /Stelle höchstens eine Frage auf einmal/);
});

test('Familien-AB: Formulierung, Nachfrage „für wen" und Mitglieder nur zum Zuordnen', () => {
  const task = defaultIncomingTask('Familie Mustermann', '030123456', 'family');
  assert.match(task, /^Bei Familie Mustermann ist gerade niemand zu Hause/);
  assert.match(task, /für wen aus der Familie der Anruf ist/);
  assert.match(task, /ob jemand von Familie Mustermann zurückrufen soll/);
  const input: PromptInput = { ...base, incoming: true, principalName: 'Familie Mustermann', principalKind: 'family', familyMembers: ' Anna,  Ben ,Oma Erika ', task };
  const text = buildInstructions(input);
  assert.match(text, /bei Familie Mustermann gerade niemand zu Hause ist/);
  assert.match(text, /Du bist am Anschluss einer Familie/);
  assert.match(text, /Halte bei end_call im Ergebnis fest, für wen der Anruf war/);
  assert.match(text, /Zur Familie gehören: Anna, Ben ,Oma Erika\. Zähle diese Namen nicht von dir aus auf/);
  assert.match(incomingFollowUpInstruction(input), /weil bei Familie Mustermann gerade niemand zu Hause ist/);
  // Ohne Mitglieder fragt die KI trotzdem; Person und Firma bleiben unverändert und bekommen die Familienregel nicht
  const noMembers = buildInstructions({ ...input, familyMembers: '' });
  assert.match(noMembers, /Du bist am Anschluss einer Familie/);
  assert.doesNotMatch(noMembers, /Zur Familie gehören/);
  assert.doesNotMatch(buildInstructions({ ...input, principalKind: 'person' }), /Anschluss einer Familie/);
  assert.doesNotMatch(buildInstructions({ ...input, principalKind: 'company' }), /Anschluss einer Familie/);
  // Ausgehende Anrufe kennen keine Familienregel
  assert.doesNotMatch(buildInstructions({ ...input, incoming: false }), /Anschluss einer Familie/);
});

test('Familien-AB: Profil mit Art „family" und Mitgliedern wird gelesen, Unbekanntes fällt auf Person zurück', () => {
  const list = parseProfiles(JSON.stringify([
    { number: '23125100', name: 'Familie Mustermann', kind: 'family', members: '  Anna,\n Ben  ' },
    { number: '23125200', name: 'Max Mustermann', kind: 'verein', members: 'x' },
    { number: '23125300', name: 'Mustermann IT', kind: 'company' },
  ]));
  assert.deepEqual(list.map((p) => p.kind), ['family', 'person', 'company']);
  assert.equal(list[0].members, 'Anna, Ben');
  assert.equal(list[2].members, '');
});

test('Spam-Abwehr: mit KI-Kennung ohne Bestätigung aktiv, ohne Kennung nur mit Bestätigung', () => {
  const s = { scamMode: 'on', scamAccepted: '', scamDisclose: 'off' } as FormSettings;
  assert.equal(scamAllowed(s), false);
  assert.equal(scamActive(s), false);
  assert.equal(scamActive({ ...s, scamDisclose: 'on' }), true);
  assert.equal(scamActive({ ...s, scamDisclose: 'on', scamMode: 'off' }), false);
  assert.equal(scamActive({ ...s, scamAccepted: '2026-11-10T10:00:00Z' }), true);
  // Einstellungen von vor dieser Version haben das Feld nicht: Es gilt „ohne Kennung" wie bisher
  assert.equal(scamActive({ scamMode: 'on', scamAccepted: '' } as FormSettings), false);
});

test('Spam-Rolle mit KI-Kennung: offen als KI, kein erfundener Name, Schutzregeln bleiben', () => {
  const hidden = buildScamInstructions({ style: 'abwimmeln', maxMinutes: 1, callerKnown: true, name: 'Schmidt', gender: 'w' });
  const open = buildScamInstructions({ style: 'abwimmeln', maxMinutes: 1, callerKnown: true, name: 'Schmidt', gender: 'w', disclose: true });
  // Standard (ohne Kennung) ist unverändert: Privatperson mit Rollenname
  assert.equal(buildScamInstructions({ style: 'abwimmeln', maxMinutes: 1, callerKnown: true, name: 'Schmidt', gender: 'w', disclose: false }), hidden);
  assert.match(hidden, /Du spielst eine Privatperson/);
  assert.match(hidden, /Du gibst dich nicht als KI zu erkennen/);
  assert.match(hidden, /„Schmidt"/);
  // Mit Kennung
  assert.match(open, /^Du bist ein KI-Telefonassistent/);
  assert.match(open, /Du trittst offen als KI auf/);
  assert.match(open, /bestätigst du ehrlich, dass du eine KI bist/);
  assert.doesNotMatch(open, /Du gibst dich nicht als KI zu erkennen/);
  assert.doesNotMatch(open, /Du spielst eine Privatperson/);
  assert.doesNotMatch(open, /Schmidt/);
  assert.doesNotMatch(open, /Du bist eine Frau/);
  assert.doesNotMatch(open, /daran erkennt man sonst die Maschine/);
  // Schutzregeln und Verhalten gelten in beiden Fällen
  for (const text of [hidden, open]) {
    assert.match(text, /Du nennst NIE echte oder erfundene persönliche Daten/);
    assert.match(text, /Du stimmst NICHTS zu/);
    assert.match(text, /Bleib höflich/);
    assert.match(text, /freundlich, aber kurz abwimmeln/);
  }
  const stall = buildScamInstructions({ style: 'beschaeftigen', maxMinutes: 5, callerKnown: false, disclose: true, extra: 'Fragt gern nach Details.' });
  assert.match(stall, /freundlich hinhalten \(höchstens 5 Minuten\)/);
  assert.match(stall, /Fragt gern nach Details\./);
  assert.doesNotMatch(stall, /gesprächigen Menschen erwischt/);
});

test('Spam-Rolle mit KI-Kennung: Begrüßung und Rollenwechsel nennen die KI', () => {
  assert.equal(scamGreeting('Schmidt', true), SCAM_GREETING_OPEN);
  assert.match(SCAM_GREETING_OPEN, /KI-Assistent/);
  assert.match(scamGreeting('Schmidt'), /„Schmidt\?"/);
  assert.match(FLAG_SPAM_ACK, /keine KI mehr/);
  assert.match(FLAG_SPAM_ACK_OPEN, /Du bleibst offen ein KI-Assistent/);
  assert.doesNotMatch(FLAG_SPAM_ACK_OPEN, /Privatperson/);
});

test('Sprachmodell: Listeneintrag oder eigene Modell-ID, sonst Vorgabe', () => {
  assert.equal(realtimeModel(REALTIME_MODELS[1], 'vorgabe'), REALTIME_MODELS[1]);
  assert.equal(realtimeModel(' gpt-realtime-next_2026.01 ', 'vorgabe'), 'gpt-realtime-next_2026.01');
  assert.equal(realtimeModel('', 'vorgabe'), 'vorgabe');
  assert.equal(realtimeModel(undefined, 'vorgabe'), 'vorgabe');
  assert.equal(realtimeModel('modell mit leerzeichen', 'vorgabe'), 'vorgabe');
  assert.equal(realtimeModel('x&voice=y', 'vorgabe'), 'vorgabe'); // darf die Adresse der Verbindung nicht verändern
  assert.equal(realtimeModel('a'.repeat(65), 'vorgabe'), 'vorgabe');
});
