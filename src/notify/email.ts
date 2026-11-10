// E-Mail-Versand: klassisch per SMTP mit Passwort oder per OAuth2 (XOAUTH2) über Gmail bzw. Microsoft 365.
// nodemailer holt mit Client-ID/-Secret und Refresh-Token die Access-Tokens selbst.
import nodemailer from 'nodemailer';
import type { MailConfig } from '../settings.js';
import { endpoints, type OAuthConfig, type TokenStore } from './oauth.js';

export interface MailStatus {
  provider: string;
  configured: boolean;
  loggedIn: boolean;
  user?: string;
  to?: string;
  hint?: string;
}

/** OAuth-Konfiguration aus der Mail-Konfiguration (nur für gmail/m365). */
export function oauthFrom(m: MailConfig): OAuthConfig | undefined {
  return m.provider !== 'smtp' && m.oauth ? { provider: m.provider, ...m.oauth } : undefined;
}

export class Mailer {
  /** getMail liefert die aktuelle Konfiguration (Einstellungen können sich zur Laufzeit ändern). */
  constructor(
    private getMail: () => MailConfig,
    private tokens: TokenStore,
  ) {}

  status(): MailStatus {
    const m = this.getMail();
    const oauth = oauthFrom(m);
    if (m.provider === 'smtp') {
      const ok = Boolean(m.smtp);
      return { provider: 'smtp', configured: ok, loggedIn: ok, user: m.smtp?.user, to: m.to, hint: ok ? undefined : 'SMTP-Server, Benutzer und Passwort eintragen oder „Automatisch einrichten"' };
    }
    const configured = Boolean(oauth?.clientId && oauth.user);
    const token = this.tokens.read();
    return {
      provider: m.provider,
      configured,
      loggedIn: configured && token?.provider === m.provider && token.user === oauth?.user,
      user: oauth?.user,
      to: m.to,
      hint: configured ? (token ? (token.user === oauth?.user ? undefined : 'Anmeldung gehört zu einem anderen Postfach – „Mail-Konto verbinden"') : 'Noch nicht angemeldet – „Mail-Konto verbinden"') : 'Client-ID und Postfach eintragen',
    };
  }

  private transport() {
    const m = this.getMail();
    const oauth = oauthFrom(m);
    if (m.provider === 'smtp') {
      if (!m.smtp) throw new Error('SMTP nicht konfiguriert (Server fehlt)');
      return nodemailer.createTransport({ host: m.smtp.host, port: m.smtp.port, secure: m.smtp.secure, connectionTimeout: 10000, greetingTimeout: 10000, auth: m.smtp.user ? { user: m.smtp.user, pass: m.smtp.pass ?? '' } : undefined });
    }
    if (!oauth) throw new Error(`${m.provider}: Client-ID und Postfach fehlen`);
    const token = this.tokens.read();
    if (!token || token.provider !== m.provider) throw new Error(`${m.provider}: noch nicht angemeldet – „Mail-Konto verbinden"`);
    const e = endpoints(oauth);
    return nodemailer.createTransport({
      host: e.smtpHost,
      port: e.smtpPort,
      secure: e.smtpPort === 465,
      connectionTimeout: 10000,
      auth: {
        type: 'OAuth2',
        user: oauth.user,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        refreshToken: token.refreshToken,
        accessUrl: e.token,
      },
    });
  }

  /** Verbindung und Anmeldung prüfen, ohne etwas zu senden. */
  async verify(): Promise<void> {
    await this.transport().verify();
  }

  /** html ist optional; mit html geht die Mail als multipart/alternative (Text bleibt die Rückfallebene). */
  async send(subject: string, text: string, html?: string): Promise<void> {
    const m = this.getMail();
    if (!m.to) throw new Error('Empfänger fehlt (E-Mail-Einstellungen)');
    const from = m.from || (m.provider === 'smtp' ? m.smtp?.user : oauthFrom(m)?.user) || m.to;
    await this.transport().sendMail({ from, to: m.to, subject, text, html });
  }
}
