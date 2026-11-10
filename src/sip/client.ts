// Schlanker SIP-UAC über UDP: Registrierung an der FRITZ!Box und ein ausgehender Anruf.
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { buildAuthorization } from './digest.js';
import {
  type SipMessage,
  cseqOf,
  extractUri,
  getHeader,
  getHeaders,
  getParam,
  parseMessage,
  serialize,
  splitList,
  topViaBranch,
} from './message.js';
import { log } from '../log.js';

const T1 = 500;
const T2 = 4000;
const TRANSACTION_TIMEOUT = 32_000;
const USER_AGENT = 'SIPFunk/0.1';

const rand = (bytes = 6) => randomBytes(bytes).toString('hex');

/** Private und lokale IPv4-Adressen (RFC 1918, Loopback, Link-Local). */
export function isPrivateIp(ip: string): boolean {
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

export interface SipClientOptions {
  server: string; // z. B. fritz.box – dient auch als SIP-Domain
  user: string;
  password: string;
  serverPort?: number;
  localPort: number;
  localIp?: string;
  debug?: boolean;
}

interface Transaction {
  method: string;
  raw: string;
  timer?: NodeJS.Timeout;
  gotProvisional: boolean;
  onProvisional?: (res: SipMessage) => void;
  resolve: (res: SipMessage) => void;
  reject: (err: Error) => void;
}

interface DialogInfo {
  callId: string;
  fromTag: string;
  toUri: string;
  toTag?: string;
  cseq: number;
  routeSet?: string[];
}

export class SipClient extends EventEmitter {
  readonly domain: string;
  localIp = '';
  private serverIp = '';
  private serverPort = 5060;
  private boundPort = 0;
  private socket = dgram.createSocket('udp4');
  private transactions = new Map<string, Transaction>();
  private calls = new Map<string, Call | IncomingCall>();
  private regCallId = `${rand(10)}@sipfunk`;
  private regTag = rand();
  private regCseq = 0;
  private regTimer?: NodeJS.Timeout;
  private stopped = false;
  /** Socket ist geschlossen: nichts mehr senden */
  private closed = false;
  private nc = 0;

  constructor(readonly opts: SipClientOptions) {
    super();
    this.domain = opts.server;
    this.serverPort = opts.serverPort ?? 5060;
  }

  get aor(): string {
    return `sip:${this.opts.user}@${this.domain}`;
  }

  get contact(): string {
    return `<sip:${this.opts.user}@${this.localIp}:${this.boundPort}>`;
  }

  async start(): Promise<void> {
    this.serverIp = (await lookup(this.opts.server, { family: 4 })).address;
    this.localIp = this.opts.localIp ?? (await detectLocalIp(this.serverIp, this.serverPort));
    // Der Socket wird nur einmal gebunden; ein erneuter start() nach fehlgeschlagener Registrierung
    // (z. B. FRITZ!Box nicht erreichbar) versucht nur die Registrierung noch einmal.
    if (!this.boundPort) {
      await new Promise<void>((resolve, reject) => {
        this.socket.once('error', reject);
        this.socket.bind(this.opts.localPort, () => { this.socket.off('error', reject); resolve(); });
      });
      this.boundPort = this.socket.address().port;
      this.socket.on('message', (buf, rinfo) => this.onPacket(buf.toString('utf8'), rinfo));
      this.socket.on('error', (err) => log.error('SIP-Socket:', err.message));
      log.info(`SIP: lokal ${this.localIp}:${this.boundPort}, Server ${this.serverIp}:${this.serverPort}`);
    }
    await this.register();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.regTimer);
    for (const call of this.calls.values()) call.hangup();
    // Abmelden ist best effort und darf das Beenden nicht aufhalten (unerreichbare Box: sonst 32 s Timeout)
    if (this.boundPort && this.serverIp) {
      await Promise.race([this.register(0).catch(() => undefined), new Promise((r) => setTimeout(r, 2000).unref())]);
    }
    // Offene Transaktionen (BYE, CANCEL, REGISTER) würden sonst auf dem geschlossenen Socket weitersenden – das wirft im Timer
    for (const tx of this.transactions.values()) {
      clearTimeout(tx.timer);
      tx.reject(new Error(`${tx.method}: SIP-Client gestoppt`));
    }
    this.transactions.clear();
    this.closed = true;
    await new Promise<void>((resolve) => {
      try {
        this.socket.close(() => resolve());
      } catch {
        resolve(); // nie gebunden oder schon zu
      }
    });
  }

  async register(expires = 300): Promise<void> {
    clearTimeout(this.regTimer);
    const uri = `sip:${this.domain}`;
    const dialog: DialogInfo = {
      callId: this.regCallId,
      fromTag: this.regTag,
      toUri: `<${this.aor}>`,
      cseq: ++this.regCseq,
    };
    const extra: [string, string][] = [['Expires', String(expires)]];
    let res = await this.sendRequest(this.buildRequest('REGISTER', uri, dialog, extra));
    if (res.status === 401 || res.status === 407) {
      dialog.cseq = ++this.regCseq;
      extra.push(this.authHeader(res, 'REGISTER', uri));
      res = await this.sendRequest(this.buildRequest('REGISTER', uri, dialog, extra));
    }
    if (res.status !== 200) {
      throw new Error(`Registrierung fehlgeschlagen: ${res.status} ${res.reason}`);
    }
    if (expires === 0) {
      log.info('SIP: abgemeldet');
      return;
    }
    // Unlesbare Gültigkeit (NaN) ergäbe einen Timer mit 1 ms und damit eine REGISTER-Dauerschleife
    const g = Number(getParam(getHeader(res, 'Contact') ?? '', 'expires') ?? getHeader(res, 'Expires') ?? expires);
    const granted = Number.isFinite(g) && g > 0 ? g : expires;
    log.info(`SIP: registriert als ${this.aor} (gültig ${granted}s)`);
    this.emit('registered');
    this.scheduleRegister(Math.max(granted * 0.8, 30) * 1000, expires);
  }

  /** Plant die nächste Registrierung; schlägt sie fehl, wird es nach 30 s erneut versucht. */
  private scheduleRegister(delayMs: number, expires: number): void {
    clearTimeout(this.regTimer);
    if (this.stopped) return;
    this.regTimer = setTimeout(() => {
      this.register(expires).catch((err) => {
        if (this.stopped) return;
        log.error(err.message);
        this.emit('registrationFailed', err);
        this.scheduleRegister(30_000, expires);
      });
    }, delayMs);
  }

  /** Startet einen ausgehenden Anruf. Das SDP-Angebot liefert der Aufrufer. */
  call(target: string, sdpOffer: string): Call {
    const call = new Call(this, target, sdpOffer);
    this.calls.set(call.callId, call);
    call.once('ended', () => this.calls.delete(call.callId));
    call.start().catch((err) => call.fail(err));
    return call;
  }

  // ---- intern, auch von Call genutzt ----

  buildRequest(method: string, uri: string, d: DialogInfo, extra: [string, string][] = [], body = '', branch = `z9hG4bK${rand(8)}`): SipMessage {
    const headers: [string, string][] = [
      ['Via', `SIP/2.0/UDP ${this.localIp}:${this.boundPort};branch=${branch};rport`],
      ['Max-Forwards', '70'],
      ['From', `<${this.aor}>;tag=${d.fromTag}`],
      ['To', d.toTag ? `${d.toUri};tag=${d.toTag}` : d.toUri],
      ['Call-ID', d.callId],
      ['CSeq', `${d.cseq} ${method}`],
    ];
    for (const route of d.routeSet ?? []) headers.push(['Route', route]);
    if (method !== 'ACK' && method !== 'CANCEL') {
      headers.push(['Contact', this.contact], ['Allow', 'INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY, REFER']);
    }
    headers.push(['User-Agent', USER_AGENT], ...extra);
    if (body) headers.push(['Content-Type', 'application/sdp']);
    return { method, uri, headers, body };
  }

  authHeader(challengeRes: SipMessage, method: string, uri: string): [string, string] {
    const proxy = challengeRes.status === 407;
    const challenge = getHeader(challengeRes, proxy ? 'Proxy-Authenticate' : 'WWW-Authenticate');
    if (!challenge) throw new Error('Auth-Challenge ohne Authenticate-Header');
    const value = buildAuthorization({
      challenge,
      method,
      uri,
      username: this.opts.user,
      password: this.opts.password,
      nc: ++this.nc,
    });
    return [proxy ? 'Proxy-Authorization' : 'Authorization', value];
  }

  /** Sendet einen Request mit UDP-Retransmission und wartet auf die finale Antwort. */
  sendRequest(msg: SipMessage, onProvisional?: (res: SipMessage) => void): Promise<SipMessage> {
    const key = `${topViaBranch(msg)}:${msg.method}`;
    const raw = serialize(msg);
    return new Promise((resolve, reject) => {
      const tx: Transaction = { method: msg.method!, raw, gotProvisional: false, onProvisional, resolve, reject };
      this.transactions.set(key, tx);
      let interval = T1;
      let elapsed = 0;
      const retransmit = () => {
        if (tx.gotProvisional && tx.method === 'INVITE') return;
        elapsed += interval;
        if (elapsed >= TRANSACTION_TIMEOUT) {
          this.transactions.delete(key);
          reject(new Error(`${tx.method}: keine Antwort vom Server (Timeout)`));
          return;
        }
        this.sendRaw(raw);
        interval = tx.method === 'INVITE' ? interval * 2 : Math.min(interval * 2, T2);
        tx.timer = setTimeout(retransmit, interval);
      };
      this.sendRaw(raw);
      tx.timer = setTimeout(retransmit, interval);
    });
  }

  sendMessage(msg: SipMessage): void {
    this.sendRaw(serialize(msg));
  }

  private sendRaw(raw: string, port = this.serverPort, ip = this.serverIp): void {
    if (this.closed) return;
    if (this.opts.debug) log.info(`SIP >>> ${ip}:${port}\n${raw}`);
    this.socket.send(raw, port, ip);
  }

  private onPacket(raw: string, rinfo: dgram.RemoteInfo): void {
    if (raw.trim() === '') return; // Keepalive (CRLF)
    if (this.opts.debug) log.info(`SIP <<< ${rinfo.address}:${rinfo.port}\n${raw}`);
    let msg: SipMessage;
    try {
      msg = parseMessage(raw);
    } catch (err) {
      log.warn('SIP: nicht lesbare Nachricht verworfen', (err as Error).message);
      return;
    }
    if (msg.status !== undefined) return this.onResponse(msg);
    // Steht die Telefonanlage im eigenen Netz (FRITZ!Box), kommen Anrufe nur von ihr: Ein INVITE von einem anderen
    // Gerät im LAN würde sonst den Anrufbeantworter auslösen. Bei Anbietern im Internet senden oft mehrere Server.
    if (msg.method === 'INVITE' && isPrivateIp(this.serverIp) && rinfo.address !== this.serverIp) {
      log.warn(`SIP: INVITE von ${rinfo.address} verworfen (nicht die Telefonanlage)`);
      return;
    }
    this.onRequest(msg, rinfo);
  }

  private onResponse(res: SipMessage): void {
    const { method } = cseqOf(res);
    const key = `${topViaBranch(res)}:${method}`;
    const tx = this.transactions.get(key);
    if (!tx) {
      // z. B. wiederholtes 200 OK auf INVITE -> ACK erneut senden
      if (method === 'INVITE' && res.status! >= 200 && res.status! < 300) {
        this.calls.get(getHeader(res, 'Call-ID') ?? '')?.resendAck();
      }
      return;
    }
    if (res.status! < 200) {
      tx.gotProvisional = true;
      if (tx.method === 'INVITE') clearTimeout(tx.timer);
      tx.onProvisional?.(res);
      return;
    }
    clearTimeout(tx.timer);
    this.transactions.delete(key);
    if (tx.method === 'INVITE' && res.status! >= 300) this.ackNon2xx(tx.raw, res);
    tx.resolve(res);
  }

  /** ACK für negative INVITE-Antworten: gleiche Transaktion (gleicher Branch). */
  private ackNon2xx(inviteRaw: string, res: SipMessage): void {
    const invite = parseMessage(inviteRaw);
    const { seq } = cseqOf(invite);
    const headers: [string, string][] = [
      ['Via', getHeaders(invite, 'Via')[0]],
      ['Max-Forwards', '70'],
      ['From', getHeader(invite, 'From')!],
      ['To', getHeader(res, 'To')!],
      ['Call-ID', getHeader(invite, 'Call-ID')!],
      ['CSeq', `${seq} ACK`],
      ...getHeaders(invite, 'Route').map((r): [string, string] => ['Route', r]),
      ['User-Agent', USER_AGENT],
    ];
    this.sendMessage({ method: 'ACK', uri: invite.uri, headers, body: '' });
  }

  private onRequest(req: SipMessage, rinfo: dgram.RemoteInfo): unknown {
    const call = this.calls.get(getHeader(req, 'Call-ID') ?? '');
    switch (req.method) {
      case 'ACK':
        if (call instanceof IncomingCall) call.onAck();
        return;
      case 'OPTIONS':
        return this.respond(req, rinfo, 200, 'OK');
      case 'NOTIFY':
        this.respond(req, rinfo, 200, 'OK');
        // Nach einem REFER meldet die Box den Stand der Vermittlung als sipfrag ("SIP/2.0 200 OK")
        if (call instanceof Call && /refer/i.test(getHeader(req, 'Event') ?? '')) call.onReferNotify(req.body);
        return;
      case 'BYE':
        if (!call) return this.respond(req, rinfo, 481, 'Call/Transaction Does Not Exist');
        this.respond(req, rinfo, 200, 'OK');
        return call.remoteHangup();
      case 'INVITE': {
        if (call instanceof IncomingCall) return call.onInviteAgain(req, rinfo);
        if (call) return this.respond(req, rinfo, 488, 'Not Acceptable Here'); // Re-INVITE im ausgehenden Gespräch
        if (this.listenerCount('incoming') === 0) return this.respond(req, rinfo, 486, 'Busy Here');
        // Eingehender Anruf: 100 sofort, alles Weitere entscheidet der CallManager (klingeln lassen, annehmen, abweisen)
        const incoming = new IncomingCall(this, req, rinfo);
        this.calls.set(incoming.callId, incoming);
        incoming.once('ended', () => this.calls.delete(incoming.callId));
        this.respond(req, rinfo, 100, 'Trying', incoming.localTag);
        this.emit('incoming', incoming);
        return;
      }
      case 'CANCEL':
        if (call instanceof IncomingCall) {
          this.respond(req, rinfo, 200, 'OK');
          return call.remoteCancel();
        }
        return this.respond(req, rinfo, 481, 'Call/Transaction Does Not Exist');
      default:
        return this.respond(req, rinfo, 405, 'Method Not Allowed');
    }
  }

  /** Antwort auf einen Request. `tag` hält das To-Tag über mehrere Antworten eines Dialogs stabil. */
  respond(req: SipMessage, rinfo: dgram.RemoteInfo, status: number, reason: string, tag?: string, extra: [string, string][] = [], body = ''): string {
    let to = getHeader(req, 'To') ?? '';
    if (status > 100 && !getParam(to, 'tag')) to += `;tag=${tag ?? rand()}`;
    const headers: [string, string][] = [
      ...getHeaders(req, 'Via').map((v): [string, string] => ['Via', v]),
      ...getHeaders(req, 'Record-Route').map((r): [string, string] => ['Record-Route', r]),
      ['From', getHeader(req, 'From') ?? ''],
      ['To', to],
      ['Call-ID', getHeader(req, 'Call-ID') ?? ''],
      ['CSeq', getHeader(req, 'CSeq') ?? ''],
      ['User-Agent', USER_AGENT],
      ...extra,
    ];
    if (body) headers.push(['Content-Type', 'application/sdp']);
    const raw = serialize({ status, reason, headers, body });
    this.sendRaw(raw, rinfo.port, rinfo.address);
    return raw;
  }

  /** Rohdaten erneut an eine Gegenstelle senden (Retransmission von Antworten). */
  resend(raw: string, rinfo: dgram.RemoteInfo): void {
    this.sendRaw(raw, rinfo.port, rinfo.address);
  }
}

