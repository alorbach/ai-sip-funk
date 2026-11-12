// Formular-Standardwerte: .env liefert die Basis, settings.json (per UI gespeichert) überschreibt sie.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { isOn, writeFileAtomic } from './fsutil.js';
import { log } from './log.js';
import { DEFAULT_MAIL_BODY, DEFAULT_MAIL_SUBJECT } from './notify/mailFormat.js';
import type { PrincipalKind } from './ai/personas.js';
import { providerById } from './ai/providers/index.js';
import { connectionsFrom } from './ai/connections.js';
import { DEFAULT_WEB_PORT, parsePort } from './webPort.js';

export interface FormSettings {
  /** Sprache der Oberfläche: 'auto' (Sprache des Browsers) | 'de' | 'en'. Die KI spricht unabhängig davon Deutsch */
  uiLang: string;
  /** Einrichtungsassistent abgeschlossen oder übersprungen ('on'): Er öffnet sich dann nicht mehr von selbst */
  setupDone: string;
  /** Stufe der Oberfläche: 'easy' (Standard, nur das Nötige) | 'advanced' (alles). Blendet nur aus, ändert keine Werte */
  uiMode: string;
  /** KI-Anbieter für Gespräch, Textmodell und Hörprobe: 'openai' | 'gemini' */
  aiProvider: string;
  /** KI-Verbindungen als JSON-Liste (siehe ai/connections.ts); leer = je Anbieter eine */
  aiConnections: string;
  /** Kennung der aktiven KI-Verbindung; leer = die des gewählten Anbieters */
  aiConnection: string;
  mode: string;
  task: string;
  persona: string;
  /** Allgemeine Stimme aus der Zeit vor den KI-Verbindungen (Startwert AI_VOICE): gilt nur noch für Verbindungen ohne eigene Standardstimme, siehe callVoice in ai/connections.ts */
  voice: string;
  address: string; // 'sie' | 'du'
  aiName: string;
  principal: string;
  personaExtra: string;
  /** Verhalten in Stufen; '' = Standard. Antwortlänge: 'knapp' | 'ausfuehrlich' */
  behaveLength: string;
  /** Gesprächstempo: 'zuegig' | 'geduldig' */
  behavePace: string;
  /** Namen, Nummern und Termine zur Bestätigung wiederholen: 'immer' | 'selten' */
  behaveConfirm: string;
  /** Small Talk: 'nein' | 'ja' */
  behaveSmalltalk: string;
  model: string; // Sprachmodell (Liste oder eigene Modell-ID), leer oder fremder Anbieter = Vorgabe des gewählten Anbieters
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
  /** KI-Kennung der Spam-Rolle: 'on' (Standard) = sie sagt offen, dass sie eine KI ist; 'off' = sie spielt eine Privatperson, nur mit scamAccepted */
  scamDisclose: string;
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
  /** Das Textmodell entscheidet im Gespräch mit und führt im Hintergrund Regie ('on'|'off'), siehe ai/judge.ts */
  liveJudge: string;
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
  /** Port der Web-UI und der MCP-Schnittstelle auf 127.0.0.1 (1024–65535); wirkt nach einem Neustart. .env (WEB_PORT) liefert die Basis */
  webPort: string;
  // ---- MCP-Schnittstelle für KI-Agenten (Seite „Einstellungen › MCP-Schnittstelle"); bewusst ohne Schalter in der .env ----
  /** MCP-Schnittstelle: 'on' | 'off' (Standard aus). Aus = jeder Tool-Aufruf wird abgelehnt */
  mcpEnabled: string;
  /** Wen ein Agent anrufen darf: 'contacts' (nur gespeicherte Kontakte) | 'any' (jede Nummer, die der Rufzielschutz erlaubt) */
  mcpTargets: string;
  /** Bestätigung vor dem Wählen: 'always' | 'unknown' (nur Nummern ohne Kontakt) | 'never' */
  mcpConfirm: string;
  /** Höchstzahl der Anrufe eines Agenten je Stunde */
  mcpPerHour: string;
  /** Höchstzahl der Anrufe eines Agenten je Tag (24 Stunden) */
  mcpPerDay: string;
  /** Höchstdauer eines Agenten-Anrufs in Minuten (nie länger als das Gesprächslimit) */
  mcpMaxMinutes: string;
  /** Agent darf die Namen der Kontakte lesen ('on'|'off'); Nummern und Notizen bekommt er nie */
  mcpContacts: string;
  /** Protokolle für den Agenten: 'own' (nur Anrufe, die über MCP ausgelöst wurden) | 'all' */
  mcpHistory: string;
  /** Gesprächsplan des Textmodells auch bei Agenten-Anrufen: 'on' | 'off' (Vorgabe aus: Der Agent liefert den Auftrag schon ausformuliert) */
  mcpPlan: string;
}

