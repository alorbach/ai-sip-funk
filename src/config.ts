import { existsSync } from 'node:fs';

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
  aiAllowInterrupt: boolean;
  aiOutputGain: number;
  aiGreetingWaitMs: number;
  /** Sprechgeschwindigkeit der KI (OpenAI speed, 0.25–1.5) */
  aiSpeechSpeed: number;
  /** Stille in ms, nach der die Spracherkennung das Ende eines Redebeitrags annimmt */
  aiVadSilenceMs: number;
  /** Nachhörphase nach der Verabschiedung in ms */
  aiHangupGraceMs: number;
  /** Stillstandswächter: Stille nach dem Ende der KI-Ausgabe in ms, bevor die KI angestoßen wird (0 = aus) */
  aiStallMs: number;
  /** Nummern des Auftraggebers: dort stellt sich die KI nur als „Agent" vor */
  ownerNumbers: string[];
  maxCallSeconds: number;
  transcriptRetentionDays: number;
  liveListenEnabled: boolean;
  /** 16-kHz-G.711 (HD) mit der FRITZ!Box aushandeln */
  hdAudio: boolean;
  webPort: number;
  sipDebug: boolean;
  /** E-Mail-Benachrichtigung: Versandweg und Empfänger; SMTP-Daten nur beim Provider 'smtp' */
  mail: {
    provider: 'smtp' | 'gmail' | 'm365';
    to: string;
    from: string;
    smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
    /** OAuth-Client für gmail/m365 */
    oauth?: { clientId: string; clientSecret?: string; tenant: string; user: string };
  };
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
  return ['1', 'true', 'yes', 'ja'].includes(env(name, String(fallback)).toLowerCase());
}

export function loadConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');
  return {
    sipServer: env('SIP_SERVER', 'fritz.box'),
    sipUser: env('SIP_USER'),
    sipPassword: env('SIP_PASSWORD'),
    sipLocalPort: envInt('SIP_LOCAL_PORT', 5062),
    rtpPort: envInt('RTP_PORT', 40000),
    localIp: env('LOCAL_IP', '') || undefined,
    openaiApiKey: env('OPENAI_API_KEY', '') || undefined,
    openaiModel: env('OPENAI_MODEL', 'gpt-realtime-2.1'),
    openaiSummaryModel: env('OPENAI_SUMMARY_MODEL', 'gpt-6-luna'),
    aiAllowInterrupt: envBool('AI_ALLOW_INTERRUPT', true),
    aiOutputGain: Number.parseFloat(env('AI_OUTPUT_GAIN', '1.5')) || 1,
    aiGreetingWaitMs: envInt('AI_GREETING_WAIT_MS', 2500),
    aiVadSilenceMs: envInt('AI_VAD_SILENCE_MS', 900),
    aiHangupGraceMs: envInt('AI_HANGUP_GRACE_MS', 2000),
    aiStallMs: envInt('AI_STALL_MS', 6000),
    aiSpeechSpeed: Math.min(1.5, Math.max(0.25, Number.parseFloat(env('AI_SPEECH_SPEED', '1.05')) || 1)),
    ownerNumbers: env('OWNER_NUMBERS', '').split(',').map((n) => n.trim()).filter(Boolean),
    maxCallSeconds: envInt('MAX_CALL_SECONDS', 300),
    transcriptRetentionDays: envInt('TRANSCRIPT_RETENTION_DAYS', 7),
    liveListenEnabled: envBool('LIVE_LISTEN_ENABLED', true),
    hdAudio: envBool('AUDIO_HD', true),
    webPort: envInt('WEB_PORT', 8080),
    sipDebug: envBool('SIP_DEBUG', false),
    mail: {
      provider: (['smtp', 'gmail', 'm365'].includes(env('MAIL_PROVIDER', 'smtp').toLowerCase()) ? env('MAIL_PROVIDER', 'smtp').toLowerCase() : 'smtp') as 'smtp' | 'gmail' | 'm365',
      to: env('NOTIFY_EMAIL_TO', '') || env('MAIL_USER', '') || env('SMTP_USER', ''),
      from: env('MAIL_FROM', '') || env('SMTP_FROM', ''),
      smtp: env('SMTP_HOST', '')
        ? {
            host: env('SMTP_HOST', ''),
            port: envInt('SMTP_PORT', 587),
            secure: envBool('SMTP_SECURE', false),
            user: env('SMTP_USER', '') || undefined,
            pass: env('SMTP_PASS', '') || undefined,
          }
        : undefined,
      oauth: env('MAIL_CLIENT_ID', '')
        ? {
            clientId: env('MAIL_CLIENT_ID', ''),
            clientSecret: env('MAIL_CLIENT_SECRET', '') || undefined,
            tenant: env('MAIL_TENANT', 'common'),
            user: env('MAIL_USER', ''),
          }
        : undefined,
    },
  };
}