/**
 * Ein eingehender Anruf (UAS). Events: 'answered' (remoteSdp: Angebot des Anrufers), 'ended' (reason).
 * Ablauf: 100 kommt vom Client, dann ring() -> 180; answer(sdp) -> 200 (wiederholt bis ACK);
 * reject() -> 486; CANCEL des Anrufers -> 487.
 */
export class IncomingCall extends EventEmitter {
  readonly callId: string;
  readonly localTag = rand();
  /** Rufnummer des Anrufers (User-Teil der From-URI) */
  readonly caller: string;
  /** Gewählte eigene Rufnummer (P-Called-Party-ID der FRITZ!Box, sonst User-Teil der To-URI) */
  readonly called: string;
  state: 'ringing' | 'connected' | 'ended' = 'ringing';
  private dialog: DialogInfo;
  private remoteTarget: string;
  private okRaw?: string;
  private okTimer?: NodeJS.Timeout;
  private acked = false;
  private inviteCseq: string;

  constructor(private client: SipClient, private invite: SipMessage, private rinfo: dgram.RemoteInfo) {
    super();
    this.callId = getHeader(invite, 'Call-ID') ?? `${rand(10)}@sipfunk`;
    const from = getHeader(invite, 'From') ?? '';
    this.caller = /sip:([^@;>]+)/.exec(extractUri(from))?.[1] ?? 'unbekannt';
    const calledHeader = getHeader(invite, 'P-Called-Party-ID') ?? getHeader(invite, 'To') ?? '';
    this.called = /sip:([^@;>]+)/.exec(extractUri(calledHeader))?.[1] ?? '';
    this.inviteCseq = getHeader(invite, 'CSeq') ?? '';
    this.remoteTarget = extractUri(getHeader(invite, 'Contact') ?? from);
    this.dialog = {
      callId: this.callId,
      fromTag: this.localTag,
      toUri: `<${extractUri(from)}>`,
      toTag: getParam(from, 'tag'),
      cseq: 1,
      // Als UAS gilt die Record-Route-Reihenfolge des INVITE unverändert
      routeSet: getHeaders(invite, 'Record-Route').flatMap(splitList),
    };
  }

