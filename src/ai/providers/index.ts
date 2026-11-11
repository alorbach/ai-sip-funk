// Die KI-Anbieter, zwischen denen die Einstellungen wählen, und was aus Einstellungen und .env für ein Gespräch folgt.
import { openai } from './openai.js';
import type { AiProvider, ProviderId, TextModel } from './types.js';

export const PROVIDERS: Record<ProviderId, AiProvider> = { openai } as Record<ProviderId, AiProvider>;

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Anbieter zur Kennung; unbekannt oder leer = OpenAI. */
export function providerById(id: string | undefined): AiProvider {
  return PROVIDERS[(id ?? '') as ProviderId] ?? openai;
}

/** Modell-IDs, wie sie in einer Adresse stehen dürfen (dieselbe Regel wie beim Speichern) */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Variablen der .env je Anbieter: Schlüssel und Vorgaben für die Modelle */
const ENV_MODELS: Record<ProviderId, { realtime: string; text: string }> = {
  openai: { realtime: 'OPENAI_MODEL', text: 'OPENAI_SUMMARY_MODEL' },
  gemini: { realtime: 'GEMINI_MODEL', text: 'GEMINI_SUMMARY_MODEL' },
};

export interface ActiveAi {
  provider: AiProvider;
  /** Schlüssel des Anbieters aus der .env; undefined = noch nicht hinterlegt */
  key?: string;
  /** Vorgaben, wenn nichts (Passendes) eingestellt ist */
  defaultRealtime: string;
  defaultText: string;
  /** Sprachmodell für einen Anruf: der gewünschte Wert, sofern er zum Anbieter gehört, sonst die Vorgabe */
  realtimeModel(value?: string): string;
  textModel: string;
  /** Textmodell, gebunden an Schlüssel und Modell; wirft ohne Schlüssel */
  ask: TextModel;
  /** Gesprächslimit in Sekunden unter Beachtung der Grenze des Anbieters */
  callLimit(seconds: number): number;
}

/** Schlüssel eines Anbieters aus der Umgebung (die .env wird beim Start geladen und beim Speichern nachgeführt). */
export function providerKey(provider: AiProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[provider.keyEnv]?.trim() || undefined;
}

/** Gewählter Anbieter samt Schlüssel und Modellen. Modelle eines anderen Anbieters in den Einstellungen gelten nicht. */
export function resolveAi(s: { aiProvider?: string; model?: string; summaryModel?: string }, env: NodeJS.ProcessEnv = process.env): ActiveAi {
  const provider = providerById(s.aiProvider);
  const key = providerKey(provider, env);
  const own = (value: string | undefined, fallback: string) => {
    const v = (value ?? '').trim();
    return MODEL_ID.test(v) && provider.ownsModel(v) ? v : fallback;
  };
  const defaultRealtime = own(env[ENV_MODELS[provider.id].realtime], provider.defaults.realtime);
  const defaultText = own(env[ENV_MODELS[provider.id].text], provider.defaults.text);
  const textModel = own(s.summaryModel, defaultText);
  return {
    provider,
    key,
    defaultRealtime,
    defaultText,
    realtimeModel: (value = s.model) => own(value, defaultRealtime),
    textModel,
    ask: (prompt, maxOutputTokens, format) => {
      if (!key) return Promise.reject(new Error(`Der ${provider.label}-Schlüssel fehlt noch (Einstellungen › KI-Anbieter)`));
      return provider.text(key, textModel, prompt, maxOutputTokens, format);
    },
    callLimit: (seconds) => (provider.maxCallSeconds ? Math.min(seconds, provider.maxCallSeconds) : seconds),
  };
}
