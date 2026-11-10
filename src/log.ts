import { EventEmitter } from 'node:events';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Jede Logzeile wird auch als 'line' emittiert, damit die Web-UI sie anzeigen kann. */
export const logEvents = new EventEmitter();

function emit(level: string, args: unknown[]): void {
  const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logEvents.emit('line', { time: ts(), level, text });
}

export const log = {
  info: (...args: unknown[]) => {
    console.log(ts(), ...args);
    emit('info', args);
  },
  warn: (...args: unknown[]) => {
    console.warn(ts(), 'WARN', ...args);
    emit('warn', args);
  },
  error: (...args: unknown[]) => {
    console.error(ts(), 'ERROR', ...args);
    emit('error', args);
  },
};
