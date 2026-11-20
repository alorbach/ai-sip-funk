// Fax-Bausteine: PDF -> Fax-TIFF (Ghostscript) und der Hilfsprozess faxmodem (spandsp, T.30 über 8-kHz-Audio).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

/** 20 ms bei 8 kHz */
export const FAX_FRAME = 160;
export const FAX_FRAME_BYTES = FAX_FRAME * 2;

const here = path.dirname(fileURLToPath(import.meta.url));
/** spandsp, libtiff und Ghostscript (MSYS2 UCRT64); später aus dem Installationspaket */
const MSYS_BIN = process.env.MSYS2_BIN ?? 'C:\\msys64\\ucrt64\\bin';
const FAXMODEM = process.env.FAXMODEM_EXE ?? path.resolve(here, '../../tools/faxmodem/bin/faxmodem.exe');
const GHOSTSCRIPT = path.join(MSYS_BIN, 'gswin64c.exe');
const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${MSYS_BIN};${process.env.PATH ?? ''}` });

/** Fehlende Bausteine (leer = Faxen möglich) */
export function faxPrerequisites(): string[] {
  const missing: string[] = [];
  if (!existsSync(FAXMODEM)) missing.push(`faxmodem (${FAXMODEM}) – tools/faxmodem/build.sh ausführen`);
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
