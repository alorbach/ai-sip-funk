// OAuth2 (Authorization Code mit lokalem Redirect) für den Mailversand über Gmail oder Microsoft 365.
// Der Refresh-Token liegt im Datenordner (mail-token.json); Access-Tokens holt nodemailer bei Bedarf.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export type MailProvider = 'smtp' | 'gmail' | 'm365';

export interface OAuthConfig {
  provider: 'gmail' | 'm365';
  clientId: string;
  clientSecret?: string;
  /** Microsoft: Mandant (Tenant), Default 'common' */
  tenant: string;
  /** Postfach, von dem gesendet wird */
  user: string;
}

export interface StoredToken {
  provider: string;
  user: string;
  refreshToken: string;
  obtainedAt: string;
}

const ENDPOINTS = {
  gmail: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
  },
  m365: (tenant: string) => ({
    auth: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scope: 'offline_access https://outlook.office.com/SMTP.Send',
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
  }),
};

export function endpoints(cfg: OAuthConfig) {
  return cfg.provider === 'gmail' ? ENDPOINTS.gmail : ENDPOINTS.m365(cfg.tenant);
}

export class TokenStore {
  constructor(private file: string) {}
  read(): StoredToken | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as StoredToken;
    } catch {
      return undefined;
    }
  }
  write(token: StoredToken): void {
    writeFileSync(this.file, JSON.stringify(token, null, 2) + '\n');
  }
  clear(): void {
    if (existsSync(this.file)) unlinkSync(this.file);
  }
}

/** Anmelde-Ablauf: URL fürs Browserfenster erzeugen, Code gegen Refresh-Token tauschen. */
export class OAuthLogin {
  private pending = new Map<string, number>(); // state -> Zeitpunkt

  /** getCfg liefert die aktuelle OAuth-Konfiguration; undefined = Versandweg ist SMTP oder nicht eingerichtet. */
  constructor(private getCfg: () => OAuthConfig | undefined, private redirectUri: string, private store: TokenStore) {}

  private get cfg(): OAuthConfig {
    const c = this.getCfg();
    if (!c) throw new Error('Dieser Versandweg braucht keine Anmeldung oder Client-ID und Postfach fehlen');
    return c;
  }

  authUrl(): string {
    const state = randomBytes(12).toString('hex');
    this.pending.set(state, Date.now());
    const e = endpoints(this.cfg);
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: e.scope,
      state,
    });
    if (this.cfg.provider === 'gmail') {
      p.set('access_type', 'offline');
      p.set('prompt', 'consent');
      if (this.cfg.user) p.set('login_hint', this.cfg.user);
    } else {
      p.set('prompt', 'select_account');
      if (this.cfg.user) p.set('login_hint', this.cfg.user);
    }
    return `${e.auth}?${p.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<StoredToken> {
    const started = this.pending.get(state);
    this.pending.delete(state);
    if (!started || Date.now() - started > 10 * 60_000) throw new Error('Anmeldung abgelaufen oder unbekannt – bitte erneut starten');
    const e = endpoints(this.cfg);
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      code,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret);
    if (this.cfg.provider === 'm365') body.set('scope', e.scope);
    const res = await fetch(e.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.refresh_token) {
      throw new Error(`Token-Tausch fehlgeschlagen: ${data.error ?? res.status} ${data.error_description ?? ''}`.trim());
    }
    const token: StoredToken = { provider: this.cfg.provider, user: this.cfg.user, refreshToken: data.refresh_token, obtainedAt: new Date().toISOString() };
    this.store.write(token);
    return token;
  }
}