  get remoteSdp(): string {
    return this.invite.body;
  }

  ring(): void {
    if (this.state !== 'ringing') return;
    this.client.respond(this.invite, this.rinfo, 180, 'Ringing', this.localTag);
  }

  /** Annehmen: 200 OK mit SDP-Antwort, bis zum ACK wiederholt. */
  answer(sdpAnswer: string): void {
    if (this.state !== 'ringing') return;
    this.state = 'connected';
    this.okRaw = this.client.respond(this.invite, this.rinfo, 200, 'OK', this.localTag, [['Contact', this.client.contact], ['Allow', 'INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY, REFER']], sdpAnswer);
    let interval = T1;
    let elapsed = 0;
    const retransmit = () => {
      if (this.acked || this.state === 'ended') return;
      elapsed += interval;
      if (elapsed >= TRANSACTION_TIMEOUT) {
        log.warn('SIP: kein ACK auf 200 OK – eingehendes Gespräch beendet');
        return this.end('kein ACK vom Anrufer');
      }
      this.client.resend(this.okRaw!, this.rinfo);
      interval = Math.min(interval * 2, T2);
      this.okTimer = setTimeout(retransmit, interval);
    };
    this.okTimer = setTimeout(retransmit, interval);
    this.emit('answered', this.remoteSdp);
  }

