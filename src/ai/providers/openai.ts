// OpenAI als Anbieter: Realtime-API für das Gespräch, Responses-API für Text, Sprachausgabe für die Hörprobe.
// Der Schlüssel geht nur an api.openai.com und steht in keiner Meldung.
import { fetchModels } from '../models.js';
import { VOICES } from '../personas.js';
import { responsesText } from '../summary.js';
import { OpenAiLive } from './openaiLive.js';
import type { AiProvider, CheckResult } from './types.js';

const TTS_MODEL = 'gpt-4o-mini-tts';
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

/** Form eines OpenAI-Schlüssels grob prüfen (keine Leerzeichen, plausibel lang); wirft mit Meldung. */
export function cleanOpenAiKey(input: unknown): string {
  const key = String(input ?? '').trim();
  if (!key) throw new Error('Schlüssel fehlt');
  // Ein Schlüssel des anderen Anbieters ginge sonst zur Prüfung an den falschen
  if (/^AIza/.test(key)) throw new Error('Das ist ein Schlüssel von Google, kein OpenAI-Schlüssel. Er gehört in eine Verbindung mit Google Gemini.');
  if (/\s/.test(key) || key.length < 20 || key.length > 400) throw new Error('Das sieht nicht nach einem OpenAI-Schlüssel aus (beginnt meist mit „sk-“, ohne Leerzeichen)');
  return key;
}

/** Schlüssel bei OpenAI prüfen: Liste der Modelle abrufen. Der Schlüssel geht nur an api.openai.com. */
export async function checkOpenAiKey(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<CheckResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'OpenAI hat den Schlüssel abgelehnt – bitte neu kopieren.' };
    if (res.status === 429) return { ok: false, error: 'OpenAI meldet ein erschöpftes Kontingent oder zu viele Anfragen – Guthaben im OpenAI-Konto prüfen.' };
    return { ok: false, error: `OpenAI antwortete mit Status ${res.status}.` };
  } catch {
    return { ok: false, error: 'OpenAI ist nicht erreichbar – besteht eine Internetverbindung?' };
  } finally {
    clearTimeout(timer);
  }
}

export const openai: AiProvider = {
  id: 'openai',
  label: 'OpenAI',
  keyEnv: 'OPENAI_API_KEY',
  keyUrl: 'https://platform.openai.com/api-keys',
  voices: VOICES,
  maleVoices: ['cedar', 'ash', 'ballad', 'echo', 'verse'],
  defaults: { realtime: 'gpt-realtime-2.1', text: 'gpt-6-luna', known: ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'] },
  supports: { speechSpeed: true, maxOutputTokens: true, updateInstructions: true },
  sampleModel: TTS_MODEL,
  ownsModel: (id) => !/^(models\/)?gemini-/i.test(id),
  cleanKey: cleanOpenAiKey,
  checkKey: (key, fetchImpl) => checkOpenAiKey(key, fetchImpl),
  fetchModels: (key, fetchImpl) => fetchModels(key, fetchImpl),
  text: (key, model, prompt, maxOutputTokens, format, fetchImpl) => responsesText(key, model, prompt, maxOutputTokens, format, fetchImpl),
  createLive: (config, events) => new OpenAiLive(config, events),
  async voiceSample(key, voice, text, fetchImpl = fetch) {
    const res = await fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`Hörprobe fehlgeschlagen: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { data: Buffer.from(await res.arrayBuffer()), ext: 'mp3', mime: 'audio/mpeg' };
  },
  async transcribe(key, wav, _textModel, fetchImpl = fetch) {
    const form = new FormData();
    form.append('model', TRANSCRIBE_MODEL);
    form.append('language', 'de');
    form.append('response_format', 'json');
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'auftrag.wav');
    const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    // Die Antwort von OpenAI enthält bei einem falschen Schlüssel Teile davon: nicht weiterreichen, nur den Status übersetzen
    if (!res.ok) {
      if (res.status === 401) throw new Error('OpenAI hat den Schlüssel abgelehnt – bitte unter Einstellungen › KI-Verbindungen neu eintragen.');
      if (res.status === 429) throw new Error('OpenAI meldet ein erschöpftes Kontingent oder zu viele Anfragen – Guthaben im OpenAI-Konto prüfen.');
      throw new Error(`Die Spracherkennung von OpenAI antwortete mit Status ${res.status}.`);
    }
    const data = (await res.json()) as { text?: unknown };
    return typeof data.text === 'string' ? data.text.trim() : '';
  },
};
