import { existsSync } from 'node:fs';
import { isOn } from './fsutil.js';
import { DEFAULT_WEB_PORT } from './webPort.js';

export interface Config {
  sipServer: string;
  sipUser: string;
  sipPassword: string;
  sipLocalPort: number;
  rtpPort: number;
  localIp?: string;
  openaiApiKey?: string;
  openaiModel: string;
  openaiSummaryModel: string;
  /** Nummern des Auftraggebers: dort stellt sich die KI nur als „Agent" vor */
  ownerNumbers: string[];
  /** Nur noch für Simulator und test-call; die App nimmt das Limit aus den Einstellungen */
  maxCallSeconds: number;
  liveListenEnabled: boolean;
  /** 16-kHz-G.711 (HD) mit der FRITZ!Box aushandeln */
  hdAudio: boolean;
  webPort: number;
  sipDebug: boolean;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Konfiguration fehlt: ${name} (siehe .env.example)`);
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(env(name, String(fallback)), 10);
  if (Number.isNaN(value)) throw new Error(`Konfiguration ${name} ist keine Zahl`);
  return value;
}

function envBool(name: string, fallback: boolean): boolean {
  return isOn(env(name, String(fallback)));
}

export function loadConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');
  return {
    sipServer: env('SIP_SERVER', 'fritz.box'),
    // Dürfen fehlen: Dann startet die App ohne Telefonanlage und der Einrichtungsassistent fragt danach
    sipUser: env('SIP_USER', ''),
    sipPassword: env('SIP_PASSWORD', ''),
    sipLocalPort: envInt('SIP_LOCAL_PORT', 5062),
    rtpPort: envInt('RTP_PORT', 40000),
    localIp: env('LOCAL_IP', '') || undefined,
    openaiApiKey: env('OPENAI_API_KEY', '') || undefined,
    openaiModel: env('OPENAI_MODEL', 'gpt-realtime-2.1'),
    openaiSummaryModel: env('OPENAI_SUMMARY_MODEL', 'gpt-6-luna'),
    ownerNumbers: env('OWNER_NUMBERS', '').split(',').map((n) => n.trim()).filter(Boolean),
    maxCallSeconds: envInt('MAX_CALL_SECONDS', 300),
    liveListenEnabled: envBool('LIVE_LISTEN_ENABLED', true),
    hdAudio: envBool('AUDIO_HD', true),
    webPort: envInt('WEB_PORT', DEFAULT_WEB_PORT),
    sipDebug: envBool('SIP_DEBUG', false),
  };
}
