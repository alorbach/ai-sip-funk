// Erkennt, ob eine Äußerung in der Nachhörphase nur Verabschiedung/Bestätigung ist (dann sofort auflegen)
// oder Inhalt hat (dann geht das Gespräch weiter).

const FAREWELL_WORDS = new Set([
  'ja', 'jo', 'jep', 'okay', 'ok', 'oki', 'alles', 'klar', 'gut', 'super', 'prima', 'perfekt', 'passt', 'genau', 'fein', 'top',
  'danke', 'dankeschön', 'vielen', 'dank', 'dir', 'ihnen', 'auch', 'ebenfalls', 'dito', 'gleichfalls',
  'tschüss', 'tschüssi', 'tschau', 'ciao', 'bye', 'goodbye', 'servus', 'ade', 'adieu',
  'bis', 'dann', 'bald', 'später', 'morgen', 'demnächst', 'auf', 'wiedersehen', 'wiederhören',
  'mach', 'machs', 'machen', 'sie', 'es', 'schön', 'schönen', 'schönes', 'tag', 'abend', 'wochenende', 'noch', 'einen', 'ein',
  'nee', 'nein', 'nö', 'nichts', 'nix', 'mehr', 'das', 'wars', 'war', 'alles', 'erledigt', 'fertig', 'und', 'so', 'weiter',
  'sehr', 'gern', 'gerne', 'bitte', 'tschüß', 'tschö',
]);

/** true, wenn der Text leer ist oder nur aus Verabschiedungs-/Bestätigungsfloskeln besteht. */
export function isFarewell(text: string): boolean {
  // Zahlen (Uhrzeit, Nummer) und Fragen sind Inhalt, auch wenn sonst nur Floskeln fallen („Und dann?", „Nein, 15!")
  if (/[\d?]/.test(text)) return false;
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-zäöüß\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  if (words.length > 12) return false;
  return words.every((w) => FAREWELL_WORDS.has(w) || BACKCHANNEL_WORDS.has(w));
}

const BACKCHANNEL_WORDS = new Set([
  'ja', 'jaja', 'jo', 'joa', 'mhm', 'mhmh', 'hm', 'hmm', 'mh', 'mm', 'aha', 'ah', 'oh', 'ach', 'so', 'okay', 'ok', 'oki',
  'genau', 'stimmt', 'richtig', 'klar', 'gut', 'verstehe', 'schön', 'super', 'eben', 'alles',
]);

const JA_WORDS = new Set(['ja', 'jaja', 'jo', 'joa']);

/**
 * true, wenn die Äußerung leer ist (Geräusch) oder nur ein Zuhör-Laut („mhm", „ja, genau", „okay").
 * Dann redet die KI ihren Satz zu Ende, statt ihn zu verwerfen. „Nein", „Moment", Fragen und alles
 * Längere gelten als Inhalt.
 */
export function isBackchannel(text: string): boolean {
  // Eine Zahl ist eine Antwort („15."), kein Zuhör-Laut
  if (/\d/.test(text)) return false;
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-zäöüß\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 3) return false;
  // Ein bloßes „Ja" ist meist die Antwort auf eine Frage; nur zusammen mit einem Zuhör-Laut („ja, genau") zählt es als solcher
  if (words.length > 0 && words.every((w) => JA_WORDS.has(w))) return false;
  return words.every((w) => BACKCHANNEL_WORDS.has(w));
}

/** Einzelne Wörter, die eine Antwort sein können: Sie gelten nie als Echo, auch wenn die KI sie gerade selbst gesagt hat. */
const ANSWER_WORDS = new Set([
  'ja', 'jaja', 'jo', 'nein', 'nee', 'nö', 'doch', 'okay', 'ok', 'gut', 'genau', 'richtig', 'stimmt', 'danke', 'bitte', 'hallo',
  'klar', 'gerne', 'gern', 'super', 'moment', 'stopp', 'stop', 'halt', 'wie', 'was', 'wer', 'wann', 'wo', 'warum', 'falsch', 'nicht',
]);

/**
 * true, wenn das „Gesagte" des Gegenübers nur wiederholt, was die KI in ihrer laufenden Antwort gerade selbst gesagt hat:
 * dieselben Wörter in derselben Reihenfolge, höchstens sechs. Das ist das Echo ihrer eigenen Stimme vom Telefon der
 * Gegenseite, keine Äußerung. Fragen, Zahlen und einzelne Antwortwörter („ja", „nein", „Moment") zählen immer als Inhalt.
 */
export function isEcho(text: string, spoken: string): boolean {
  if (/[\d?]/.test(text)) return false;
  const words = (s: string) => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-zäöüß\s]/g, ' ').split(/\s+/).filter(Boolean);
  const said = words(text);
  const own = words(spoken);
  if (said.length === 0 || said.length > 6 || own.length < said.length) return false;
  if (said.length === 1 && ANSWER_WORDS.has(said[0])) return false;
  for (let i = 0; i + said.length <= own.length; i++) {
    if (said.every((w, k) => own[i + k] === w)) return true;
  }
  return false;
}
