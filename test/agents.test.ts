// SIPFunk bei KI-Agenten eintragen, erkennen, aktualisieren und entfernen. Alles in einem temporären Benutzerordner:
// Die echten Konfigurationen des Benutzers werden nie gelesen oder geschrieben, und es wird kein Programm gestartet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentStatus, installAgent, removeAgent, tomlRemove, tomlSet, type AgentEnv, type McpTarget } from '../src/mcp/agents.js';

const target = (port: number): McpTarget => ({
  httpUrl: `http://127.0.0.1:${port}/mcp`,
  stdio: { command: 'C:\\Programme\\SIPFunk\\SIPFunk.exe', args: ['C:\\Programme\\SIPFunk\\resources\\app.asar\\dist\\mcp\\server.js'], env: { SIPFUNK_DATA_DIR: 'C:\\Daten\\SIPFunk', ELECTRON_RUN_AS_NODE: '1' } },
});
const T1 = target(3865), T2 = target(3866);
const NOW = new Date('2026-11-12T10:20:30Z');

function sandbox(): { env: AgentEnv; home: string; calls: string[][]; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'sipfunk-agents-'));
  const calls: string[][] = [];
  const env: AgentEnv = { home, appData: join(home, 'AppData', 'Roaming'), localAppData: join(home, 'AppData', 'Local') };
  return { env, home, calls, done: () => rmSync(home, { recursive: true, force: true }) };
}
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const state = (env: AgentEnv, id: string, t = T1) => agentStatus(env, t).find((a) => a.id === id)!.state;
const backups = (file: string) => readdirSync(dirname(file)).filter((f) => f.endsWith('.bak'));

test('Agenten: ohne Ordner „nicht gefunden“, mit Ordner „nicht eingetragen“', () => {
  const s = sandbox();
  try {
    assert.deepEqual(agentStatus(s.env, T1).map((a) => a.state), ['absent', 'absent', 'absent', 'absent', 'absent', 'absent']);
    mkdirSync(join(s.home, '.cursor'));
    assert.equal(state(s.env, 'cursor'), 'missing');
    assert.equal(state(s.env, 'codex'), 'absent');
  } finally { s.done(); }
});

test('Cursor (JSON): Eintrag ergänzen, fremde Einträge und Formatierung bleiben, Sicherungskopie entsteht', async () => {
  const s = sandbox();
  try {
    const file = join(s.home, '.cursor', 'mcp.json');
    const before = '{\r\n    "mcpServers": {\r\n        "anderer": {\r\n            "url": "https://example.org/mcp"\r\n        }\r\n    },\r\n    "sonstiges": 1\r\n}\r\n';
    put(file, before);
    const r = await installAgent('cursor', s.env, T1, NOW);
    assert.equal(r.changed, true);
    assert.equal(r.agent.state, 'ok');
    const after = readFileSync(file, 'utf8');
    // Einrückung (4 Leerzeichen), Zeilenenden (CRLF) und die Reihenfolge der fremden Einträge wie vorher
    assert.equal(after, '{\r\n    "mcpServers": {\r\n        "anderer": {\r\n            "url": "https://example.org/mcp"\r\n        },\r\n        "sipfunk": {\r\n            "url": "http://127.0.0.1:3865/mcp"\r\n        }\r\n    },\r\n    "sonstiges": 1\r\n}\r\n');
    assert.equal(r.backup, `${file}.sipfunk-2026-11-12T10-20-30.bak`);
    assert.equal(readFileSync(r.backup!, 'utf8'), before);
    // Schon aktuell: nichts schreiben, keine zweite Sicherung
    assert.equal((await installAgent('cursor', s.env, T1, new Date('2026-11-12T11:00:00Z'))).changed, false);
    assert.equal(backups(file).length, 1);
  } finally { s.done(); }
});

test('Portänderung: Eintrag gilt als veraltet und lässt sich aktualisieren; Entfernen lässt den Rest stehen', async () => {
  const s = sandbox();
  try {
    const file = join(s.home, '.cursor', 'mcp.json');
    put(file, '{\n  "mcpServers": {\n    "anderer": {\n      "command": "x"\n    }\n  }\n}\n');
    await installAgent('cursor', s.env, T1, NOW);
    assert.equal(state(s.env, 'cursor', T2), 'stale');
    const up = await installAgent('cursor', s.env, T2, new Date('2026-11-12T10:21:00Z'));
    assert.equal(up.agent.state, 'ok');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.sipfunk.url, T2.httpUrl);
    const rm = await removeAgent('cursor', s.env, T2, new Date('2026-11-12T10:22:00Z'));
    assert.equal(rm.agent.state, 'missing');
    assert.equal(readFileSync(file, 'utf8'), '{\n  "mcpServers": {\n    "anderer": {\n      "command": "x"\n    }\n  }\n}\n');
    assert.equal(backups(file).length, 3);
    // Nichts eingetragen: Entfernen schreibt nicht
    assert.equal((await removeAgent('cursor', s.env, T2)).changed, false);
  } finally { s.done(); }
});

