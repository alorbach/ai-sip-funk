// Port der Web-UI (und damit von /mcp): einstellbar, weicht bei belegtem Port dauerhaft aus und steht für
// andere Prozesse (stdio-MCP-Server, Installationsskript) in einer kleinen Datei im Datenordner.
import { createServer } from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 3865 = „FUNK“ auf der Telefontastatur; 8080 war auf vielen Rechnern schon belegt */
export const DEFAULT_WEB_PORT = 3865;
/** Datei im Datenordner mit dem Port, auf dem die laufende App wirklich lauscht. */
export const PORT_FILE = 'sipfunk.port';

/** Gültiger Port für die Web-UI (1024–65535), sonst undefined. */
export function parsePort(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1024 && n <= 65535 ? n : undefined;
}

/** true, wenn sich der Port auf 127.0.0.1 gerade binden lässt. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export interface PortChoice {
  port: number;
  /** Der gewünschte Port war belegt; `port` ist der nächste freie */
  moved: boolean;
}

/**
 * Den gewünschten Port nehmen, wenn er frei ist; sonst den nächsten freien darüber. Vor dem Ausweichen kurz warten
 * und erneut prüfen: Nach einem Neustart gibt der alte Prozess den Port manchmal erst einen Moment später frei.
 * Ist in der Nähe nichts frei, bleibt es beim gewünschten Port (der Start meldet dann den Fehler).
 */
export async function chooseWebPort(wanted: number, opts: { free?: (port: number) => Promise<boolean>; retries?: number; retryMs?: number; span?: number } = {}): Promise<PortChoice> {
  const free = opts.free ?? portFree;
  for (let i = 0; i <= (opts.retries ?? 3); i++) {
    if (await free(wanted)) return { port: wanted, moved: false };
    if (i < (opts.retries ?? 3)) await new Promise((r) => setTimeout(r, opts.retryMs ?? 400));
  }
  for (let port = wanted + 1; port <= Math.min(65535, wanted + (opts.span ?? 50)); port++) {
    if (await free(port)) return { port, moved: true };
  }
  return { port: wanted, moved: false };
}

export function writePortFile(dataDir: string, port: number): void {
  try {
    writeFileSync(join(dataDir, PORT_FILE), `${port}\n`);
  } catch {
    /* ohne die Datei gilt für andere Prozesse der Standardport */
  }
}

/** Beim Beenden: Die Datei soll nicht auf einen Port zeigen, den inzwischen ein anderes Programm nutzt. */
export function removePortFile(dataDir: string, port: number): void {
  try {
    if (readPortFile(dataDir) === port) rmSync(join(dataDir, PORT_FILE), { force: true });
  } catch {
    /* bleibt liegen */
  }
}

export function readPortFile(dataDir: string): number | undefined {
  try {
    return parsePort(readFileSync(join(dataDir, PORT_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Adresse der laufenden App für den stdio-MCP-Server: ausdrücklich gesetzte SIPFUNK_URL, sonst der Port aus der
 * Datei im Datenordner (SIPFUNK_DATA_DIR; folgt damit jeder Portänderung), sonst WEB_PORT bzw. der Standard.
 */
export function appBaseUrl(env: Record<string, string | undefined>): string {
  if (env.SIPFUNK_URL?.trim()) return env.SIPFUNK_URL.trim().replace(/\/+$/, '');
  const fromFile = env.SIPFUNK_DATA_DIR?.trim() ? readPortFile(env.SIPFUNK_DATA_DIR.trim()) : undefined;
  return `http://127.0.0.1:${fromFile ?? parsePort(env.WEB_PORT) ?? DEFAULT_WEB_PORT}`;
}
