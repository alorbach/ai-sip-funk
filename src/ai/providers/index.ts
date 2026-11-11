// Die KI-Anbieter, zwischen denen die Einstellungen wählen, und was aus Einstellungen und .env für ein Gespräch folgt.
import { gemini } from './gemini.js';
import { openai } from './openai.js';
import { connectionKey, connectionsFrom, type AiConnection, type ConnectionSettings } from '../connections.js';
import type { AiProvider, ProviderId, TextModel } from './types.js';

export const PROVIDERS: Record<ProviderId, AiProvider> = { openai, gemini };

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Anbieter zur Kennung, nur für echte Einträge: „constructor“ und Ähnliches aus einer Anfrage sind kein Anbieter. */
export function knownProvider(id: unknown): AiProvider | undefined {
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id as ProviderId] : undefined;
}

/** Anbieter zur Kennung; unbekannt oder leer = OpenAI. */
export function providerById(id: string | undefined): AiProvider {
  return knownProvider(id) ?? openai;
}

/** Modell-IDs, wie sie in einer Adresse stehen dürfen (dieselbe Regel wie beim Speichern) */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Variablen der .env je Anbieter: Schlüssel und Vorgaben für die Modelle */
const ENV_MODELS: Record<ProviderId, { realtime: string; text: string }> = {
  openai: { realtime: 'OPENAI_MODEL', text: 'OPENAI_SUMMARY_MODEL' },
  gemini: { realtime: 'GEMINI_MODEL', text: 'GEMINI_SUMMARY_MODEL' },
};

export interface ActiveAi {
  /** Die Verbindung, um die es geht (ohne Angabe: die aktive) */
  connection: AiConnection;
  provider: AiProvider;
  /** Schlüssel der Verbindung aus der .env; undefined = noch nicht hinterlegt */
  key?: string;
  /** Vorgaben, wenn an der Verbindung nichts (Passendes) eingestellt ist */
  defaultRealtime: string;
  defaultText: string;
  /** Sprachmodell für einen Anruf: der gewünschte Wert, sofern er zum Anbieter gehört, sonst das Modell der Verbindung */
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

/**
 * Die aktive KI-Verbindung (oder die mit der genannten Kennung) samt Anbieter, Schlüssel und Modellen.
 * Modelle eines anderen Anbieters gelten nicht; dann greift die Vorgabe (.env bzw. Anbieter).
 */
export function resolveAi(s: ConnectionSettings, env: NodeJS.ProcessEnv = process.env, connectionId?: string): ActiveAi {
  const { list, active } = connectionsFrom(s);
  const connection = (connectionId !== undefined && list.find((c) => c.id === connectionId)) || active;
  const provider = providerById(connection.provider);
  const key = connectionKey(connection, env);
  const own = (value: string | undefined, fallback: string) => {
    const v = (value ?? '').trim();
    return MODEL_ID.test(v) && provider.ownsModel(v) ? v : fallback;
  };
  const defaultRealtime = own(env[ENV_MODELS[provider.id].realtime], provider.defaults.realtime);
  const defaultText = own(env[ENV_MODELS[provider.id].text], provider.defaults.text);
  const realtime = own(connection.model, defaultRealtime);
  const textModel = own(connection.textModel, defaultText);
  return {
    connection,
    provider,
    key,
    defaultRealtime,
    defaultText,
    realtimeModel: (value) => own(value, realtime),
    textModel,
    ask: (prompt, maxOutputTokens, format) => {
      if (!key) return Promise.reject(new Error(`Der ${provider.label}-Schlüssel fehlt noch (Einstellungen › KI-Verbindungen)`));
      return provider.text(key, textModel, prompt, maxOutputTokens, format);
    },
    callLimit: (seconds) => (provider.maxCallSeconds ? Math.min(seconds, provider.maxCallSeconds) : seconds),
  };
}
