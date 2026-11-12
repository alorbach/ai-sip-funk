// SIPFunk als MCP-Server in KI-Agenten eintragen, erkennen und wieder entfernen (Oberfläche: „Einstellungen › MCP-Schnittstelle“).
// Grundsätze: nur auf ausdrücklichen Klick schreiben, fremde Einträge nie anfassen, vor jedem Schreiben eine Sicherungskopie.
// Claude Code verwaltet seine Datei selbst (und schreibt sie laufend neu): Dort trägt der eigene Befehl „claude mcp“ ein,
// SIPFunk liest die Datei nur. Formate und Pfade laut Doku der Agenten, Stand November 2026.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileAtomic } from '../fsutil.js';

export const SERVER_NAME = 'sipfunk';

/** Wie SIPFunk erreichbar ist: Adresse für Streamable HTTP und der Befehl für den stdio-Prozess. */
export interface McpTarget {
  httpUrl: string;
  stdio: { command: string; args: string[]; env: Record<string, string> };
}

/** Umgebung des Benutzers; in Tests zeigen die Ordner auf ein temporäres Verzeichnis. */
export interface AgentEnv {
  home: string;
  appData: string;
  localAppData: string;
  /** Befehl eines Agenten ausführen (nur Claude Code); wirft, wenn es das Programm nicht gibt */
  run?: (command: string, args: string[]) => Promise<{ code: number; output: string }>;
}

/** 'absent' = Agent nicht gefunden · 'missing' = nicht eingetragen · 'ok' · 'stale' = Eintrag passt nicht mehr (z. B. alter Port) · 'unreadable' = Datei nicht auswertbar */
export type AgentState = 'absent' | 'missing' | 'ok' | 'stale' | 'unreadable';

export interface AgentInfo {
  id: string;
  label: string;
  state: AgentState;
  /** Datei, in der der Eintrag steht */
  file: string;
  transport: 'http' | 'stdio';
  /** Was nach dem Eintragen nötig ist, damit der Agent SIPFunk sieht */
  restart: string;
  /** Hinweis zum Zustand (z. B. warum die Datei nicht auswertbar ist) */
  detail?: string;
}

type Entry = Record<string, unknown>;

interface AgentDef {
  id: string;
  label: string;
  transport: 'http' | 'stdio';
  restart: string;
  file: (env: AgentEnv) => string;
  /** Agent gilt als vorhanden, wenn es diesen Ordner gibt */
  dir: (env: AgentEnv) => string;
  kind: 'json' | 'toml' | 'claude-cli';
  entry: (t: McpTarget) => Entry;
}

const stdioEntry = (t: McpTarget): Entry => ({ command: t.stdio.command, args: t.stdio.args, env: t.stdio.env });

/** Claude Desktop: klassische Installation unter %APPDATA%\Claude; die Store-Fassung (MSIX) legt die Datei in ihren Paketordner. */
function claudeDesktopDir(env: AgentEnv): string {
  const classic = join(env.appData, 'Claude');
  if (existsSync(classic)) return classic;
  try {
    const packages = join(env.localAppData, 'Packages');
    for (const name of readdirSync(packages)) {
      const dir = join(packages, name, 'LocalCache', 'Roaming', 'Claude');
      if (/^(AnthropicPBC\.)?Claude_/i.test(name) && existsSync(dir)) return dir;
    }
  } catch {
    /* kein Paketordner */
  }
  return classic;
}

