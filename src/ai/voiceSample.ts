// Hörprobe einer Stimme über die OpenAI-Sprachausgabe (gpt-4o-mini-tts, dieselben Stimmen wie Realtime).
// Ergebnis wird je Stimme und Text im Datenordner gecacht, damit die Probe nur einmal Geld kostet.
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TTS_MODEL = 'gpt-4o-mini-tts';

export function sampleText(aiName: string, principalName: string): string {
  return `Hallo? Hier ist ${aiName}, der Telefonassistent von ${principalName}. ${principalName} ist gerade nicht da – worum geht es denn?`;
}

export async function voiceSample(apiKey: string, voice: string, text: string, cacheDir: string): Promise<Buffer> {
  const hash = createHash('sha1').update(`${TTS_MODEL}\n${text}`).digest('hex').slice(0, 8);
  const file = join(cacheDir, `${voice}-${hash}.mp3`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`Hörprobe fehlgeschlagen: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, buf);
  return buf;
}
