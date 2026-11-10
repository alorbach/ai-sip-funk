// Zustandsmaschine für genau ein Gespräch: Registrierung, Wählen, Audio, Limits, Auflegen.
import { EventEmitter } from 'node:events';
import { checkDialTarget, normalizeTarget } from './dialPolicy.js';
import { log } from './log.js';
import { decodeG711, encodeG711 } from './rtp/g711.js';
import { RtpSession } from './rtp/session.js';
import { Call, SipClient, type IncomingCall } from './sip/client.js';
import { buildAnswer, buildOffer, codecLabel, parseAnswer } from './sip/sdp.js';

const RING_TIMEOUT_SEC = 60;
/** Klingelrhythmus in Deutschland: 1 s Ton, 4 s Pause */
const RING_PERIOD_MS = 5000;

/** Verarbeitet das Telefon-Audio eines Gesprächs. PCM16 mit der Abtastrate des Gesprächs (8 oder 16 kHz), 20-ms-Frames. */
export interface AudioHandler {
  /** Gespräch ist angenommen, RTP läuft; ab jetzt gilt diese Abtastrate. */
  onConnected?(sampleRate: number): void;
  onRemoteAudio(pcm: Int16Array): void;
  nextFrame(): Int16Array | undefined;
  close(): void;
}

export type Phase = 'starting' | 'offline' | 'idle' | 'calling' | 'ringing' | 'incoming' | 'connected' | 'ended';

/** Anrufbeantworter: eingehende Anrufe annehmen? Default aus. */
export interface IncomingSettings {
  enabled: boolean;
  /** Annahme beim n-ten Klingeln (1 = sofort) */
  answerAfterRings: number;
}

export interface Status {
  phase: Phase;
  registered: boolean;
  target?: string;
  mode?: string;
  /** true = das laufende/letzte Gespräch war ein eingehender Anruf */
  incoming?: boolean;
  incomingSettings: IncomingSettings;
  connectedAt?: number;
  durationSec: number;
  codec?: string;
  /** Abtastrate des laufenden Gesprächs (fürs Mithören) */
  sampleRate?: number;
  rtpSent: number;
  rtpReceived: number;
  result?: string;
  maxCallSeconds: number;
  liveListen: boolean;
  /** false = es sind noch keine SIP-Zugangsdaten hinterlegt (Einrichtung offen) */
  sipConfigured: boolean;
  /** Grund der letzten fehlgeschlagenen Anmeldung an der Telefonanlage */
  sipError?: string;
}

/** Zugangsdaten zur Telefonanlage (FRITZ!Box oder SIP-Anschluss). */
export interface SipAccount {
  server: string;
  user: string;
  password: string;
}

export interface CallManagerOptions {
  sipServer: string;
  sipServerPort?: number;
  sipUser: string;
  sipPassword: string;
  sipLocalPort: number;
  rtpPort: number;
  localIp?: string;
  sipDebug: boolean;
  maxCallSeconds: number;
  liveListenEnabled: boolean;
  /** 16-kHz-G.711 (HD) anbieten und annehmen; false = nur klassisches 8 kHz */
  hdAudio?: boolean;
  incoming?: IncomingSettings;
  /** Liefert den Audio-Handler für einen angenommenen eingehenden Anruf (Anrufer-Nummer, gewählte eigene Nummer). */
  createIncomingHandler?: (caller: string, called: string, opts?: { forceScam?: boolean }) => AudioHandler;
  /** Abweichende Annahme je gewählter eigener Nummer (Profil): undefined-Felder = allgemeine Einstellung */
  incomingFor?: (called: string) => { enabled?: boolean; answerAfterRings?: number } | undefined;
}

/**
 * Events: 'status' (Status), 'audio' (Int16Array – Mix beider Seiten, 20 ms),
 * 'callEnded' (reason: string), 'incoming' (caller: string, answered: boolean),
 * 'ring' ({ caller, called, willAnswer, answerAt? }) solange ein Anruf klingelt, 'ringEnd' wenn er angenommen wurde oder endete.
 */