const AGENTS: AgentDef[] = [
  {
    id: 'claude-code', label: 'Claude Code', transport: 'http', kind: 'claude-cli',
    restart: 'Gilt in jeder neuen Sitzung von Claude Code; laufende Sitzungen sehen die Änderung nicht.',
    file: (e) => join(e.home, '.claude.json'), dir: (e) => join(e.home, '.claude'),
    entry: (t) => ({ type: 'http', url: t.httpUrl }),
  },
  {
    id: 'claude-desktop', label: 'Claude Desktop', transport: 'stdio', kind: 'json',
    restart: 'Claude Desktop ganz beenden (auch im Infobereich der Taskleiste) und neu starten.',
    file: (e) => join(claudeDesktopDir(e), 'claude_desktop_config.json'), dir: claudeDesktopDir,
    entry: stdioEntry,
  },
  {
    id: 'codex', label: 'Codex', transport: 'http', kind: 'toml',
    restart: 'Gilt in jeder neuen Codex-Sitzung; App und IDE-Erweiterung einmal neu starten.',
    file: (e) => join(e.home, '.codex', 'config.toml'), dir: (e) => join(e.home, '.codex'),
    entry: (t) => ({ url: t.httpUrl }),
  },
  {
    id: 'cursor', label: 'Cursor', transport: 'http', kind: 'json',
    restart: 'In Cursor unter „Settings › MCP“ prüfen, ob „sipfunk“ aktiv ist; sonst Cursor neu starten.',
    file: (e) => join(e.home, '.cursor', 'mcp.json'), dir: (e) => join(e.home, '.cursor'),
    entry: (t) => ({ url: t.httpUrl }),
  },
  {
    id: 'gemini-cli', label: 'Gemini CLI', transport: 'http', kind: 'json',
    restart: 'Gilt in jeder neuen Sitzung der Gemini CLI.',
    file: (e) => join(e.home, '.gemini', 'settings.json'), dir: (e) => join(e.home, '.gemini'),
    entry: (t) => ({ httpUrl: t.httpUrl }),
  },
  {
    id: 'copilot-cli', label: 'GitHub Copilot CLI', transport: 'http', kind: 'json',
    restart: 'Gilt in jeder neuen Sitzung der Copilot CLI.',
    file: (e) => join(e.home, '.copilot', 'mcp-config.json'), dir: (e) => join(e.home, '.copilot'),
    entry: (t) => ({ type: 'http', url: t.httpUrl, tools: ['*'] }),
  },
];

/** JSON mit sortierten Schlüsseln: Die Reihenfolge der Felder (z. B. in „env“) soll beim Vergleich keine Rolle spielen. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, val: unknown) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Entry).sort(([a], [b]) => (a < b ? -1 : 1))) : val));

/** Der vorhandene Eintrag passt, wenn er alle Felder des erwarteten Eintrags mit gleichem Wert enthält. */
function entryMatches(existing: unknown, expected: Entry): boolean {
  if (!existing || typeof existing !== 'object') return false;
  return Object.entries(expected).every(([k, v]) => canonical((existing as Entry)[k]) === canonical(v));
}

/** Datei als Text lesen. Ist sie nicht in UTF-8 gespeichert, gingen beim Zurückschreiben Zeichen fremder Einträge kaputt: dann nicht anfassen. */
function readText(file: string): string {
  const raw = readFileSync(file);
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) throw new Error('Die Datei ist nicht in UTF-8 gespeichert – bitte den Eintrag von Hand ergänzen.');
  return text;
}

// ---- JSON-Dateien (mcpServers.sipfunk) ----

interface JsonDoc {
  data: Record<string, unknown>;
  bom: boolean;
  eol: string;
  indent: string;
  finalNewline: boolean;
}