/** Was ein KI-Agent über die MCP-Schnittstelle darf; geprüft und begrenzt. */
export interface McpPolicy {
  enabled: boolean;
  targets: 'contacts' | 'any';
  confirm: 'always' | 'unknown' | 'never';
  perHour: number;
  perDay: number;
  maxSeconds: number;
  contacts: boolean;
  history: 'own' | 'all';
  /** true = vor einem Agenten-Anruf erstellt das Textmodell einen Gesprächsplan */
  plan: boolean;
}

export function mcpPolicyFrom(s: FormSettings): McpPolicy {
  const int = (v: string, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    enabled: s.mcpEnabled === 'on',
    targets: s.mcpTargets === 'any' ? 'any' : 'contacts',
    confirm: s.mcpConfirm === 'never' ? 'never' : s.mcpConfirm === 'unknown' ? 'unknown' : 'always',
    perHour: int(s.mcpPerHour, 10, 1, 60),
    perDay: int(s.mcpPerDay, 30, 1, 500),
    maxSeconds: int(s.mcpMaxMinutes, 10, 1, 60) * 60,
    contacts: s.mcpContacts === 'on',
    history: s.mcpHistory === 'all' ? 'all' : 'own',
    plan: s.mcpPlan === 'on',
  };
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

export const SETTINGS_KEYS: (keyof FormSettings)[] = ['uiMode', 'uiLang', 'setupDone', 'aiProvider', 'aiConnections', 'aiConnection', 'mode', 'task', 'persona', 'voice', 'address', 'aiName', 'principal', 'personaExtra', 'behaveLength', 'behavePace', 'behaveConfirm', 'behaveSmalltalk', 'model', 'incoming', 'incomingRings', 'incomingTask', 'incomingIdentities', 'incomingProfiles', 'notifyTray', 'notifyEmail', 'notifyCall', 'scamMode', 'scamAccepted', 'scamStyle', 'scamMaxMinutes', 'scamNumbers', 'scamName', 'scamVoice', 'scamSpeed', 'scamGender', 'scamExtra', 'scamDisclose', 'ringPopup', 'spamLookup', 'maxCallSeconds', 'retentionDays', 'stallMs', 'vadSilenceMs', 'vadThreshold', 'hangupGraceMs', 'greetingWaitMs', 'speechSpeed', 'outputGain', 'allowInterrupt', 'liveJudge', 'summaryModel', 'mailProvider', 'mailTo', 'mailFrom', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'mailClientId', 'mailClientSecret', 'mailTenant', 'mailUser', 'mailSubject', 'mailBody', 'webPort', 'mcpEnabled', 'mcpTargets', 'mcpConfirm', 'mcpPerHour', 'mcpPerDay', 'mcpMaxMinutes', 'mcpContacts', 'mcpHistory', 'mcpPlan'];

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
  liveJudge: boolean;
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
    greetingWaitMs: int(s.greetingWaitMs, 1500, 0, 10000),
    speechSpeed: num(s.speechSpeed, 1.05, 0.25, 1.5),
    outputGain: num(s.outputGain, 1.5, 0.2, 4),
    allowInterrupt: s.allowInterrupt !== 'off',
    liveJudge: s.liveJudge !== 'off',
    summaryModel: s.summaryModel.trim() || 'gpt-6-luna',
  };
}

const SETTINGS_FILE = 'settings.json';

