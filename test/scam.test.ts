import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScamInstructions, isScamNumber, parseScamNumbers, SCAM_GREETING, scamGender, scamGreeting } from '../src/ai/scam.js';
import { scamActive, scamMaxSeconds, scamSpeed, type FormSettings } from '../src/settings.js';

test('Spam-Liste: Präfixe, Kommentare, „anonym“, 0049-Normalisierung', () => {
  const list = '0800\n030 23125888 # Stromtarif\n\nanonym\nab\n';
  assert.deepEqual(parseScamNumbers(list), { prefixes: ['0800', '03023125888'], anonymous: true });
  assert.equal(isScamNumber('08001234567', list), true);
  assert.equal(isScamNumber('+49 30 23125888', list), true);
  assert.equal(isScamNumber('00493023125888', list), true);
  assert.equal(isScamNumber('03023125889', list), false);
  assert.equal(isScamNumber('', list), true); // anonym steht auf der Liste
  assert.equal(isScamNumber('', '0800'), false);
  assert.equal(isScamNumber('030231257777', ''), false);
});

test('Scam-Modus: nur mit Schalter UND Bestätigung aktiv; Zeitlimit gedeckelt', () => {
  const base = { scamMode: 'on', scamAccepted: '', scamMaxMinutes: '5' } as FormSettings;
  assert.equal(scamActive(base), false);
  assert.equal(scamActive({ ...base, scamAccepted: '2026-11-07T10:00:00Z' }), true);
  assert.equal(scamActive({ ...base, scamMode: 'off', scamAccepted: '2026-11-07T10:00:00Z' }), false);
  assert.equal(scamMaxSeconds(base, 600), 300);
  assert.equal(scamMaxSeconds({ ...base, scamMaxMinutes: '99' }, 600), 600); // globales Limit
  assert.equal(scamMaxSeconds({ ...base, scamMaxMinutes: 'x' }, 600), 300);
  assert.equal(scamMaxSeconds({ ...base, scamMaxMinutes: '0' }, 600), 300); // 0 = ungültig -> Standard
  assert.equal(scamMaxSeconds({ ...base, scamMaxMinutes: '1' }, 600), 60);
});

