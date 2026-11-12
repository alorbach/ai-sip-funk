// Kontakt-Import aus Google (People API) und Microsoft (Graph): Anmeldung mit eigenem OAuth-Client des Nutzers
// (Authorization Code mit PKCE, Rückkehr auf den lokalen Server), nur Lesezugriff auf Kontakte.
// Das Zugriffstoken bleibt nur im Arbeitsspeicher (kein Refresh-Token, keine Datei); „Trennen“ oder ein Neustart verwirft es.
import { createHash, randomBytes } from 'node:crypto';
import { fromGoogle, fromGraph, type ImportCandidate } from './contactImport.js';

export type ImportProvider = 'google' | 'microsoft';

export interface ImportClients {
  google?: { clientId: string; clientSecret?: string };
  microsoft?: { clientId: string; tenant: string };
}

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: URLSearchParams }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Höchstzahl abgerufener Adressbucheinträge (Schutz vor Endlosschleifen beim Blättern) */
const MAX_ENTRIES = 20_000;

const GOOGLE = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  scope: 'https://www.googleapis.com/auth/contacts.readonly',
  people: 'https://people.googleapis.com/v1/people/me/connections',
  revoke: 'https://oauth2.googleapis.com/revoke',
};
const microsoft = (tenant: string) => ({
  auth: `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/authorize`,
  token: `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/token`,
  scope: 'https://graph.microsoft.com/Contacts.Read',
});
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_SELECT = '$select=id,displayName,givenName,surname,companyName,mobilePhone,homePhones,businessPhones&$top=500';

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class ContactSources {
  private pending = new Map<string, { provider: ImportProvider; verifier: string; at: number }>();
  private tokens = new Map<ImportProvider, { accessToken: string; expiresAt: number }>();

  /**
   * redirect(provider) liefert die Rückkehradresse: Google akzeptiert für Desktop-Clients http://127.0.0.1:<port>,
   * Microsoft nimmt im Portal nur http://localhost an (Port wird dort beim Abgleich ignoriert).
   */
  constructor(
    private clients: () => ImportClients,
    private redirect: (provider: ImportProvider) => string,
    private fetchFn: FetchFn = fetch as unknown as FetchFn,
    private now: () => number = Date.now,
  ) {}

  status(): Record<ImportProvider, { configured: boolean; connected: boolean }> {
    const c = this.clients();
    return {
      google: { configured: Boolean(c.google?.clientId), connected: this.connected('google') },
      microsoft: { configured: Boolean(c.microsoft?.clientId), connected: this.connected('microsoft') },
    };
  }

  private connected(p: ImportProvider): boolean {
    const t = this.tokens.get(p);
    return Boolean(t && t.expiresAt > this.now());
  }

  /** Gehört der state aus /oauth/callback zu einer Kontakt-Anmeldung? */
  owns(state: string): boolean {
    return this.pending.has(state);
  }

  authUrl(provider: ImportProvider): string {
    const c = this.clients();
    const state = randomBytes(12).toString('hex');
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const p = new URLSearchParams({ response_type: 'code', redirect_uri: this.redirect(provider), state, code_challenge: challenge, code_challenge_method: 'S256' });
    let url: string;
    if (provider === 'google') {
      if (!c.google?.clientId) throw new Error('Für Google fehlt die Client-ID (eigener OAuth-Client vom Typ „Desktop-App“)');
      p.set('client_id', c.google.clientId);
      p.set('scope', GOOGLE.scope);
      p.set('prompt', 'select_account');
      url = GOOGLE.auth;
    } else {
      if (!c.microsoft?.clientId) throw new Error('Für Microsoft fehlt die Client-ID (eigene App-Registrierung)');
      p.set('client_id', c.microsoft.clientId);
      p.set('scope', microsoft(c.microsoft.tenant).scope);
      p.set('prompt', 'select_account');
      url = microsoft(c.microsoft.tenant).auth;
    }
    // Abgelaufene, nie abgeschlossene Anmeldungen aufräumen
    for (const [k, v] of this.pending) if (this.now() - v.at > 10 * 60_000) this.pending.delete(k);
    this.pending.set(state, { provider, verifier, at: this.now() });
    return `${url}?${p.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<ImportProvider> {
    const pend = this.pending.get(state);
    this.pending.delete(state);
    if (!pend || this.now() - pend.at > 10 * 60_000) throw new Error('Anmeldung abgelaufen oder unbekannt – bitte erneut starten');
    if (!code) throw new Error('Anmeldung abgebrochen');
    const c = this.clients();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirect(pend.provider), code_verifier: pend.verifier });
    let tokenUrl: string;
    if (pend.provider === 'google') {
      if (!c.google?.clientId) throw new Error('Client-ID für Google fehlt');
      body.set('client_id', c.google.clientId);
      // Bei Desktop-Clients gilt das „Geheimnis“ laut Google nicht als geheim, wird aber beim Tausch erwartet
      if (c.google.clientSecret) body.set('client_secret', c.google.clientSecret);
      tokenUrl = GOOGLE.token;
    } else {
      if (!c.microsoft?.clientId) throw new Error('Client-ID für Microsoft fehlt');
      body.set('client_id', c.microsoft.clientId);
      body.set('scope', microsoft(c.microsoft.tenant).scope);
      tokenUrl = microsoft(c.microsoft.tenant).token;
    }
    const res = await this.fetchFn(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new Error(`Token-Tausch fehlgeschlagen: ${data.error ?? res.status} ${data.error_description ?? ''}`.trim());
    // Etwas Puffer, damit ein Abruf nicht mitten im Blättern abläuft
    this.tokens.set(pend.provider, { accessToken: data.access_token, expiresAt: this.now() + Math.max(60, (data.expires_in ?? 3600) - 120) * 1000 });
    return pend.provider;
  }

  /**
   * Token verwerfen. Google bekommt zusätzlich einen Widerruf, damit das Token auch dort sofort ungültig ist;
   * Microsoft bietet für einzelne Zugriffstokens keinen Widerruf, es läuft dort nach spätestens etwa einer Stunde ab.
   */
  async disconnect(provider: ImportProvider): Promise<void> {
    const t = this.tokens.get(provider);
    this.tokens.delete(provider);
    for (const [k, v] of this.pending) if (v.provider === provider) this.pending.delete(k);
    if (provider === 'google' && t) {
      await this.fetchFn(GOOGLE.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.accessToken }) }).catch(() => undefined);
    }
  }

  /** Adressbuch abrufen und in Kandidaten mit Telefonnummer umwandeln (nichts wird gespeichert). */
  async load(provider: ImportProvider): Promise<ImportCandidate[]> {
    const t = this.tokens.get(provider);
    if (!t || t.expiresAt <= this.now()) {
      this.tokens.delete(provider);
      throw new Error('Nicht verbunden oder Anmeldung abgelaufen – bitte das Konto (erneut) verbinden');
    }
    return provider === 'google' ? fromGoogle(await this.googlePeople(t.accessToken)) : fromGraph(await this.graphContacts(t.accessToken));
  }

  private async getJson(url: string, token: string): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } | string };
    if (!res.ok) {
      const msg = typeof data.error === 'string' ? data.error : data.error?.message;
      throw new Error(`Abruf fehlgeschlagen (${res.status})${msg ? `: ${msg}` : ''}`);
    }
    return data;
  }

  private async googlePeople(token: string): Promise<Parameters<typeof fromGoogle>[0]> {
    const out: Parameters<typeof fromGoogle>[0] = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ personFields: 'names,phoneNumbers,organizations', pageSize: '1000', sortOrder: 'FIRST_NAME_ASCENDING' });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await this.getJson(`${GOOGLE.people}?${q.toString()}`, token);
      out.push(...((data.connections as Parameters<typeof fromGoogle>[0] | undefined) ?? []));
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    } while (pageToken && out.length < MAX_ENTRIES);
    return out;
  }

  private async graphContacts(token: string): Promise<Parameters<typeof fromGraph>[0]> {
    const out: (Parameters<typeof fromGraph>[0][number] & { id?: string })[] = [];
    const seen = new Set<string>();
    /** Alle Seiten einer Graph-Liste; Folgeseiten nur bei Graph selbst abrufen, das Token geht an keine andere Adresse */
    const all = async <T>(first: string, limit: number): Promise<T[]> => {
      const items: T[] = [];
      let next: string | undefined = first;
      while (next && items.length < limit) {
        const data = await this.getJson(next, token);
        items.push(...((data.value as T[] | undefined) ?? []));
        const link = data['@odata.nextLink'];
        next = typeof link === 'string' && link.startsWith(`${GRAPH}/`) ? link : undefined;
      }
      return items;
    };
    const collect = async (first: string) => {
      for (const c of await all<(typeof out)[number]>(first, MAX_ENTRIES - out.length)) {
        if (c.id && seen.has(c.id)) continue;
        if (c.id) seen.add(c.id);
        out.push(c);
      }
    };
    // Standardordner und die Ordner darunter (Unterordner zweiter Ebene werden nicht durchsucht)
    await collect(`${GRAPH}/me/contacts?${GRAPH_SELECT}`);
    // Ordner und ihre Unterordner (eine Ebene tiefer; noch tiefere werden nicht durchsucht)
    const folders = await all<{ id?: string }>(`${GRAPH}/me/contactFolders?$select=id&$top=100`, 1000);
    for (const f of folders) {
      if (out.length >= MAX_ENTRIES) break;
      if (!f.id) continue;
      const id = encodeURIComponent(f.id);
      await collect(`${GRAPH}/me/contactFolders/${id}/contacts?${GRAPH_SELECT}`);
      const children = await all<{ id?: string }>(`${GRAPH}/me/contactFolders/${id}/childFolders?$select=id&$top=100`, 200);
      for (const ch of children) {
        if (out.length >= MAX_ENTRIES) break;
        if (ch.id) await collect(`${GRAPH}/me/contactFolders/${id}/childFolders/${encodeURIComponent(ch.id)}/contacts?${GRAPH_SELECT}`);
      }
    }
    return out;
  }
}
