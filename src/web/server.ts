// Lokale Web-UI: HTTP für Seite und API, WebSocket für Status, Log und Mithör-Audio.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AudioHandler, CallManager } from '../callManager.js';
import { log, logEvents } from '../log.js';
import { loadSettings, publicSettings, saveSettings, type FormSettings } from '../settings.js';
import type { CallRecord, TranscriptStore } from '../transcripts.js';
import type { ContactStore } from '../contacts.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

export type HandlerFactory = (mode: string, params: Record<string, unknown>) => AudioHandler;

export interface WebServerOptions {
  port: number;
  manager: CallManager;
  /** Erzeugt den Audio-Handler für einen Anruf; 'tone' und 'echo' gibt es immer, 'ai' nur mit OPENAI_API_KEY. */
  createHandler: HandlerFactory;
  modes: { id: string; label: string }[];
  /** Zusätzliche Stammdaten für die UI (Personas, Stimmen); wird je Abruf neu gebildet, weil sich z. B. der OpenAI-Schlüssel zur Laufzeit ändern kann */
  uiData: () => Record<string, unknown>;
  /** Einrichtungsassistent: Zustand ohne Geheimnisse, Zugangsdaten prüfen und in die .env schreiben */
  setup?: {
    status: () => Record<string, unknown>;
    saveSip: (input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    saveOpenAi: (key: unknown) => Promise<{ ok: boolean; error?: string }>;
  };
  /** Nach dem Speichern der Einstellungen (z. B. Anrufbeantworter umschalten) */
  onSettingsChanged?: (settings: FormSettings) => void;
  /** Hörprobe einer Stimme als MP3 (nur mit OpenAI-Key) */
  voiceSample: (voice: string) => Promise<Buffer>;
  /** Klingelnder Anruf: Zustand mit Spam-Einschätzung und Umleiten (Pop-up der Tray-App, Web-UI) */
  ring?: { info: () => Record<string, unknown>; divert: (mode: 'scam' | 'answer' | 'skip') => { ok: boolean; reason: string } };
  /** Beschwerde-Entwurf (Bundesnetzagentur) aus einem Spam-Protokoll (nur mit OpenAI-Key) */
  complaint: (record: CallRecord) => Promise<string>;
  /** E-Mail: Zustand, OAuth-Anmeldung, Probe-Mail */
  mail?: {
    status: () => Record<string, unknown>;
    loginUrl?: () => string;
    callback?: (code: string, state: string) => Promise<{ user: string }>;
    sendTest: () => Promise<void>;
    /** Verbindung und Anmeldung prüfen, ohne zu senden */
    verify: () => Promise<void>;
    /** Vorschlag für SMTP-Server usw. aus der Adresse */
    autoconfig: (email: string) => Promise<unknown>;
  };
  /** 'message' (obj) wird als JSON an alle Browser geschickt (Transkript, Usage) */
  bus: EventEmitter;
  store: TranscriptStore;
  contacts: ContactStore;
}

/** Größter angenommener Request-Body; die längsten echten Eingaben (Mail-Vorlage, Notizen) liegen weit darunter. */
const MAX_BODY_BYTES = 1_000_000;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Anfrage zu groß');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const data = JSON.parse(text) as unknown;
  // null, Listen und einfache Werte sind gültiges JSON, aber kein Formular
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON-Objekt erwartet');
  return data as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Nur die eigene Seite darf die Web-UI ansprechen: Host muss 127.0.0.1/localhost sein (gegen DNS-Rebinding),
 * und schickt der Browser einen Origin mit, muss er dazu passen (gegen Zugriffe fremder Webseiten auf API und WebSocket).
 * Aufrufer ohne Origin (Tray-App, MCP-Server, Adresszeile) bleiben erlaubt.
 */
export function localRequestAllowed(host: string | undefined, origin: string | undefined): boolean {
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return false;
  return origin === undefined || origin === `http://${host}`;
}

/**
 * Die API zusätzlich gegen Abrufe ohne Origin schützen, die eine fremde Seite auslöst (<img>, <audio>, <script>):
 * Browser melden deren Herkunft in Sec-Fetch-Site. Solche Abrufe könnten sonst z. B. kostenpflichtige Hörproben auslösen.
 * Fehlt der Header (Tray-App, MCP-Server, alte Browser), bleibt es bei der Prüfung von Host und Origin.
 */
export function apiFetchAllowed(secFetchSite: string | undefined): boolean {
  return secFetchSite === undefined || secFetchSite === 'same-origin' || secFetchSite === 'none';
}

export function startWebServer(opts: WebServerOptions): () => void {
  const { manager } = opts;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!localRequestAllowed(req.headers.host, req.headers.origin)) return sendJson(res, 403, { error: 'Nur lokal erreichbar' });
    if (url.pathname.startsWith('/api/') && !apiFetchAllowed(req.headers['sec-fetch-site'] as string | undefined)) return sendJson(res, 403, { error: 'Nur von der eigenen Seite aufrufbar' });
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(PUBLIC_DIR + 'index.html');
        // Nicht zwischenspeichern: Nach einem Update soll der Browser nicht die alte Oberfläche zeigen
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/ring.html') {
        const html = await readFile(PUBLIC_DIR + 'ring.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/api/ring') {
        return sendJson(res, 200, opts.ring ? opts.ring.info() : { ringing: false });
      }
      const rx = /^\/api\/ring\/(trap|answer|skip)$/.exec(url.pathname);
      if (rx && req.method === 'POST') {
        if (!opts.ring) return sendJson(res, 400, { error: 'Nicht verfügbar' });
        const r = opts.ring.divert(rx[1] === 'trap' ? 'scam' : (rx[1] as 'answer' | 'skip'));
        return r.ok ? sendJson(res, 200, r) : sendJson(res, 409, { error: r.reason });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(res, 200, { status: manager.status(), modes: opts.modes, ...opts.uiData() });
      }
      if (req.method === 'GET' && url.pathname === '/api/setup') {
        return sendJson(res, 200, opts.setup ? opts.setup.status() : { available: false });
      }
      if (req.method === 'POST' && (url.pathname === '/api/setup/sip' || url.pathname === '/api/setup/openai')) {
        if (!opts.setup) return sendJson(res, 400, { error: 'Nicht verfügbar' });
        const body = await readJson(req);
        // Die Antwort enthält nur „ok“ oder eine Meldung – nie die übergebenen Zugangsdaten
        const r = url.pathname.endsWith('/sip') ? await opts.setup.saveSip(body) : await opts.setup.saveOpenAi(body.key);
        return r.ok ? sendJson(res, 200, { ok: true, setup: opts.setup.status() }) : sendJson(res, 400, { error: r.error ?? 'Prüfung fehlgeschlagen' });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return sendJson(res, 200, publicSettings(loadSettings()));
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const saved = saveSettings(await readJson(req));
        log.info('Einstellungen gespeichert (settings.json)');
        opts.onSettingsChanged?.(saved);
        return sendJson(res, 200, publicSettings(saved));
      }
      const vx = /^\/api\/voices\/([a-z]+)\/sample$/.exec(url.pathname);
      if (vx && req.method === 'GET') {
        const mp3 = await opts.voiceSample(vx[1]);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length, 'Cache-Control': 'private, max-age=3600' });
        return res.end(mp3);
      }
      if (req.method === 'GET' && url.pathname === '/api/mail/status') {
        return sendJson(res, 200, opts.mail ? opts.mail.status() : { provider: 'none', configured: false, loggedIn: false });
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/login') {
        if (!opts.mail?.loginUrl) return sendJson(res, 400, { error: 'Dieser Versandweg braucht keine Anmeldung' });
        return sendJson(res, 200, { url: opts.mail.loginUrl() });
      }
      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') ?? '';
        const err = url.searchParams.get('error_description') ?? url.searchParams.get('error');
        let html: string;
        try {
          if (err || !code || !opts.mail?.callback) throw new Error(err ?? 'Kein Code erhalten');
          const r = await opts.mail.callback(code, state);
          log.info(`Mail-Konto verbunden: ${r.user}`);
          html = `<p>Mail-Konto <b>${escapeHtml(r.user)}</b> verbunden. Dieses Fenster kann geschlossen werden.</p>`;
        } catch (e) {
          log.error(`Mail-Anmeldung fehlgeschlagen: ${(e as Error).message}`);
          html = `<p>Anmeldung fehlgeschlagen: ${escapeHtml((e as Error).message)}</p>`;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>SIPFunk</title><body style="font-family:system-ui;padding:24px">${html}</body>`);
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/verify') {
        if (!opts.mail) return sendJson(res, 400, { error: 'E-Mail nicht konfiguriert' });
        await opts.mail.verify();
        log.info('Mail-Verbindung geprüft: ok');
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/autoconfig') {
        if (!opts.mail) return sendJson(res, 400, { error: 'E-Mail nicht konfiguriert' });
        const { email } = (await readJson(req)) as { email?: string };
        if (!email || !/@/.test(email)) return sendJson(res, 400, { error: 'Bitte eine E-Mail-Adresse angeben' });
        const suggestion = await opts.mail.autoconfig(email);
        log.info(`Mail-Autokonfiguration für ${email.replace(/^[^@]+/, '…')}: ${suggestion ? 'Vorschlag gefunden' : 'nichts gefunden'}`);
        return suggestion ? sendJson(res, 200, suggestion) : sendJson(res, 404, { error: 'Für diese Adresse wurde kein Server gefunden – bitte Serverdaten beim Anbieter nachsehen' });
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/test') {
        if (!opts.mail) return sendJson(res, 400, { error: 'E-Mail nicht konfiguriert' });
        await opts.mail.sendTest();
        log.info('Probe-Mail gesendet');
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/transcripts') {
        const number = url.searchParams.get('number');
        return sendJson(res, 200, { items: number ? opts.store.listByNumber(number) : opts.store.list() });
      }
      if (req.method === 'GET' && url.pathname === '/api/contacts') {
        return sendJson(res, 200, { items: opts.contacts.list() });
      }
      if (req.method === 'POST' && url.pathname === '/api/contacts') {
        const c = opts.contacts.create(await readJson(req));
        log.info(`Kontakt angelegt: ${c.name}`);
        return sendJson(res, 200, c);
      }
      const cx = /^\/api\/contacts\/([^/]+)$/.exec(url.pathname);
      if (cx && req.method === 'PUT') {
        const c = opts.contacts.update(cx[1], await readJson(req));
        log.info(`Kontakt geändert: ${c.name}`);
        return sendJson(res, 200, c);
      }
      if (cx && req.method === 'DELETE') {
        const ok = opts.contacts.delete(cx[1]);
        if (ok) log.info(`Kontakt gelöscht: ${cx[1]}`);
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true, items: opts.contacts.list() } : { error: 'Nicht gefunden' });
      }
      const cpx = /^\/api\/transcripts\/([^/]+)\/complaint$/.exec(url.pathname);
      if (cpx && req.method === 'POST') {
        const record = opts.store.read(decodeURIComponent(cpx[1]));
        if (!record) return sendJson(res, 404, { error: 'Nicht gefunden' });
        const text = await opts.complaint(record);
        log.info(`Beschwerde-Entwurf erstellt für ${record.id}`);
        return sendJson(res, 200, { text });
      }
      const tx = /^\/api\/transcripts\/([^/]+)$/.exec(url.pathname);
      if (tx && req.method === 'GET') {
        const record = opts.store.read(decodeURIComponent(tx[1]));
        return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: 'Nicht gefunden' });
      }
      if (tx && req.method === 'DELETE') {
        const ok = opts.store.delete(decodeURIComponent(tx[1]));
        if (ok) log.info(`Protokoll gelöscht: ${tx[1]}`);
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true, items: opts.store.list() } : { error: 'Nicht gefunden' });
      }
      if (req.method === 'POST' && url.pathname === '/api/call/prepare') {
        const body = await readJson(req);
        const target = manager.prepare(String(body.target ?? ''));
        return sendJson(res, 200, { target });
      }
      if (req.method === 'POST' && url.pathname === '/api/call/dial') {
        const body = await readJson(req);
        const mode = String(body.mode ?? 'tone');
        // Erst prüfen, dann den Handler erzeugen: Ein KI-Handler setzt das laufende Protokoll zurück und öffnet eine Verbindung
        manager.checkDial(String(body.target ?? ''));
        // Interne Schalter (Anrufbeantworter, Spam-Rolle, Rückruf mit Vermittlung) sind über die API nicht setzbar
        for (const k of ['incoming', 'scam', 'scamAllowed', 'notifyCall', 'transferTo', 'called']) delete body[k];
        const handler = opts.createHandler(mode, body);
        try {
          manager.dial(String(body.target ?? ''), mode, handler);
        } catch (err) {
          handler.close();
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/call/hangup') {
        manager.hangup();
        return sendJson(res, 200, { ok: true });
      }
      sendJson(res, 404, { error: `Unbekannt: ${req.method} ${url.pathname}` });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ origin, req }: { origin?: string; req: { headers: { host?: string } } }) => localRequestAllowed(req.headers.host, origin || undefined) });
  const broadcast = (data: string | Buffer) => {
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', status: manager.status() }));
  });
  manager.on('status', (status) => broadcast(JSON.stringify({ type: 'status', status })));
  logEvents.on('line', (line) => broadcast(JSON.stringify({ type: 'log', ...line })));
  opts.bus.on('message', (msg) => broadcast(JSON.stringify(msg)));
  // Audio nur als Binärnachricht (PCM16 LE, 20 ms; Abtastrate steht im Status als sampleRate)
  manager.on('audio', (pcm: Int16Array) => {
    if (wss.clients.size > 0) broadcast(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  });

  // Status mit Dauer regelmäßig schicken, solange ein Gespräch läuft
  const ticker = setInterval(() => {
    const s = manager.status();
    if (s.phase === 'connected') broadcast(JSON.stringify({ type: 'status', status: s }));
  }, 1000);

  server.on('error', (err: NodeJS.ErrnoException) => {
    // Ohne Behandlung endet der Prozess mit einem Stacktrace; so steht die Ursache im Log und im Tray
    log.error(err.code === 'EADDRINUSE' ? `Web-UI: Port ${opts.port} ist belegt – läuft SIPFunk schon? Sonst WEB_PORT in der .env ändern.` : `Web-UI: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(opts.port, '127.0.0.1', () => {
    log.info(`Web-UI: http://127.0.0.1:${opts.port}`);
  });

  return () => {
    clearInterval(ticker);
    wss.close();
    server.close();
  };
}
