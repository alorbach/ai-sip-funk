// SIPFunk als MCP-Server in KI-Agenten eintragen, erkennen und wieder entfernen (Oberfläche: „Einstellungen › MCP-Schnittstelle“).
// Grundsätze: nur auf ausdrücklichen Klick schreiben, fremde Einträge nie anfassen, vor jedem Schreiben eine Sicherungskopie.
// Claude Code verwaltet seine Datei selbst (und schreibt sie laufend neu): Dort trägt der eigene Befehl „claude mcp“ ein,
// SIPFunk liest die Datei nur. Formate und Pfade laut Doku der Agenten, Stand November 2026.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
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

/** Der vorhandene Eintrag passt, wenn er alle Felder des erwarteten Eintrags mit gleichem Wert enthält. */
function entryMatches(existing: unknown, expected: Entry): boolean {
  if (!existing || typeof existing !== 'object') return false;
  return Object.entries(expected).every(([k, v]) => JSON.stringify((existing as Entry)[k]) === JSON.stringify(v));
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
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const bom = raw.startsWith('﻿');
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
  return (doc.bom ? '﻿' : '') + (doc.eol === '\n' ? text : text.replace(/\n/g, doc.eol));
}

const jsonEntry = (doc: JsonDoc): unknown => (doc.data.mcpServers as Record<string, unknown> | undefined)?.[SERVER_NAME];

// ---- TOML (Codex): Abschnitt [mcp_servers.sipfunk] samt Unterabschnitten, rein auf Textebene ----

const TOML_OURS = /^\s*\[\s*mcp_servers\s*\.\s*(?:sipfunk|"sipfunk"|'sipfunk')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const TOML_HEADER = /^\s*\[/;

/** Zeilen in „unser Abschnitt“ und den Rest teilen. */
function tomlSplit(text: string): { ours: string[]; rest: string[] } {
  const ours: string[] = [], rest: string[] = [];
  let inOurs = false;
  for (const line of text.split(/\r?\n/)) {
    if (TOML_HEADER.test(line)) inOurs = TOML_OURS.test(line);
    (inOurs ? ours : rest).push(line);
  }
  return { ours, rest };
}

/** Schreibweisen, die sich nicht sicher auf Textebene ändern lassen (Inline-Tabelle, Punkt-Schlüssel). */
function tomlUnsupported(rest: string[]): boolean {
  let table = '';
  for (const line of rest) {
    const header = /^\s*\[\s*([^\]]*?)\s*\]/.exec(line);
    if (header) { table = header[1].replace(/\s+/g, ''); continue; }
    if (table === '' && /^\s*mcp_servers\s*(=|\.\s*["']?sipfunk)/.test(line)) return true;
    if (table === 'mcp_servers' && /^\s*["']?sipfunk["']?\s*(=|\.)/.test(line)) return true;
  }
  return false;
}

/** Wert einer einfachen Zeichenkette im Hauptabschnitt, z. B. url = "…". */
function tomlValue(ours: string[], key: string): string | undefined {
  let first = true;
  for (const line of ours) {
    if (TOML_HEADER.test(line)) { if (!first) break; first = false; continue; }
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`).exec(line);
    if (m) return m[2] ?? (JSON.parse(`"${m[1]}"`) as string);
  }
  return undefined;
}

export function tomlRemove(text: string): string {
  const { ours, rest } = tomlSplit(text);
  if (!ours.length) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // Höchstens eine Leerzeile dort lassen, wo der Abschnitt stand
  return rest.join(eol).replace(/(\r?\n){3,}/g, eol + eol).replace(/^(\r?\n)+/, '').replace(/(\r?\n){2,}$/, eol);
}

export function tomlSet(text: string, url: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const base = tomlRemove(text).replace(/\s+$/, '');
  // wait_for_events wartet bis zu einer Minute: über der Vorgabe von Codex (60 s) bleiben
  const block = [`[mcp_servers.${SERVER_NAME}]`, `url = ${JSON.stringify(url)}`, 'tool_timeout_sec = 120'].join(eol);
  return (base ? base + eol + eol : '') + block + eol;
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
      const { ours, rest } = tomlSplit(readFileSync(file, 'utf8'));
      if (tomlUnsupported(rest)) throw new Error('„mcp_servers“ steht dort in einer Schreibweise, die SIPFunk nicht sicher ändern kann – bitte den Eintrag von Hand pflegen.');
      if (ours.length) info.state = tomlValue(ours, 'url') === target.httpUrl ? 'ok' : 'stale';
    } else {
      const entry = jsonEntry(readJsonDoc(file));
      if (entry !== undefined) info.state = entryMatches(entry, def.entry(target)) ? 'ok' : 'stale';
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
  const copy = `${file}.sipfunk-${stamp}.bak`;
  copyFileSync(file, copy);
  return copy;
}

function write(file: string, text: string, now: Date): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  const copy = backup(file, now);
  writeFileAtomic(file, text);
  return copy;
}

export interface AgentResult {
  agent: AgentInfo;
  /** Pfad der Sicherungskopie, falls eine Datei geändert wurde */
  backup?: string;
  changed: boolean;
}

async function runClaude(env: AgentEnv, args: string[]): Promise<{ code: number; output: string }> {
  if (!env.run) throw new Error('Claude Code lässt sich von hier nicht aufrufen.');
  try {
    return await env.run('claude', args);
  } catch {
    throw new Error('Der Befehl „claude“ wurde nicht gefunden. Bitte den Befehl unten kopieren und im Terminal ausführen.');
  }
}

/** Eintrag anlegen oder auf den aktuellen Stand bringen. */
export async function installAgent(id: string, env: AgentEnv, target: McpTarget, now = new Date()): Promise<AgentResult> {
  const def = AGENTS.find((a) => a.id === id);
  if (!def) throw new Error(`Unbekannter Agent: ${id}`);
  const before = statusOf(def, env, target);
  if (before.state === 'unreadable') throw new Error(`${def.label}: ${before.detail}`);
  if (before.state === 'ok') return { agent: before, changed: false };
  const file = def.file(env);
  let copy: string | undefined;
  if (def.kind === 'claude-cli') {
    // Ein vorhandener Eintrag (alter Port) muss erst weg: „claude mcp add“ überschreibt nicht
    if (before.state === 'stale') await runClaude(env, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    const r = await runClaude(env, ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, target.httpUrl]);
    if (r.code !== 0) throw new Error(`Claude Code meldet einen Fehler: ${r.output.trim().slice(0, 300) || `Code ${r.code}`}`);
  } else if (def.kind === 'toml') {
    copy = write(file, tomlSet(existsSync(file) ? readFileSync(file, 'utf8') : '', target.httpUrl), now);
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
    const r = await runClaude(env, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    if (r.code !== 0) throw new Error(`Claude Code meldet einen Fehler: ${r.output.trim().slice(0, 300) || `Code ${r.code}`}`);
  } else if (def.kind === 'toml') {
    copy = write(file, tomlRemove(readFileSync(file, 'utf8')), now);
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
export function runCommand(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    if (args.some((a) => !/^[\w.:/-]+$/.test(a))) return reject(new Error('Unzulässiges Argument'));
    const child = spawn(command, args, { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 20_000);
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
