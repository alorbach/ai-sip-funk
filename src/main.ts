// Einstieg: SIP-Registrierung und lokale Web-UI starten.
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { chooseWebPort, parsePort, removePortFile, writePortFile } from './webPort.js';
import { VERSION } from './version.js';
import { CallManager, type AudioHandler } from './callManager.js';
import { log, logEvents } from './log.js';
import { EchoHandler, ToneHandler } from './rtp/testSources.js';
import { startWebServer } from './web/server.js';
import { RealtimeBridge, type CallOutcome, type TranscriptEntry, type Usage } from './ai/realtimeBridge.js';
import { agentLabel } from './ai/agentCall.js';
import { buildInstructions, defaultIncomingTask, firstName, greetingInstruction, incomingFollowUpInstruction, loadPersonas } from './ai/personas.js';
import { sampleText, voiceSample } from './ai/voiceSample.js';
import { McpGateway, type AgentCallControl } from './mcp/gateway.js';
import { handleMcpHttp } from './mcp/http.js';
import { agentStatus, installAgent, removeAgent, userAgentEnv, type McpTarget } from './mcp/agents.js';
import { existsSync } from 'node:fs';
import { mcpPolicyFrom, incomingFrom, incomingOverride, loadSettings, saveSettings, saveWebPort, settingsBroken, type FormSettings, mailConfigFrom, SECRET_MASK, notifyPolicies, parseProfiles, profileFor, scamActive, scamAllowed, SCAM_DEFAULT_SPEED, scamMaxSeconds, scamSpeed, shouldNotify, tuningFrom } from './settings.js';
import { buildScamInstructions, isScamNumber, scamGender, scamGreeting, type ScamStyle } from './ai/scam.js';
import { draftComplaint } from './ai/complaint.js';
import { localVerdict, lookupTellows, withTellows, type SpamVerdict } from './spamCheck.js';
import { formatPlan, planCall } from './ai/plan.js';
import { createDirector, createJudge, type Director, type JudgeContext } from './ai/judge.js';
import { summarize } from './ai/summary.js';
import { assessCall } from './ai/assess.js';
import { Mailer, oauthFrom } from './notify/email.js';
import { buildCallMail, buildTestMail } from './notify/mailFormat.js';
import { suggestMail } from './notify/autoconfig.js';
import { OAuthLogin, TokenStore } from './notify/oauth.js';
import { BUDGET_MODELS, estimateCostUsd } from './ai/pricing.js';
import { ModelCatalog } from './ai/models.js';
import { testConnection } from './ai/connectionTest.js';
import { cleanAdminKey, fetchOpenAiMonthCosts, monthKey, UsageCounter } from './usageCounter.js';
import { PROVIDER_IDS, PROVIDERS, providerById, providerKey, resolveAi } from './ai/providers/index.js';
import { callVoice, connectionKey, connectionKeyEnv, connectionsFrom, connectionVoice, MAX_CONNECTIONS, mergeConnections, type AiConnection } from './ai/connections.js';
import type { AiProvider, ProviderId, TextModel } from './ai/providers/types.js';
import { TranscriptStore, type CallRecord } from './transcripts.js';
import { normalizeTarget } from './dialPolicy.js';
import { ContactStore, numberKey } from './contacts.js';
import { writeEnvValues } from './envFile.js';
import { cleanSipAccount, explainSipError, testSipAccount } from './setup.js';

// Datenordner: .env, settings.json, contacts.json, transcripts/. Standard = Projektordner; die Tray-App
// setzt SIPFUNK_DATA_DIR auf den Benutzerdaten-Ordner, damit das installierte Programm beschreibbar bleibt.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDir = process.env.SIPFUNK_DATA_DIR ? resolve(process.env.SIPFUNK_DATA_DIR) : projectRoot;
mkdirSync(dataDir, { recursive: true });
process.chdir(dataDir);

const config = loadConfig();
// Port der Web-UI: aus den Einstellungen (Basis: WEB_PORT der .env). Ist er belegt, weicht SIPFunk auf den nächsten
// freien aus und speichert ihn, damit die Adresse für eingetragene Agenten danach wieder fest ist.
const wantedWebPort = parsePort(loadSettings().webPort) ?? config.webPort;
const webPortChoice = await chooseWebPort(wantedWebPort);
config.webPort = webPortChoice.port;
// Die .env liefert nur den Startwert: Wer dort später WEB_PORT ändert, soll erfahren, warum das nichts bewirkt
if (parsePort(process.env.WEB_PORT) && parsePort(process.env.WEB_PORT) !== wantedWebPort) log.warn(`WEB_PORT=${process.env.WEB_PORT} aus der .env wird nicht verwendet: Es gilt Port ${wantedWebPort} aus den Einstellungen (Einstellungen › Technik).`);
/** Ausgewichen, aber der neue Port ließ sich nicht speichern: Dann gilt für Anzeige und Agenten-Einträge der laufende Port */
let webPortUnsaved = false;
/** Gesetzt, wenn beim Start ausgewichen wurde: der Port, der belegt war */
const webPortMovedFrom = webPortChoice.moved ? wantedWebPort : undefined;
if (webPortChoice.moved) {
  const kept = saveWebPort(webPortChoice.port);
  webPortUnsaved = !kept;
  log.warn(`Web-UI: Port ${wantedWebPort} ist belegt – SIPFunk nutzt ${kept ? 'ab jetzt' : 'für diesen Lauf'} Port ${webPortChoice.port}${kept ? ' (gespeichert)' : ' (nicht gespeichert: settings.json ist nicht lesbar oder nicht beschreibbar)'}. Eingetragene Agenten bitte unter „Einstellungen › MCP-Schnittstelle“ aktualisieren.`);
}
const personas = loadPersonas(join(projectRoot, 'personas'));
const bus = new EventEmitter();
const contacts = new ContactStore(join(dataDir, 'contacts.json'));
// Technische Werte (Limits, Wächter, Modelle) kommen aus den Einstellungen; die .env liefert nur die Basis
// Der gewählte KI-Anbieter mit Schlüssel und Modellen; wird je Aufruf neu gelesen, weil er sich in der Oberfläche ändern lässt
const ai = () => resolveAi(loadSettings());
/** Technische Werte; das Gesprächslimit beachtet die Grenze des gewählten Anbieters. */
const tuning = () => {
  const s = loadSettings();
  const t = tuningFrom(s);
  return { ...t, maxCallSeconds: resolveAi(s).callLimit(t.maxCallSeconds) };
};
const store = new TranscriptStore(join(dataDir, 'transcripts'), tuning().retentionDays);
store.startCleanupTimer();

const manager = new CallManager({
  sipServer: config.sipServer,
  sipUser: config.sipUser,
  sipPassword: config.sipPassword,
  sipLocalPort: config.sipLocalPort,
  rtpPort: config.rtpPort,
  localIp: config.localIp,
  sipDebug: config.sipDebug,
  maxCallSeconds: tuning().maxCallSeconds,
  liveListenEnabled: config.liveListenEnabled,
  hdAudio: config.hdAudio,
  incoming: incomingFrom(loadSettings()),
  // Je gewählter Nummer kann das Profil Annahme und Klingelzahl überstimmen
  incomingFor: (called) => {
    const s = loadSettings();
    return incomingOverride(profileFor(called, parseProfiles(s.incomingProfiles, s.incomingIdentities)));
  },
  // Anrufbeantworter: KI-Gespräch mit den gespeicherten Standardwerten und dem Anrufbeantworter-Auftrag
  createIncomingHandler: (caller, called, opts) => {
    const base = loadSettings();
    // Profil je gewählter Nummer: Meldung („KI-Assistent von <Name>"), Person/Firma und abweichende Vorgaben
    const prof = profileFor(called, parseProfiles(base.incomingProfiles, base.incomingIdentities));
    const principal = prof?.name || base.principal || 'der Inhaber';
    const principalKind = prof?.kind ?? 'person';
    // „model“ der Einstellungen stammt aus der Zeit vor den KI-Verbindungen: Das Modell gehört jetzt zur Verbindung (model: '' unten)
    const s = prof
      ? { ...base, familyMembers: prof.members, address: prof.address || base.address, persona: prof.persona || base.persona, incomingTask: prof.task || base.incomingTask, personaExtra: prof.extra || base.personaExtra }
      : base;
    if (prof) log.info(`Anrufbeantworter für ${called || '?'}: Profil „${prof.name}" (${principalKind === 'company' ? 'Firma' : principalKind === 'family' ? 'Familie' : 'Person'}${prof.address ? `, ${prof.address}` : ''}${prof.persona ? `, ${prof.persona}` : ''}${prof.voice ? `, ${prof.voice}` : ''})`);
    // Spam-Abwehr: Nummer aus der Liste -> von Anfang an als Privatperson; sonst darf die KI per flag_spam umschalten
    const scam = scamActive(s);
    // Stimme: die des Profils; sonst entscheidet die Standardstimme der Verbindung (nicht die alte allgemeine Einstellung)
    s.voice = prof?.voice ?? '';
    // Von Hand in die Spam-Falle umgeleitet (Pop-up beim Klingeln): gilt wie ein Listentreffer
    if (opts?.forceScam) {
      log.info(`Spam-Abwehr: Anruf von ${caller || 'anonym'} von Hand in die Spam-Falle umgeleitet (${s.scamStyle})`);
      return createAiHandler({ ...s, model: '', principal, principalKind, target: caller, called, task: '', incoming: true, scam: true });
    }
    if (scam && isScamNumber(caller, s.scamNumbers)) {
      log.info(`Spam-Abwehr: Nummer ${caller || 'anonym'} steht auf der Liste – KI tritt als Privatperson auf (${s.scamStyle})`);
      return createAiHandler({ ...s, model: '', principal, principalKind, target: caller, called, task: '', incoming: true, scam: true });
    }
    // Bekannte Kontakte darf die KI nie im Gespräch als Spam einstufen; nur die Liste (ausdrücklicher Wille) gilt für sie
    const known = Boolean(contacts.findByNumber(caller));
    if (scam && known) log.info('Spam-Abwehr: Anrufer ist ein Kontakt – Erkennung im Gespräch ausgeschaltet');
    return createAiHandler({ ...s, model: '', principal, principalKind, target: caller, called, task: s.incomingTask || defaultIncomingTask(principal, caller, principalKind), incoming: true, scamAllowed: scam && !known });
  },
});