function envDefaults(): FormSettings {
  const e = (k: string, fallback = '') => process.env[k]?.trim() || fallback;
  return {
    uiMode: 'easy',
    uiLang: 'auto',
    setupDone: 'off',
    aiProvider: e('AI_PROVIDER', 'openai').toLowerCase(),
    aiConnections: '',
    aiConnection: '',
    mode: e('AI_DEFAULT_MODE', 'ai'),
    task: e('AI_TASK'),
    persona: e('AI_PERSONA', 'professionell'),
    voice: e('AI_VOICE', 'marin'),
    address: e('AI_ADDRESS', 'sie').toLowerCase() === 'du' ? 'du' : 'sie',
    aiName: e('AI_NAME', 'Alex'),
    principal: e('AI_PRINCIPAL'),
    personaExtra: e('AI_EXTRA'),
    behaveLength: '',
    behavePace: '',
    behaveConfirm: '',
    behaveSmalltalk: '',
    model: e('OPENAI_MODEL', 'gpt-realtime-2.1'),
    incoming: onOff(e('INCOMING_ENABLED', 'off')),
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
    // Bewusst an: Die KI gibt sich auch Spam-Anrufern zu erkennen (Art. 50 KI-VO); die Privatperson gibt es nur nach bestätigtem Risiko
    scamDisclose: 'on',
    ringPopup: onOff(e('RING_POPUP', 'on')),
    // Bewusst aus: die Abfrage überträgt die Anrufernummer an einen Dritten
    spamLookup: onOff(e('SPAM_LOOKUP', 'off')),
    maxCallSeconds: e('MAX_CALL_SECONDS', '300'),
    retentionDays: e('TRANSCRIPT_RETENTION_DAYS', '7'),
    stallMs: e('AI_STALL_MS', '6000'),
    vadSilenceMs: e('AI_VAD_SILENCE_MS', '900'),
    vadThreshold: e('AI_VAD_THRESHOLD', '0.6'),
    hangupGraceMs: e('AI_HANGUP_GRACE_MS', '2000'),
    greetingWaitMs: e('AI_GREETING_WAIT_MS', '1500'),
    speechSpeed: e('AI_SPEECH_SPEED', '1.05'),
    outputGain: e('AI_OUTPUT_GAIN', '1.5'),
    allowInterrupt: onOff(e('AI_ALLOW_INTERRUPT', 'on')),
    liveJudge: onOff(e('AI_LIVE_JUDGE', 'on')),
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
    webPort: String(parsePort(e('WEB_PORT')) ?? DEFAULT_WEB_PORT),
    // Bewusst aus und ohne .env-Schalter: Dass ein Agent telefonieren darf, wird in der Oberfläche entschieden
    mcpEnabled: 'off',
    mcpTargets: 'contacts',
    mcpConfirm: 'always',
    mcpPerHour: '10',
    mcpPerDay: '30',
    mcpMaxMinutes: '10',
    mcpContacts: 'off',
    mcpHistory: 'own',
    mcpPlan: 'off',
  };
}

