// Sicherung: Einstellungen (.env und settings.json), Kontakte mit Anrufbeantworter-Profilen und Spam-Liste (beide
// stehen in settings.json) in einer Datei. Gesprächsprotokolle gehören nicht dazu. Kennwörter und Schlüssel nur auf
// Wunsch, dann ist die ganze Datei mit einem Passwort verschlüsselt (scrypt + AES-256-GCM).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { parseEnv } from 'node:util';
import { SECRET_KEYS } from './settings.js';
import { updateEnvText } from './envFile.js';
import { numberKey, type Contact, type ContactInput, type ContactStore } from './contacts.js';

export const BACKUP_FORMAT = 'sipfunk-backup';
const BACKUP_VERSION = 1;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Inhalt einer Sicherung */
export interface BackupData {
  /** Werte der .env */
  env: Record<string, string>;
  /** settings.json wie gespeichert (ohne Port) */
  settings: Record<string, unknown>;
  contacts: Contact[];
  /** Anmeldung des Mail-Postfachs (OAuth, mail-token.json); nur mit Geheimnissen */
  mailToken?: unknown;
}

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  created: string;
  app: string;
  /** Kennwörter und Schlüssel sind enthalten */
  secrets: boolean;
  encryption?: { alg: 'aes-256-gcm'; kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; tag: string };
  /** Klartext als Objekt, verschlüsselt als base64 */
  data: BackupData | string;
}

/** Variablen der .env mit Kennwort, Schlüssel oder Token (SIP_PASSWORD, OPENAI_API_KEY, AI_KEY_…, SMTP_PASS, …) */
export const isSecretEnv = (key: string): boolean => /PASS|SECRET|KEY|TOKEN/i.test(key);

/** Gehören zu diesem Rechner, nicht in eine Sicherung: eigene IP-Adresse, Port der Oberfläche, Datenordner */
const LOCAL_ENV = new Set(['LOCAL_IP', 'WEB_PORT', 'SIPFUNK_DATA_DIR']);
const LOCAL_SETTINGS = ['webPort'];

/** Geheimnisse, die nur mit ihrem Server zusammen gelten: ändert die Sicherung den Server, entfällt das alte Kennwort */
const ENV_SERVER_SECRETS: [string, string][] = [['SIP_SERVER', 'SIP_PASSWORD'], ['FRITZ_HOST', 'FRITZ_PASSWORD'], ['SIP_SERVER', 'FAX_PASSWORD'], ['SMTP_HOST', 'SMTP_PASS']];

/** Sicherung als Dateitext erstellen. Mit `secrets` ist ein Passwort Pflicht. */
export function createBackup(input: { envText: string; settingsText: string; contacts: Contact[]; mailTokenText?: string }, opts: { secrets: boolean; password?: string; app: string; now?: Date }): string {
  if (opts.secrets && !(opts.password && opts.password.length >= 8)) throw new Error('Für eine Sicherung mit Kennwörtern bitte ein Passwort mit mindestens 8 Zeichen wählen');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseEnv(input.envText))) if (v !== undefined && !LOCAL_ENV.has(k) && (opts.secrets || !isSecretEnv(k))) env[k] = v;
  const settings = parseSettings(input.settingsText);
  for (const k of LOCAL_SETTINGS) delete settings[k];
  if (!opts.secrets) for (const k of SECRET_KEYS) delete settings[k];
  const data: BackupData = { env, settings, contacts: input.contacts };
  if (opts.secrets && input.mailTokenText) {
    try {
      data.mailToken = JSON.parse(input.mailTokenText);
    } catch {
      /* defekte Anmeldung nicht mitnehmen */
    }
  }
  const file: BackupFile = { format: BACKUP_FORMAT, version: BACKUP_VERSION, created: (opts.now ?? new Date()).toISOString(), app: opts.app, secrets: opts.secrets, data };
  if (opts.secrets) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(opts.password!, salt, 32, SCRYPT), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    file.encryption = { alg: 'aes-256-gcm', kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    file.data = enc.toString('base64');
  }
  return JSON.stringify(file, null, 2) + '\n';
}

function parseSettings(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const data = JSON.parse(text.replace(/^﻿/, '')) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('settings.json ist kein JSON-Objekt');
  return data as Record<string, unknown>;
}

/** Fehler, wenn die Sicherung verschlüsselt ist und das Passwort fehlt oder falsch ist */
export class BackupPasswordError extends Error {}