export class CallManager extends EventEmitter {
  private sip: SipClient;
  private phase: Phase = 'starting';
  private registered = false;
  private call?: Call | IncomingCall;
  private isIncoming = false;
  private incoming: IncomingSettings;
  private answerTimer?: NodeJS.Timeout;
  /** Klingelnder Anruf, den die KI annehmen wird (bis zur Annahme) */
  private ringingInc?: IncomingCall;
  /** Klingelnder Anruf, den die KI NICHT annimmt (Anrufbeantworter aus oder übersprungen) – kann per divertIncoming übernommen werden */
  private pendingInc?: IncomingCall;
  private rtp?: RtpSession;
  private handler?: AudioHandler;
  private target?: string;
  private mode?: string;
  private connectedAt?: number;
  private codec?: string;
  private result?: string;
  private limitTimer?: NodeJS.Timeout;
  /** Erneuter Anmeldeversuch nach einem fehlgeschlagenen Start */
  private retryTimer?: NodeJS.Timeout;
  private sipError?: string;
  private ringTimer?: NodeJS.Timeout;
  private remoteQueue: Int16Array[] = [];

  constructor(private opts: CallManagerOptions) {
    super();
    this.sip = this.createSip();
    this.incoming = opts.incoming ?? { enabled: false, answerAfterRings: 5 };
  }

  /** SIP-Client mit den aktuellen Zugangsdaten; Ereignisse eines abgelösten Clients werden ignoriert. */
  private createSip(): SipClient {
    const sip = new SipClient({
      server: this.opts.sipServer,
      serverPort: this.opts.sipServerPort,
      user: this.opts.sipUser,
      password: this.opts.sipPassword,
      localPort: this.opts.sipLocalPort,
      localIp: this.opts.localIp,
      debug: this.opts.sipDebug,
    });
    sip.on('registered', () => {
      if (sip !== this.sip) return;
      this.registered = true;
      this.sipError = undefined;
      if (this.phase === 'starting' || this.phase === 'offline') this.setPhase('idle');
      else this.emitStatus();
    });
    sip.on('registrationFailed', (err?: Error) => {
      if (sip !== this.sip) return;
      this.registered = false;
      this.sipError = err?.message;
      if (!this.call) this.setPhase('offline');
      else this.emitStatus();
    });
    sip.on('incoming', (inc: IncomingCall) => {
      if (sip === this.sip) this.onIncoming(inc);
    });
    return sip;
  }

  private get sipConfigured(): boolean {
    return Boolean(this.opts.sipUser && this.opts.sipPassword);
  }

  /** Gesprächslimit aus den Einstellungen übernehmen (gilt ab dem nächsten Anruf). */
  setMaxCallSeconds(seconds: number): void {
    this.opts.maxCallSeconds = seconds;
  }

  /** Anrufbeantworter zur Laufzeit umschalten (UI/Settings). */
  setIncoming(settings: Partial<IncomingSettings>): void {
    this.incoming = { ...this.incoming, ...settings };
    this.incoming.answerAfterRings = Math.max(1, Math.min(10, Math.round(this.incoming.answerAfterRings) || 5));
    log.info(`Anrufbeantworter ${this.incoming.enabled ? `an, Annahme beim ${this.incoming.answerAfterRings}. Klingeln` : 'aus'}`);
    this.emitStatus();
  }

  /**
   * Eingehender Anruf. Aus oder kein Handler: klingeln lassen (andere Telefone klingeln weiter,
   * der Anrufer legt irgendwann auf). Besetzt: abweisen. Sonst nach der Klingelzahl annehmen.
   */
  private onIncoming(inc: IncomingCall): void {
    if (this.call) {
      log.info(`Eingehender Anruf von ${inc.caller} während eines Gesprächs – besetzt`);
      inc.reject();
      return;
    }
    inc.ring();
    const over = this.opts.incomingFor?.(inc.called);
    const enabled = over?.enabled ?? this.incoming.enabled;
    const rings = Math.max(1, Math.min(10, over?.answerAfterRings ?? this.incoming.answerAfterRings));
    if (!enabled || !this.opts.createIncomingHandler) {
      log.info(`Eingehender Anruf von ${inc.caller}${inc.called ? ` für ${inc.called}` : ''} – Anrufbeantworter ${over?.enabled === false ? 'für diese Nummer aus' : 'aus'}, klingelt nur`);
      this.watchPending(inc);
      this.emit('incoming', inc.caller, false);
      this.emit('ring', { caller: inc.caller, called: inc.called, willAnswer: false });
      return;
    }
    this.track(inc);
    const delay = (rings - 1) * RING_PERIOD_MS;
    log.info(`Eingehender Anruf von ${inc.caller}${inc.called ? ` für ${inc.called}` : ''} – Annahme beim ${rings}. Klingeln${over?.answerAfterRings ? ' (Profil)' : ''}, in ${delay / 1000}s`);
    this.setPhase('incoming');
    this.emit('incoming', inc.caller, true);
    this.emit('ring', { caller: inc.caller, called: inc.called, willAnswer: true, answerAt: Date.now() + delay });
    // Den KI-Handler schon beim Klingeln erzeugen: So steht die Verbindung zu OpenAI beim Abnehmen
    // bereits, und der Anrufer hört die Ansage ohne Sekunden der Stille. Legt er vorher auf,
    // räumt onEnded den Handler wieder ab.
    try {
      this.handler = this.opts.createIncomingHandler!(inc.caller, inc.called);
    } catch (err) {
      log.error(`Eingehender Anruf: kein Handler (${(err as Error).message})`);
      inc.reject();
      return;
    }
    this.answerTimer = setTimeout(() => this.answerNow(inc), delay);
  }

