// KI-Verbindungen: benannte Zugänge zu einem KI-Anbieter, zwischen denen sich umschalten lässt. Eine Verbindung
// besteht aus Anbieter, eigenem Schlüssel und den Modellen, die mit ihr benutzt werden (Sprachmodell für Anrufe,
// Textmodell für Plan, Zusammenfassung, Einschätzung). So können z. B. zwei OpenAI-Konten oder ein günstiges und
// ein teures Modell nebeneinander stehen. Die Liste liegt in den Einstellungen (settings.json), die Schlüssel
// liegen wie alle Zugangsdaten nur in der .env.
import { knownProvider, providerById } from './providers/index.js';
import type { ProviderId } from './providers/types.js';
import { MAX_FALLBACKS } from './limits.js';

export interface AiConnection {
  /** Kennung (klein, a–z und Ziffern); „openai“ und „gemini“ sind die beiden mitgelieferten Verbindungen */
  id: string;
  name: string;
  provider: ProviderId;
  /** Sprachmodell für Anrufe; leer = Vorgabe des Anbieters */
  model: string;
  /** Textmodell; leer = Vorgabe des Anbieters */
  textModel: string;
  /** Standardstimme dieser Verbindung (eine Stimme ihres Anbieters); leer = Vorgabe, siehe connectionVoice */
  voice: string;
  /** Ausweich-Sprachmodelle, der Reihe nach: Lehnt der Anbieter die Sitzung wegen eines Limits ab, wird mit dem nächsten aufgebaut */
  modelFallbacks?: string[];
  /** Ausweich-Textmodelle, der Reihe nach: Meldet das Textmodell ein Limit oder eine Überlastung, antwortet das nächste */
  textFallbacks?: string[];
}

/** Höchstens so viele Verbindungen (die Oberfläche bleibt übersichtlich, die .env auch) */
export const MAX_CONNECTIONS = 12;

const ID = /^[a-z0-9]{1,16}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Variable der .env, in der der Schlüssel einer Verbindung liegt. Die mitgelieferten Verbindungen behalten die
 * bekannten Namen (OPENAI_API_KEY, GEMINI_API_KEY); jede weitere bekommt AI_KEY_<KENNUNG>.
 */
export function connectionKeyEnv(c: Pick<AiConnection, 'id' | 'provider'>): string {
  const provider = knownProvider(c.id);
  if (provider && provider.id === c.provider) return provider.keyEnv;
  return `AI_KEY_${c.id.toUpperCase()}`;
}

/** Schlüssel einer Verbindung aus der Umgebung; undefined = noch nicht hinterlegt. */
export function connectionKey(c: Pick<AiConnection, 'id' | 'provider'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[connectionKeyEnv(c)]?.trim() || undefined;
}

function clean(raw: unknown): AiConnection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim();
  const provider = knownProvider(r.provider);
  if (!ID.test(id) || !provider) return undefined;
  const model = (v: unknown) => {
    const m = String(v ?? '').trim();
    return MODEL_ID.test(m) && provider.ownsModel(m) ? m : '';
  };
  const name = String(r.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || provider.label;
  const voice = String(r.voice ?? '').trim();
  // Ausweichmodelle: gültige Modelle des Anbieters, jedes einmal; fehlt die Liste oder ist sie leer, gibt es das Feld nicht
  const fallbacks = (v: unknown) => {
    const list = [...new Set((Array.isArray(v) ? v : []).map(model).filter(Boolean))].slice(0, MAX_FALLBACKS);
    return list.length ? list : undefined;
  };
  const modelFallbacks = fallbacks(r.modelFallbacks);
  const textFallbacks = fallbacks(r.textFallbacks);
  return {
    id, name, provider: provider.id, model: model(r.model), textModel: model(r.textModel), voice: provider.voices.includes(voice) ? voice : '',
    ...(modelFallbacks ? { modelFallbacks } : {}),
    ...(textFallbacks ? { textFallbacks } : {}),
  };
}

