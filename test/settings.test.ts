import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityFor, parseIdentities } from '../src/settings.js';

test('Meldung je gewählter Nummer: Zeilen parsen, Endziffern vergleichen, längster Treffer gewinnt', () => {
  const text = '23125100 = Max Mustermann\r\n030 23125777: Mustermann IT-Service\n\nkaputt\n  = ohne Nummer\n';
  assert.deepEqual(parseIdentities(text), [
    { number: '23125100', name: 'Max Mustermann' },
    { number: '03023125777', name: 'Mustermann IT-Service' },
  ]);
  assert.equal(identityFor('030123125100', text, 'Fallback'), 'Max Mustermann');
  assert.equal(identityFor('03023125777', text, 'Fallback'), 'Mustermann IT-Service');
  assert.equal(identityFor('23125777', text, 'Fallback'), 'Mustermann IT-Service'); // Box liefert nur die Endziffern
  assert.equal(identityFor('999999', text, 'Fallback'), 'Fallback');
  assert.equal(identityFor('', text, 'Fallback'), 'Fallback');
  assert.equal(identityFor('23125100', '', 'Fallback'), 'Fallback');
});

test('Technik-Werte: Grenzen und Fallbacks', async () => {
  const { tuningFrom } = await import('../src/settings.js');
  const base = { maxCallSeconds: '300', retentionDays: '7', stallMs: '6000', vadSilenceMs: '900', hangupGraceMs: '2000', greetingWaitMs: '2500', speechSpeed: '1.05', outputGain: '1.5', allowInterrupt: 'on', summaryModel: 'gpt-6-luna' };
  const t = tuningFrom(base as never);
  assert.equal(t.maxCallSeconds, 300);
  assert.equal(t.stallMs, 6000);
  assert.equal(t.allowInterrupt, true);
  const x = tuningFrom({ ...base, maxCallSeconds: '99999', stallMs: '0', speechSpeed: 'abc', outputGain: '0', allowInterrupt: 'off', summaryModel: ' ' } as never);
  assert.equal(x.maxCallSeconds, 3600); // Obergrenze
  assert.equal(x.stallMs, 0); // 0 = aus bleibt erlaubt
  assert.equal(x.speechSpeed, 1.05); // Unsinn -> Standard
  assert.equal(x.outputGain, 0.2); // Untergrenze
  assert.equal(x.allowInterrupt, false);
  assert.equal(x.summaryModel, 'gpt-6-luna');
});

test('Anrufbeantworter-Profile: JSON, Altformat, Treffer je Nummer', async () => {
  const { parseProfiles, profileFor } = await import('../src/settings.js');
  const legacy = parseProfiles('', '23125100 = Max Mustermann\n23125200 = Mustermann IT Service');
  assert.equal(legacy.length, 2);
  assert.equal(legacy[1].kind, 'person');
  const json = JSON.stringify([{ number: '030 23125100', name: 'Max Mustermann', kind: 'person', address: 'du', persona: 'locker' }, { number: '23125200', name: 'Mustermann IT Service', kind: 'company', address: 'sie', voice: 'cedar', task: 'Nimm Störungsmeldungen auf.' }, { number: '', name: 'ohne Nummer' }]);
  const profs = parseProfiles(json, legacy.length ? 'ignoriert' : '');
  assert.equal(profs.length, 2);
  assert.equal(profs[0].number, '03023125100');
  assert.equal(profileFor('03023125200', profs)?.name, 'Mustermann IT Service');
  assert.equal(profileFor('23125200', profs)?.kind, 'company');
  assert.equal(profileFor('23125100', profs)?.address, 'du');
  assert.equal(profileFor('999', profs), undefined);
  assert.equal(parseProfiles('kaputt', '23125100 = Max')[0]?.name, 'Max'); // ungültiges JSON -> Altformat
});

test('Benachrichtigungen: allgemeine Regel und Profil je Nummer', async () => {
  const { notifyPolicies, parseProfiles, shouldNotify } = await import('../src/settings.js');
  const s = { notifyTray: 'on', notifyEmail: 'off', notifyCall: 'on' } as never;
  assert.deepEqual(notifyPolicies(s), { tray: 'all', email: 'off', call: 'important' });
  const [prof] = parseProfiles(JSON.stringify([{ number: '23125200', name: 'IT', notifyTray: 'off', notifyEmail: 'all', notifyCall: 'quatsch' }]));
  assert.deepEqual(notifyPolicies(s, prof), { tray: 'off', email: 'all', call: 'important' });
  assert.equal(shouldNotify('all', false), true);
  assert.equal(shouldNotify('important', false), false);
  assert.equal(shouldNotify('important', true), true);
  assert.equal(shouldNotify('off', true), false);
});

test('Profil: Annahme und Klingelzahl je Nummer', async () => {
  const { incomingOverride, parseProfiles } = await import('../src/settings.js');
  const [a, b, c] = parseProfiles(JSON.stringify([
    { number: '1', name: 'A', answer: 'off', rings: '3' },
    { number: '2', name: 'B', answer: 'on', rings: '12' },
    { number: '3', name: 'C' },
  ]));
  assert.deepEqual(incomingOverride(a), { enabled: false, answerAfterRings: 3 });
  assert.deepEqual(incomingOverride(b), { enabled: true }); // 12 ist ungültig -> allgemein
  assert.deepEqual(incomingOverride(c), {});
  assert.equal(incomingOverride(undefined), undefined);
});

import { localRequestAllowed } from '../src/web/server.js';

test('Web-UI: nur lokaler Host und passender Origin', () => {
  assert.equal(localRequestAllowed('127.0.0.1:8080', undefined), true);
  assert.equal(localRequestAllowed('localhost:8080', 'http://localhost:8080'), true);
  assert.equal(localRequestAllowed('127.0.0.1:8080', 'http://127.0.0.1:8080'), true);
  assert.equal(localRequestAllowed('127.0.0.1:8080', 'https://example.org'), false);
  assert.equal(localRequestAllowed('127.0.0.1:8080', 'null'), false);
  assert.equal(localRequestAllowed('rebind.example.org:8080', undefined), false);
  assert.equal(localRequestAllowed(undefined, undefined), false);
});