  /** Klingelnden Anruf als „unser Gespräch" führen (Zustand wie bei einem ausgehenden Anruf). */
  private track(inc: IncomingCall): void {
    this.call = inc;
    this.ringingInc = inc;
    this.pendingInc = undefined;
    this.isIncoming = true;
    this.target = inc.caller;
    this.mode = 'ai';
    this.result = undefined;
    this.connectedAt = undefined;
    this.codec = undefined;
    this.remoteQueue = [];
    inc.removeAllListeners('ended');
    // Nur solange der Anruf unser Gespräch ist, beendet sein Ende das Gespräch (nach „klingeln lassen" nicht mehr)
    inc.on('ended', (reason: string) => {
      if (this.call === inc) this.onEnded(reason);
      else this.pendingEnded(inc, reason);
    });
  }

  /** Klingelt nur (KI nimmt nicht an): merken, bis der Anrufer auflegt oder der Anruf umgeleitet wird. */
  private watchPending(inc: IncomingCall): void {
    this.pendingInc = inc;
    inc.removeAllListeners('ended');
    inc.on('ended', (reason: string) => {
      if (this.call === inc) this.onEnded(reason);
      else this.pendingEnded(inc, reason);
    });
  }

  private pendingEnded(inc: IncomingCall, reason: string): void {
    log.info(`Eingehender Anruf von ${inc.caller}: ${reason}`);
    if (this.pendingInc === inc) {
      this.pendingInc = undefined;
      this.emit('ringEnd');
    }
  }

  private answerNow(inc: IncomingCall): void {
    if (this.call !== inc || inc.state !== 'ringing') return;
    clearTimeout(this.answerTimer);
    let offer;
    try {
      offer = parseAnswer(inc.remoteSdp, this.opts.hdAudio ?? true);
    } catch (err) {
      log.error(`Eingehender Anruf: ${(err as Error).message}`);
      inc.reject();
      return;
    }
    this.ringingInc = undefined;
    this.emit('ringEnd');
    inc.once('answered', (sdp: string) => this.onAnswered(sdp));
    inc.answer(buildAnswer(this.sip.localIp, this.opts.rtpPort, offer.codec));
  }