  /** Abweisen (besetzt). */
  reject(): void {
    if (this.state !== 'ringing') return;
    this.client.respond(this.invite, this.rinfo, 486, 'Busy Here', this.localTag);
    this.end('abgewiesen');
  }

  hangup(): void {
    if (this.state === 'ended') return;
    if (this.state === 'ringing') return this.reject();
    // Nicht auf die Antwort der Box warten: Bleibt sie aus, liefen RTP und KI-Sitzung sonst bis zum Timeout (32 s) weiter.
      // Das Ende wird wie bisher erst nach dem aktuellen Aufruf gemeldet (Aufrufer hängen ihre Listener danach an)
    void this.sendBye();
    setImmediate(() => this.end('aufgelegt'));
  }

  remoteHangup(): void {
    this.end('Gegenseite hat aufgelegt');
  }

  resendAck(): void {
    // nur für ausgehende Anrufe relevant
  }

  // ---- vom Client gerufen ----

  onAck(): void {
    this.acked = true;
    clearTimeout(this.okTimer);
  }

  /** Anrufer legt vor Annahme auf. */
  remoteCancel(): void {
    if (this.state !== 'ringing') return;
    this.client.respond(this.invite, this.rinfo, 487, 'Request Terminated', this.localTag);
    this.end('Anrufer hat aufgelegt');
  }