const onOff = (v: string): string => (isOn(v) ? 'on' : 'off');

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
  /** Person („ist nicht da"), Firma („dort ist gerade niemand erreichbar") oder Familie („gerade ist niemand zu Hause") */
  kind: PrincipalKind;
  /** Familien-AB: Namen der Familienmitglieder, frei durch Komma getrennt; leer = die KI fragt nur, für wen der Anruf ist */
  members: string;
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
      kind: p.kind === 'company' || p.kind === 'family' ? p.kind : 'person',
      members: String(p.members ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
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

/** Spam-Abwehr ohne KI-Kennung braucht die Bestätigung des Risikos; mit KI-Kennung nicht. */
export function scamAllowed(s: FormSettings): boolean {
  return s.scamDisclose === 'on' || s.scamAccepted.trim().length > 0;
}

/** Spam-Abwehr ist nur aktiv, wenn eingeschaltet UND (KI-Kennung an ODER das Risiko bestätigt wurde). */
export function scamActive(s: FormSettings): boolean {
  return s.scamMode === 'on' && scamAllowed(s);
}

/** Bekannte Realtime-Modelle zur Auswahl (Preise siehe ai/pricing.ts) */
export const REALTIME_MODELS = ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'];

/** Realtime-Modell für einen Anruf: ein Listeneintrag oder eine eigene Modell-ID; leer oder unzulässige Zeichen = fallback. */
export function realtimeModel(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v) ? v : fallback;
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

/** Eine defekte settings.json nur einmal je Inhalt melden (loadSettings läuft bei jedem Anruf mehrfach). */
let warnedBroken = '';

export function loadSettings(): FormSettings {
  const base = envDefaults();
  if (!existsSync(SETTINGS_FILE)) return base;
  let text = '';
  try {
    text = readFileSync(SETTINGS_FILE, 'utf8');
    const saved = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    if (!saved || typeof saved !== 'object') throw new Error('kein JSON-Objekt');
    const picked = pick(saved as Record<string, unknown>);
    // Einstellungen aus der Zeit vor dem Schalter: Wer das Risiko bestätigt hatte, behält die Privatperson
    if (picked.scamDisclose === undefined && String(picked.scamAccepted ?? '').trim()) picked.scamDisclose = 'off';
    return normalize({ ...base, ...picked });
  } catch (err) {
    if (warnedBroken !== text) {
      warnedBroken = text;
      log.warn(`settings.json ist nicht lesbar (${(err as Error).message}) – es gelten die Vorgaben aus der .env`);
    }
    return base;
  }
}

/**
 * Einstellungen aus der Oberfläche speichern. `internal` sind Werte, die der Server selbst geprüft hat (die Liste der
 * KI-Verbindungen): Über die Oberfläche lässt sie sich nicht direkt setzen, sonst ließe sich einer Verbindung ein
 * anderer Anbieter unterschieben und ihr Schlüssel ginge dorthin.
 */
export function saveSettings(input: Record<string, unknown>, internal: Partial<FormSettings> = {}): FormSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Einstellungen müssen ein JSON-Objekt sein');
  const current = loadSettings();
  const incoming = pick(input);
  // Maskierte Kennwörter aus der UI bedeuten „unverändert"
  for (const k of SECRET_KEYS) if (incoming[k] === SECRET_MASK) delete incoming[k];
  delete incoming.aiConnections;
  // Ein ungültiger Port (Tippfehler, unter 1024) ändert nichts, statt auf die Vorgabe zurückzuspringen
  if (incoming.webPort !== undefined && parsePort(incoming.webPort) === undefined) delete incoming.webPort;
  // Umschalten geht nur auf eine Verbindung, die es gibt
  if (incoming.aiConnection !== undefined && !connectionsFrom(current).list.some((c) => c.id === incoming.aiConnection)) delete incoming.aiConnection;
  const merged = normalize({ ...current, ...incoming, ...internal });
  // Neuer Mailserver ohne neu eingegebenes Passwort: das gespeicherte verwerfen. Sonst ließe sich ein hinterlegtes
  // Passwort an einen fremden Server schicken, indem jemand nur die Serveradresse ändert (wie beim SIP-Kennwort).
  if (incoming.smtpPass === undefined && current.smtpPass && merged.smtpHost.trim().toLowerCase() !== current.smtpHost.trim().toLowerCase()) merged.smtpPass = '';
  // Unveränderte Standardvorlage nicht festschreiben: '' folgt späteren Änderungen der eingebauten Vorlage
  for (const [k, def] of MAIL_TEMPLATES) if (sameText(merged[k], def)) merged[k] = '';
  // Spam-Abwehr ohne KI-Kennung und ohne bestätigtes Risiko bleibt aus, egal was das Formular schickt
  if (!scamAllowed(merged)) merged.scamMode = 'off';
  keepBrokenFile();
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

/**
 * Nur den Port festhalten (SIPFunk ist beim Start auf einen freien Port ausgewichen). Anders als saveSettings schreibt das
 * keine anderen Werte fest: Was bisher aus der .env kam, kommt weiter von dort. Eine nicht lesbare settings.json bleibt
 * unangetastet; dann liefert false, und der Port gilt nur für diesen Lauf.
 */
export function saveWebPort(port: number): boolean {
  let data: Record<string, unknown> = {};
  if (existsSync(SETTINGS_FILE)) {
    if (settingsBroken()) return false;
    data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  }
  try {
    writeFileAtomic(SETTINGS_FILE, JSON.stringify({ ...data, webPort: String(port) }, null, 2) + '\n');
  } catch {
    return false;
  }
  return true;
}

/** true, wenn es eine settings.json gibt, sie sich aber nicht lesen lässt (dann gelten die Vorgaben aus der .env). */
export function settingsBroken(): boolean {
  if (!existsSync(SETTINGS_FILE)) return false;
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '')) as unknown;
    return !saved || typeof saved !== 'object';
  } catch {
    return true;
  }
}