/** Gespeicherte Liste lesen; ungültige und doppelte Einträge entfallen. */
export function parseConnections(json: string | undefined): AiConnection[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: AiConnection[] = [];
  for (const raw of arr) {
    const c = clean(raw);
    if (c && !out.some((x) => x.id === c.id) && out.length < MAX_CONNECTIONS) out.push(c);
  }
  return out;
}

export interface ConnectionSettings {
  aiConnections?: string;
  aiConnection?: string;
  /** Vor den Verbindungen: gewählter Anbieter und seine Modelle */
  aiProvider?: string;
  model?: string;
  summaryModel?: string;
}

/**
 * Verbindungen und die aktive davon. Ist noch keine Liste gespeichert, gibt es je Anbieter eine Verbindung mit
 * dessen Namen; die bisherigen Einstellungen (gewählter Anbieter, Modelle) gehen darin auf.
 */
export function connectionsFrom(s: ConnectionSettings, env: NodeJS.ProcessEnv = process.env): { list: AiConnection[]; active: AiConnection } {
  let list = parseConnections(s.aiConnections);
  if (!list.length) {
    const chosen = providerById(s.aiProvider);
    list = (['openai', 'gemini'] as const).map((id) => {
      const p = providerById(id);
      // Die alten Modell-Einstellungen gehörten zum damals gewählten Anbieter. Was nur die Vorgabe wiederholt, bleibt leer:
      // So folgt die Verbindung weiter der Vorgabe (.env bzw. Anbieter), statt sie beim ersten Speichern festzuschreiben.
      const own = (m: string | undefined, ...defaults: (string | undefined)[]) => {
        const v = (m ?? '').trim();
        return p.id === chosen.id && MODEL_ID.test(v) && p.ownsModel(v) && !defaults.some((d) => d?.trim() === v) ? v : '';
      };
      const prefix = id === 'openai' ? 'OPENAI' : 'GEMINI';
      return { id, name: p.label, provider: p.id, model: own(s.model, p.defaults.realtime, env[`${prefix}_MODEL`]), textModel: own(s.summaryModel, p.defaults.text, env[`${prefix}_SUMMARY_MODEL`]), voice: '' };
    });
  }
  const wanted = (s.aiConnection ?? '').trim();
  const active = list.find((c) => c.id === wanted) ?? (wanted ? undefined : list.find((c) => c.id === providerById(s.aiProvider).id)) ?? list[0];
  return { list, active };
}

/**
 * Einträge aus der Oberfläche prüfen und aufbereiten: vorhandene Kennungen bleiben, neue Einträge (ohne oder mit
 * unbekannter Kennung) bekommen eine. Wirft mit Meldung bei ungültigen Angaben.
 */