  /** INVITE erneut erhalten: Retransmission -> letzte Antwort wiederholen; Re-INVITE -> ablehnen. */
  onInviteAgain(req: SipMessage, rinfo: dgram.RemoteInfo): void {
    if (getHeader(req, 'CSeq') === this.inviteCseq) {
      if (this.okRaw) this.client.resend(this.okRaw, rinfo);
      else this.client.respond(req, rinfo, 180, 'Ringing', this.localTag);
      return;
    }
    this.client.respond(req, rinfo, 488, 'Not Acceptable Here', this.localTag);
  }

  private async sendBye(): Promise<void> {
    try {
      let res = await this.client.sendRequest(this.client.buildRequest('BYE', this.remoteTarget, this.dialog));
      if (res.status === 401 || res.status === 407) {
        this.dialog.cseq++;
        const auth = this.client.authHeader(res, 'BYE', this.remoteTarget);
        res = await this.client.sendRequest(this.client.buildRequest('BYE', this.remoteTarget, this.dialog, [auth]));
      }
    } catch (err) {
      log.warn('BYE:', (err as Error).message);
    }
  }

  private end(reason: string): void {
    if (this.state === 'ended') return;
    clearTimeout(this.okTimer);
    this.state = 'ended';
    this.emit('ended', reason);
  }
}

