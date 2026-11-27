// Fax-Bausteine: PDF -> Fax-TIFF (Ghostscript) und der Hilfsprozess faxmodem (spandsp, T.30 über 8-kHz-Audio).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

/** 20 ms bei 8 kHz */
export const FAX_FRAME = 160;
export const FAX_FRAME_BYTES = FAX_FRAME * 2;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Ordner mit faxmodem.exe, Ghostscript und ihren DLLs (tools/faxmodem/bundle.sh):
 * im Installationspaket resources/fax/bin (neben app.asar), im Projekt vendor/fax/bin.
 * Ohne Bündel (Entwicklung): faxmodem aus tools/faxmodem/bin, DLLs und Ghostscript aus MSYS2.
 */
function binDir(): { dir: string; faxmodem: string } {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [process.env.FAX_BIN, resources && path.join(resources, 'fax', 'bin'), path.resolve(here, '../../../fax/bin'), path.resolve(here, '../../vendor/fax/bin')];
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, 'faxmodem.exe')) && existsSync(path.join(dir, 'gswin64c.exe'))) return { dir, faxmodem: path.join(dir, 'faxmodem.exe') };
  }
  return { dir: process.env.MSYS2_BIN ?? 'C:\\msys64\\ucrt64\\bin', faxmodem: path.resolve(here, '../../tools/faxmodem/bin/faxmodem.exe') };
}
const BIN = binDir();
const FAXMODEM = BIN.faxmodem;
const GHOSTSCRIPT = path.join(BIN.dir, 'gswin64c.exe');
// Die DLLs liegen neben den Programmen; der Pfad hilft nur im Entwicklungsfall (faxmodem aus tools/, DLLs aus MSYS2)
const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${BIN.dir};${process.env.PATH ?? ''}` });

/** Fehlende Bausteine (leer = Faxen möglich) */
export function faxPrerequisites(): string[] {
  const missing: string[] = [];
  if (!existsSync(FAXMODEM)) missing.push(`faxmodem (${FAXMODEM}) – tools/faxmodem/bundle.sh ausführen`);
  if (!existsSync(GHOSTSCRIPT)) missing.push(`Ghostscript (${GHOSTSCRIPT})`);
  return missing;
}

/** PDF/PS -> mehrseitiges Fax-TIFF, 1728 Pixel breit (204 dpi), A4-Höhe; fine = 196 statt 98 dpi senkrecht. */
export async function toFaxTiff(src: string, dst: string, fine = true): Promise<void> {
  const widthPt = (1728 / 204) * 72;
  const args = [
    '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT',
    '-sDEVICE=tiffg3', `-r204x${fine ? 196 : 98}`,
    `-dDEVICEWIDTHPOINTS=${widthPt.toFixed(2)}`, '-dDEVICEHEIGHTPOINTS=841.89',
    '-dFIXEDMEDIA', '-dPDFFitPage', '-dAdjustWidth=0',
    `-sOutputFile=${dst}`, src,
  ];
  await new Promise<void>((resolve, reject) => {
    const gs = spawn(GHOSTSCRIPT, args, { env: childEnv(), windowsHide: true });
    let err = '';
    gs.stderr.on('data', (d) => (err += d));
    gs.on('error', reject);
    gs.on('close', (code) => (code === 0 && existsSync(dst) ? resolve() : reject(new Error(`PDF ließ sich nicht umwandeln: ${err.trim() || `Ghostscript ${code}`}`))));
  });
}

/** Seitenzahl eines TIFF (Kette der IFDs); 0 = nicht lesbar */
export function tiffPageCount(file: string): number {
  try {
    const b = readFileSync(file);
    const le = b.toString('latin1', 0, 2) === 'II';
    const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    let off = u32(4);
    let pages = 0;
    while (off > 0 && off + 2 <= b.length && pages < 1000) {
      pages++;
      off = u32(off + 2 + u16(off) * 12);
    }
    return pages;
  } catch {
    return 0;
  }
}

/** PostScript (vom Drucker) -> PDF */
export async function psToPdf(src: string, dst: string): Promise<void> {
  const args = ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT', '-sDEVICE=pdfwrite', `-sOutputFile=${dst}`, src];
  await new Promise<void>((resolve, reject) => {
    const gs = spawn(GHOSTSCRIPT, args, { env: childEnv(), windowsHide: true });
    let err = '';
    gs.stderr.on('data', (d) => (err += d));
    gs.on('error', reject);
    gs.on('close', (code) => (code === 0 && existsSync(dst) ? resolve() : reject(new Error(`Druckauftrag ließ sich nicht umwandeln: ${err.trim() || `Ghostscript ${code}`}`))));
  });
}

/** Erste Seite eines PDF als kleines PNG (Vorschaubild im Fax-Fenster); dpi 30 ≈ 250×350 Pixel bei A4 */
export async function pdfThumbnail(src: string, dpi = 30): Promise<Buffer> {
  const args = ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT', '-sDEVICE=png16m', `-r${dpi}`, '-dFirstPage=1', '-dLastPage=1',
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-sOutputFile=%stdout', src];
  return new Promise<Buffer>((resolve, reject) => {
    const gs = spawn(GHOSTSCRIPT, args, { env: childEnv(), windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    gs.stdout.on('data', (d: Buffer) => out.push(d));
    gs.stderr.on('data', (d) => (err += d));
    gs.on('error', reject);
    gs.on('close', (code) => {
      const png = Buffer.concat(out);
      if (code === 0 && png.subarray(1, 4).toString('latin1') === 'PNG') resolve(png);
      else reject(new Error(`Vorschau ließ sich nicht erzeugen: ${err.trim() || `Ghostscript ${code}`}`));
    });
  });
}

export interface FaxResult {
  /** 0 = Erfolg (spandsp T30_ERR_OK) */
  code: number;
  pages: number;
  text: string;
}

export interface FaxModemOptions {
  ident?: string;
  header?: string;
  /** 14400, 9600 oder 4800 */
  maxBitRate?: number;
  /** Jede Zeile des T.30-Protokolls loggen */
  verbose?: boolean;
  onPhase?: (line: string) => void;
}

/** Hilfsprozess faxmodem: je geschriebenem 20-ms-Frame kommt genau ein Frame zurück (onTx). stdin schließen = aufgelegt. */
export class FaxModem {
  readonly result: Promise<FaxResult>;
  onTx: (frame: Buffer) => void = () => undefined;
  private readonly proc: ChildProcessWithoutNullStreams;
  private pending: Buffer = Buffer.alloc(0);

  constructor(mode: 'send' | 'recv', tiff: string, opts: FaxModemOptions = {}) {
    const args = [mode, tiff, opts.ident ?? '', opts.header ?? '', String(opts.maxBitRate ?? 14400)];
    this.proc = spawn(FAXMODEM, args, { env: childEnv(), windowsHide: true });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
      while (this.pending.length >= FAX_FRAME_BYTES) {
        // Kopie: der Empfänger darf den Frame behalten, während pending weiterwächst
        this.onTx(Buffer.from(this.pending.subarray(0, FAX_FRAME_BYTES)));
        this.pending = this.pending.subarray(FAX_FRAME_BYTES);
      }
    });
    this.proc.stdin.on('error', () => undefined); // Prozess schon beendet
    let resultLine = '';
    let rest = '';
    this.proc.stderr.on('data', (d: Buffer) => {
      const lines = (rest + d.toString('latin1')).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('RESULT ')) resultLine = line;
        else if (line.startsWith('PHASE ')) opts.onPhase?.(line);
        if (opts.verbose && !line.startsWith('RESULT ')) log.info(`Fax: ${line}`);
      }
    });
    this.result = new Promise((resolve) => {
      this.proc.on('error', (err) => resolve({ code: -1, pages: 0, text: `faxmodem: ${err.message}` }));
      this.proc.on('close', () => {
        const m = /^RESULT (-?\d+) (\d+) (.*)$/.exec(resultLine);
        resolve(m ? { code: Number(m[1]), pages: Number(m[2]), text: m[3] } : { code: -1, pages: 0, text: 'faxmodem ohne Ergebnis beendet' });
      });
    });
  }

  write(frame: Buffer): void {
    if (this.proc.stdin.writable) this.proc.stdin.write(frame);
  }

  /** Aufgelegt: faxmodem holt Phase E nach und beendet sich */
  end(): void {
    if (this.proc.stdin.writable) this.proc.stdin.end();
  }

  kill(): void {
    this.proc.kill();
  }
}