const modes = [
  { id: 'ai', label: 'KI-Gespräch' },
  { id: 'echo', label: 'Echo (1 s)' },
  { id: 'tone', label: 'Testton' },
];

/** Laufendes KI-Gespräch: Transkript, Usage und Metadaten fürs Protokoll. */
let transcript: TranscriptEntry[] = [];
let current:
  | { startedAt: Date; task: string; persona: Record<string, string>; model: string; provider: ProviderId; ask: TextModel; usage?: Usage; plan?: string; outcome?: CallOutcome; director?: Director; incoming?: { caller: string; called: string; principal: string }; spam?: boolean; notify?: boolean; origin?: 'mcp' }
  | undefined;
/** Zeitlimit der Spam-Abwehr (läuft ab Umschalten bzw. Annahme) */
let spamTimer: NodeJS.Timeout | undefined;

/** Zeitlimit der Spam-Abwehr in Sekunden (je nach Stil). */
function scamLimit(s: ReturnType<typeof loadSettings>): number {
  const max = resolveAi(s).callLimit(tuningFrom(s).maxCallSeconds);
  return s.scamStyle === 'beschaeftigen' ? scamMaxSeconds(s, max) : Math.min(120, max);
}

/** Zeitlimit der Spam-Abwehr starten: beim Umschalten im Gespräch sofort, bei Listentreffern erst mit der Annahme. */
function armSpamLimit(s: ReturnType<typeof loadSettings>): void {
  const mine = current;
  clearTimeout(spamTimer);
  spamTimer = setTimeout(() => {
    spamTimer = undefined;
    // Nur das Gespräch beenden, für das das Limit gestartet wurde
    if (current === mine && manager.status().phase !== 'idle') {
      log.info('Spam-Abwehr: Zeitlimit erreicht – lege auf');
      manager.hangup('Spam-Abwehr: Zeitlimit');
    }
  }, scamLimit(s) * 1000);
  spamTimer.unref();
}

/** Spam-Abwehr: Anweisungen bauen und das Gespräch markieren (das Zeitlimit startet armSpamLimit). */
function startScam(s: ReturnType<typeof loadSettings>, caller: string, voice: string, maleVoices: readonly string[]): string {
  const style: ScamStyle = s.scamStyle === 'beschaeftigen' ? 'beschaeftigen' : 'abwimmeln';
  const limit = scamLimit(s);
  if (current) current.spam = true;
  return buildScamInstructions({ style, maxMinutes: Math.max(1, Math.round(limit / 60)), callerKnown: /\d{3,}/.test(caller), name: s.scamName, extra: s.scamExtra, gender: scamGender(s.scamGender, voice, maleVoices), disclose: s.scamDisclose === 'on' });
}

function createHandler(mode: string, params: Record<string, unknown>): AudioHandler {
  switch (mode) {
    case 'tone':
      return new ToneHandler();
    case 'echo':
      return new EchoHandler();
    case 'ai':
      return createAiHandler(params);
    default:
      throw new Error(`Unbekannter Modus: ${mode}`);
  }
}

/** Inhabernummer: Kontakt mit Kennzeichen „Inhaber" oder OWNER_NUMBERS aus der .env. */
function isOwnerNumber(target: string): boolean {
  const t = numberKey(target);
  return t.length > 0 && (contacts.isOwnerNumber(target) || config.ownerNumbers.some((n) => numberKey(n) === t));
}

/**
 * Hintergrundwissen aus Kontakt und Historie: Notizen und die letzte Zusammenfassung.
 * Bei einem Agenten-Anruf (`agent`) liest der Agent mit, was die KI sagt: Dann bleiben die Notizen draußen, und aus der
 * Historie zählt nur, was der Agent ohnehin lesen darf (eigene Anrufe über MCP, oder alle mit der Freigabe dafür).
 */