export type CallState = 'calling' | 'ringing' | 'connected' | 'ended';

/**
 * Ein ausgehender Anruf. Events:
 *  'state' (CallState), 'answered' (remoteSdp: string), 'ended' (reason: string)
 */
export class Call extends EventEmitter {
  readonly callId = `${rand(10)}@sipfunk`;
  state: CallState = 'calling';
  endReason?: string;
  private dialog: DialogInfo;
  private requestUri: string;
  private remoteTarget?: string;
  private inviteMsg?: SipMessage;
  private inviteAuth?: [string, string];
  private lastAck?: SipMessage;
  private hangupRequested = false;
  private referPending = false;
  private referResolve?: (ok: boolean, reason: string) => void;
  private referTimer?: NodeJS.Timeout;

  constructor(private client: SipClient, readonly target: string, private sdpOffer: string) {
    super();
    this.requestUri = `sip:${target}@${client.domain}`;
    this.dialog = { callId: this.callId, fromTag: rand(), toUri: `<${this.requestUri}>`, cseq: 1 };
  }

  async start(): Promise<void> {
    this.setState('calling');
    let res = await this.sendInvite();
    if (res.status === 401 || res.status === 407) {
      this.dialog.cseq++;
      this.inviteAuth = this.client.authHeader(res, 'INVITE', this.requestUri);
      res = await this.sendInvite();
    }
    if (res.status! >= 200 && res.status! < 300) return this.onAnswered(res);
    this.end(this.hangupRequested ? 'abgebrochen' : `nicht verbunden: ${res.status} ${res.reason}`);
  }

