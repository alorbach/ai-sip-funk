// Version des Programms: steht nur in der package.json (im Repository wie im installierten Programm).
import { readFileSync } from 'node:fs';

function read(): string {
  try {
    const v = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

export const VERSION = read();