/** Datei lesen; fehlt sie oder ist sie leer, entsteht ein leeres Dokument. Wirft bei Inhalt, der sich nicht verlustfrei schreiben ließe. */
function readJsonDoc(file: string): JsonDoc {
  const raw = existsSync(file) ? readText(file) : '';
  const bom = raw.startsWith('\uFEFF');
  const text = bom ? raw.slice(1) : raw;
  const doc: JsonDoc = { data: {}, bom, eol: text.includes('\r\n') ? '\r\n' : '\n', indent: /^([ \t]+)"/m.exec(text)?.[1] ?? '  ', finalNewline: text === '' || text.endsWith('\n') };
  if (!text.trim()) return doc;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Kommentare oder Kommas am Zeilenende gingen beim Neuschreiben verloren: lieber nicht anfassen
    throw new Error('Die Datei ist kein reines JSON (Kommentare oder Tippfehler?) – bitte den Eintrag von Hand ergänzen.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Die Datei hat einen unerwarteten Aufbau – bitte den Eintrag von Hand ergänzen.');
  const servers = (data as Record<string, unknown>).mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('„mcpServers“ hat einen unerwarteten Aufbau – bitte den Eintrag von Hand ergänzen.');
  doc.data = data as Record<string, unknown>;
  return doc;
}

function jsonText(doc: JsonDoc): string {
  const text = JSON.stringify(doc.data, null, doc.indent) + (doc.finalNewline ? '\n' : '');
  return (doc.bom ? '\uFEFF' : '') + (doc.eol === '\n' ? text : text.replace(/\n/g, doc.eol));
}

const jsonEntry = (doc: JsonDoc): unknown => (doc.data.mcpServers as Record<string, unknown> | undefined)?.[SERVER_NAME];

/** Claude Code legt Einträge ohne „--scope user“ je Projektordner ab (projects.<Ordner>.mcpServers); sie haben dort Vorrang. */
function projectEntries(doc: JsonDoc, expected: Entry): 'none' | 'same' | 'differ' {
  const projects = doc.data.projects;
  if (!projects || typeof projects !== 'object') return 'none';
  const entries = Object.values(projects as Record<string, unknown>).map((p) => ((p as Entry | null)?.mcpServers as Entry | undefined)?.[SERVER_NAME]).filter((e) => e !== undefined);
  return entries.length === 0 ? 'none' : entries.every((e) => entryMatches(e, expected)) ? 'same' : 'differ';
}

// ---- TOML (Codex): Abschnitt [mcp_servers.sipfunk] samt Unterabschnitten, rein auf Textebene ----

/** Kopfzeile einer Tabelle ([a.b] oder [[a.b]]) in ihre Namensteile zerlegen; undefined, wenn die Zeile keine ist. Anführungszeichen um einzelne Teile zählen nicht zum Namen. */
function tomlHeader(line: string): string[] | undefined {
  const m = /^\s*\[\[?((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\]"'#])*)\]\]?\s*(?:#.*)?$/.exec(line);
  if (!m) return undefined;
  const parts = m[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.]+/g) ?? [];
  return parts.map((p) => p.trim().replace(/^(["'])(.*)\1$/, '$2'));
}
const isOurs = (h: string[]): boolean => h[0] === 'mcp_servers' && h[1] === SERVER_NAME;
const TOML_UNSAFE = '„mcp_servers“ steht dort in einer Schreibweise, die SIPFunk nicht sicher ändern kann – bitte den Eintrag von Hand pflegen.';
/** Beginnt hier eine Tabelle? Nur ganze Kopfzeilen zählen, keine Zeile einer mehrzeiligen Liste wie „["a"],“. */
const TOML_TABLE = { test: (line: string): boolean => tomlHeader(line) !== undefined };

/**
 * Zeilen in „unser Abschnitt“ (samt Unterabschnitten) und den Rest teilen. Leerzeilen direkt nach unseren Werten gehören
 * zu uns; ein Kommentar vor der nächsten Tabelle gehört zu ihr und bleibt deshalb mit allem danach im Rest.
 */
function tomlSplit(text: string): { ours: string[]; rest: string[] } {
  const ours: string[] = [], rest: string[] = [];
  let block: string[] | undefined;
  const flush = () => {
    if (!block) return;
    let last = block.length - 1;
    while (last > 0 && /^\s*(#.*)?$/.test(block[last])) last--;
    let end = last + 1;
    while (end < block.length && block[end].trim() === '') end++;
    ours.push(...block.slice(0, end));
    rest.push(...block.slice(end));
    block = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (TOML_TABLE.test(line)) {
      if (isOurs(tomlHeader(line) ?? [])) { (block ??= []).push(line); continue; }
      flush();
    } else if (block && /^\s*\[/.test(line)) {
      // In unserem Abschnitt beginnt eine Zeile mit „[“, ist aber kein lesbarer Tabellenkopf: Wo der Abschnitt endet, ist dann nicht sicher
      throw new Error(TOML_UNSAFE);
    }
    (block ?? rest).push(line);
  }
  flush();
  return { ours, rest };
}

/** Schreibweisen, die sich nicht sicher auf Textebene ändern lassen (Inline-Tabelle, Punkt-Schlüssel). */
function tomlUnsupported(rest: string[]): boolean {
  const key = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`, name = String.raw`(?:sipfunk|"sipfunk"|'sipfunk')`;
  let table = '';
  for (const line of rest) {
    if (TOML_TABLE.test(line)) { table = (tomlHeader(line) ?? ['?']).join('.'); continue; }
    if (table === '' && new RegExp(String.raw`^\s*${key}\s*(=|\.\s*${name})`).test(line)) return true;
    if (table === 'mcp_servers' && new RegExp(String.raw`^\s*${name}\s*(=|\.)`).test(line)) return true;
  }
  return false;
}

/** Wert einer einfachen Zeichenkette im Hauptabschnitt, z. B. url = "…". */
function tomlValue(ours: string[], key: string): string | undefined {
  let first = true;
  for (const line of ours) {
    if (TOML_TABLE.test(line)) { if (!first) break; first = false; continue; }
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`).exec(line);
    if (!m) continue;
    if (m[2] !== undefined) return m[2];
    // TOML kennt Maskierungen, die JSON nicht kennt: Dann gilt der Wert als unbekannt (der Eintrag als veraltet)
    try { return JSON.parse(`"${m[1]}"`) as string; } catch { return undefined; }
  }
  return undefined;
}

/** Unseren Abschnitt herausnehmen. Alles andere bleibt Zeichen für Zeichen stehen, auch Leerzeilen und mehrzeilige Texte. */
export function tomlRemove(text: string): string {
  const { ours, rest } = tomlSplit(text);
  if (!ours.length) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = rest.join(eol);
  // Stand unser Abschnitt am Ende, gehört der Zeilenumbruch der Zeile davor wieder ans Dateiende
  return out && /\n$/.test(text) && !/\n$/.test(out) ? out + eol : out;
}

export function tomlSet(text: string, url: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const base = tomlRemove(text).replace(/\s+$/, '');
  // wait_for_events wartet bis zu 50 Sekunden: mit Abstand über der Vorgabe von Codex (60 s) bleiben
  const block = [`[mcp_servers.${SERVER_NAME}]`, `url = ${JSON.stringify(url)}`, 'tool_timeout_sec = 120'].join(eol);
  const out = (base ? base + eol + eol : '') + block + eol;
  // Sicherheitsnetz: Stünde der Abschnitt jetzt doppelt in der Datei, könnte Codex sie gar nicht mehr laden
  if (out.split(/\r?\n/).filter((l) => (tomlHeader(l) ?? []).join('.') === `mcp_servers.${SERVER_NAME}`).length !== 1) throw new Error(TOML_UNSAFE);
  return out;
}

// ---- Zustand ----

function statusOf(def: AgentDef, env: AgentEnv, target: McpTarget): AgentInfo {
  const file = def.file(env);
  const info: AgentInfo = { id: def.id, label: def.label, state: 'missing', file, transport: def.transport, restart: def.restart };
  if (!existsSync(file)) {
    if (!existsSync(def.dir(env))) info.state = 'absent';
    return info;
  }
  try {
    if (def.kind === 'toml') {
      const { ours, rest } = tomlSplit(readText(file));
      if (tomlUnsupported(rest)) throw new Error(TOML_UNSAFE);
      if (ours.length) info.state = tomlValue(ours, 'url') === target.httpUrl ? 'ok' : 'stale';
    } else {
      const doc = readJsonDoc(file);
      const entry = jsonEntry(doc);
      if (entry !== undefined) info.state = entryMatches(entry, def.entry(target)) ? 'ok' : 'stale';
      // Claude Code: Ein Eintrag in einem einzelnen Projekt hat dort Vorrang vor dem für alle Projekte
      if (def.kind === 'claude-cli') {
        const inProjects = projectEntries(doc, def.entry(target));
        if (inProjects === 'differ') info.detail = 'In mindestens einem Projekt gibt es einen eigenen Eintrag „sipfunk“ mit anderer Adresse; er hat dort Vorrang. Im Ordner des Projekts mit „claude mcp remove sipfunk“ entfernen.';
        if (inProjects === 'same') info.detail = 'Zusätzlich in einzelnen Projekten eingetragen; diese Einträge ändert SIPFunk nicht (im Ordner des Projekts: „claude mcp remove sipfunk“).';
      }
    }
  } catch (err) {
    info.state = 'unreadable';
    info.detail = (err as Error).message;
  }
  return info;
}

export function agentStatus(env: AgentEnv, target: McpTarget): AgentInfo[] {
  return AGENTS.map((def) => statusOf(def, env, target));
}

// ---- Schreiben ----

/** Sicherungskopie neben der Datei, mit Zeitstempel; liefert ihren Pfad (oder undefined, wenn es die Datei noch nicht gab). */
function backup(file: string, now: Date): string | undefined {
  if (!existsSync(file)) return undefined;
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let copy = `${file}.sipfunk-${stamp}.bak`;
  for (let n = 2; existsSync(copy); n++) copy = `${file}.sipfunk-${stamp}-${n}.bak`;
  copyFileSync(file, copy);
  return copy;
}

function write(file: string, text: string, now: Date): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  const copy = backup(file, now);
  // Ist die Datei eine Verknüpfung (z. B. in einen Ordner mit eigenen Einstellungen), das Ziel ändern statt sie zu ersetzen
  writeFileAtomic(existsSync(file) ? realpathSync(file) : file, text);
  return copy;
}

export interface AgentResult {
  agent: AgentInfo;
  /** Pfad der Sicherungskopie, falls eine Datei geändert wurde */
  backup?: string;
  changed: boolean;
}

const claudeMissing = (todo: string[]): Error => new Error(`Der Befehl „claude“ wurde nicht gefunden. Bitte im Terminal ausführen: claude ${todo.join(' ')}`);

/** `todo` ist der Befehl, um den es eigentlich geht: Fehlt das Programm, nennt ihn die Meldung zum Ausführen von Hand. */
async function runClaude(env: AgentEnv, args: string[], todo = args): Promise<{ code: number; output: string }> {
  if (!env.run) throw new Error('Claude Code lässt sich von hier nicht aufrufen.');
  try {
    return await env.run('claude', args);
  } catch {
    throw claudeMissing(todo);
  }
}

/** Gibt es den Befehl überhaupt? Vor der Sicherungskopie prüfen, damit ein fehlendes Programm keine Kopien hinterlässt. */
async function findClaude(env: AgentEnv, todo: string[]): Promise<void> {
  // Ein Fehlercode heißt hier: Das Programm gibt es nicht (die Shell meldet das je nach Sprache von Windows anders)
  if ((await runClaude(env, ['--version'], todo)).code !== 0) throw claudeMissing(todo);
}

/** Eintrag anlegen oder auf den aktuellen Stand bringen. */
export async function installAgent(id: string, env: AgentEnv, target: McpTarget, now = new Date()): Promise<AgentResult> {
  const def = AGENTS.find((a) => a.id === id);
  if (!def) throw new Error(`Unbekannter Agent: ${id}`);
  const before = statusOf(def, env, target);
  if (before.state === 'unreadable') throw new Error(`${def.label}: ${before.detail}`);
  if (before.state === 'ok') return { agent: before, changed: false };
  // Kein Ordner dieses Agenten: nichts anlegen (die Oberfläche bietet den Knopf dann auch nicht an)
  if (before.state === 'absent') throw new Error(`${def.label} wurde auf diesem Rechner nicht gefunden.`);
  const file = def.file(env);
  let copy: string | undefined;
  if (def.kind === 'claude-cli') {
    // Ein vorhandener Eintrag (alter Port) muss erst weg: „claude mcp add“ überschreibt nicht
    const add = ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, target.httpUrl];
    await findClaude(env, add);
    copy = backup(file, now);
    if (before.state === 'stale') await runClaude(env, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    const r = await runClaude(env, add);
    if (r.code !== 0) throw new Error(`Claude Code meldet einen Fehler: ${r.output.trim().slice(0, 300) || `Code ${r.code}`}`);
  } else if (def.kind === 'toml') {
    copy = write(file, tomlSet(existsSync(file) ? readText(file) : '', target.httpUrl), now);
  } else {
    const doc = readJsonDoc(file);
    doc.data.mcpServers = { ...(doc.data.mcpServers as Record<string, unknown> | undefined), [SERVER_NAME]: def.entry(target) };
    copy = write(file, jsonText(doc), now);
  }
  return { agent: statusOf(def, env, target), backup: copy, changed: true };
}

/** Eintrag entfernen; alles andere in der Datei bleibt. */
export async function removeAgent(id: string, env: AgentEnv, target: McpTarget, now = new Date()): Promise<AgentResult> {
  const def = AGENTS.find((a) => a.id === id);
  if (!def) throw new Error(`Unbekannter Agent: ${id}`);
  const before = statusOf(def, env, target);
  if (before.state === 'unreadable') throw new Error(`${def.label}: ${before.detail}`);
  if (before.state !== 'ok' && before.state !== 'stale') return { agent: before, changed: false };
  const file = def.file(env);
  let copy: string | undefined;
  if (def.kind === 'claude-cli') {
    const remove = ['mcp', 'remove', '--scope', 'user', SERVER_NAME];
    await findClaude(env, remove);
    copy = backup(file, now);
    const r = await runClaude(env, remove);
    if (r.code !== 0) throw new Error(`Claude Code meldet einen Fehler: ${r.output.trim().slice(0, 300) || `Code ${r.code}`}`);
  } else if (def.kind === 'toml') {
    copy = write(file, tomlRemove(readText(file)), now);
  } else {
    const doc = readJsonDoc(file);
    const servers = { ...(doc.data.mcpServers as Record<string, unknown>) };
    delete servers[SERVER_NAME];
    doc.data.mcpServers = servers;
    copy = write(file, jsonText(doc), now);
  }
  return { agent: statusOf(def, env, target), backup: copy, changed: true };
}

/** Befehl eines Agenten ausführen (Windows: über die Shell, weil „claude“ auch als .cmd installiert sein kann). Die Argumente sind feste, unverfängliche Werte. */
export function runCommand(command: string, args: string[], cwd = homedir()): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    if (args.some((a) => !/^[\w.:/-]+$/.test(a))) return reject(new Error('Unzulässiges Argument'));
    // Im Benutzerordner starten: Die Windows-Shell sucht ein Programm zuerst im aktuellen Ordner, und das wäre sonst der Datenordner
    // Unter Windows als eine Befehlszeile (Node warnt sonst bei Shell plus Argumentliste); die Argumente sind oben geprüft
    // Zugangsdaten aus der .env (SIP, KI-Schlüssel, Mail) gehen ein fremdes Programm nichts an
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SIP_|SMTP_|MAIL_|OPENAI_|GEMINI_|ELECTRON_)|KEY|TOKEN|SECRET|PASS/i.test(k)));
    const opts = { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const child = process.platform === 'win32' ? spawn([command, ...args].join(' '), { ...opts, shell: true }) : spawn(command, args, opts);
    let output = '';
    // Hängt das Programm, nicht ewig warten: Unter Windows beendet kill() nur die Shell davor
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, output: 'Keine Antwort innerhalb von 20 Sekunden.' }); }, 20_000);
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => { output += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Über die Shell gestartet meldet Windows ein fehlendes Programm mit Code 9009 bzw. Code 1 und diesem Text
      if (code === 9009 || (code !== 0 && /is not recognized as|konnte nicht gefunden werden/i.test(output))) return reject(new Error('nicht gefunden'));
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Ordner des angemeldeten Benutzers. */
export function userAgentEnv(e: NodeJS.ProcessEnv, home: string): AgentEnv {
  return { home, appData: e.APPDATA || join(home, 'AppData', 'Roaming'), localAppData: e.LOCALAPPDATA || join(home, 'AppData', 'Local'), run: runCommand };
}
