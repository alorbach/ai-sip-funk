import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localVerdict, numberHint, parseTellows, withTellows } from '../src/spamCheck.js';

test('Spam-Einschätzung lokal: Kontakt, Liste, Verlauf, Rufnummerngasse', () => {
  const base = { scamNumbers: '0800\nanonym', spamCalls: 0 };
  assert.equal(localVerdict('03023125123', { ...base, contactName: 'Praxis Weber' }).level, 'contact');
  assert.equal(localVerdict('08005551234', base).source, 'liste');
  assert.equal(localVerdict('', base).level, 'spam'); // „anonym" steht auf der Liste
  assert.equal(localVerdict('', { scamNumbers: '', spamCalls: 0 }).label, 'Nummer unterdrückt');
  assert.equal(localVerdict('03023125123', { scamNumbers: '', spamCalls: 2 }).source, 'verlauf');
  assert.equal(localVerdict('09005551234', { scamNumbers: '', spamCalls: 0 }).level, 'suspicious');
  assert.equal(localVerdict('03023125123', { scamNumbers: '', spamCalls: 0 }).level, 'unknown');
  assert.equal(numberHint('+44 20 5550123'), 'Auslandsnummer');
  assert.equal(numberHint('+49 30 23125123'), undefined);
  assert.equal(numberHint('0049 30 23125123'), undefined);
  assert.match(numberHint('0137 5550123') ?? '', /Massenverkehr/);
});

test('tellows: Antwort lesen und einarbeiten', () => {
  const body = '{"tellows":{"number":"0301234","score":"8","searches":"1500","comments":"42","location":"Berlin","numberDetails":{"name":"","isCompany":"0"}}}Partner Data not correct';
  const t = parseTellows(body);
  assert.deepEqual(t, { score: 8, searches: 1500, comments: 42, name: undefined, location: 'Berlin' });
  assert.equal(parseTellows('kaputt'), undefined);
  assert.equal(parseTellows('{"tellows":{"score":"0"}}'), undefined);
  const unknown = localVerdict('03023125888', { scamNumbers: '', spamCalls: 0 });
  const spam = withTellows(unknown, t);
  assert.equal(spam.level, 'spam');
  assert.equal(spam.source, 'tellows');
  assert.match(spam.detail, /Score 8 von 9/);
  // Kontakt und eigene Liste haben Vorrang vor tellows
  const contact = localVerdict('03023125888', { contactName: 'Oma', scamNumbers: '', spamCalls: 0 });
  assert.equal(withTellows(contact, t).level, 'contact');
  // seriöser Eintrag mit Namen
  assert.equal(withTellows(unknown, { score: 2, searches: 287, comments: 0, name: 'Beispiel GmbH' }).level, 'ok');
  // neutraler Score ohne Bewertungen sagt nichts
  assert.equal(withTellows(unknown, { score: 5, searches: 3, comments: 0 }).level, 'unknown');
  assert.equal(withTellows(unknown, undefined), unknown);
});