  /** Legt auf: CANCEL vor Annahme, BYE danach. */
  hangup(): void {
    if (this.state === 'ended' || this.hangupRequested) return;
    this.hangupRequested = true;
    if (this.state === 'connected') {
      // Nicht auf die Antwort der Box warten: Bleibt sie aus, liefen RTP und KI-Sitzung sonst bis zum Timeout (32 s) weiter.
      // Das Ende wird wie bisher erst nach dem aktuellen Aufruf gemeldet (Aufrufer hängen ihre Listener danach an)
      void this.sendBye();
      setImmediate(() => this.end('aufgelegt'));
    } else if (this.inviteMsg) {
      this.sendCancel();
      // Fallback, falls die Box auf CANCEL nicht reagiert
      setTimeout(() => this.end('abgebrochen'), 5000).unref();
    } else {
      this.end('abgebrochen');
    }
  }

  remoteHangup(): void {
    this.end(this.referPending ? 'vermittelt' : 'Gegenseite hat aufgelegt');
  }

  resendAck(): void {
    if (this.lastAck) this.client.sendMessage(this.lastAck);
  }

  /**
   * Vermittlung (RFC 3515): Die Box soll den Gesprächspartner mit `target` verbinden. Löst sich mit dem
   * Ergebnis auf, sobald die Box per NOTIFY den Erfolg meldet (danach beendet sie unser Gespräch per BYE)
   * oder einen Fehler; ohne Rückmeldung nach 30 s.
   */
  refer(target: string): Promise<{ ok: boolean; reason: string }> {
    if (this.state !== 'connected') return Promise.resolve({ ok: false, reason: 'kein verbundenes Gespräch' });
    const referTo = `<sip:${target}@${this.client.domain}>`;
    const uri = this.remoteTarget ?? this.requestUri;
    const extra: [string, string][] = [
      ['Refer-To', referTo],
      ['Referred-By', `<${this.client.aor}>`],
    ];
    return new Promise((resolve) => {
      const finish = (ok: boolean, reason: string) => {
        clearTimeout(this.referTimer);
        this.referTimer = undefined;
        this.referResolve = undefined;
        if (!ok) this.referPending = false;
        resolve({ ok, reason });
      };
      (async () => {
        this.dialog.cseq++;
        let res = await this.client.sendRequest(this.client.buildRequest('REFER', uri, this.dialog, extra));
        if (res.status === 401 || res.status === 407) {
          this.dialog.cseq++;
          res = await this.client.sendRequest(this.client.buildRequest('REFER', uri, this.dialog, [...extra, this.client.authHeader(res, 'REFER', uri)]));
        }
        log.info(`REFER an ${target}: ${res.status} ${res.reason}`);
        if (res.status! < 200 || res.status! >= 300) return finish(false, `Box lehnt Vermittlung ab: ${res.status} ${res.reason}`);
        this.referPending = true;
        this.referResolve = finish;
        this.referTimer = setTimeout(() => finish(false, 'keine Rückmeldung der Box zur Vermittlung'), 30_000);
        this.referTimer.unref();
      })().catch((err) => finish(false, (err as Error).message));
    });
  }