export function cleanConnections(input: unknown, current: readonly AiConnection[], newId: () => string = () => Math.random().toString(36).slice(2, 8)): AiConnection[] {
  if (!Array.isArray(input)) throw new Error('Liste der Verbindungen erwartet');
  if (input.length > MAX_CONNECTIONS) throw new Error(`Höchstens ${MAX_CONNECTIONS} Verbindungen`);
  const out: AiConnection[] = [];
  for (const raw of input) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const known = current.find((c) => c.id === r.id);
    let id = known ? known.id : '';
    for (let i = 0; !id && i < 50; i++) {
      const candidate = `c${newId()}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
      // Nie eine Kennung vergeben, die schon benutzt wird; das „c“ davor hält sie von den Kennungen der Anbieter fern
      if (ID.test(candidate) && ![...current, ...out].some((c) => c.id === candidate)) id = candidate;
    }
    if (!knownProvider(r.provider)) throw new Error('Unbekannter KI-Anbieter');
    // Der Anbieter einer Verbindung steht fest: Sonst ginge ihr gespeicherter Schlüssel an einen anderen Anbieter
    if (known && known.provider !== r.provider) throw new Error('Der Anbieter einer Verbindung lässt sich nicht ändern – leg dafür eine neue Verbindung an.');
    // Ein Fenster aus der Zeit vor der Standardstimme schickt keine: Dann bleibt die gespeicherte
    // Ebenso die Ausweichmodelle: Ein Fenster, das sie nicht kennt, löscht sie nicht
    const keep = (field: 'modelFallbacks' | 'textFallbacks') => (r[field] === undefined && known ? known[field] : r[field]);
    const c = clean({ ...r, id, voice: r.voice === undefined && known ? known.voice : r.voice, modelFallbacks: keep('modelFallbacks'), textFallbacks: keep('textFallbacks') });
    if (!c) throw new Error('Ungültige Verbindung');
    if (!String(r.name ?? '').trim()) throw new Error('Jede Verbindung braucht einen Namen');
    if (out.some((x) => x.id === c.id)) throw new Error('Verbindung doppelt in der Liste');
    out.push(c);
  }
  return out;
}

/**
 * Änderungen in die gespeicherte Liste einarbeiten: genannte Verbindungen werden ersetzt, neue angehängt, entfernt
 * wird nur, was ausdrücklich in `remove` steht. Ein veraltetes Fenster, das eine Verbindung noch nicht kennt, kann
 * sie so nicht versehentlich löschen. Wirft mit Meldung, wenn keine Verbindung übrig bliebe oder es zu viele würden.
 */
export function mergeConnections(current: readonly AiConnection[], changes: unknown, remove: unknown, newId?: () => string): { next: AiConnection[]; removed: AiConnection[] } {
  const cleaned = cleanConnections(changes ?? [], current, newId);
  const gone = Array.isArray(remove) ? remove.map(String) : [];
  const removed = current.filter((c) => gone.includes(c.id));
  const next = [
    ...current.filter((c) => !gone.includes(c.id)).map((c) => cleaned.find((x) => x.id === c.id) ?? c),
    ...cleaned.filter((x) => !current.some((c) => c.id === x.id)),
  ];
  if (!next.length) throw new Error('Mindestens eine Verbindung muss bleiben');
  if (next.length > MAX_CONNECTIONS) throw new Error(`Höchstens ${MAX_CONNECTIONS} Verbindungen`);
  return { next, removed };
}

/**
 * Stimme für ein Gespräch: der erste Wunsch, der eine Stimme des Anbieters ist, sonst dessen erste Stimme.
 * Stimmen gehören zum Anbieter; ein Wunsch des anderen Anbieters (Kontakt, Profil, alte Einstellung) zählt nicht.
 */
export function pickVoice(voices: readonly string[], ...wishes: (string | undefined)[]): string {
  for (const w of wishes) {
    const v = (w ?? '').trim();
    if (v && voices.includes(v)) return v;
  }
  return voices[0] ?? '';
}

/**
 * Standardstimme einer Verbindung: ihre eigene; ist keine gewählt, die Stimme aus der Zeit vor den Verbindungen
 * (Einstellung „voice“ bzw. AI_VOICE), sofern sie zum Anbieter gehört; sonst die erste Stimme des Anbieters.
 */
export function connectionVoice(c: Pick<AiConnection, 'provider' | 'voice'>, legacyVoice?: string): string {
  return pickVoice(providerById(c.provider).voices, c.voice, legacyVoice);
}

/**
 * Rangfolge der Stimme für ein Gespräch (jeweils nur, wenn die Stimme zum Anbieter der Verbindung gehört):
 * 1. Stimme der Spam-Rolle, wenn die Rolle ab Annahme feststeht
 * 2. Stimme, die der Anruf selbst nennt (Dashboard, API, MCP); ohne Angabe die des Kontakts (ausgehend) bzw.
 *    des Profils der eigenen Rufnummer (eingehend) – der Aufrufer reicht sie als `call` herein
 * 3. Standardstimme der Verbindung (connectionVoice)
 */
export function callVoice(c: Pick<AiConnection, 'provider' | 'voice'>, o: { scam?: string; call?: string; legacy?: string }): string {
  return pickVoice(providerById(c.provider).voices, o.scam, o.call, connectionVoice(c, o.legacy));
}
