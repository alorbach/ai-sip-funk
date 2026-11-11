// MCP über Streamable HTTP auf dem Listener der Web-UI (nur 127.0.0.1, Pfad /mcp). Zustandslos: je Anfrage ein
// eigener Server samt Transport, Antworten als JSON ohne Ereignisstrom. Host und Origin prüft der Web-Server vorher.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type RunTool } from './tools.js';

export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, body: unknown, run: RunTool): Promise<void> {
  if (req.method !== 'POST') {
    // Kein Ereignisstrom und keine Sitzungen: GET und DELETE gibt es hier nicht
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
    return;
  }
  const server = createMcpServer(run);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