function contactContext(target: string, incoming = false, agent = false): string {
  const parts: string[] = [];
  const c = contacts.findByNumber(target);
  if (c) {
    parts.push(`${incoming ? `Die Nummer des Anrufers ist als Kontakt „${c.name}" gespeichert; wer wirklich dran ist, sagt er selbst.` : `Du rufst ${c.name} an.`}${c.notes && !agent ? ` Notizen zu diesem Kontakt: ${c.notes}` : ''}`);
  }
  const allHistory = !agent || mcpPolicyFrom(loadSettings()).history === 'all';
  const last = store.listByNumber(target).find((r) => r.summary && (allHistory || r.origin === 'mcp'));
  if (last) {
    parts.push(`Letztes Gespräch mit dieser Nummer am ${last.startedAt.slice(0, 10)} (${last.durationSec}s). Zusammenfassung:
${last.summary}`);
  }
  return parts.join('\n\n');
}

function createAiHandler(params: Record<string, unknown>): RealtimeBridge {
  const active = ai();
  const { provider } = active;
  const apiKey = needKey('Das KI-Gespräch');
  const str = (k: string, fallback = '') => (typeof params[k] === 'string' ? (params[k] as string) : fallback);
  // Kontakt-Standardwerte greifen, wo das Formular nichts vorgibt
  const contact = contacts.findByNumber(str('target'));
  if (contact) {
    for (const k of ['persona', 'voice', 'address', 'task'] as const) {
      // Die Stimme eines Kontakts gilt für Anrufe bei ihm, nicht für den Anrufbeantworter
      if (k === 'voice' && params.incoming === true) continue;
      if (!str(k) && contact[k]) params[k] = contact[k];
    }
  }
  const incoming = params.incoming === true;
  // Anruf eines KI-Agenten (MCP): Stil und Anrede kommen vom Agenten, sonst vom Kontakt, sonst aus den Einstellungen
  const mcp = params.mcp === true && !incoming;
  if (mcp) {
    const base = loadSettings();
    for (const k of ['persona', 'address'] as const) if (!str(k)) params[k] = base[k];
  }
  const persona = personas.find((p) => p.id === str('persona')) ?? personas[0];
  if (!persona) throw new Error('Keine Persona-Dateien in personas/ gefunden');
  const scam = incoming && params.scam === true;
  // Modell und Verhalten: Nennt der Aufrufer nichts (z. B. ein Anruf über MCP), gelten die gespeicherten Einstellungen
  const saved = loadSettings();
  const orSaved = (k: 'behaveLength' | 'behavePace' | 'behaveConfirm' | 'behaveSmalltalk') => (typeof params[k] === 'string' ? (params[k] as string) : saved[k]);
  const t = tuning();
  // Spam-Rolle ab Annahme: eigene Stimme und eigenes Tempo, sofern eingestellt
  const sc = scam ? loadSettings() : undefined;
  // Rangfolge siehe callVoice: Spam-Rolle, Anruf (bzw. Kontakt oder Profil), Standardstimme der Verbindung
  const voice = callVoice(active.connection, { scam: sc?.scamVoice, call: str('voice'), legacy: saved.voice });
  const speechSpeed = sc ? scamSpeed(sc, SCAM_DEFAULT_SPEED) : t.speechSpeed;
  const scamOpen = loadSettings().scamDisclose === 'on';
  if (sc) log.info(`Spam-Abwehr: ${scamOpen ? 'mit KI-Kennung' : `Rolle${sc.scamName.trim() ? ` „${sc.scamName.trim()}"` : ' ohne Namen'}`}, Stimme ${voice} (${scamGender(sc.scamGender, voice, provider.maleVoices) === 'm' ? 'Mann' : 'Frau'}), Tempo ${speechSpeed}${sc.scamExtra.trim() ? ', eigene Anweisungen' : ''}`);
  // Anruf beim Inhaber selbst: immer Du und Vorname – er weiß, wer da anruft
  const owner = !incoming && isOwnerNumber(str('target'));
  const ownerFirst = owner ? firstName(contact?.name || str('principal', '')) : '';
  const input = {
    persona,
    incoming,
    principalKind: params.principalKind === 'company' ? ('company' as const) : params.principalKind === 'family' ? ('family' as const) : ('person' as const),
    familyMembers: str('familyMembers'),
    extra: str('personaExtra'),
    behavior: { length: orSaved('behaveLength'), pace: orSaved('behavePace'), confirm: orSaved('behaveConfirm'), smalltalk: orSaved('behaveSmalltalk') },
    formal: owner ? false : str('address', 'sie') !== 'du',
    aiName: str('aiName', 'Alex') || 'Alex',
    principalName: owner && ownerFirst ? ownerFirst : str('principal', 'meinem Auftraggeber') || 'meinem Auftraggeber',
    task: str('task'),
    context: [str('context'), contactContext(str('target'), incoming, mcp)].filter(Boolean).join('\n\n') || undefined,
    // Inhaber-Logik („dein Agent") nur beim Anrufen des Inhabers; beim Anrufbeantworter bleibt die KI der Assistent
    owner,
    // Rückrufnummer: der Inhaber-Kontakt, sofern wir nicht gerade ihn selbst anrufen
    callbackNumber: isOwnerNumber(str('target')) ? undefined : (contacts.list().find((c) => c.owner)?.number ?? config.ownerNumbers[0]),
    agent: mcp,
    agentName: mcp ? agentLabel(str('agentClient')) : undefined,
    // Ein Agenten-Anruf kann kürzer begrenzt sein als das allgemeine Gesprächslimit
    maxCallSeconds: mcp && typeof params.maxSeconds === 'number' ? Math.min(t.maxCallSeconds, params.maxSeconds) : t.maxCallSeconds,
  };
  const instructions = buildInstructions(input);
  if (input.owner) log.info(`KI: Ziel ist eine Inhabernummer – ${mcp ? 'Agenten-Anruf, Vorstellung als KI-Assistent' : 'Vorstellung als Agent ohne KI-Erklärung'}`);
  if (incoming) log.info(`KI: Anrufbeantworter für Anruf von ${str('target') || 'unbekannt'}`);
  // Das Modell gehört zur Verbindung; nur ein Anruf über die API, der ausdrücklich eines nennt, weicht davon ab
  let model = active.realtimeModel(typeof params.model === 'string' ? params.model : undefined);
  log.info(`KI: ${provider.label}, Modell ${model}, Persona ${persona.label}, Stimme ${voice}, ${input.formal ? 'Sie' : 'Du'}, Name ${input.aiName}`);

  transcript = [];
  // Zeitlimit eines früheren Spam-Anrufs (z. B. auf „klingeln lassen" gestellt) gilt nicht für dieses Gespräch
  clearTimeout(spamTimer);
  spamTimer = undefined;
  current = {
    startedAt: new Date(),
    model,
    provider: provider.id,
    ask: active.ask,
    // Ins Protokoll (und damit in die Zusammenfassung) kommt bei einem Agenten-Anruf nur, was der Agent selbst mitgegeben hat:
    // Der Kontaktname aus dem Hintergrundwissen stünde sonst in dem, was er abrufen kann
    task: (mcp ? str('context') : input.context) ? `${input.task}

Hintergrundwissen:
${mcp ? str('context') : input.context}` : input.task,
    persona: { stil: persona.label, stimme: voice, anrede: input.formal ? 'Sie' : 'Du', name: input.aiName, auftraggeber: input.principalName },
    incoming: incoming ? { caller: str('target'), called: str('called'), principal: input.principalName } : undefined,
    notify: params.notifyCall === true || undefined,
    origin: mcp ? 'mcp' : undefined,
  };
  bus.emit('message', { type: 'transcript', entries: transcript });
  bus.emit('message', { type: 'summary', text: '' });

  // Spam-Abwehr ab Annahme (Nummernliste): markiert das Gespräch; das Zeitlimit läuft ab der Annahme (onConnected)
  const scamInstructions = scam ? startScam(loadSettings(), str('target'), voice, provider.maleVoices) : undefined;
  // Das Textmodell entscheidet mit und führt Regie (Einstellungen › Technik); es kennt dafür Auftrag, Plan (außer bei Agenten-Anrufen) und das ganze Transkript.
  // Nicht in der Spam-Abwehr. Bei Agenten-Anrufen führt der Agent Regie, das Textmodell entscheidet nur an den Regelstellen mit
  const started = current;
  // Die vollständige Anweisung der Sprach-KI gehört zum Kontext (mit Plan, sobald er da ist)
  let liveInstructions = instructions;
  // Bei Agenten-Anrufen ohne den Plan: Er kann den Kontaktnamen nennen, und was die Prüfung als offen meldet, liest der Agent mit
  const judgeContext = (): JudgeContext => ({ task: input.task, plan: mcp ? undefined : started.plan, instructions: liveInstructions, principal: input.principalName, incoming, entries: transcript, situation: bridge.situation() });
  const liveJudge = t.liveJudge && !scam;
  const director =
    liveJudge && !mcp
      ? createDirector(active.ask, judgeContext, (hint) => current === started && bridge.directorHint(hint), (message) => log.warn(`Regie: Textmodell fehlgeschlagen (${message.slice(0, 120)})`))
      : undefined;
  // (Am Ende des Gesprächs hält callEnded sie an: Sie liest sonst das Transkript des nächsten Gesprächs)
  started.director = director;
  const bridge: RealtimeBridge = new RealtimeBridge({
    judge: liveJudge ? createJudge(active.ask, judgeContext) : undefined,
    apiKey,
    createLive: (cfg, events) => provider.createLive(cfg, events),
    model,
    fallbackModels: active.realtimeFallbacks(model),
    onModel: (m) => {
      model = m;
      if (current) current.model = m;
    },
    instructions: scamInstructions ?? instructions,
    voice,
    greetingInstruction: scam ? scamGreeting(sc?.scamName, scamOpen) : greetingInstruction(input),
    scam,
    scamDisclose: scamOpen,
    owner: input.owner,
    formal: input.formal,
    transcriptionHints: [input.principalName, contact?.name ?? '', input.aiName],
    allowInterrupt: t.allowInterrupt,
    outputGain: t.outputGain,
    speechSpeed,
    maxOutputTokens: typeof params.maxOutputTokens === 'number' ? params.maxOutputTokens : scam ? 500 : undefined,
    vadSilenceMs: t.vadSilenceMs,
    vadThreshold: t.vadThreshold,
    hangupGraceMs: t.hangupGraceMs,
    stallMs: t.stallMs,
    // Beim Anrufbeantworter meldet sich die KI sofort, der Anrufer erwartet eine Ansage
    greetingWaitMs: incoming ? 0 : t.greetingWaitMs,
    // Ausgehend muss sich die KI als KI zu erkennen geben; nur dem Inhaber selbst gegenüber entfällt das (außer bei Agenten-Anrufen)
    requireAiIntro: !incoming && !scam && (!input.owner || mcp),
    // Anrufbeantworter: erst nur „Hallo?"; sagt der Anrufer nichts, stellt sich die KI nach kurzer Pause vor
    greetingFollowUp: scam
      ? { afterMs: 3000, instruction: 'Der Anrufer hat nichts gesagt. Sag noch einmal fragend „Hallo? Ist da jemand?" und warte.' }
      : incoming
        ? { afterMs: 2500, instruction: incomingFollowUpInstruction(input) }
        : undefined,
    onTranscript: (entry) => {
      // Zwischenstände der KI werden ersetzt, finale Einträge angehängt
      const last = transcript.at(-1);
      if (last && !last.final && last.speaker === entry.speaker) transcript[transcript.length - 1] = entry;
      else transcript.push(entry);
      bus.emit('message', { type: 'transcript', entries: transcript });
      if (mcp) gateway.transcript(entry);
      // Ein Redebeitrag der KI ist fertig: Die Regie sieht sich den Wortwechsel an
      if (entry.final && entry.speaker === 'ki' && current === started) director?.onAiTurn();
    },
    onUsage: (usage: Usage) => {
      if (current) current.usage = usage;
      bus.emit('message', { type: 'usage', usage, model, costUsd: estimateCostUsd(model, usage) });
    },
    onEndCall: (reason) => manager.hangup(reason),
    onOutcome: (outcome) => {
      if (current) current.outcome = outcome;
    },
    // Rückruf an den Inhaber: auf Wunsch zum Anrufer durchstellen (REFER an die Box)
    onTransfer: str('transferTo') ? () => manager.transfer(str('transferTo')) : undefined,
    // Anrufbeantworter mit aktiver Spam-Abwehr: Die KI darf Werbe-/Betrugsanrufe melden und wechselt dann die Rolle
    onFlagSpam:
      params.scamAllowed === true
        ? (reason) => {
            director?.stop();
            transcript.push({ speaker: 'system', text: `Spam-Abwehr: ${reason || 'als Werbe-/Betrugsanruf erkannt'}`, final: true });
            bus.emit('message', { type: 'transcript', entries: transcript });
            const s = loadSettings();
            armSpamLimit(s);
            return startScam(s, str('target'), voice, provider.maleVoices);
          }
        : undefined,
    // Agenten-Anruf: Die KI darf beim Agenten nachfragen (Tool ask_principal)
    onAskAgent: mcp ? (question) => gateway.question(question) : undefined,
    onConnected: scam ? () => armSpamLimit(loadSettings()) : undefined,
    onError: (message) => {
      bus.emit('message', { type: 'aiError', message });
      // KI fällt schon beim Klingeln aus: Anruf nicht abweisen, sondern nur klingeln lassen (andere Telefone klingeln weiter)
      if (manager.status().phase === 'incoming' && manager.divertIncoming('skip').ok) {
        log.warn(`KI nicht verfügbar (${message}) – eingehender Anruf klingelt nur`);
        return;
      }
      // Ohne KI-Verbindung macht das Gespräch keinen Sinn: sauber auflegen
      if (manager.status().phase !== 'idle') manager.hangup(`KI-Fehler: ${message}`);
    },
  });

  // Gesprächsplan parallel zum Wählen erstellen; das Klingeln dauert meist länger als das Modell.
  // Ohne Auftrag (Testgespräch) gibt es nichts zu planen. Beim Anrufbeantworter und beim Rückruf an den
  // Inhaber ist der Auftrag schon fest strukturiert; der Plan brachte dort nur Selbstprüfungs-Schleifen am Ende.
  if (input.task.trim() && !incoming && params.plan !== false) {
    planCall(active.ask, {
      task: input.task,
      context: str('context') || undefined,
      principalName: input.principalName,
      aiName: input.aiName,
      formal: input.formal,
      contactName: contact?.name,
      owner: input.owner,
    })
      .then((plan) => {
        if (!started || current !== started) return; // Gespräch inzwischen vorbei
        const text = formatPlan(plan);
        started.plan = text;
        liveInstructions = buildInstructions({ ...input, plan: text });
        bridge.updateInstructions(liveInstructions, plan.schritte);
        log.info(`Gesprächsplan: ${plan.schritte.length} Schritt(e) – ${plan.schritte.join(' | ')}`);
        if (mcp) gateway.plan(plan.schritte);
      })
      .catch((err) => log.warn(`Kein Gesprächsplan, KI telefoniert ohne: ${(err as Error).message}`));
  }
  return bridge;
}

// Nach einem KI-Gespräch: Protokoll speichern, Zusammenfassung holen, UI informieren
manager.on('callEnded', (reason: string) => {
  const st = manager.status();
  if (!current || st.mode !== 'ai') return;
  const c = current;
  current = undefined;
  c.director?.stop();
  clearTimeout(spamTimer);
  spamTimer = undefined;
  if (!st.connectedAt) {
    // Nie verbunden (nicht abgenommen, besetzt, abgelehnt): kein leeres Protokoll anlegen
    log.info(`Kein Protokoll: Gespräch kam nicht zustande (${reason})`);
    bus.emit('message', { type: 'summary', text: '' });
    if (c.origin === 'mcp') gateway.callEnded(reason);
    return;
  }
  const record: CallRecord = {
    id: TranscriptStore.makeId(c.startedAt, st.target ?? ''),
    startedAt: c.startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    target: st.target ?? '',
    mode: 'ai',
    durationSec: st.durationSec,
    codec: st.codec,
    endReason: reason,
    task: c.task || undefined,
    plan: c.plan,
    outcome: c.outcome,
    persona: c.persona,
    model: c.model,
    provider: c.provider,
    entries: transcript.filter((e) => e.final),
    usage: c.usage,
    costUsd: c.usage ? estimateCostUsd(c.model, c.usage) : undefined,
    spam: c.spam || undefined,
    called: c.incoming?.called || undefined,
    notify: c.notify,
    origin: c.origin,
  };
  let saved = false;
  try {
    store.save(record);
    saved = true;
  } finally {
    // Auch wenn das Protokoll nicht geschrieben werden konnte: Der Anruf des Agenten ist vorbei, sonst bliebe das Gateway belegt
    if (c.origin === 'mcp') gateway.callEnded(reason, saved ? record.id : undefined);
  }
  try {
    usageCounter.add(c.provider, record.durationSec, record.costUsd ?? 0, c.startedAt);
  } catch (err) {
    log.warn(`Monatsverbrauch nicht fortgeschrieben: ${(err as Error).message}`);
  }
  bus.emit('message', { type: 'transcripts', items: store.list() });
  bus.emit('message', { type: 'summary', text: 'Zusammenfassung wird erstellt …' });
  summarize(c.ask, record.task, record.entries, record.outcome)
    .then((summary) => {
      record.summary = summary;
      store.save(record);
      log.info(`Protokoll gespeichert: ${record.id}`);
      bus.emit('message', { type: 'summary', text: summary });
      bus.emit('message', { type: 'transcripts', items: store.list() });
      if (c.incoming) notifyAfterIncoming(record, c.incoming, c).catch((err) => log.error(`Benachrichtigung: ${(err as Error).message}`));
    })
    .catch((err) => {
      log.error((err as Error).message);
      bus.emit('message', { type: 'summary', text: `Keine Zusammenfassung: ${(err as Error).message}` });
      // Auch ohne Zusammenfassung (Anbieter gerade nicht erreichbar) soll der Inhaber vom Anruf erfahren
      if (c.incoming) notifyAfterIncoming(record, c.incoming, c).catch((e) => log.error(`Benachrichtigung: ${(e as Error).message}`));
    });
});

// ---- MCP-Schnittstelle: Ein KI-Agent löst Anrufe aus, liest mit und gibt Vorgaben (Erlaubnisse siehe mcp/gateway.ts) ----
const gateway: McpGateway = new McpGateway({
  policy: () => mcpPolicyFrom(loadSettings()),
  principal: () => loadSettings().principal,
  contacts: () => contacts.list().map((c) => ({ name: c.name, number: c.number })),
  findContact: (number) => contacts.findByNumber(number),
  prepare: (target) => manager.prepare(target),
  line: () => {
    const st = manager.status();
    return { phase: st.phase, registered: st.registered, maxCallSeconds: st.maxCallSeconds };
  },
  dial: (number, p): AgentCallControl => {
    // Erst prüfen, dann den Handler erzeugen: createAiHandler setzt Protokoll und Transkript zurück und öffnet die Verbindung
    manager.checkDial(number);
    const s = loadSettings();
    // Name der KI und zusätzliche Hinweise kommen immer aus den Einstellungen des Betreibers, nie vom Agenten
    const bridge = createAiHandler({ target: number, task: p.task, context: p.context, principal: p.principal, address: p.address ?? '', persona: p.persona ?? '', aiName: s.aiName, personaExtra: s.personaExtra, mcp: true, plan: mcpPolicyFrom(s).plan, maxSeconds: p.maxSeconds, agentClient: p.client ?? '' });
    try {
      manager.dial(number, 'ai', bridge);
    } catch (err) {
      bridge.close();
      throw err;
    }
    return { say: (text, now) => bridge.agentSay(text, now), end: () => bridge.agentEnd(), situation: () => bridge.situation() };
  },
  hangup: (reason) => manager.hangup(reason),
  records: store,
  publish: (info) => {
    bus.emit('message', info);
    // Beantwortet, abgelaufen oder zurückgezogen: Das Pop-up der Tray-App hat nichts mehr zu fragen
    if (!info.pending) traySend({ type: 'mcpAskEnd' });
  },
  // Die Tray-App fragt in einem eigenen Pop-up (mcp-ask.html), damit die Web-UI dafür nicht offen sein muss
  notify: () => traySend({ type: 'mcpAsk' }),
});
manager.on('status', (s: { phase: string }) => gateway.linePhase(s.phase));

/** Wie ein Agent den MCP-Server erreicht: Adresse für Streamable HTTP und der Befehl für den stdio-Prozess (für die Schnipsel der Oberfläche). */
function mcpConnect(): McpTarget & { packaged: boolean; port: number; runningPort: number } {
  // Der eingestellte Port: Weicht er vom laufenden ab (gespeichert, aber noch nicht neu gestartet), gilt er ab dem Neustart
  const port = webPortUnsaved ? config.webPort : parsePort(loadSettings().webPort) ?? config.webPort;
  const url = `http://127.0.0.1:${port}`;
  const built = fileURLToPath(new URL('./mcp/server.js', import.meta.url));
  const source = fileURLToPath(new URL('./mcp/server.ts', import.meta.url));
  // Aus dem Quelltext gestartet (npm start): über tsx; gebaut oder installiert: mit dem eigenen Programm als Node
  const fromSource = !existsSync(built) && existsSync(source);
  const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  // Der Prozess liest den Port der laufenden App aus dem Datenordner und folgt so jeder Portänderung
  const env: Record<string, string> = { SIPFUNK_DATA_DIR: dataDir };
  if (!fromSource && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    httpUrl: `${url}/mcp`,
    // Aus dem Quelltext: Node mit dem tsx-Programm direkt (ein Agent kann „npx“ unter Windows nicht ohne Shell starten)
    stdio: fromSource ? (existsSync(tsxCli) ? { command: process.execPath, args: [tsxCli, source], env } : { command: 'npx', args: ['tsx', source], env }) : { command: process.execPath, args: [built], env },
    packaged: Boolean(process.versions.electron) && !fromSource,
    port,
    runningPort: config.webPort,
  };
}

// Einträge in den Konfigurationen der Agenten (Claude Code, Claude Desktop, Codex, Cursor …): nur lesen, außer auf Klick
const agentEnv = userAgentEnv(process.env, homedir());
async function agentAction(id: string, action: string): Promise<Record<string, unknown>> {
  if (action !== 'install' && action !== 'remove') throw new Error('Unbekannte Aktion');
  const r = action === 'install' ? await installAgent(id, agentEnv, mcpConnect()) : await removeAgent(id, agentEnv, mcpConnect());
  if (r.changed) log.info(`MCP: Eintrag bei ${r.agent.label} ${action === 'install' ? 'geschrieben' : 'entfernt'} (${r.agent.file})${r.backup ? `, Sicherung: ${r.backup}` : ''}`);
  return { agents: agentStatus(agentEnv, mcpConnect()), agent: r.agent, backup: r.backup, changed: r.changed };
}

/** Tray-Hinweis an die Tray-App (electron/main.cjs), falls wir als Kindprozess laufen. */
function trayNotice(title: string, body: string): void {
  if (typeof process.send !== 'function') return;
  try {
    process.send({ type: 'notice', title, body });
  } catch {
    /* Elternprozess weg */
  }
}

/**
 * Nach einem angenommenen Anruf: Einschätzung (wichtig?), dann Tray-Hinweis, E-Mail und bei wichtigen
 * Anrufen ein Rückruf beim Inhaber – jedes davon in den Einstellungen abschaltbar.
 */
async function notifyAfterIncoming(record: CallRecord, inc: { caller: string; called: string; principal: string }, call: { ask: TextModel }): Promise<void> {
  const s = loadSettings();
  // Je eigener Nummer kann das Profil die Kanäle überstimmen (aus / nur wichtige / alle)
  const profile = profileFor(inc.called, parseProfiles(s.incomingProfiles, s.incomingIdentities));
  const policy = notifyPolicies(s, profile);
  if (policy.tray === 'off' && policy.email === 'off' && policy.call === 'off') {
    log.info(`Benachrichtigungen für ${inc.called || 'diese Nummer'}: alle Kanäle aus`);
    return;
  }
  const contact = contacts.findByNumber(inc.caller);
  const who = contact ? `${contact.name} (${inc.caller})` : inc.caller;
  let assessment = { important: false, reason: 'keine Einschätzung', headline: `Anruf von ${who}` };
  let assessed = false;
  if (record.spam) {
    // Spam-Abwehr: nie wichtig, kein Rückruf; Hinweis und Mail nur zur Information
    assessment = { important: false, reason: 'Spam-Abwehr war aktiv', headline: `Spam-Anruf von ${who || 'anonym'} abgewehrt` };
  } else try {
    // Mit der Verbindung des Gesprächs, nicht mit der inzwischen vielleicht umgeschalteten: Der Inhalt bleibt bei einem Anbieter
    assessment = await assessCall(call.ask, { caller: inc.caller, callerName: contact?.name, summary: record.summary ?? '', task: record.task });
    assessed = true;
    log.info(`Einschätzung: ${assessment.important ? 'wichtig' : 'unwichtig'} – ${assessment.reason}`);
  } catch (err) {
    log.warn(`Keine Einschätzung (${(err as Error).message}) – behandle den Anruf als unwichtig`);
  }
  const title = record.spam ? `Spam-Anruf von ${contact?.name ?? (inc.caller || 'anonym')}` : `${assessment.important ? 'Wichtiger Anruf' : 'Anruf'} von ${contact?.name ?? inc.caller}`;
  const when = new Date(record.startedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

  log.info(`Benachrichtigung (${profile ? `Profil ${profile.name}` : 'Standard'}): Tray ${policy.tray}, E-Mail ${policy.email}, Rückruf ${policy.call}`);
  if (shouldNotify(policy.tray, assessment.important)) trayNotice(title, `${assessment.headline || who} · ${when}${assessment.important ? `\n${assessment.reason}` : ''}`);

  if (shouldNotify(policy.email, assessment.important)) {
    const ms = mailer.status();
    if (!ms.loggedIn) {
      log.warn(`E-Mail-Benachrichtigung ist an, aber nicht einsatzbereit: ${ms.hint ?? ms.provider}`);
    } else {
      // Die Ersatz-Kurzzeilen („Anruf von …“) gehören nicht in den Betreff; dort steht der Anrufer ohnehin
      const mail = buildCallMail({
        record: { ...record, called: record.called || inc.called },
        assessment: assessed ? assessment : { ...assessment, headline: '' },
        contactName: contact?.name,
        principal: inc.principal,
        webPort: config.webPort,
        spam: record.spam,
        templates: { subject: s.mailSubject, body: s.mailBody },
      });
      try {
        await mailer.send(mail.subject, mail.text, mail.html);
        log.info(`E-Mail an ${mailConfig().to} gesendet (${mailConfig().provider})`);
      } catch (err) {
        log.error(`E-Mail fehlgeschlagen: ${(err as Error).message}`);
      }
    }
  }

  // Rückruf: nie bei Spam; sonst nach Regel (Standard nur wichtige, je Profil auch alle)
  if (record.spam || !shouldNotify(policy.call, assessment.important)) return;

  // Wichtiger Anruf: Inhaber anrufen (Handy)
  const ownerName = firstName(contacts.list().find((c) => c.owner)?.name || s.principal || inc.principal);
  const digits = inc.caller.replace(/\D/g, '');
  const numberSpoken = digits ? digits.replace(/(\d{3})(?=\d)/g, '$1 ').split('').join(' ').replace(/\s{2,}/g, ' – ') : '';
  const context = [
    `Angenommener Anruf von ${who} am ${when} auf der Leitung „${profile?.name || inc.principal}"${inc.called ? ` (${inc.called})` : ''}.`,
    ...(digits ? [`Rückrufnummer des Anrufers: ${digits}`] : []),
    `Zusammenfassung:\n${record.summary ?? ''}`,
    ...(record.outcome?.result ? [`Ergebnis laut KI: ${record.outcome.result}`] : []),
    '— Transkript —',
    ...record.entries.filter((e) => e.speaker !== 'system').map((e) => `${e.speaker === 'ki' ? 'KI' : 'Anrufer'}: ${e.text}`),
  ].join('\n\n');
  // Auf welcher eigenen Leitung der Anruf einging (Profilname) – das will der Inhaber als Erstes wissen
  const line = profile?.name || inc.principal;
  const lineHint = `Sag zuerst, auf welcher Leitung der Anruf einging: auf der Nummer von „${line}"${inc.called ? ` (Endziffern ${inc.called.replace(/\D/g, '').slice(-3).split('').join(' ')})` : ''} – z. B. „Auf der Nummer von ${line} war gerade ein Anruf".`;
  // Ruft jemand von der Inhabernummer selbst an (Test) oder passt der Kontaktname nicht, zählt der Name aus dem Gespräch
  const fromOwner = isOwnerNumber(inc.caller);
  const callerHint = fromOwner
    ? `der Anrufer hat sich im Gespräch selbst vorgestellt – nimm den Namen aus dem Gespräch; der Anruf kam von ${ownerName}s eigener Nummer, erwähne das nur in einem Halbsatz und sag NICHT „auf deinem Handy"`
    : contact?.name
      ? `${contact.name} laut Kontakten; hat sich der Anrufer im Gespräch anders vorgestellt, nimm den Namen aus dem Gespräch`
      : digits
        ? 'Name aus dem Gespräch, sonst „eine unbekannte Nummer"'
        : 'Name aus dem Gespräch, Nummer unterdrückt';
  const report = [
    lineHint,
    `Berichte gleich nach der Begrüßung ALLES am Stück, ohne dass er nachfragen muss, aber wie eine Kollegin, die kurz Bescheid sagt – nicht wie ein Protokoll: wer angerufen hat (${callerHint}), wann (${when}; sag nur die Uhrzeit oder „gerade eben", kein Datum), worum es ging, was der Anrufer möchte, und in einem Halbsatz deine Einschätzung (${assessment.important ? 'wichtig' : 'eher unwichtig'}: ${assessment.reason}).`,
    digits
      ? `Nenne dabei die Rückrufnummer des Anrufers, Ziffern einzeln in Dreiergruppen: ${numberSpoken}. Wiederhole sie auf Wunsch.`
      : 'Der Anrufer hat seine Nummer unterdrückt; sag das.',
  ].join(' ');

  const owner = contacts.list().find((c) => c.owner)?.number ?? config.ownerNumbers[0];
  if (!owner) {
    log.warn('Rückruf bei wichtigem Anruf ist an, aber kein Inhaber-Kontakt bzw. OWNER_NUMBERS hinterlegt');
    return;
  }
  const task = [
    `Sag ${ownerName} Bescheid: Du hast gerade als Anrufbeantworter einen Anruf angenommen. Du duzt ${ownerName}.`,
    report,
    digits ? `Verlangt ${ownerName} ausdrücklich, mit dem Anrufer verbunden zu werden („verbinde mich", „stell durch"), sag „Ich verbinde dich" und rufe transfer_call auf. Sagt er „nein", „nee, das war's", „danke" oder etwas Unklares, verbindest du NICHT; im Zweifel frag einmal nach.` : '',
    `Frag danach kurz, ob ${ownerName} noch etwas wissen will oder verbunden werden möchte; beantworte Fragen aus dem Hintergrundwissen. Wenn nichts mehr offen ist oder er sich verabschiedet, rufe end_call auf – ohne Ankündigung. Verabschiede dich locker, nicht förmlich.`,
  ]
    .filter(Boolean)
    .join(' ');
  // Der Bericht am Stück ist gewollt lang: Token-Notbremse höher als im normalen Gespräch
  await dialAi(owner, { ...s, model: '', voice: '', task, context, incoming: false, plan: false, notifyCall: true, transferTo: digits || '', maxOutputTokens: 3000 }, `Wichtiger Anruf: rufe ${ownerName} unter der Inhabernummer an`);
}

/** Wählt, sobald die Leitung frei ist, und wartet das Gesprächsende ab (die Benachrichtigungen laufen nacheinander). */
async function dialAi(target: string, params: Record<string, unknown>, logLine: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const st = manager.status();
    if (st.phase === 'idle' && st.registered) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  try {
    // Erst prüfen, dann den Handler erzeugen: createAiHandler setzt Protokoll und Transkript des laufenden Gesprächs zurück
    manager.checkDial(target);
    const handler = createAiHandler({ ...params, target });
    try {
      manager.dial(target, 'ai', handler);
    } catch (err) {
      handler.close();
      throw err;
    }
    log.info(logLine);
    await new Promise<void>((resolve) => manager.once('callEnded', () => resolve()));
  } catch (err) {
    log.error(`Anruf an ${target} nicht möglich: ${(err as Error).message}`);
  }
}

// E-Mail: OAuth-Token im Datenordner, Anmeldung über die Web-UI (Redirect auf 127.0.0.1)
const mailTokens = new TokenStore(join(dataDir, 'mail-token.json'));
// ---- Klingelnder Anruf: Einschätzung der Nummer fürs Pop-up, Umleiten auf Knopfdruck ----
interface RingState { caller: string; called: string; callerName?: string; line: string; willAnswer: boolean; answerAt?: number; verdict: SpamVerdict }
let ring: RingState | undefined;
const traySend = (msg: Record<string, unknown>) => { try { process.send?.(msg); } catch { /* Elternprozess weg */ } };
function ringInfo(): Record<string, unknown> {
  if (!ring) return { ringing: false };
  // Mit KI-Kennung braucht die Spam-Falle keine Bestätigung des Risikos
  const accepted = scamAllowed(loadSettings());
  return { ringing: true, ...ring, canTrap: accepted && Boolean(ai().key), trapHint: accepted ? '' : 'Spam-Falle erst unter Einstellungen › Spam-Abwehr bestätigen' };
}
manager.on('ring', (r: { caller: string; called: string; willAnswer: boolean; answerAt?: number }) => {
  const s = loadSettings();
  if (ring && ring.caller === r.caller && ring.called === r.called) {
    // Derselbe Anruf, nur anderer Zustand (z. B. „klingeln lassen")
    Object.assign(ring, { willAnswer: r.willAnswer, answerAt: r.answerAt });
    bus.emit('message', { type: 'ring', ring: ringInfo() });
    return;
  }
  const contact = contacts.findByNumber(r.caller);
  const prof = profileFor(r.called, parseProfiles(s.incomingProfiles, s.incomingIdentities));
  const numbered = /\d{3,}/.test(r.caller.replace(/\D/g, ''));
  const spamCalls = numbered ? store.listByNumber(r.caller).filter((x) => x.spam).length : 0;
  const local = localVerdict(r.caller, { contactName: contact?.name, scamNumbers: s.scamNumbers, spamCalls });
  const mine: RingState = { caller: r.caller, called: r.called, callerName: contact?.name, line: prof?.name || s.principal || '', willAnswer: r.willAnswer, answerAt: r.answerAt, verdict: local };
  ring = mine;
  log.info(`Klingeln: Einschätzung „${local.label}" (${local.source})`);
  if (s.ringPopup !== 'off') traySend({ type: 'ring' });
  bus.emit('message', { type: 'ring', ring: ringInfo() });
  // Online-Abfrage nur, wenn erlaubt, und nie für Kontakte oder Nummern von der eigenen Liste
  if (s.spamLookup === 'on' && numbered && local.level !== 'contact' && local.source !== 'liste') {
    lookupTellows(r.caller)
      .then((t) => {
        if (ring !== mine || !t) return;
        mine.verdict = withTellows(local, t);
        log.info(`Klingeln: tellows-Score ${t.score} → „${mine.verdict.label}"`);
        bus.emit('message', { type: 'ring', ring: ringInfo() });
      })
      .catch(() => undefined);
  }
});
manager.on('ringEnd', () => {
  if (!ring) return;
  ring = undefined;
  traySend({ type: 'ringEnd' });
  bus.emit('message', { type: 'ring', ring: { ringing: false } });
});
function divertRing(mode: 'scam' | 'answer' | 'skip'): { ok: boolean; reason: string } {
  if (mode === 'scam' && !scamAllowed(loadSettings())) return { ok: false, reason: 'Spam-Falle erst unter Einstellungen › Spam-Abwehr bestätigen (einmalig, wegen des rechtlichen Hinweises)' };
  return manager.divertIncoming(mode);
}

function needKey(what: string): string {
  const { provider, key } = ai();
  if (!key) throw new Error(`${what} braucht den ${provider.label}-Schlüssel (Einstellungen › KI-Verbindungen)`);
  return key;
}

// ---- Einrichtungsassistent: Zustand ohne Geheimnisse; Zugangsdaten werden geprüft und erst dann in die .env geschrieben ----
const envFile = join(dataDir, '.env');
function setupStatus(): Record<string, unknown> {
  const s = loadSettings();
  const st = manager.status();
  const sipConfigured = Boolean(config.sipUser && config.sipPassword);
  return {
    available: true,
    // Der Assistent meldet sich von selbst, solange das Nötigste fehlt und er nicht übersprungen wurde
    needed: s.setupDone !== 'on' && (!sipConfigured || !ai().key || !s.principal.trim()),
    done: s.setupDone === 'on',
    sip: { server: config.sipServer, user: config.sipUser, hasPassword: Boolean(config.sipPassword), configured: sipConfigured, registered: st.registered, error: st.sipError ? explainSipError(st.sipError, config.sipServer) : undefined },
    ai: aiInfo(),
    openai: { hasKey: Boolean(providerKey(PROVIDERS.openai)) },
    principal: s.principal.trim().length > 0,
  };
}

async function saveSip(input: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  // Maske oder leer = das hinterlegte Kennwort behalten – aber nur, wenn Anlage und Benutzer dieselben bleiben:
  // Sonst ginge das gespeicherte Kennwort (als Digest) an eine andere, womöglich fremde Gegenstelle
  const sameTarget = String(input.server ?? '').trim().toLowerCase() === config.sipServer.toLowerCase() && String(input.user ?? '').trim() === config.sipUser;
  const keep = input.password === SECRET_MASK || input.password === '' || input.password === undefined;
  if (keep && !(sameTarget && config.sipPassword)) return { ok: false, error: 'Bitte das Kennwort eingeben.' };
  let account;
  try {
    account = cleanSipAccount({ ...input, password: keep ? config.sipPassword : input.password });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (manager.status().phase !== 'idle' && manager.status().phase !== 'offline' && manager.status().phase !== 'starting') return { ok: false, error: 'Bitte erst das laufende Gespräch beenden.' };
  const test = await testSipAccount(account, { localIp: config.localIp });
  if (!test.ok) {
    log.warn(`Einrichtung: Anmeldung an ${account.server} fehlgeschlagen (${test.error})`);
    return test;
  }
  try {
    writeEnvValues(envFile, { SIP_SERVER: account.server, SIP_USER: account.user, SIP_PASSWORD: account.password });
  } catch (err) {
    return { ok: false, error: `Die Zugangsdaten stimmen, ließen sich aber nicht speichern: ${(err as Error).message}` };
  }
  Object.assign(config, { sipServer: account.server, sipUser: account.user, sipPassword: account.password });
  log.info(`Einrichtung: Zugangsdaten zur Telefonanlage ${account.server} gespeichert (.env) – melde neu an`);
  const r = await manager.reconfigureSip(account);
  return r.ok ? { ok: true } : { ok: false, error: `Gespeichert, aber die Anmeldung steht noch nicht: ${explainSipError(r.error ?? '', account.server)}` };
}

/** KI-Verbindungen für Oberfläche und Assistent: welche es gibt, welche aktiv ist, wer einen Schlüssel hat – nie der Schlüssel selbst. */
function aiInfo(): Record<string, unknown> {
  const s = loadSettings();
  const active = resolveAi(s);
  return {
    active: active.connection.id,
    provider: active.provider.id,
    hasKey: Boolean(active.key),
    connections: connectionsFrom(s).list.map((c) => {
      const r = resolveAi(s, process.env, c.id);
      return { ...c, providerLabel: r.provider.label, hasKey: Boolean(r.key), effectiveVoice: connectionVoice(c, s.voice), effectiveModel: r.realtimeModel(), effectiveTextModel: r.textModel, defaultRealtime: r.defaultRealtime, defaultText: r.defaultText };
    }),
    providers: PROVIDER_IDS.map((id) => {
      const p = PROVIDERS[id];
      return { id, label: p.label, keyUrl: p.keyUrl, voices: p.voices, models: p.defaults.known, maxCallSeconds: p.maxCallSeconds ?? null, supports: p.supports };
    }),
    maxConnections: MAX_CONNECTIONS,
  };
}

/** Stammdaten der Oberfläche, die von der aktiven Verbindung abhängen. */
function aiUiData(): Record<string, unknown> {
  const active = ai();
  return {
    voices: active.provider.voices,
    model: active.realtimeModel(),
    modelNotes: { budget: BUDGET_MODELS },
    aiAvailable: Boolean(active.key),
    ai: aiInfo(),
  };
}

/**
 * Verbindung zur Kennung (ohne Angabe: die aktive). Für ältere Aufrufer gilt auch die Kennung eines Anbieters:
 * dann die aktive Verbindung, wenn sie zu ihm gehört, sonst seine erste.
 */
function connectionById(id: unknown): AiConnection | undefined {
  const { list, active } = connectionsFrom(loadSettings());
  if (id === undefined || id === null || id === '') return active;
  return list.find((c) => c.id === id) ?? (active.provider === id ? active : list.find((c) => c.provider === id));
}

/** Schlüssel einer Verbindung prüfen und in die .env schreiben; er wird nie zurückgegeben und steht in keinem Log. */
async function saveAiKey(connectionId: unknown, input: unknown): Promise<{ ok: boolean; error?: string }> {
  const connection = connectionById(connectionId);
  if (!connection) return { ok: false, error: 'Unbekannte KI-Verbindung' };
  const provider = providerById(connection.provider);
  let key;
  try {
    key = provider.cleanKey(input);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const check = await provider.checkKey(key);
  if (!check.ok) return check;
  // Während der Prüfung entfernt: Der Schlüssel bliebe sonst ohne Verbindung in der .env liegen
  if (!connectionsFrom(loadSettings()).list.some((c) => c.id === connection.id && c.provider === connection.provider)) return { ok: false, error: 'Unbekannte KI-Verbindung' };
  const keyEnv = connectionKeyEnv(connection);
  try {
    writeEnvValues(envFile, { [keyEnv]: key });
  } catch (err) {
    return { ok: false, error: `Der Schlüssel stimmt, ließ sich aber nicht speichern: ${(err as Error).message}` };
  }
  if (keyEnv === 'OPENAI_API_KEY') config.openaiApiKey = key;
  catalogFor(connection).clear();
  log.info(`Einrichtung: Schlüssel der KI-Verbindung „${connection.name}“ (${provider.label}) geprüft und gespeichert (.env)`);
  return { ok: true };
}

/**
 * Verbindungen ändern: genannte ersetzen, neue anlegen, ausdrücklich genannte entfernen, die aktive umschalten.
 * Entfernte Verbindungen verlieren ihren Schlüssel in der .env. Ein laufendes Gespräch behält, womit es begonnen hat.
 */
function saveConnections(input: Record<string, unknown>): { ok: boolean; error?: string } {
  const s = loadSettings();
  const before = connectionsFrom(s);
  let next: AiConnection[];
  let removed: AiConnection[];
  try {
    ({ next, removed } = mergeConnections(before.list, input.connections, input.remove));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const wanted = typeof input.active === 'string' ? input.active : before.active.id;
  const active = next.find((c) => c.id === wanted) ?? next.find((c) => c.id === before.active.id) ?? next[0];
  try {
    // Erst die Liste, dann die Schlüssel: Scheitert das Speichern, bleibt die Verbindung samt Schlüssel, wie sie war
    const saved = saveSettings({}, { aiConnections: JSON.stringify(next), aiConnection: active.id });
    if (removed.length) writeEnvValues(envFile, Object.fromEntries(removed.map((c) => [connectionKeyEnv(c), ''])));
    if (removed.some((c) => connectionKeyEnv(c) === 'OPENAI_API_KEY')) config.openaiApiKey = undefined;
    onSettingsChanged(saved);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  for (const c of removed) log.info(`KI-Verbindung „${c.name}“ entfernt, ihr Schlüssel ist aus der .env gelöscht`);
  log.info(`KI-Verbindungen gespeichert (${next.length}), aktiv: „${active.name}“ (${providerById(active.provider).label})`);
  return { ok: true };
}

// Modelle zur Auswahl: je Verbindung geladen und zwischengespeichert (jede hat ihren eigenen Schlüssel, der zur Laufzeit dazukommen kann)
const catalogs = new Map<string, ModelCatalog>();
function catalogFor(c: AiConnection): ModelCatalog {
  const id = `${c.id}:${c.provider}`;
  let catalog = catalogs.get(id);
  if (!catalog) {
    const p = providerById(c.provider);
    catalog = new ModelCatalog(() => connectionKey(c), fetch, undefined, undefined, (key, fetchImpl) => p.fetchModels(key, fetchImpl), `Der ${p.label}-Schlüssel fehlt noch (Einstellungen › KI-Verbindungen).`);
    catalogs.set(id, catalog);
  }
  return catalog;
}

// ---- Monatsverbrauch: eigener Zähler je Anbieter; die Kosten laut OpenAI nur mit hinterlegtem Admin-Schlüssel ----
const usageCounter = new UsageCounter(join(dataDir, 'usage.json'));
if (usageCounter.empty) {
  // Erster Start mit Zähler: den laufenden Monat aus den noch vorhandenen Protokollen nachtragen (ohne Angabe im Protokoll: OpenAI)
  const month = monthKey(new Date());
  try {
    for (const r of store.list()) {
      const at = new Date(r.startedAt);
      if (typeof r.costUsd === 'number' && monthKey(at) === month) usageCounter.add(store.read(r.id)?.provider ?? 'openai', r.durationSec, r.costUsd, at);
    }
  } catch (err) {
    // Der Zähler ist eine Zusatzanzeige: Lässt er sich nicht schreiben, startet die App trotzdem
    log.warn(`Monatsverbrauch nicht nachgetragen: ${(err as Error).message}`);
  }
}
const adminKey = () => process.env.OPENAI_ADMIN_KEY?.trim() || undefined;
let billed: { usd?: number; error?: string; fetchedAt: number; key: string } | undefined;
async function usageInfo(refresh: boolean): Promise<Record<string, unknown>> {
  const key = adminKey();
  // Die Kosten ändern sich bei OpenAI nur tageweise: höchstens alle 30 Minuten neu fragen, außer auf Knopfdruck
  if (key && (refresh || !billed || billed.key !== key || Date.now() - billed.fetchedAt > 30 * 60_000)) {
    try {
      billed = { usd: await fetchOpenAiMonthCosts(key), fetchedAt: Date.now(), key };
    } catch (err) {
      billed = { error: (err as Error).message, fetchedAt: Date.now(), key };
    }
  }
  return {
    month: monthKey(new Date()),
    providers: usageCounter.month(),
    openaiBilled: key ? { hasAdminKey: true, usd: billed?.usd, error: billed?.error, fetchedAt: billed ? new Date(billed.fetchedAt).toISOString() : null } : { hasAdminKey: false },
  };
}
async function saveAdminKey(input: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    if (String(input ?? '').trim() === '') {
      writeEnvValues(envFile, { OPENAI_ADMIN_KEY: '' });
      billed = undefined;
      log.info('OpenAI-Admin-Schlüssel entfernt (.env)');
      return { ok: true };
    }
    const key = cleanAdminKey(input);
    const usd = await fetchOpenAiMonthCosts(key);
    writeEnvValues(envFile, { OPENAI_ADMIN_KEY: key });
    billed = { usd, fetchedAt: Date.now(), key };
    log.info('OpenAI-Admin-Schlüssel geprüft und gespeichert (.env)');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Nach dem Speichern von Einstellungen: was sofort gelten soll, an die laufenden Teile weitergeben. */
function onSettingsChanged(s: FormSettings): void {
  manager.setIncoming(incomingFrom(s));
  const t = tuningFrom(s);
  manager.setMaxCallSeconds(resolveAi(s).callLimit(t.maxCallSeconds));
  store.setRetention(t.retentionDays);
  gateway.policyChanged();
}

// Mail-Konfiguration kommt aus den Einstellungen (UI) und wird bei jedem Versand neu gelesen
const mailConfig = () => mailConfigFrom(loadSettings());
const mailer = new Mailer(mailConfig, mailTokens);
const mailLogin = new OAuthLogin(() => oauthFrom(mailConfig()), `http://127.0.0.1:${config.webPort}/oauth/callback`, mailTokens);

const stopWeb = startWebServer({
  mail: {
    status: () => mailer.status() as unknown as Record<string, unknown>,
    loginUrl: () => mailLogin.authUrl(),
    callback: (code, state) => mailLogin.handleCallback(code, state),
    sendTest: () => {
      const st = loadSettings();
      const mail = buildTestMail(mailConfigFrom(st).provider, { subject: st.mailSubject, body: st.mailBody });
      return mailer.send(mail.subject, mail.text, mail.html);
    },
    verify: () => mailer.verify(),
    autoconfig: (email) => suggestMail(email),
  },
  port: config.webPort,
  onListening: () => writePortFile(dataDir, config.webPort),
  // Neustart über die Tray-App (z. B. nach einer Portänderung); ohne sie muss von Hand neu gestartet werden
  restart: typeof process.send === 'function' ? () => traySend({ type: 'restart' }) : undefined,
  manager,
  createHandler,
  modes,
  bus,
  store,
  contacts,
  onSettingsChanged,
  ring: { info: ringInfo, divert: divertRing },
  // Der Schlüssel kann zur Laufzeit dazukommen (Einrichtungsassistent): bei jedem Aufruf neu prüfen
  complaint: async (record) => {
    needKey('Der Beschwerde-Entwurf');
    return draftComplaint(ai().ask, record, contacts.findByNumber(record.target)?.name);
  },
  voiceSample: async (voice, connectionId) => {
    // Ohne Angabe die aktive Verbindung; sonst die genannte (Hörprobe beim Wählen ihrer Standardstimme)
    const connection = connectionById(connectionId);
    if (!connection) throw new Error('Unbekannte KI-Verbindung');
    const provider = providerById(connection.provider);
    const key = connectionKey(connection);
    if (!key) throw new Error(`Die Hörprobe braucht den ${provider.label}-Schlüssel (Einstellungen › KI-Verbindungen)`);
    if (!provider.voices.includes(voice)) throw new Error(`Unbekannte Stimme: ${voice}`);
    const s = loadSettings();
    return voiceSample(provider, key, voice, sampleText(s.aiName || 'Alex', s.principal || 'Max'), join(dataDir, 'voice-samples', ...(provider.id === 'openai' ? [] : [provider.id])));
  },
  models: async (refresh, connectionId) => {
    const connection = connectionById(connectionId);
    if (!connection) throw new Error('Unbekannte KI-Verbindung');
    const provider = providerById(connection.provider);
    const state = { ...(await catalogFor(connection).get(refresh)), provider: provider.id, connection: connection.id };
    if (refresh) log[state.error ? 'warn' : 'info'](state.error ? `Modell-Liste nicht aktualisiert: ${state.error}` : `Modell-Liste von ${provider.label} geladen (${state.realtime.length} Sprach-, ${state.text.length} Textmodelle)`);
    return state as unknown as Record<string, unknown>;
  },
  setup: { status: setupStatus, saveSip, saveAiKey },
  mcp: {
    info: () => ({ ...gateway.info(), connect: mcpConnect() }),
    agents: () => ({ agents: agentStatus(agentEnv, mcpConnect()) }),
    agentAction,
    approve: (id, allow) => gateway.approve(id, allow),
    run: (tool, args, client) => gateway.run(tool, args, client),
    http: (req, res, body) => handleMcpHttp(req, res, body, (tool, args) => gateway.run(tool, args, String(req.headers['user-agent'] ?? 'http'))),
  },
  ai: {
    test: async (id) => {
      const connection = connectionById(id);
      if (!connection) throw new Error('Unbekannte KI-Verbindung');
      const r = resolveAi(loadSettings(), process.env, connection.id);
      const result = await testConnection(r.provider, r.key, r.realtimeModel());
      log[result.ok ? 'info' : 'warn'](`Verbindungstest „${connection.name}“ (${r.provider.label}, ${result.model}): ${result.steps.map((st) => `${st.id} ${st.ok ? 'ok' : st.skipped ? 'übersprungen' : 'fehlgeschlagen'}`).join(', ')}`);
      return result as unknown as Record<string, unknown>;
    },
    saveConnections: async (body) => saveConnections(body),
  },
  usage: { get: usageInfo, saveAdminKey },
  uiData: () => ({
    personas: personas.map(({ id, label }) => ({ id, label })),
    // Eine nicht lesbare settings.json fällt sonst nur im Log auf: Es gelten dann die Vorgaben, auch für die KI-Verbindung
    settingsBroken: settingsBroken(),
    ...aiUiData(),
    // Nur zur Anzeige auf der Technik-Seite; Zugangsdaten bleiben in der .env
    env: { version: VERSION, sipServer: config.sipServer, sipLocalPort: config.sipLocalPort, rtpPort: config.rtpPort, webPort: config.webPort, webPortMovedFrom, canRestart: typeof process.send === 'function', dataDir, hdAudio: config.hdAudio, liveListen: config.liveListenEnabled, ownerNumbers: config.ownerNumbers.length },
  }),
});
await manager.start();

// Tray-App (electron/main.cjs) bekommt Zustand und Fehler per IPC, falls wir als Kindprozess laufen
if (typeof process.send === 'function') {
  const send = (msg: Record<string, unknown>) => { try { process.send?.(msg); } catch { /* Elternprozess weg */ } };
  send({ type: 'ready', webPort: config.webPort, webPortMovedFrom, dataDir, setupNeeded: setupStatus().needed === true });
  manager.on('status', (s) => send({ type: 'status', phase: s.phase, registered: s.registered, incoming: s.incomingSettings.enabled, target: s.target }));
  logEvents.on('line', (line: { level: string; text: string }) => { if (line.level === 'error') send({ type: 'error', message: line.text }); });
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Beende ...');
  stopWeb();
  removePortFile(dataDir, config.webPort);
  await manager.stop();
  process.exit(0);
}
// Die Tray-App bittet per IPC ums Beenden: SIGTERM beendet einen Kindprozess unter Windows sofort,
// ohne dass ein laufendes Gespräch aufgelegt oder die Registrierung abgemeldet wird
process.on('message', (msg: unknown) => {
  if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'shutdown') void shutdown();
});
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