/** Sicherungsdatei lesen und prüfen; verschlüsselte nur mit dem richtigen Passwort. */
export function readBackup(text: string, password?: string): { data: BackupData; secrets: boolean; created: string; app: string } {
  let file: BackupFile;
  try {
    file = JSON.parse(text.replace(/^﻿/, '')) as BackupFile;
  } catch {
    throw new Error('Das ist keine SIPFunk-Sicherung');
  }
  if (!file || file.format !== BACKUP_FORMAT) throw new Error('Das ist keine SIPFunk-Sicherung');
  if (file.version > BACKUP_VERSION) throw new Error('Diese Sicherung stammt aus einer neueren SIPFunk-Version – bitte SIPFunk zuerst aktualisieren');
  let data: BackupData;
  if (file.encryption) {
    if (!password) throw new BackupPasswordError('Diese Sicherung ist mit einem Passwort geschützt');
    const e = file.encryption;
    try {
      const key = scryptSync(password, Buffer.from(e.salt, 'base64'), 32, { N: e.N, r: e.r, p: e.p, maxmem: SCRYPT.maxmem });
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
      data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(String(file.data), 'base64')), decipher.final()]).toString('utf8')) as BackupData;
    } catch {
      throw new BackupPasswordError('Das Passwort ist falsch');
    }
  } else {
    data = file.data as BackupData;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.contacts) || typeof data.settings !== 'object' || typeof data.env !== 'object') throw new Error('Die Sicherung ist unvollständig');
  return { data, secrets: !!file.secrets, created: String(file.created ?? ''), app: String(file.app ?? '') };
}

/**
 * Neuer Stand von .env und settings.json nach dem Wiederherstellen: Werte der Sicherung ersetzen die vorhandenen;
 * was die Sicherung nicht enthält (Geheimnisse einer Sicherung ohne Kennwörter, Port, eigene IP), bleibt.
 * Wechselt die Sicherung einen Server, entfällt das vorhandene Kennwort dafür, statt es an den neuen zu schicken.
 */
export function restoredConfig(data: BackupData, current: { envText: string; settingsText: string }): { envText: string; settingsText: string } {
  const oldEnv = parseEnv(current.envText);
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.env)) if (!LOCAL_ENV.has(k) && typeof v === 'string' && !/[\r\n]/.test(v)) values[k] = v;
  for (const [server, secret] of ENV_SERVER_SECRETS) {
    const changed = values[server] !== undefined && values[server].trim().toLowerCase() !== (oldEnv[server] ?? '').trim().toLowerCase();
    if (changed && values[secret] === undefined && oldEnv[secret]) values[secret] = '';
  }
  const oldSettings = current.settingsText.trim() ? parseSettings(current.settingsText) : {};
  const settings: Record<string, unknown> = { ...data.settings };
  for (const k of LOCAL_SETTINGS) {
    if (oldSettings[k] !== undefined) settings[k] = oldSettings[k];
    else delete settings[k];
  }
  for (const k of SECRET_KEYS) if (settings[k] === undefined && oldSettings[k] !== undefined) settings[k] = oldSettings[k];
  const host = (s: Record<string, unknown>) => String(s.smtpHost ?? '').trim().toLowerCase();
  if (data.settings.smtpPass === undefined && host(settings) !== host(oldSettings)) settings.smtpPass = '';
  return { envText: updateEnvText(current.envText, values), settingsText: JSON.stringify(settings, null, 2) + '\n' };
}

/**
 * Kontakte der Sicherung mit den vorhandenen zusammenführen (wie beim Import): Kontakte mit bekannter Nummer bekommen
 * nur fehlende Nummern, die übrigen werden mit allen Angaben neu angelegt.
 */
export function restoreContacts(store: ContactStore, list: Contact[]): { created: number; merged: number; skipped: string[] } {
  const create: ContactInput[] = [];
  const add = new Map<string, string[]>();
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || typeof c.number !== 'string') continue;
    const nums = [c.number, ...(Array.isArray(c.numbers) ? c.numbers : [])].filter((n) => typeof n === 'string' && numberKey(n));
    const existing = nums.map((n) => store.findByNumber(n)).find(Boolean);
    if (existing) {
      const fresh = nums.filter((n) => !store.findByNumber(n));
      if (fresh.length) add.set(existing.id, [...(add.get(existing.id) ?? []), ...fresh]);
      continue;
    }
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = c;
    create.push(rest);
  }
  return store.importMany(create, [...add].map(([id, numbers]) => ({ id, numbers })));
}

/** Dateiname „SIPFunk-Sicherung-2026-11-28.sipfunk“ */
export function backupFileName(now = new Date()): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `SIPFunk-Sicherung-${d}.sipfunk`;
}
