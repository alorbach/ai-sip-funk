import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContactStore, numberKey } from '../src/contacts.js';

test('Nummern-Schlüssel', () => {
  assert.equal(numberKey('+49 171 3920012'), '01713920012');
  assert.equal(numberKey('0049171-3920012'), '01713920012');
  assert.equal(numberKey('0171 3920012'), '01713920012');
  assert.equal(numberKey('**610'), '**610');
});

test('Kontakte anlegen, finden, ändern, löschen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sipfunk-c-'));
  try {
    const file = join(dir, 'contacts.json');
    const store = new ContactStore(file);
    const max = store.create({ name: 'Max', number: '+49 171 3920012', owner: true, address: 'du' });
    const laden = store.create({ name: 'Bäckerei Müller', number: '030 23125777', task: 'Nach Öffnungszeiten fragen', persona: 'professionell' });
    assert.throws(() => store.create({ name: 'Doppelt', number: '0171 3920012' }), /schon bei „Max"/);
    assert.throws(() => store.create({ name: '', number: '1' }), /Name fehlt/);

    assert.equal(store.isOwnerNumber('01713920012'), true);
    assert.equal(store.isOwnerNumber('03023125777'), false);
    assert.equal(store.findByName('müller')?.id, laden.id);
    assert.equal(store.findByName('max')?.id, max.id);
    assert.equal(store.findByName('zzz'), undefined);
    assert.deepEqual(store.list().map((c) => c.name), ['Max', 'Bäckerei Müller']);

    const updated = store.update(laden.id, { notes: 'freundlich', task: '' });
    assert.equal(updated.notes, 'freundlich');
    assert.equal(updated.task, undefined);
    // Freigabe für Agenten-Anrufe ohne Nachfrage: nur ein echtes true zählt, abwählen entfernt sie
    assert.equal(store.update(laden.id, { agentDirect: 'ja' as unknown as boolean }).agentDirect, undefined);
    assert.equal(store.update(laden.id, { agentDirect: true }).agentDirect, true);
    assert.equal(new ContactStore(file).get(laden.id)?.agentDirect, true);
    // Neue Hauptnummer ohne erneutes Häkchen: Freigabe entfällt
    store.update(laden.id, { agentDirect: true });
    assert.equal(store.update(laden.id, { number: '030 23125778' }).agentDirect, undefined);
    assert.equal(store.update(laden.id, { number: '030 23125777', agentDirect: true }).agentDirect, true);
    assert.equal(store.update(laden.id, { agentDirect: false }).agentDirect, undefined);

    // Neu laden aus Datei
    const store2 = new ContactStore(file);
    assert.equal(store2.list().length, 2);
    assert.equal(store2.delete(laden.id), true);
    assert.equal(store2.delete(laden.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
