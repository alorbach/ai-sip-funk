// Hörprobe einer Stimme über die Sprachausgabe des gewählten Anbieters.
// Ergebnis wird je Anbieter, Stimme und Text im Datenordner gecacht, damit die Probe nur einmal Geld kostet.
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiProvider, VoiceSampleAudio } from './providers/types.js';

const MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav' };

export function sampleText(aiName: string, principalName: string): string {
  return `Hallo? Hier ist ${aiName}, der Telefonassistent von ${principalName}. ${principalName} ist gerade nicht da – worum geht es denn?`;
}

export async function voiceSample(provider: AiProvider, apiKey: string, voice: string, text: string, cacheDir: string): Promise<VoiceSampleAudio> {
  const hash = createHash('sha1').update(`${provider.sampleModel}\n${text}`).digest('hex').slice(0, 8);
  const base = `${voice}-${hash}.`;
  const cached = existsSync(cacheDir) ? readdirSync(cacheDir).find((f) => f.startsWith(base) && MIME[f.slice(base.length)]) : undefined;
  if (cached) return { data: readFileSync(join(cacheDir, cached)), ext: cached.slice(base.length), mime: MIME[cached.slice(base.length)] };
  const audio = await provider.voiceSample(apiKey, voice, text);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${base}${audio.ext}`), audio.data);
  return audio;
}
