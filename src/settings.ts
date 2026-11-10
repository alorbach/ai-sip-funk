// Formular-Standardwerte: .env liefert die Basis, settings.json (per UI gespeichert) überschreibt sie.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_MAIL_BODY, DEFAULT_MAIL_SUBJECT } from './notify/mailFormat.js';

export interface FormSettings {
  mode: string;
  task: string;
  persona: string;
  voice: string;
  address: string; // 'sie' | 'du'
  aiName: string;
  principal: string;
  personaExtra: string;
  model: string; // Realtime-Modell, leer = OPENAI_MODEL aus der .env
  /** Anrufbeantworter: 'on' | 'off' (Default aus) */
  incoming: string;
  /** Annahme beim n-ten Klingeln */
  incomingRings: string;
  /** Auftrag der KI bei eingehenden Anrufen; leer = eingebauter Anrufbeantworter-Text */
  incomingTask: string;
  /** Alt: Meldung je gewählter eigener Nummer, eine Zeile je Nummer: „23125100 = Max Mustermann" (wird in incomingProfiles übernommen) */
  incomingIdentities: string;
  /** Profile je gewählter eigener Nummer als JSON-Liste (siehe IncomingProfile) */
  incomingProfiles: string;
  /** Nach einem angenommenen Anruf: Hinweis im Tray ('on'|'off') */
  notifyTray: string;
  /** Nach einem angenommenen Anruf: E-Mail mit Zusammenfassung ('on'|'off') */
  notifyEmail: string;
  /** Bei wichtigen Anrufen: Inhaber auf der Handynummer anrufen ('on'|'off') */
  notifyCall: string;
  /** Spam-Abwehr (Scam-Modus): 'on' | 'off'. Wirkt nur mit scamAccepted (siehe scamActive) */
  scamMode: string;
  /** Zeitpunkt (ISO), zu dem der Inhaber das rechtliche Risiko in der UI bestätigt hat; leer = nicht bestätigt */
  scamAccepted: string;
  /** 'abwimmeln' | 'beschaeftigen' */
  scamStyle: string;
  /** Zeitlimit des Hinhaltens in Minuten */
  scamMaxMinutes: string;
  /** Spam-Nummern/Vorwahlen, eine je Zeile; „anonym" = unterdrückte Nummern */
  scamNumbers: string;
  /** Erfundener Name der Spam-Rolle; leer = nennt keinen Namen */
  scamName: string;
  /** Stimme der Spam-Rolle; leer = Stimme des Assistenten. Gilt, wenn die Rolle ab Annahme feststeht */
  scamVoice: string;
  /** Sprechgeschwindigkeit der Spam-Rolle (0,25–1,5); leer = SCAM_DEFAULT_SPEED */
  scamSpeed: string;
  /** Geschlecht der Spam-Rolle: 'm' | 'w'; leer = nach der Stimme */
  scamGender: string;
  /** Eigene Anweisungen für die Spam-Rolle */
  scamExtra: string;
  /** Pop-up der Tray-App, solange ein Anruf klingelt ('on'|'off') */
  ringPopup: string;
  /** Unbekannte Anrufernummern beim Klingeln bei tellows.de nachschlagen ('on'|'off'); überträgt die Nummer dorthin */
  spamLookup: string;
  // ---- Technik (Seite „Einstellungen › Technik"; .env liefert die Basis) ----
  /** Gesprächslimit in Sekunden */
  maxCallSeconds: string;
  /** Aufbewahrung der Protokolle in Tagen */
  retentionDays: string;
  /** Stillstandswächter in ms (0 = aus) */
  stallMs: string;
  /** Stille bis Satzende (Server-VAD) in ms */
  vadSilenceMs: string;
  /** Schwelle der Spracherkennung (0,3–0,9); höher = unempfindlicher gegen Geräusche */
  vadThreshold: string;
  /** Nachhörphase nach der Verabschiedung in ms */
  hangupGraceMs: string;
  /** Wartezeit nach Abnehmen bei ausgehenden Anrufen in ms */
  greetingWaitMs: string;
  /** Sprechgeschwindigkeit 0.25–1.5 */
  speechSpeed: string;
  /** Verstärkung der KI-Stimme Richtung Telefon */
  outputGain: string;
  /** Gegenüber darf die KI unterbrechen ('on'|'off') */
  allowInterrupt: string;
  /** Textmodell für Plan, Zusammenfassung, Einschätzung, Beschwerde */
  summaryModel: string;
  // ---- E-Mail-Versand (Seite „Einstellungen › E-Mail"; .env liefert die Basis; Kennwörter liegen in settings.json) ----
  /** 'smtp' | 'gmail' | 'm365' */
  mailProvider: string;
  /** Empfänger der Benachrichtigungen; leer = Postfach */
  mailTo: string;
  /** Absender; leer = Postfach */
  mailFrom: string;
  smtpHost: string;
  smtpPort: string;
  /** 'on' = SSL/TLS (465), 'off' = STARTTLS (587) */
  smtpSecure: string;
  smtpUser: string;
  smtpPass: string;
  /** OAuth-Client (Gmail / Microsoft 365) */
  mailClientId: string;
  mailClientSecret: string;
  mailTenant: string;
  /** Postfach für OAuth */
  mailUser: string;
  /** Betreff-Vorlage der Benachrichtigungs-Mail mit Variablen wie {anrufer}; leer = Standard */
  mailSubject: string;
  /** Text-Vorlage der Benachrichtigungs-Mail; leer = Standard */
  mailBody: string;
}

