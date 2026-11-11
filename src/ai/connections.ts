// KI-Verbindungen: benannte Zugänge zu einem KI-Anbieter, zwischen denen sich umschalten lässt. Eine Verbindung
// besteht aus Anbieter, eigenem Schlüssel und den Modellen, die mit ihr benutzt werden (Sprachmodell für Anrufe,
// Textmodell für Plan, Zusammenfassung, Einschätzung). So können z. B. zwei OpenAI-Konten oder ein günstiges und
// ein teures Modell nebeneinander stehen. Die Liste liegt in den Einstellungen (settings.json), die Schlüssel
// liegen wie alle Zugangsdaten nur in der .env.
import { knownProvider, providerById } from './providers/index.js';
import type { ProviderId } from './providers/types.js';

export interface AiConnection {
  /** Kennung (klein, a–z und Ziffern); „openai“ und „gemini“ sind die beiden mitgelieferten Verbindungen */
  id: string;
  name: string;
  provider: ProviderId;
  /** Sprachmodell für Anrufe; leer = Vorgabe des Anbieters */
  model: string;
  /** Textmodell; leer = Vorgabe des Anbieters */
  textModel: string;
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
  return { id, name, provider: provider.id, model: model(r.model), textModel: model(r.textModel) };
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
export function connectionsFrom(s: ConnectionSettings): { list: AiConnection[]; active: AiConnection } {
  let list = parseConnections(s.aiConnections);
  if (!list.length) {
    const chosen = providerById(s.aiProvider);
    list = (['openai', 'gemini'] as const).map((id) => {
      const p = providerById(id);
      // Die alten Modell-Einstellungen gehörten zum damals gewählten Anbieter
      const own = (m: string | undefined) => (p.id === chosen.id && m && MODEL_ID.test(m.trim()) && p.ownsModel(m.trim()) ? m.trim() : '');
      return { id, name: p.label, provider: p.id, model: own(s.model), textModel: own(s.summaryModel) };
    });
  }
  const wanted = (s.aiConnection ?? '').trim();
  const active = list.find((c) => c.id === wanted) ?? (wanted ? undefined : list.find((c) => c.id === providerById(s.aiProvider).id)) ?? list[0];
  return { list, active };
}

/**
 * Liste aus der Oberfläche prüfen und für das Speichern aufbereiten: vorhandene Kennungen bleiben, neue Einträge
 * (ohne oder mit unbekannter Kennung) bekommen eine. Wirft mit Meldung, wenn nichts Brauchbares übrig bleibt.
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
      // Nie eine Kennung vergeben, die schon benutzt wird oder die einem Anbieter gehört (deren Schlüssel-Variable ist vergeben)
      if (ID.test(candidate) && !knownProvider(candidate) && ![...current, ...out].some((c) => c.id === candidate)) id = candidate;
    }
    if (!knownProvider(r.provider)) throw new Error('Unbekannter KI-Anbieter');
    // Der Anbieter einer Verbindung steht fest: Sonst ginge ihr gespeicherter Schlüssel an einen anderen Anbieter
    if (known && known.provider !== r.provider) throw new Error('Der Anbieter einer Verbindung lässt sich nicht ändern – leg dafür eine neue Verbindung an.');
    const c = clean({ ...r, id });
    if (!c) throw new Error('Ungültige Verbindung');
    if (!String(r.name ?? '').trim()) throw new Error('Jede Verbindung braucht einen Namen');
    if (out.some((x) => x.id === c.id)) throw new Error('Verbindung doppelt in der Liste');
    out.push(c);
  }
  if (!out.length) throw new Error('Mindestens eine Verbindung muss bleiben');
  return out;
}