test('Scam-Anweisung: keine KI-Nennung, keine Daten, keine Zustimmung, Rückweg zum Assistenten', () => {
  const quick = buildScamInstructions({ style: 'abwimmeln', maxMinutes: 5, callerKnown: true, styleText: 'Sprich ruhig.' });
  assert.match(quick, /gibst dich nicht als KI zu erkennen/);
  assert.match(quick, /NIE echte oder erfundene persönliche Daten/);
  assert.match(quick, /stimmst NICHTS zu/);
  assert.match(quick, /Keine Beleidigungen/);
  assert.match(quick, /doch ein echtes Anliegen .* KI-Assistent/);
  assert.match(quick, /kurz abwimmeln/);
  assert.doesNotMatch(quick, /Sprich ruhig\./); // Persona-Stil bleibt draußen
  assert.match(quick, /So klingst du wie ein Mensch/);
  assert.match(quick, /Höchstens EINE Frage/);
  assert.match(quick, /Kein Büro- oder Behördendeutsch/);
  assert.doesNotMatch(quick, /hinhalten \(höchstens/);
  const slow = buildScamInstructions({ style: 'beschaeftigen', maxMinutes: 7, callerKnown: false });
  assert.match(slow, /hinhalten \(höchstens 7 Minuten\)/);
  assert.match(slow, /Nummer war unterdrückt/);
  assert.doesNotMatch(slow, /\$\{/);
});

test('Spam-Rolle: eigener Name, eigene Anweisungen, eigenes Tempo', () => {
  const plain = buildScamInstructions({ style: 'abwimmeln', maxMinutes: 1, callerKnown: true });
  assert.match(plain, /keinen Namen nennen/);
  assert.doesNotMatch(plain, /Deine Figur/);
  assert.equal(scamGreeting(''), SCAM_GREETING);

  const own = buildScamInstructions({ style: 'abwimmeln', maxMinutes: 1, callerKnown: true, name: ' Schmidt\n"x" ', extra: 'Ältere Dame, erzählt vom Garten.' });
  assert.match(own, /heißt du „Schmidt x"/); // einzeilig, ohne Anführungszeichen
  assert.match(own, /außer deinem Rollennamen/);
  assert.doesNotMatch(own, /keinen Namen nennen/);
  assert.match(own, /Einen anderen Namen nennst du nie/);
  assert.match(own, /## Deine Figur[^\n]*\nÄltere Dame, erzählt vom Garten\.\n[^\n]*gelten die Grundregeln/);
  assert.ok(own.indexOf('## Deine Figur') < own.indexOf('## Grundregeln')); // Figur steht vorn
  assert.match(own, /## Zum Schluss: deine Figur\nDu bist: Ältere Dame/); // und noch einmal am Ende
  assert.match(own, /Wie viel du redest, bestimmt deine Figur/);
  assert.match(plain, /meist 3 bis 10 Wörter\./);
  assert.match(own, /stimmst NICHTS zu/); // Schutzregeln bleiben
  assert.doesNotMatch(own, /\$\{/);
  assert.match(scamGreeting('Schmidt'), /„Schmidt\?"/);

  const base = { scamSpeed: '' } as FormSettings;
  assert.equal(scamSpeed(base, 1.05), 1.05);
  assert.equal(scamSpeed({ ...base, scamSpeed: '0,9' }, 1.05), 0.9);
  assert.equal(scamSpeed({ ...base, scamSpeed: '9' }, 1.05), 1.5);
  assert.equal(scamSpeed({ ...base, scamSpeed: 'x' }, 1.05), 1.05);
});

test('Hinhalten: wach und interessiert, nicht begriffsstutzig', () => {
  const slow = buildScamInstructions({ style: 'beschaeftigen', maxMinutes: 5, callerKnown: true, name: 'Schmidt' });
  assert.match(slow, /geistig wacher Mensch/);
  assert.match(slow, /Frag NIE zweimal dasselbe/);
  assert.match(slow, /darf nicht merken, dass du ihn hinhältst/);
  assert.doesNotMatch(slow, /schwerhörig\. Lass dir alles zweimal/);
  assert.match(slow, /Verlangt der Anrufer Herrn oder Frau Schmidt/);
  assert.match(slow, /Am Apparat/);
  assert.doesNotMatch(slow, /\$\{/);
});

test('Spam-Rolle kennt ihr Geschlecht: nach Stimme oder ausdrücklich', () => {
  assert.equal(scamGender('', 'cedar'), 'm');
  assert.equal(scamGender('', 'marin'), 'w');
  assert.equal(scamGender('w', 'cedar'), 'w');
  assert.equal(scamGender('x', 'echo'), 'm');
  const man = buildScamInstructions({ style: 'beschaeftigen', maxMinutes: 5, callerKnown: true, name: 'Schmidt', gender: 'm' });
  assert.match(man, /Du bist ein Mann/);
  assert.match(man, /Verlangt der Anrufer Herrn Schmidt, sagst du „Am Apparat\."/);
  assert.match(man, /Verlangt er Frau Schmidt, bist das NICHT du/);
  assert.match(man, /„Die ist grad nicht da/);
  const woman = buildScamInstructions({ style: 'abwimmeln', maxMinutes: 1, callerKnown: true, name: 'Schmidt', gender: 'w' });
  assert.match(woman, /Du bist eine Frau/);
  assert.match(woman, /Verlangt er Herrn Schmidt, bist das NICHT du/);
  assert.match(woman, /Pass dich NICHT dem Tempo des Anrufers an/);
  assert.doesNotMatch(man + woman, /\$\{/);
});
