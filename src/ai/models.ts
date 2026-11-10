// Modelle zur Auswahl: Die Liste kommt zur Laufzeit von OpenAI (GET /v1/models) und wird hier nach
// Verwendung getrennt (Sprachmodell für Anrufe, Textmodell). OpenAI liefert je Modell nur ID, Erstelldatum
// und Besitzer, keine Fähigkeiten: Die Trennung geht deshalb über den Namen. Was der Filter nicht kennt,
// lässt sich in der Oberfläche weiterhin als eigene Modell-ID eintragen.
// Der Schlüssel geht nur an api.openai.com und steht in keiner Meldung.

export interface ModelEntry {
  id: string;
  /** Fest datierte Version (z. B. …-2026-08-28) statt des laufend gepflegten Namens */
  snapshot: boolean;
}

export interface ModelLists {
  realtime: ModelEntry[];
  text: ModelEntry[];
}

export interface ModelCatalogState extends ModelLists {
  /** Zeitpunkt des letzten gelungenen Abrufs (ISO), null = noch nie geladen */
  fetchedAt: string | null;
  /** Meldung, wenn der letzte Abruf scheiterte; die Listen zeigen dann den letzten bekannten Stand */
  error?: string;
}

interface ApiModel {
  id?: unknown;
  created?: unknown;
}

/** Nichts für ein Telefongespräch: Realtime-Varianten, die nur transkribieren oder übersetzen */
const NOT_A_VOICE_MODEL = /transcri|translat|whisper|tts/;
/** Chat-Modelle von OpenAI (auch eigene Feinabstimmungen, „ft:…“) */
const TEXT_FAMILY = /^(ft:)?(gpt-|chatgpt-|o\d)/;
/** Kein allgemeines Textmodell: Sprache/Audio, Bild, Video, Suche, Einbettung, Moderation, Spezialmodelle */
const NOT_A_TEXT_MODEL = /realtime|audio|transcri|whisper|tts|image|dall-e|sora|embedding|moderation|search|instruct|codex|computer-use|deep-research/;
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

/**
 * Rohliste von OpenAI nach Verwendung trennen und ordnen: zuerst die laufend gepflegten Namen, dann die fest
 * datierten Versionen; innerhalb beider Gruppen das neueste Modell zuerst, bei gleichem Datum nach Name.
 */
export function classifyModels(data: readonly ApiModel[]): ModelLists {
  const seen = new Map<string, number>();
  for (const m of data) {
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    // Dieselbe Regel wie beim Speichern einer Modell-ID: nichts, was die Adresse der Verbindung verändern könnte
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id) || seen.has(id)) continue;
    seen.set(id, typeof m.created === 'number' && Number.isFinite(m.created) ? m.created : 0);
  }
  const order = (ids: string[]): ModelEntry[] =>
    ids
      .map((id) => ({ id, snapshot: SNAPSHOT.test(id) }))
      .sort((a, b) => Number(a.snapshot) - Number(b.snapshot) || seen.get(b.id)! - seen.get(a.id)! || a.id.localeCompare(b.id, 'en'));
  const ids = [...seen.keys()];
  return {
    realtime: order(ids.filter((id) => id.toLowerCase().includes('realtime') && !NOT_A_VOICE_MODEL.test(id.toLowerCase()))),
    text: order(ids.filter((id) => TEXT_FAMILY.test(id.toLowerCase()) && !NOT_A_TEXT_MODEL.test(id.toLowerCase()))),
  };
}

/** Modell-Liste bei OpenAI abrufen; wirft mit einer Meldung, die man der Oberfläche zeigen kann (ohne Schlüssel). */
export async function fetchModels(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<ModelLists> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  let body: unknown;
  try {
    res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    body = res.ok ? await res.json() : undefined;
  } catch {
    // Die ursprüngliche Meldung bewusst nicht weiterreichen: Sie könnte Teile der Anfrage enthalten
    throw new Error('OpenAI ist nicht erreichbar – besteht eine Internetverbindung?');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new Error('OpenAI hat den Schlüssel abgelehnt – bitte neu kopieren.');
  if (res.status === 429) throw new Error('OpenAI meldet ein erschöpftes Kontingent oder zu viele Anfragen – Guthaben im OpenAI-Konto prüfen.');
  if (!res.ok) throw new Error(`OpenAI antwortete mit Status ${res.status}.`);
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('OpenAI lieferte keine Modell-Liste.');
  return classifyModels(data as ApiModel[]);
}

/**
 * Zwischenspeicher der Modell-Liste im Arbeitsspeicher: höchstens ein Abruf je `ttlMs`, außer er wird ausdrücklich
 * verlangt („Aktualisieren“). Scheitert ein Abruf, bleibt der letzte bekannte Stand erhalten und die Meldung steht dabei.
 */
export class ModelCatalog {
  private lists: ModelLists = { realtime: [], text: [] };
  private fetchedAt = 0;
  private running?: Promise<ModelCatalogState>;

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private state(error?: string): ModelCatalogState {
    return { ...this.lists, fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null, ...(error ? { error } : {}) };
  }

  /** Nach einem neuen Schlüssel: Die Liste gehört zum alten Konto */
  clear(): void {
    this.lists = { realtime: [], text: [] };
    this.fetchedAt = 0;
  }

  get(force = false): Promise<ModelCatalogState> {
    if (!force && this.fetchedAt && this.now() - this.fetchedAt < this.ttlMs) return Promise.resolve(this.state());
    // Gleichzeitige Anfragen (zwei Fenster, Doppelklick) teilen sich einen Abruf
    this.running ??= this.load().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async load(): Promise<ModelCatalogState> {
    const key = this.apiKey();
    if (!key) return this.state('Der OpenAI-Schlüssel fehlt noch (Einstellungen › Einrichtungsassistent).');
    try {
      const lists = await fetchModels(key, this.fetchImpl);
      // Ein inzwischen ausgetauschter Schlüssel hat den Speicher geleert: das Ergebnis des alten nicht mehr übernehmen
      if (this.apiKey() !== key) return this.state();
      this.lists = lists;
      this.fetchedAt = this.now();
      return this.state();
    } catch (err) {
      return this.state((err as Error).message);
    }
  }
}
