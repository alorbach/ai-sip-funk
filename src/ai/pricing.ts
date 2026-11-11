// Grobe Kostenschätzung aus den Usage-Angaben. Preise USD je 1M Token, Stand 06.11.2026,
// laut https://developers.openai.com/api/docs/pricing; Gemini (bezahlte Stufe) Stand 11.11.2026 laut
// https://aistudio.google.com/docs/pricing – bei Änderungen hier anpassen.
import type { Usage } from './providers/types.js';

interface Price {
  audioIn: number;
  audioOut: number;
  textIn: number;
  textOut: number;
}

const PRICES: Record<string, Price> = {
  'gpt-realtime-2.1-mini': { audioIn: 10, audioOut: 20, textIn: 0.6, textOut: 2.4 },
  'gpt-realtime-mini': { audioIn: 10, audioOut: 20, textIn: 0.6, textOut: 2.4 },
  'gpt-realtime-2.1': { audioIn: 32, audioOut: 64, textIn: 4, textOut: 16 },
  'gpt-realtime': { audioIn: 32, audioOut: 64, textIn: 4, textOut: 16 },
  'gemini-3.8-live': { audioIn: 3, audioOut: 12, textIn: 0.75, textOut: 4.5 },
};
const FALLBACK: Price = { audioIn: 32, audioOut: 64, textIn: 4, textOut: 16 };
/** Unbekannte Gemini-Modelle: Preis des Standard-Sprachmodells */
const GEMINI_FALLBACK: Price = PRICES['gemini-3.8-live'];

/** Modelle, die laut dieser Tabelle weniger kosten als das Standardmodell (Kennzeichnung „günstig“ in der Auswahl) */
export const BUDGET_MODELS = Object.keys(PRICES).filter((id) => !id.startsWith('gemini-') && PRICES[id].audioOut < FALLBACK.audioOut);

/**
 * Schätzung ohne Transkription und ohne gecachte Rabatte – eher etwas zu hoch als zu niedrig. Bei Gemini gilt der
 * Preis der bezahlten Stufe, auch wenn das Gespräch über das kostenlose Kontingent lief.
 */
export function estimateCostUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? (model.startsWith('gemini-') ? GEMINI_FALLBACK : FALLBACK);
  return (u.inputAudioTokens * p.audioIn + u.outputAudioTokens * p.audioOut + u.inputTextTokens * p.textIn + u.outputTextTokens * p.textOut) / 1e6;
}