  /**
   * Klingelnden Anruf von Hand lenken (Pop-up der Tray-App, Web-UI):
   * 'scam' = sofort annehmen und in die Spam-Falle (KI als Privatperson), 'answer' = sofort normal annehmen,
   * 'skip' = die KI nimmt diesen Anruf nicht an, er klingelt nur weiter.
   */
  divertIncoming(mode: 'scam' | 'answer' | 'skip'): { ok: boolean; reason: string } {
    const tracked = this.ringingInc && this.call === this.ringingInc && this.ringingInc.state === 'ringing' ? this.ringingInc : undefined;
    const inc = tracked ?? (this.pendingInc?.state === 'ringing' ? this.pendingInc : undefined);
    if (!inc) return { ok: false, reason: 'Es klingelt gerade kein Anruf' };
    if (mode === 'skip') {
      if (!tracked) return { ok: true, reason: 'klingelt nur' };
      log.info(`Eingehender Anruf von ${inc.caller}: von Hand auf „klingeln lassen" gestellt`);
      this.untrack(inc);
      return { ok: true, reason: 'klingelt nur' };
    }
    if (!this.opts.createIncomingHandler) return { ok: false, reason: 'Kein KI-Handler (OPENAI_API_KEY fehlt)' };
    if (!tracked) {
      if (this.call) return { ok: false, reason: 'Es läuft bereits ein Gespräch' };
      this.track(inc);
      this.setPhase('incoming');
    }
    clearTimeout(this.answerTimer);
    try {
      // Spam-Falle braucht andere Anweisungen: den beim Klingeln vorbereiteten Handler ersetzen
      if (mode === 'scam' || !this.handler) {
        this.handler?.close();
        this.handler = this.opts.createIncomingHandler(inc.caller, inc.called, { forceScam: mode === 'scam' });
      }
    } catch (err) {
      log.error(`Umleiten fehlgeschlagen: ${(err as Error).message}`);
      // Ohne Handler kann die KI nicht annehmen: Der Anruf klingelt nur weiter, statt als „eingehender Anruf" hängen zu bleiben
      this.untrack(inc);
      return { ok: false, reason: (err as Error).message };
    }
    log.info(`Eingehender Anruf von ${inc.caller}: von Hand ${mode === 'scam' ? 'in die Spam-Falle umgeleitet' : 'sofort angenommen'}`);
    this.answerNow(inc);
    return { ok: true, reason: mode === 'scam' ? 'Spam-Falle' : 'angenommen' };
  }

  /** Klingelnden Anruf wieder abgeben: Die KI nimmt ihn nicht an, er klingelt nur weiter (umleitbar bleibt er). */
  private untrack(inc: IncomingCall): void {
    clearTimeout(this.answerTimer);
    this.handler?.close();
    this.handler = undefined;
    this.call = undefined;
    this.ringingInc = undefined;
    this.isIncoming = false;
    this.target = undefined;
    this.pendingInc = inc;
    this.setPhase(this.registered ? 'idle' : 'offline');
    this.emit('ring', { caller: inc.caller, called: inc.called, willAnswer: false });
  }

