// MCP-Server über stdio für Agenten, die einen Prozess starten (Claude Desktop, Codex, Claude Code).
// Der Prozess selbst darf nichts: Jeder Tool-Aufruf geht per HTTP an die laufende SIPFunk-App auf 127.0.0.1,
// die Schalter, Erlaubnisse, Limits und den Rufzielschutz prüft (mcp/gateway.ts). SIPFunk muss also laufen.
//
// Start aus dem Repository: `npm run mcp`. Aus der installierten App: SIPFunk.exe mit ELECTRON_RUN_AS_NODE=1 und
// diesem Skript als Argument – die fertige Konfiguration zeigt die Web-UI unter „Einstellungen › MCP-Schnittstelle“.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './tools.js';
import { appBaseUrl } from '../webPort.js';

const server = createMcpServer(async (tool, args) => {
  // Bei jedem Aufruf neu: Ändert sich der Port der App, findet ihn der Prozess ohne Neustart des Agenten wieder
  const BASE = appBaseUrl(process.env);
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/mcp/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ tool, args, client: server.server.getClientVersion()?.name ?? 'stdio' }),
    });
  } catch (err) {
    return { text: `SIPFunk ist unter ${BASE} nicht erreichbar – läuft die App? (${(err as Error).message})`, isError: true };
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string; isError?: boolean; error?: string };
  if (!res.ok || typeof data.text !== 'string') return { text: data.error ?? `SIPFunk antwortet mit HTTP ${res.status}. Ist die laufende App älter als dieser MCP-Server?`, isError: true };
  return { text: data.text, isError: data.isError };
});

await server.connect(new StdioServerTransport());
