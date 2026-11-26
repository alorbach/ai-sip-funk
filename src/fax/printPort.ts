// Druckerport für den Windows-Drucker „SIPFunk Fax“: nimmt RAW-Druckaufträge (PostScript vom „Microsoft PS Class Driver“)
// an, nur auf 127.0.0.1, und wandelt sie in ein PDF um. Die Zielnummer fragt danach das Fax-Fenster ab.
import { createServer, type Server } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { psToPdf } from './modem.js';

/** Größter Druckauftrag (PostScript mit eingebetteten Bildern kann groß werden) */
const MAX_JOB_BYTES = 200_000_000;

export interface PrintedDocument {
  name: string;
  pdf: Buffer;
  pages?: number;
}

/**
 * PJL-Umschlag weg, nur das PostScript behalten. Der Klassentreiber setzt „ESC%-12345X@PJL …“ davor und dahinter;
 * kommt gar kein PostScript, ist der falsche Treiber eingestellt.
 */
export function cleanPostScript(data: Buffer): Buffer {
  // Der Auftrag muss mit PostScript oder dem PJL-Umschlag des Treibers beginnen (davor nur Leerraum oder Strg-D).
  // So kommt z. B. eine HTTP-Anfrage einer Webseite an 127.0.0.1 nicht durch, auch wenn „%!PS“ im Body steht.
  let lead = 0;
  while (lead < data.length && lead < 64 && (data[lead] === 0x04 || /\s/.test(String.fromCharCode(data[lead])))) lead++;
  const head = data.subarray(lead, lead + 9).toString('latin1');
  const start = head.startsWith('%!PS') ? lead : head === '\x1b%-12345X' ? data.indexOf('%!PS', lead) : -1;
  if (start < 0) throw new Error('Der Druckauftrag ist kein PostScript – Drucker „SIPFunk Fax“ braucht den Treiber „Microsoft PS Class Driver“');
  let end = data.indexOf('\x1b%-12345X', start);
  if (end < 0) end = data.length;
  return data.subarray(start, end);
}

/** Titel, die nur den Druckweg benennen, nicht das Dokument */
const GENERIC_TITLE = /^(MSxpsPS|Microsoft Word - ?|untitled|Unbenannt|Dokument|Document)$/i;

/** Auftragsname aus dem PJL-Kopf („@PJL JOB NAME = "…"“), falls der Treiber ihn mitschickt */
export function pjlJobName(data: Buffer): string | undefined {
  const head = data.subarray(0, 4096).toString('latin1');
  const name = /@PJL\s+JOB\s+NAME\s*=\s*"([^"]+)"/i.exec(head)?.[1]?.trim();
  return name && !GENERIC_TITLE.test(name) ? name : undefined;
}

/** Dokumentname und Seitenzahl aus den DSC-Kommentaren des Treibers (%%Title, %%Pages) */
export function postScriptInfo(ps: Buffer): { title?: string; pages?: number } {
  const head = ps.subarray(0, 64 * 1024).toString('latin1');
  const title = /^%%Title:\s*(.+?)\s*$/m.exec(head)?.[1]?.replace(/^\((.*)\)$/, '$1').trim();
  const pages = Number(/^%%Pages:\s*(\d+)/m.exec(ps.subarray(Math.max(0, ps.length - 64 * 1024)).toString('latin1') + '\n' + head)?.[1]);
  return { title: title || undefined, pages: Number.isFinite(pages) && pages > 0 ? pages : undefined };
}

export class FaxPrintPort {
  private server?: Server;

  constructor(private readonly port: number, private readonly onDocument: (doc: PrintedDocument) => void) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((sock) => {
        const chunks: Buffer[] = [];
        let size = 0;
        sock.on('data', (d: Buffer) => {
          size += d.length;
          if (size > MAX_JOB_BYTES) {
            log.warn('Fax-Drucker: Druckauftrag zu groß, verworfen');
            sock.destroy();
            return;
          }
          chunks.push(d);
        });
        sock.on('error', () => undefined);
        sock.on('end', () => {
          sock.end();
          if (size === 0 || size > MAX_JOB_BYTES) return;
          void this.handle(Buffer.concat(chunks));
        });
      });
      server.on('error', (err) => {
        log.warn(`Fax-Drucker: Port 127.0.0.1:${this.port} nicht verfügbar (${err.message}) – Drucken an SIPFunk geht nicht`);
        resolve();
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        log.info(`Fax-Drucker: lausche auf 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(data: Buffer): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), 'sipfunk-print-'));
    try {
      const ps = cleanPostScript(data);
      const info = postScriptInfo(ps);
      const psFile = path.join(dir, 'auftrag.ps');
      const pdfFile = path.join(dir, 'auftrag.pdf');
      writeFileSync(psFile, ps);
      await psToPdf(psFile, pdfFile);
      // „MSxpsPS“ u. ä. ist nur der interne Name des XPS-Druckwegs: dann der Auftragsname aus dem PJL-Kopf, sonst die Uhrzeit
      const title = info.title && !GENERIC_TITLE.test(info.title) ? info.title : pjlJobName(data);
      const name = title ?? `Druckauftrag ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
      log.info(`Fax-Drucker: „${name}“ empfangen${info.pages ? ` (${info.pages} Seite(n))` : ''}`);
      this.onDocument({ name, pdf: readFileSync(pdfFile), pages: info.pages });
    } catch (err) {
      log.warn(`Fax-Drucker: ${(err as Error).message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
