// Englisches Wörterbuch der Oberfläche: Jeder Schlüssel muss noch als deutscher Text in den Quellen stehen.
// So fällt auf, wenn ein Text geändert wurde und seine Übersetzung dadurch nicht mehr greift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function loadDictionary(): { exact: Record<string, string>; patterns: [RegExp, unknown][] } {
  const window: Record<string, unknown> = { I18N: { t: (s: string) => s } };
  vm.runInNewContext(read('public/i18n-en.js'), { window });
  return window.SIPFUNK_EN as { exact: Record<string, string>; patterns: [RegExp, unknown][] };
}

function sources(): string {
  const walk = (dir: string): string[] => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : e.name.endsWith('.ts') ? [`${dir}${e.name}`] : []));
  const files = ['public/index.html', 'public/ring.html', ...walk('src/'), ...readdirSync(new URL('personas/', root)).map((f) => `personas/${f}`)];
  return norm(files.map(read).join('\n'));
}

// Texte, die erst im Browser zusammengesetzt werden (Großschreibung der Phase, Zusätze) oder Platzhalter enthalten
const COMPOSED = new Set([
  'Wählt', 'Klingelt', 'Eingehender Anruf', 'Verbunden', 'Beendet', 'an', 'aus',
  'KI-Gespräch (OpenAI-Schlüssel fehlt)', 'gpt-realtime-2.1 (besser)', 'gpt-realtime-2.1-mini (günstig)',
  'OpenAI-Schlüssel hinterlegt. Ein neuer Schlüssel ersetzt ihn.', 'Nummer steht auf deiner Spam-Liste.',
]);

test('Wörterbuch: Schlüssel stehen noch in den deutschen Quellen', () => {
  const { exact } = loadDictionary();
  const text = sources();
  // HTML-Schlüssel entsprechen dem innerHTML des Browsers: Anführungszeichen in Attributen sind dort immer doppelt
  const missing = Object.keys(exact).filter((k) => !COMPOSED.has(k) && !text.includes(k) && !text.includes(k.replace(/"/g, "'")));
  assert.deepEqual(missing, []);
});

test('Wörterbuch: keine leeren Übersetzungen, Platzhalter bleiben erhalten', () => {
  const { exact, patterns } = loadDictionary();
  assert.ok(Object.keys(exact).length > 300);
  for (const [de, en] of Object.entries(exact)) {
    assert.ok(typeof en === 'string' && en.trim().length > 0, de);
    assert.deepEqual((en.match(/\{\d\}/g) ?? []).sort(), (de.match(/\{\d\}/g) ?? []).sort(), de);
    // Auszeichnung und Variablen der Mail-Vorlage müssen in der Übersetzung dieselben sein
    assert.deepEqual((en.match(/<code>[^<]*<\/code>/g) ?? []).filter((c) => c.includes('{')).sort(), (de.match(/<code>[^<]*<\/code>/g) ?? []).filter((c) => c.includes('{')).sort(), de);
  }
  for (const [re] of patterns) assert.ok(Object.prototype.toString.call(re) === '[object RegExp]' && re.source.startsWith('^'), String(re)); // anderes Realm (vm): kein instanceof
});