test('Neue Datei: Ordner da, Datei fehlt oder ist leer', async () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.gemini'));
    const r = await installAgent('gemini-cli', s.env, T1, NOW);
    assert.equal(r.backup, undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, '.gemini', 'settings.json'), 'utf8')), { mcpServers: { sipfunk: { httpUrl: T1.httpUrl } } });
    put(join(s.home, '.copilot', 'mcp-config.json'), '');
    await installAgent('copilot-cli', s.env, T1, NOW);
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, '.copilot', 'mcp-config.json'), 'utf8')), { mcpServers: { sipfunk: { type: 'http', url: T1.httpUrl, tools: ['*'] } } });
  } finally { s.done(); }
});

test('Datei mit Kommentaren oder unerwartetem Aufbau: nicht anfassen', async () => {
  const s = sandbox();
  try {
    const file = join(s.home, '.cursor', 'mcp.json');
    for (const text of ['{\n  // Kommentar\n  "mcpServers": {}\n}\n', '[]', '{"mcpServers": []}', '{"mcpServers": ']) {
      put(file, text);
      assert.equal(state(s.env, 'cursor'), 'unreadable', text);
      await assert.rejects(installAgent('cursor', s.env, T1, NOW), /von Hand/);
      await assert.rejects(removeAgent('cursor', s.env, T1, NOW), /von Hand/);
      assert.equal(readFileSync(file, 'utf8'), text);
    }
    assert.equal(backups(file).length, 0);
  } finally { s.done(); }
});

test('Claude Desktop: Eintrag als Prozess; Store-Fassung wird gefunden; anderer Programmpfad gilt als veraltet', async () => {
  const s = sandbox();
  try {
    const file = join(s.env.appData, 'Claude', 'claude_desktop_config.json');
    put(file, '{"globalShortcut":"Alt+C","mcpServers":{"fs":{"command":"npx","args":["-y","fs"]}}}');
    const r = await installAgent('claude-desktop', s.env, T1, NOW);
    assert.equal(r.agent.transport, 'stdio');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data.mcpServers.sipfunk, T1.stdio);
    assert.deepEqual(data.mcpServers.fs, { command: 'npx', args: ['-y', 'fs'] });
    assert.equal(data.globalShortcut, 'Alt+C');
    // Der Prozess findet den Port selbst: Eine Portänderung macht den Eintrag nicht ungültig
    assert.equal(state(s.env, 'claude-desktop', T2), 'ok');
    assert.equal(state(s.env, 'claude-desktop', { ...T1, stdio: { ...T1.stdio, command: 'D:\\Neu\\SIPFunk.exe' } }), 'stale');
  } finally { s.done(); }
  const store = sandbox();
  try {
    const dir = join(store.env.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    mkdirSync(dir, { recursive: true });
    const r = await installAgent('claude-desktop', store.env, T1, NOW);
    assert.equal(r.agent.file, join(dir, 'claude_desktop_config.json'));
    assert.ok(existsSync(r.agent.file));
  } finally { store.done(); }
});