/** Felder, die die API nur maskiert zurückgibt; kommt die Maske zurück, bleibt der gespeicherte Wert. */
export const SECRET_KEYS: (keyof FormSettings)[] = ['smtpPass', 'mailClientSecret'];
export const SECRET_MASK = '••••••••';

/** Mail-Vorlagen: gespeichert wird '' für „Standard“, die UI zeigt dann die eingebaute Vorlage zum Bearbeiten. */
const MAIL_TEMPLATES: [keyof FormSettings, string][] = [['mailSubject', DEFAULT_MAIL_SUBJECT], ['mailBody', DEFAULT_MAIL_BODY]];
const sameText = (a: string, b: string) => a.replace(/\r/g, '').trim() === b.trim();

/** Einstellungen für die UI: Kennwörter maskiert, leere Mail-Vorlagen durch die Standardvorlage ersetzt. */
export function publicSettings(s: FormSettings): FormSettings {
  const out = { ...s };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = SECRET_MASK;
  for (const [k, def] of MAIL_TEMPLATES) if (!out[k]?.trim()) out[k] = def;
  return out;
}

export interface MailConfig {
  provider: 'smtp' | 'gmail' | 'm365';
  to: string;
  from: string;
  smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  oauth?: { clientId: string; clientSecret?: string; tenant: string; user: string };
}

/** Mail-Konfiguration aus den Einstellungen (ersetzt die reine .env-Auswertung). */
export function mailConfigFrom(s: FormSettings): MailConfig {
  const provider = (['smtp', 'gmail', 'm365'].includes(s.mailProvider) ? s.mailProvider : 'smtp') as MailConfig['provider'];
  const user = provider === 'smtp' ? s.smtpUser.trim() : s.mailUser.trim();
  return {
    provider,
    to: s.mailTo.trim() || user,
    from: s.mailFrom.trim(),
    smtp: s.smtpHost.trim()
      ? { host: s.smtpHost.trim(), port: Number.parseInt(s.smtpPort, 10) || (s.smtpSecure === 'on' ? 465 : 587), secure: s.smtpSecure === 'on', user: s.smtpUser.trim() || undefined, pass: s.smtpPass || undefined }
      : undefined,
    oauth: s.mailClientId.trim() ? { clientId: s.mailClientId.trim(), clientSecret: s.mailClientSecret || undefined, tenant: s.mailTenant.trim() || 'common', user: s.mailUser.trim() } : undefined,
  };
}