  /** NOTIFY zur Vermittlung: Body ist ein sipfrag wie "SIP/2.0 180 Ringing" oder "SIP/2.0 200 OK". */
  onReferNotify(body: string): void {
    const m = /SIP\/2\.0\s+(\d{3})\s*(.*)/.exec(body);
    if (!m || !this.referResolve) return;
    const status = Number(m[1]);
    log.info(`Vermittlung: ${status} ${m[2].trim()}`);
    if (status >= 200 && status < 300) this.referResolve(true, 'verbunden');
    else if (status >= 300) this.referResolve(false, `Vermittlung fehlgeschlagen: ${status} ${m[2].trim()}`);
  }

  fail(err: Error): void {
    this.end(`Fehler: ${err.message}`);
  }

  private sendInvite(): Promise<SipMessage> {
    const extra = this.inviteAuth ? [this.inviteAuth] : [];
    this.inviteMsg = this.client.buildRequest('INVITE', this.requestUri, this.dialog, extra, this.sdpOffer);
    return this.client.sendRequest(this.inviteMsg, (res) => {
      if (res.status === 180 || res.status === 183) this.setState('ringing');
    });
  }

  private sendCancel(): void {
    const invite = this.inviteMsg!;
    const headers: [string, string][] = [
      ['Via', getHeaders(invite, 'Via')[0]],
      ['Max-Forwards', '70'],
      ['From', getHeader(invite, 'From')!],
      ['To', getHeader(invite, 'To')!],
      ['Call-ID', this.callId],
      ['CSeq', `${this.dialog.cseq} CANCEL`],
      ['User-Agent', USER_AGENT],
    ];
    this.client
      .sendRequest({ method: 'CANCEL', uri: invite.uri, headers, body: '' })
      .catch((err) => log.warn('CANCEL:', err.message));
  }

  private onAnswered(res: SipMessage): void {
    this.dialog.toTag = getParam(getHeader(res, 'To') ?? '', 'tag');
    this.remoteTarget = extractUri(getHeader(res, 'Contact') ?? this.requestUri);
    this.dialog.routeSet = getHeaders(res, 'Record-Route').flatMap(splitList).reverse();
    this.lastAck = this.client.buildRequest('ACK', this.remoteTarget, this.dialog);
    this.client.sendMessage(this.lastAck);

    if (this.hangupRequested) {
      // CANCEL kam zu spät, Gespräch wurde trotzdem angenommen: beenden. War der Anruf schon als beendet gemeldet
      // (Box reagierte 5 s nicht auf CANCEL), bleibt es dabei – ein zweites „ended" träfe womöglich ein neues Gespräch
      void this.sendBye();
      this.end('abgebrochen');
      return;
    }
    this.setState('connected');
    this.emit('answered', res.body);
  }

  private async sendBye(): Promise<void> {
    this.dialog.cseq++;
    const uri = this.remoteTarget ?? this.requestUri;
    try {
      let res = await this.client.sendRequest(this.client.buildRequest('BYE', uri, this.dialog));
      if (res.status === 401 || res.status === 407) {
        this.dialog.cseq++;
        const auth = this.client.authHeader(res, 'BYE', uri);
        res = await this.client.sendRequest(this.client.buildRequest('BYE', uri, this.dialog, [auth]));
      }
    } catch (err) {
      log.warn('BYE:', (err as Error).message);
    }
  }

  private setState(state: CallState): void {
    if (this.state === state && state !== 'calling') return;
    this.state = state;
    this.emit('state', state);
  }

  private end(reason: string): void {
    if (this.state === 'ended') return;
    this.endReason = reason;
    this.state = 'ended';
    this.emit('state', 'ended');
    this.emit('ended', reason);
  }
}

/** Ermittelt die lokale IP, über die der Server erreichbar ist. */
async function detectLocalIp(serverIp: string, port: number): Promise<string> {
  const sock = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.connect(port, serverIp, () => resolve());
    });
    return sock.address().address;
  } finally {
    sock.close();
  }
}