test('Codex (TOML): Abschnitt anhängen, ersetzen und entfernen; der Rest bleibt Zeichen für Zeichen', async () => {
  const s = sandbox();
  try {
    const file = join(s.home, '.codex', 'config.toml');
    const before = '# Meine Einstellungen\nmodel = "gpt-x"\n\n[mcp_servers.anderer]\ncommand = "npx"\nargs = ["-y", "x"]\n\n[mcp_servers.anderer.env]\nKEY = "v"\n';
    put(file, before);
    assert.equal(state(s.env, 'codex'), 'missing');
    const r = await installAgent('codex', s.env, T1, NOW);
    assert.equal(r.agent.state, 'ok');
    assert.equal(readFileSync(file, 'utf8'), `${before}\n[mcp_servers.sipfunk]\nurl = "http://127.0.0.1:3865/mcp"\ntool_timeout_sec = 120\n`);
    assert.equal(readFileSync(r.backup!, 'utf8'), before);
    assert.equal(state(s.env, 'codex', T2), 'stale');
    await installAgent('codex', s.env, T2, new Date('2026-11-12T10:21:00Z'));
    assert.equal(readFileSync(file, 'utf8'), `${before}\n[mcp_servers.sipfunk]\nurl = "http://127.0.0.1:3866/mcp"\ntool_timeout_sec = 120\n`);
    await removeAgent('codex', s.env, T2, new Date('2026-11-12T10:22:00Z'));
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { s.done(); }
});

test('TOML: alter Eintrag als Prozess mit Unterabschnitt mitten in der Datei, CRLF', () => {
  const text = 'a = 1\r\n\r\n[mcp_servers.sipfunk]\r\ncommand = \'C:\\SIPFunk.exe\'\r\n\r\n[mcp_servers.sipfunk.env]\r\nSIPFUNK_URL = "http://127.0.0.1:8080"\r\n\r\n[profiles.x]\r\nmodel = "y"\r\n';
  assert.equal(tomlRemove(text), 'a = 1\r\n\r\n[profiles.x]\r\nmodel = "y"\r\n');
  assert.equal(tomlSet(text, 'http://127.0.0.1:3865/mcp'), 'a = 1\r\n\r\n[profiles.x]\r\nmodel = "y"\r\n\r\n[mcp_servers.sipfunk]\r\nurl = "http://127.0.0.1:3865/mcp"\r\ntool_timeout_sec = 120\r\n');
  assert.equal(tomlSet('', 'http://x/mcp'), '[mcp_servers.sipfunk]\nurl = "http://x/mcp"\ntool_timeout_sec = 120\n');
  // Ähnliche Namen gehören nicht dazu
  const other = '[mcp_servers.sipfunk2]\nurl = "x"\n';
  assert.equal(tomlRemove(other), other);
});

test('Codex: Schreibweisen, die sich nicht sicher ändern lassen, werden nicht angefasst', async () => {
  const s = sandbox();
  try {
    const file = join(s.home, '.codex', 'config.toml');
    for (const text of ['mcp_servers = { sipfunk = { url = "http://127.0.0.1:1/mcp" } }\n', '[mcp_servers]\nsipfunk = { url = "x" }\n', 'mcp_servers.sipfunk.url = "x"\n']) {
      put(file, text);
      assert.equal(state(s.env, 'codex'), 'unreadable', text);
      await assert.rejects(installAgent('codex', s.env, T1, NOW), /von Hand/);
      assert.equal(readFileSync(file, 'utf8'), text);
    }
  } finally { s.done(); }
});

test('Claude Code: SIPFunk liest die Datei nur und trägt über den Befehl „claude mcp“ ein', async () => {
  const s = sandbox();
  try {
    const file = join(s.home, '.claude.json');
    const original = '{"numStartups":7,"mcpServers":{"sipfunk":{"type":"http","url":"http://127.0.0.1:8080/mcp"}}}';
    put(file, original);
    assert.equal(state(s.env, 'claude-code'), 'stale');
    // Ohne Befehl: klare Meldung, nichts geschrieben
    await assert.rejects(installAgent('claude-code', s.env, T1, NOW), /nicht aufrufen/);
    await assert.rejects(installAgent('claude-code', { ...s.env, run: async () => { throw new Error('ENOENT'); } }, T1, NOW), /nicht gefunden/);
    assert.equal(readFileSync(file, 'utf8'), original);
    // Mit Befehl: erst den alten Eintrag entfernen, dann neu anlegen; das Schreiben erledigt Claude Code selbst
    const run: AgentEnv['run'] = async (command, args) => {
      s.calls.push([command, ...args]);
      if (args[1] === 'add') writeFileSync(file, JSON.stringify({ numStartups: 7, mcpServers: { sipfunk: { type: 'http', url: args[args.length - 1] } } }));
      if (args[1] === 'remove') writeFileSync(file, JSON.stringify({ numStartups: 7, mcpServers: {} }));
      return { code: 0, output: '' };
    };
    const r = await installAgent('claude-code', { ...s.env, run }, T1, NOW);
    assert.deepEqual(s.calls, [['claude', 'mcp', 'remove', '--scope', 'user', 'sipfunk'], ['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'sipfunk', 'http://127.0.0.1:3865/mcp']]);
    assert.equal(r.agent.state, 'ok');
    assert.equal(r.backup, undefined);
    assert.equal(backups(file).length, 0);
    assert.equal((await removeAgent('claude-code', { ...s.env, run }, T1, NOW)).agent.state, 'missing');
    await assert.rejects(installAgent('claude-code', { ...s.env, run: async () => ({ code: 1, output: 'kaputt' }) }, T1, NOW), /kaputt/);
  } finally { s.done(); }
});

test('Unbekannter Agent wird abgelehnt', async () => {
  const s = sandbox();
  try {
    await assert.rejects(installAgent('gibtsnicht', s.env, T1), /Unbekannter Agent/);
    await assert.rejects(removeAgent('../x', s.env, T1), /Unbekannter Agent/);
  } finally { s.done(); }
});