export const SETTINGS_KEYS: (keyof FormSettings)[] = ['mode', 'task', 'persona', 'voice', 'address', 'aiName', 'principal', 'personaExtra', 'model', 'incoming', 'incomingRings', 'incomingTask', 'incomingIdentities', 'incomingProfiles', 'notifyTray', 'notifyEmail', 'notifyCall', 'scamMode', 'scamAccepted', 'scamStyle', 'scamMaxMinutes', 'scamNumbers', 'scamName', 'scamVoice', 'scamSpeed', 'scamGender', 'scamExtra', 'ringPopup', 'spamLookup', 'maxCallSeconds', 'retentionDays', 'stallMs', 'vadSilenceMs', 'vadThreshold', 'hangupGraceMs', 'greetingWaitMs', 'speechSpeed', 'outputGain', 'allowInterrupt', 'summaryModel', 'mailProvider', 'mailTo', 'mailFrom', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'mailClientId', 'mailClientSecret', 'mailTenant', 'mailUser', 'mailSubject', 'mailBody'];

/** Technische Werte, geprüft und begrenzt; gelten ab dem nächsten Anruf. */
export interface Tuning {
  maxCallSeconds: number;
  retentionDays: number;
  stallMs: number;
  vadSilenceMs: number;
  vadThreshold: number;
  hangupGraceMs: number;
  greetingWaitMs: number;
  speechSpeed: number;
  outputGain: number;
  allowInterrupt: boolean;
  summaryModel: string;
}

