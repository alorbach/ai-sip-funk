// Google Gemini als Anbieter (Schlüssel aus Google AI Studio): Live API für das Gespräch, generateContent für Text,
// Sprachausgabe für die Hörprobe. Stand der Dokumentation: 11.11.2026 (aistudio.google.com/docs).
// Der Schlüssel geht nur an generativelanguage.googleapis.com und steht in keiner Meldung.
import type { ModelEntry, ModelLists } from '../models.js';
import { GeminiLive } from './geminiLive.js';
import type { AiProvider, CheckResult } from './types.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const LIVE_MODEL = 'gemini-3.8-live';
const TEXT_MODEL = 'gemini-3.5-flash-lite';
const TTS_MODEL = 'gemini-3.8-flash-lite-tts';

/** Stimmen der Live API (dieselben wie die Sprachausgabe) */
const VOICES = [
  'Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];
/** Stimmen, die nach einem Mann klingen (nur für die Spam-Rolle; dort lässt sich das Geschlecht auch fest einstellen) */
const MALE_VOICES = ['Puck', 'Charon', 'Fenrir', 'Orus', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Algenib', 'Rasalgethi', 'Alnilam', 'Schedar', 'Achird', 'Zubenelgenubi', 'Sadachbia', 'Sadaltager'];

export function cleanGeminiKey(input: unknown): string {
  const key = String(input ?? '').trim();
  if (!key) throw new Error('Schlüssel fehlt');
  if (/\s/.test(key) || key.length < 20 || key.length > 400) throw new Error('Das sieht nicht nach einem Schlüssel aus Google AI Studio aus (beginnt meist mit „AIza“, ohne Leerzeichen)');
  return key;
}

/** Abruf bei Google mit Zeitlimit; die ursprüngliche Fehlermeldung wird nicht weitergereicht (sie könnte Teile der Anfrage enthalten). */
async function call(fetchImpl: typeof fetch, path: string, key: string, body?: unknown, timeoutMs = 8000, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchImpl(`${API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-goog-api-key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch {
    throw new Error('Google ist nicht erreichbar – besteht eine Internetverbindung?');
  } finally {
    clearTimeout(timer);
  }
}

/** Status einer Antwort von Google in einen Satz übersetzen; undefined = in Ordnung. */
function statusError(status: number): string | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 400 || status === 401 || status === 403) return 'Google hat den Schlüssel abgelehnt – bitte neu kopieren.';
  if (status === 402) return 'Google meldet ein aufgebrauchtes Guthaben – Abrechnung in Google AI Studio prüfen.';
  if (status === 429) return 'Google meldet ein erschöpftes Kontingent oder zu viele Anfragen – Kontingent in Google AI Studio prüfen.';
  return `Google antwortete mit Status ${status}.`;
}

export async function checkGeminiKey(key: string, fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  try {
    const error = statusError((await call(fetchImpl, '/models?pageSize=1', key)).status);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

interface ApiModel {
  name?: unknown;
  supportedGenerationMethods?: unknown;
}

/** Nichts für ein Telefongespräch: Live-Varianten, die nur übersetzen oder transkribieren */
const NOT_A_VOICE_MODEL = /translat|transcri|tts|image/;
/** Kein allgemeines Textmodell */
const NOT_A_TEXT_MODEL = /live|tts|audio|image|embedding|robotics|computer-use|transcri|translat|deep-research|veo|imagen/;
const SNAPSHOT = /(-\d{3}|-\d{2}-\d{4}|-\d{4}-\d{2}-\d{2}|preview|exp)\b/;

/**
 * Rohliste von Google nach Verwendung trennen: Sprachmodelle sind die mit der Methode bidiGenerateContent oder
 * „live“ im Namen, Textmodelle die Gemini-Modelle mit generateContent. Neueste Version zuerst, Vorschau- und fest
 * datierte Versionen dahinter. Das Standard-Sprachmodell steht immer in der Liste: Ob die Liste Live-Modelle
 * überhaupt nennt, sagt die Dokumentation nicht.
 */
export function classifyGeminiModels(data: readonly ApiModel[]): ModelLists {
  const live = new Set<string>([LIVE_MODEL]);
  const text = new Set<string>();
  for (const m of data) {
    const id = typeof m?.name === 'string' ? m.name.replace(/^models\//, '').trim() : '';
    if (!/^gemini-[A-Za-z0-9._-]{1,56}$/.test(id)) continue;
    const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]).map(String) : undefined;
    if ((methods?.includes('bidiGenerateContent') || /live/.test(id)) && !NOT_A_VOICE_MODEL.test(id)) live.add(id);
    else if ((!methods || methods.includes('generateContent')) && !NOT_A_TEXT_MODEL.test(id)) text.add(id);
  }
  const order = (ids: Set<string>): ModelEntry[] =>
    [...ids]
      .map((id) => ({ id, snapshot: SNAPSHOT.test(id) }))
      .sort((a, b) => Number(a.snapshot) - Number(b.snapshot) || b.id.localeCompare(a.id, 'en', { numeric: true }));
  return { realtime: order(live), text: order(text) };
}

export async function fetchGeminiModels(key: string, fetchImpl: typeof fetch = fetch): Promise<ModelLists> {
  const res = await call(fetchImpl, '/models?pageSize=1000', key);
  const error = statusError(res.status);
  if (error) throw new Error(error);
  const models = ((await res.json().catch(() => null)) as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new Error('Google lieferte keine Modell-Liste.');
  return classifyGeminiModels(models as ApiModel[]);
}

/**
 * Textantwort über generateContent; wirft bei Fehler oder leerer Antwort. Mit `format` antwortet das Modell als JSON
 * nach dem Schema. Lehnt ein Modell die Denk-Vorgabe oder das Schema ab, wird ohne sie noch einmal gefragt.
 */
export async function geminiText(key: string, model: string, prompt: string, maxOutputTokens: number, format?: { name: string; schema: object }, fetchImpl: typeof fetch = fetch): Promise<string> {
  let thinking = true;
  let schema = Boolean(format);
  for (;;) {
    const res = await call(fetchImpl, `/models/${encodeURIComponent(model)}:generateContent`, key, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // Das Budget muss Nachdenken und Text decken
        maxOutputTokens: maxOutputTokens + 1024,
        ...(thinking ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
        ...(format ? { responseMimeType: 'application/json', ...(schema ? { responseJsonSchema: format.schema } : {}) } : {}),
      },
    }, 60_000);
    if (!res.ok) {
      const failure = (await res.text()).slice(0, 200);
      if (res.status === 400 && thinking && /thinking/i.test(failure)) { thinking = false; continue; }
      if (res.status === 400 && schema && /schema/i.test(failure)) { schema = false; continue; }
      throw new Error(`Textmodell fehlgeschlagen: ${res.status} ${failure}`);
    }
    const data = (await res.json()) as { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    if (!text.trim()) throw new Error(`Antwort leer (Status ${cand?.finishReason ?? '?'})`);
    return text.trim();
  }
}

/** PCM16 mono in einen WAV-Rahmen setzen (falls die Sprachausgabe rohes PCM liefert). */
function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export const gemini: AiProvider = {
  id: 'gemini',
  label: 'Google Gemini',
  keyEnv: 'GEMINI_API_KEY',
  keyUrl: 'https://aistudio.google.com/apikey',
  voices: VOICES,
  maleVoices: MALE_VOICES,
  defaults: { realtime: LIVE_MODEL, text: TEXT_MODEL, known: [LIVE_MODEL] },
  // Die Live API trennt eine Verbindung nach etwa zehn Minuten; eine Fortsetzung der Sitzung ist nicht eingebaut
  maxCallSeconds: 540,
  supports: { speechSpeed: false, maxOutputTokens: false, updateInstructions: false },
  sampleModel: TTS_MODEL,
  ownsModel: (id) => /^gemini-/i.test(id),
  cleanKey: cleanGeminiKey,
  checkKey: checkGeminiKey,
  fetchModels: fetchGeminiModels,
  text: geminiText,
  createLive: (config, events) => new GeminiLive(config, events),
  async voiceSample(key, voice, text, fetchImpl = fetch) {
    const res = await call(fetchImpl, '/interactions', key, {
      model: TTS_MODEL,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }, 30_000, { 'Api-Revision': '2026-05-20' });
    if (!res.ok) throw new Error(`Hörprobe fehlgeschlagen: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { steps?: { type?: string; content?: { type?: string; data?: string }[] }[] };
    const b64 = (data.steps ?? []).flatMap((s) => s.content ?? []).find((c) => c.type === 'audio' && c.data)?.data;
    if (!b64) throw new Error('Hörprobe fehlgeschlagen: Die Antwort enthielt kein Audio');
    const audio = Buffer.from(b64, 'base64');
    return { data: audio.subarray(0, 4).toString('latin1') === 'RIFF' ? audio : wav(audio, 24000), ext: 'wav', mime: 'audio/wav' };
  },
};