/**
 * Ist die vorhandene settings.json nicht lesbar (Tippfehler nach einer Änderung von Hand), gelten beim Laden die
 * Vorgaben. Das nächste Speichern würde die Datei damit überschreiben und alles Eingestellte wäre weg: Vorher bleibt
 * sie als settings.json.defekt erhalten (wie bei den Kontakten).
 */
function keepBrokenFile(): void {
  if (!settingsBroken()) return;
  try {
    copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.defekt`);
    log.warn('settings.json war nicht lesbar und wird neu geschrieben; der alte Inhalt liegt in settings.json.defekt');
  } catch (err) {
    throw new Error(`settings.json ist nicht lesbar und ließ sich nicht sichern (${(err as Error).message}) – nichts gespeichert`);
  }
}

/** Verhalten in Stufen: zulässige Werte je Einstellung ('' = Standard). */
const BEHAVE_VALUES: [keyof FormSettings, string[]][] = [
  ['behaveLength', ['knapp', 'ausfuehrlich']],
  ['behavePace', ['zuegig', 'geduldig']],
  ['behaveConfirm', ['immer', 'selten']],
  ['behaveSmalltalk', ['nein', 'ja']],
];

/** Werte mit fester Auswahl auf einen gültigen Stand bringen. */
function normalize(s: FormSettings): FormSettings {
  if (s.uiMode !== 'advanced') s.uiMode = 'easy';
  if (s.setupDone !== 'on') s.setupDone = 'off';
  if (s.uiLang !== 'de' && s.uiLang !== 'en') s.uiLang = 'auto';
  if (s.scamDisclose !== 'off') s.scamDisclose = 'on';
  // Ungültiger Port (Tippfehler, unter 1024): beim Vorgabewert bleiben statt beim nächsten Start zu scheitern
  s.webPort = String(parsePort(s.webPort) ?? parsePort(process.env.WEB_PORT) ?? DEFAULT_WEB_PORT);
  if (s.mcpEnabled !== 'on') s.mcpEnabled = 'off';
  if (s.mcpTargets !== 'any') s.mcpTargets = 'contacts';
  if (s.mcpConfirm !== 'never' && s.mcpConfirm !== 'unknown') s.mcpConfirm = 'always';
  if (s.mcpContacts !== 'on') s.mcpContacts = 'off';
  if (s.mcpHistory !== 'all') s.mcpHistory = 'own';
  if (s.mcpPlan !== 'on') s.mcpPlan = 'off';
  // Die Limits so speichern, wie sie gelten: Die Oberfläche soll nicht 100 zeigen, wenn 60 wirkt
  const mcp = mcpPolicyFrom(s);
  s.mcpPerHour = String(mcp.perHour);
  s.mcpPerDay = String(mcp.perDay);
  s.mcpMaxMinutes = String(mcp.maxSeconds / 60);
  // Der „gewählte Anbieter“ ist der Anbieter der aktiven Verbindung
  s.aiProvider = connectionsFrom({ ...s, aiProvider: providerById(s.aiProvider).id }).active.provider;
  for (const [k, allowed] of BEHAVE_VALUES) if (!allowed.includes(s[k])) s[k] = '';
  return s;
}

function pick(obj: Record<string, unknown>): Partial<FormSettings> {
  const out: Partial<FormSettings> = {};
  for (const k of SETTINGS_KEYS) if (typeof obj[k] === 'string') out[k] = obj[k] as string;
  return out;
}
