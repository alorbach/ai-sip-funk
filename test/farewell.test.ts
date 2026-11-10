import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFarewell } from '../src/ai/farewell.js';

test('Verabschiedungen werden erkannt', () => {
  for (const t of ['Okay, tschüss.', 'Tschüss!', 'Ja, danke dir, mach’s gut.', 'Auf Wiedersehen.', 'Bis dann, ciao!', 'Nee, das war’s. Danke.', 'Alles klar, schönen Tag noch.', '', '  ']) {
    assert.equal(isFarewell(t), true, t);
  }
});

test('Inhalt wird nicht als Verabschiedung gewertet', () => {
  for (const t of ['Ach, eine Frage noch: Wann genau?', 'Moment, kannst du das wiederholen?', 'Nee, das Ding ist, du sollst erkennen, wenn ich Tschüss sage.', 'Tschüss, aber sag Max noch Bescheid.']) {
    assert.equal(isFarewell(t), false, t);
  }
});

test('Zahlen und Fragen sind Inhalt, Zuhör-Laut plus Abschied ist Abschied', () => {
  for (const t of ['15.', 'Nein, 15!', '0171 234', 'Und dann?', 'War das alles?', 'Machen Sie das morgen?']) assert.equal(isFarewell(t), false, t);
  for (const t of ['Mhm, tschüss.', 'Aha, okay, tschüss', 'Danke sehr, tschüß!', 'Gerne, ciao.']) assert.equal(isFarewell(t), true, t);
  for (const t of ['15.', '17 30']) assert.equal(isBackchannel(t), false, t);
});

import { isBackchannel } from '../src/ai/farewell.js';

test('Zuhör-Laute und Geräusche unterbrechen die KI nicht, Inhalt schon', () => {
  for (const t of ['', '  ', 'Mhm.', 'Ja, genau.', 'Okay', 'Ach so.', 'Aha, verstehe.']) assert.equal(isBackchannel(t), true, t);
  for (const t of ['Ja.', 'Ja, ja.', 'Nein.', 'Moment mal', 'Stopp', 'Wie bitte?', 'Ja, aber das stimmt nicht.', 'Ich hätte da noch eine Frage', 'Tschüss']) assert.equal(isBackchannel(t), false, t);
});