export function tuningFrom(s: FormSettings): Tuning {
  const int = (v: string, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const num = (v: string, fallback: number, min: number, max: number) => {
    const n = Number.parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    maxCallSeconds: int(s.maxCallSeconds, 300, 30, 3600),
    retentionDays: int(s.retentionDays, 7, 1, 3650),
    stallMs: int(s.stallMs, 6000, 0, 60000),
    vadSilenceMs: int(s.vadSilenceMs, 900, 200, 5000),
    vadThreshold: num(s.vadThreshold, 0.6, 0.3, 0.9),
    hangupGraceMs: int(s.hangupGraceMs, 2000, 0, 10000),
    greetingWaitMs: int(s.greetingWaitMs, 2500, 0, 10000),
    speechSpeed: num(s.speechSpeed, 1.05, 0.25, 1.5),
    outputGain: num(s.outputGain, 1.5, 0.2, 4),
    allowInterrupt: s.allowInterrupt !== 'off',
    summaryModel: s.summaryModel.trim() || 'gpt-6-luna',
  };
}

const SETTINGS_FILE = 'settings.json';

function envDefaults(): FormSettings {
  const e = (k: string, fallback = '') => process.env[k]?.trim() || fallback;
  return {
    mode: e('AI_DEFAULT_MODE', 'ai'),
    task: e('AI_TASK'),
    persona: e('AI_PERSONA', 'professionell'),
    voice: e('AI_VOICE', 'marin'),
    address: e('AI_ADDRESS', 'sie').toLowerCase() === 'du' ? 'du' : 'sie',
    aiName: e('AI_NAME', 'Alex'),
    principal: e('AI_PRINCIPAL'),
    personaExtra: e('AI_EXTRA'),
    model: e('OPENAI_MODEL', 'gpt-realtime-2.1'),
    incoming: ['1', 'true', 'on', 'ja'].includes(e('INCOMING_ENABLED', 'off').toLowerCase()) ? 'on' : 'off',
    incomingRings: e('INCOMING_ANSWER_AFTER_RINGS', '5'),
    incomingTask: e('INCOMING_TASK'),
    incomingIdentities: e('INCOMING_IDENTITIES').replace(/;\s*/g, '\n'),
    incomingProfiles: '',
    notifyTray: onOff(e('NOTIFY_TRAY', 'on')),
    notifyEmail: onOff(e('NOTIFY_EMAIL', 'on')),
    notifyCall: onOff(e('NOTIFY_CALL', 'on')),
    // Scam-Modus hat bewusst keinen .env-Schalter: Die Bestätigung muss in der UI erfolgen
    scamMode: 'off',
    scamAccepted: '',
    scamStyle: 'abwimmeln',
    scamMaxMinutes: '5',
    scamNumbers: e('SCAM_NUMBERS').replace(/;\s*/g, '\n'),
    scamName: '',
    scamVoice: '',
    scamSpeed: '',
    scamGender: '',
    scamExtra: '',
    ringPopup: onOff(e('RING_POPUP', 'on')),
    // Bewusst aus: die Abfrage überträgt die Anrufernummer an einen Dritten
    spamLookup: onOff(e('SPAM_LOOKUP', 'off')),
    maxCallSeconds: e('MAX_CALL_SECONDS', '300'),
    retentionDays: e('TRANSCRIPT_RETENTION_DAYS', '7'),
    stallMs: e('AI_STALL_MS', '6000'),
    vadSilenceMs: e('AI_VAD_SILENCE_MS', '900'),
    vadThreshold: e('AI_VAD_THRESHOLD', '0.6'),
    hangupGraceMs: e('AI_HANGUP_GRACE_MS', '2000'),
    greetingWaitMs: e('AI_GREETING_WAIT_MS', '2500'),
    speechSpeed: e('AI_SPEECH_SPEED', '1.05'),
    outputGain: e('AI_OUTPUT_GAIN', '1.5'),
    allowInterrupt: onOff(e('AI_ALLOW_INTERRUPT', 'on')),
    summaryModel: e('OPENAI_SUMMARY_MODEL', 'gpt-6-luna'),
    mailProvider: ['smtp', 'gmail', 'm365'].includes(e('MAIL_PROVIDER', 'smtp').toLowerCase()) ? e('MAIL_PROVIDER', 'smtp').toLowerCase() : 'smtp',
    mailTo: e('NOTIFY_EMAIL_TO'),
    mailFrom: e('MAIL_FROM') || e('SMTP_FROM'),
    smtpHost: e('SMTP_HOST'),
    smtpPort: e('SMTP_PORT', '587'),
    smtpSecure: onOff(e('SMTP_SECURE', 'off')),
    smtpUser: e('SMTP_USER'),
    smtpPass: e('SMTP_PASS'),
    mailClientId: e('MAIL_CLIENT_ID'),
    mailClientSecret: e('MAIL_CLIENT_SECRET'),
    mailTenant: e('MAIL_TENANT', 'common'),
    mailUser: e('MAIL_USER'),
    mailSubject: '',
    mailBody: '',
  };
}

const onOff = (v: string): string => (['1', 'true', 'on', 'ja'].includes(v.toLowerCase()) ? 'on' : 'off');

/** „23125100 = Max Mustermann" je Zeile -> Liste; Nummern werden auf Ziffern reduziert. */
export function parseIdentities(text: string): { number: string; name: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*([+\d\s/()-]+?)\s*[=:]\s*(.+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ number: m[1].replace(/\D/g, ''), name: m[2] }))
    .filter((e) => e.number.length > 0);
}

/** Anrufbeantworter-Profil je eigener Rufnummer: Meldung und abweichende Vorgaben für Gespräche auf dieser Nummer. */
export interface IncomingProfile {
  /** Eigene Rufnummer oder Endziffern (die Box liefert P-Called-Party-ID) */
  number: string;
  /** Meldung: „KI-Assistent von <name>" */
  name: string;
  /** Person („ist nicht da") oder Firma („dort ist gerade niemand erreichbar") */
  kind: 'person' | 'company';
  /** '' = Standard aus den Einstellungen */
  address: '' | 'sie' | 'du';
  persona: string;
  voice: string;
  /** Eigener Auftrag für Anrufe auf dieser Nummer; leer = Standard */
  task: string;
  /** Zusätzliche Hinweise zum Verhalten; leer = Standard */
  extra: string;
  /** Annahme auf dieser Nummer: '' = allgemeine Einstellung, 'on', 'off' */
  answer: '' | 'on' | 'off';
  /** Annahme beim n-ten Klingeln; '' = allgemeine Einstellung */
  rings: string;
  /** Benachrichtigungen je Kanal: '' = allgemeine Einstellung, 'off', 'important' (nur wichtige), 'all' */
  notifyTray: NotifyPolicy | '';
  notifyEmail: NotifyPolicy | '';
  notifyCall: NotifyPolicy | '';
}

