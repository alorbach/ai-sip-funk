// Grobe Kostenschätzung aus den Usage-Angaben. Preise USD je 1M Token, Stand 06.11.2026,
// laut https://developers.openai.com/api/docs/pricing – bei Änderungen hier anpassen.
import type { Usage } from './realtimeBridge.js';

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
};
const FALLBACK: Price = { audioIn: 32, audioOut: 64, textIn: 4, textOut: 16 };

/** Modelle, die laut dieser Tabelle weniger kosten als das Standardmodell (Kennzeichnung „günstig“ in der Auswahl) */
export const BUDGET_MODELS = Object.keys(PRICES).filter((id) => PRICES[id].audioOut < FALLBACK.audioOut);

/** Schätzung ohne Transkription und ohne gecachte Rabatte – eher etwas zu hoch als zu niedrig. */
export function estimateCostUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? FALLBACK;
  return (u.inputAudioTokens * p.audioIn + u.outputAudioTokens * p.audioOut + u.inputTextTokens * p.textIn + u.outputTextTokens * p.textOut) / 1e6;
}