  /** Meldet sich an der Telefonanlage an. Ohne Zugangsdaten (Einrichtung offen) bleibt die App „nicht verbunden“. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    clearTimeout(this.retryTimer);
    if (!this.sipConfigured) {
      log.info('SIP: noch keine Zugangsdaten – Einrichtung über die Web-UI');
      this.setPhase('offline');
      return { ok: false, error: 'Noch keine Zugangsdaten hinterlegt' };
    }
    const sip = this.sip;
    try {
      await sip.start();
      return { ok: true };
    } catch (err) {
      const error = (err as Error).message;
      // Inzwischen durch neue Zugangsdaten abgelöst: der alte Versuch geht niemanden mehr an
      if (sip !== this.sip) return { ok: false, error };
      log.error('SIP-Start fehlgeschlagen:', error);
      this.sipError = error;
      this.setPhase('offline');
      // nach einer Minute erneut versuchen
      this.retryTimer = setTimeout(() => void this.start(), 60_000);
      this.retryTimer.unref();
      return { ok: false, error };
    }
  }

  /**
   * Neue Zugangsdaten zur Laufzeit übernehmen: alten SIP-Client abmelden und schließen, neuen starten.
   * Wartet höchstens `waitMs` auf die Anmeldung; danach läuft der Versuch im Hintergrund weiter.
   */
  async reconfigureSip(account: SipAccount, waitMs = 10_000): Promise<{ ok: boolean; error?: string }> {
    if (this.call || this.pendingInc) throw new Error('Während eines Gesprächs lassen sich die Zugangsdaten nicht ändern');
    clearTimeout(this.retryTimer);
    const old = this.sip;
    this.opts = { ...this.opts, sipServer: account.server, sipUser: account.user, sipPassword: account.password };
    this.registered = false;
    this.sipError = undefined;
    // Erst den neuen Client zum aktuellen machen: Ereignisse des alten zählen ab hier nicht mehr
    this.sip = this.createSip();
    this.setPhase('starting');
    await old.stop().catch(() => undefined);
    const attempt = this.start();
    const timeout = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      setTimeout(() => resolve({ ok: false, error: `Keine Antwort von ${account.server} – läuft die Telefonanlage, und stimmt die Adresse?` }), waitMs).unref();
    });
    return Promise.race([attempt, timeout]);
  }

  async stop(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.hangup('Anwendung beendet');
    await this.sip.stop();
  }

  status(): Status {
    return {
      phase: this.phase,
      registered: this.registered,
      target: this.target,
      mode: this.mode,
      incoming: this.isIncoming,
      incomingSettings: this.incoming,
      connectedAt: this.connectedAt,
      durationSec: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0,
      codec: this.codec,
      sampleRate: this.rtp?.codec.sampleRate,
      rtpSent: this.rtp?.packetsSent ?? 0,
      rtpReceived: this.rtp?.packetsReceived ?? 0,
      result: this.result,
      maxCallSeconds: this.opts.maxCallSeconds,
      liveListen: this.opts.liveListenEnabled,
      sipConfigured: this.sipConfigured,
      sipError: this.registered ? undefined : this.sipError,
    };
  }

  /** Prüft ein Rufziel, ohne zu wählen. Liefert die normalisierte Nummer. */
  prepare(rawTarget: string): string {
    const blocked = checkDialTarget(rawTarget);
    if (blocked) throw new Error(blocked);
    return normalizeTarget(rawTarget);
  }

  /**
   * Wirft, wenn jetzt nicht gewählt werden kann (Gespräch läuft, nicht registriert, Ziel gesperrt).
   * Vor dem Erzeugen des Audio-Handlers aufrufen: Ein KI-Handler baut sonst für nichts eine Verbindung auf.
   */
  checkDial(rawTarget: string): string {
    if (this.call) throw new Error('Es läuft bereits ein Gespräch');
    if (!this.sipConfigured) throw new Error('Die Telefonanlage ist noch nicht eingerichtet (Einstellungen › Einrichtungsassistent)');
    if (!this.registered) throw new Error('Nicht an der Telefonanlage angemeldet');
    return this.prepare(rawTarget);
  }

  /** Wählt. Der Aufrufer hat die Nummer vorher bestätigt. */
  dial(rawTarget: string, mode: string, handler: AudioHandler): void {
    const target = this.checkDial(rawTarget);

    this.target = target;
    this.mode = mode;
    this.isIncoming = false;
    this.handler = handler;
    this.result = undefined;
    this.connectedAt = undefined;
    this.codec = undefined;
    this.remoteQueue = [];
    log.info(`Wähle ${target} (${mode})`);

    const call = this.sip.call(target, buildOffer(this.sip.localIp, this.opts.rtpPort, this.opts.hdAudio ?? true));
    this.call = call;
    this.setPhase('calling');

    this.ringTimer = setTimeout(() => {
      log.info(`Keine Annahme nach ${RING_TIMEOUT_SEC}s – breche ab`);
      call.hangup();
    }, RING_TIMEOUT_SEC * 1000);

    call.on('state', (state) => {
      if (state === 'ringing') this.setPhase('ringing');
    });
    call.on('answered', (sdp: string) => this.onAnswered(sdp));
    call.on('ended', (reason: string) => {
      if (this.call === call) this.onEnded(reason);
    });
  }

  /**
   * Vermittelt das laufende ausgehende Gespräch per REFER an eine andere Nummer: Die Box verbindet
   * unseren Gesprächspartner mit `target` und beendet danach unser Gespräch.
   */
  transfer(target: string): Promise<{ ok: boolean; reason: string }> {
    // Auch beim Vermitteln gilt der Rufzielschutz: Das Ziel ist die Nummer eines Anrufers, also von außen vorgegeben
    const blocked = checkDialTarget(target);
    if (blocked) {
      log.warn(`Vermittlung abgelehnt: ${blocked}`);
      return Promise.resolve({ ok: false, reason: blocked });
    }
    if (!this.call || this.isIncoming || !(this.call instanceof Call)) return Promise.resolve({ ok: false, reason: 'kein ausgehendes Gespräch' });
    const number = normalizeTarget(target);
    log.info(`Vermittle an ${number}`);
    return this.call.refer(number);
  }

  hangup(reason = 'Vom Nutzer aufgelegt'): void {
    if (!this.call) return;
    log.info(`Auflegen: ${reason}`);
    this.call.hangup();
  }

  private async onAnswered(sdp: string): Promise<void> {
    clearTimeout(this.ringTimer);
    let answer;
    try {
      answer = parseAnswer(sdp, this.opts.hdAudio ?? true);
    } catch (err) {
      log.error((err as Error).message);
      this.call?.hangup();
      return;
    }
    const codec = answer.codec;
    this.codec = codecLabel(codec);
    this.connectedAt = Date.now();
    const rtp = new RtpSession(this.opts.rtpPort, codec);
    this.rtp = rtp;

    rtp.setSource(() => {
      const pcm = this.handler?.nextFrame();
      return pcm ? encodeG711(pcm, codec.law) : undefined;
    });
    rtp.on('frame', (payload: Buffer) => {
      const pcm = decodeG711(payload, codec.law);
      this.handler?.onRemoteAudio(pcm);
      if (this.opts.liveListenEnabled && this.listenerCount('audio') > 0) {
        // Pakete der Gegenstelle können kürzer sein als unsere Frames (10 ms): flach sammeln
        this.remoteQueue.push(pcm);
        let total = 0;
        for (const q of this.remoteQueue) total += q.length;
        while (total > rtp.samplesPerFrame * 25 && this.remoteQueue.length > 1) total -= this.remoteQueue.shift()!.length;
      }
    });
    rtp.on('sent', (payload: Buffer) => {
      if (!this.opts.liveListenEnabled || this.listenerCount('audio') === 0) return;
      const sent = decodeG711(payload, codec.law);
      const mix = new Int16Array(rtp.samplesPerFrame);
      let chunk = this.remoteQueue[0];
      let pos = 0;
      for (let i = 0; i < mix.length; i++) {
        while (chunk && pos >= chunk.length) {
          this.remoteQueue.shift();
          chunk = this.remoteQueue[0];
          pos = 0;
        }
        const r = chunk ? chunk[pos++] : 0;
        const v = sent[i] + r;
        mix[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      if (chunk && pos > 0) this.remoteQueue[0] = chunk.subarray(pos);
      this.emit('audio', mix);
    });

    try {
      await rtp.start(answer.ip, answer.port);
    } catch (err) {
      log.error('RTP-Start fehlgeschlagen:', (err as Error).message);
      this.call?.hangup();
      return;
    }
    // Gespräch endete, während RTP startete: onEnded hat schon aufgeräumt, kein Limit-Timer und kein „verbunden" mehr
    if (this.rtp !== rtp) return;
    log.info(`Verbunden, Codec ${this.codec}, Gegenstelle ${answer.ip}:${answer.port}`);
    this.setPhase('connected');
    this.handler?.onConnected?.(codec.sampleRate);

    this.limitTimer = setTimeout(() => {
      this.hangup(`Gesprächslimit ${this.opts.maxCallSeconds}s erreicht`);
    }, this.opts.maxCallSeconds * 1000);
  }

  private onEnded(reason: string): void {
    clearTimeout(this.ringTimer);
    clearTimeout(this.limitTimer);
    clearTimeout(this.answerTimer);
    if (this.ringingInc) {
      this.ringingInc = undefined;
      this.emit('ringEnd');
    }
    const talk = this.connectedAt ? ((Date.now() - this.connectedAt) / 1000).toFixed(0) : '0';
    this.result = `${reason} – Gesprächsdauer ${talk}s, RTP ${this.rtp?.packetsSent ?? 0}/${this.rtp?.packetsReceived ?? 0}`;
    if (this.rtp) log.info(`RTP-Takt: ${this.rtp.bursts} Bursts (max. ${this.rtp.maxBurst} Frames), größte Timer-Lücke ${this.rtp.maxTickGapMs.toFixed(0)} ms`);
    log.info(`Gespräch beendet: ${this.result}`);
    this.rtp?.stop();
    this.handler?.close();
    this.rtp = undefined;
    this.handler = undefined;
    this.call = undefined;
    this.setPhase('ended');
    this.emit('callEnded', reason);
    // kurz "beendet" zeigen, dann zurück auf bereit
    setTimeout(() => {
      if (this.phase === 'ended') {
        this.connectedAt = undefined;
        this.setPhase(this.registered ? 'idle' : 'offline');
      }
    }, 3000).unref();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }
}