/** Wann ein Kanal nach einem angenommenen Anruf meldet. */
export type NotifyPolicy = 'off' | 'important' | 'all';

/** Allgemeine Einstellung (on/off) plus Profil -> wirksame Regel je Kanal. Tray und E-Mail melden standardmäßig alle Anrufe, der Rückruf nur wichtige. */
export function notifyPolicies(s: FormSettings, profile?: IncomingProfile): { tray: NotifyPolicy; email: NotifyPolicy; call: NotifyPolicy } {
  const def = (v: string, on: NotifyPolicy): NotifyPolicy => (v === 'on' ? on : 'off');
  return {
    tray: profile?.notifyTray || def(s.notifyTray, 'all'),
    email: profile?.notifyEmail || def(s.notifyEmail, 'all'),
    call: profile?.notifyCall || def(s.notifyCall, 'important'),
  };
}

/** Abweichende Annahme-Einstellung aus dem Profil für den CallManager (undefined = allgemein). */
export function incomingOverride(profile: IncomingProfile | undefined): { enabled?: boolean; answerAfterRings?: number } | undefined {
  if (!profile) return undefined;
  const out: { enabled?: boolean; answerAfterRings?: number } = {};
  if (profile.answer === 'on') out.enabled = true;
  if (profile.answer === 'off') out.enabled = false;
  if (profile.rings) out.answerAfterRings = Number.parseInt(profile.rings, 10);
  return out;
}

/** true, wenn der Kanal bei diesem Anruf melden soll. */
export function shouldNotify(policy: NotifyPolicy, important: boolean): boolean {
  return policy === 'all' || (policy === 'important' && important);
}

/** Profile aus JSON lesen; fehlt die Liste, werden die alten „Nummer = Name"-Zeilen übernommen. */
export function parseProfiles(json: string, legacyIdentities = ''): IncomingProfile[] {
  const norm = (p: Partial<IncomingProfile>): IncomingProfile | undefined => {
    const number = String(p.number ?? '').replace(/\D/g, '');
    const name = String(p.name ?? '').trim();
    if (!number || !name) return undefined;
    return {
      number,
      name,
      kind: p.kind === 'company' ? 'company' : 'person',
      address: p.address === 'sie' || p.address === 'du' ? p.address : '',
      persona: String(p.persona ?? '').trim(),
      voice: String(p.voice ?? '').trim(),
      task: String(p.task ?? '').trim(),
      extra: String(p.extra ?? '').trim(),
      answer: p.answer === 'on' || p.answer === 'off' ? p.answer : '',
      rings: /^([1-9]|10)$/.test(String(p.rings ?? '').trim()) ? String(p.rings).trim() : '',
      notifyTray: policy(p.notifyTray),
      notifyEmail: policy(p.notifyEmail),
      notifyCall: policy(p.notifyCall),
    };
  };
  const policy = (v: unknown): NotifyPolicy | '' => (v === 'off' || v === 'important' || v === 'all' ? v : '');
  try {
    const arr = JSON.parse(json || '[]') as unknown;
    if (Array.isArray(arr)) {
      const out = arr.map((p) => norm(p as Partial<IncomingProfile>)).filter((p): p is IncomingProfile => !!p);
      if (out.length || !legacyIdentities.trim()) return out;
    }
  } catch {
    // ungültiges JSON: auf die alten Zeilen zurückfallen
  }
  return parseIdentities(legacyIdentities).map((e) => norm({ number: e.number, name: e.name })).filter((p): p is IncomingProfile => !!p);
}

/** Profil für die gewählte Nummer (Endziffern-Vergleich, längster Treffer gewinnt). */
export function profileFor(called: string, profiles: IncomingProfile[]): IncomingProfile | undefined {
  const digits = called.replace(/\D/g, '');
  if (!digits) return undefined;
  return profiles
    .filter((p) => digits.endsWith(p.number) || p.number.endsWith(digits))
    .sort((x, y) => y.number.length - x.number.length)[0];
}

/** Name, mit dem sich die KI für die gewählte Nummer meldet (Endziffern-Vergleich), sonst fallback. */
export function identityFor(called: string, identities: string, fallback: string): string {
  const digits = called.replace(/\D/g, '');
  if (!digits) return fallback;
  const hit = parseIdentities(identities)
    .filter((e) => digits.endsWith(e.number) || e.number.endsWith(digits))
    .sort((x, y) => y.number.length - x.number.length)[0];
  return hit?.name ?? fallback;
}

/** Spam-Abwehr ist nur aktiv, wenn eingeschaltet UND das Risiko bestätigt wurde. */
export function scamActive(s: FormSettings): boolean {
  return s.scamMode === 'on' && s.scamAccepted.trim().length > 0;
}

/** Tempo der Spam-Rolle, wenn nichts eingestellt ist: einen Tick langsamer als der Assistent, das wirkt beiläufiger. */
export const SCAM_DEFAULT_SPEED = 0.95;

/** Sprechgeschwindigkeit der Spam-Rolle; leer oder ungültig = fallback. */
export function scamSpeed(s: FormSettings, fallback: number): number {
  const n = Number.parseFloat(String(s.scamSpeed ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.min(1.5, Math.max(0.25, n)) : fallback;
}

/** Zeitlimit des Hinhaltens (1–15 Minuten), gedeckelt durch das globale Gesprächslimit. */
export function scamMaxSeconds(s: FormSettings, maxCallSeconds: number): number {
  const min = Math.min(15, Math.max(1, Number.parseInt(s.scamMaxMinutes, 10) || 5));
  return Math.min(min * 60, maxCallSeconds);
}

/** Aus den Formularwerten die Anrufbeantworter-Einstellung für den CallManager ableiten. */
export function incomingFrom(s: FormSettings): { enabled: boolean; answerAfterRings: number } {
  return { enabled: s.incoming === 'on', answerAfterRings: Number.parseInt(s.incomingRings, 10) || 5 };
}

export function loadSettings(): FormSettings {
  const base = envDefaults();
  if (!existsSync(SETTINGS_FILE)) return base;
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<FormSettings>;
    return { ...base, ...pick(saved) };
  } catch {
    return base;
  }
}

export function saveSettings(input: Record<string, unknown>): FormSettings {
  const current = loadSettings();
  const incoming = pick(input);
  // Maskierte Kennwörter aus der UI bedeuten „unverändert"
  for (const k of SECRET_KEYS) if (incoming[k] === SECRET_MASK) delete incoming[k];
  const merged = { ...current, ...incoming };
  // Unveränderte Standardvorlage nicht festschreiben: '' folgt späteren Änderungen der eingebauten Vorlage
  for (const [k, def] of MAIL_TEMPLATES) if (sameText(merged[k], def)) merged[k] = '';
  // Spam-Abwehr ohne bestätigtes Risiko bleibt aus, egal was das Formular schickt
  if (!merged.scamAccepted.trim()) merged.scamMode = 'off';
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

function pick(obj: Record<string, unknown>): Partial<FormSettings> {
  const out: Partial<FormSettings> = {};
  for (const k of SETTINGS_KEYS) if (typeof obj[k] === 'string') out[k] = obj[k] as string;
  return out;
}
