// Phase-1-Spike ohne Web-UI: registrieren und optional eine Nebenstelle anrufen.
//
//   npm run test-call                      nur registrieren (Strg+C beendet)
//   npm run test-call -- **610             Anruf, Piepton abspielen
//   npm run test-call -- **610 --echo      Anruf, Gesagtes nach 1 s zurückspielen
//   npm run test-call -- **610 --seconds 60
import { loadConfig } from '../config.js';
import { log } from '../log.js';
import { CallManager } from '../callManager.js';
import { EchoHandler, ToneHandler } from '../rtp/testSources.js';

const args = process.argv.slice(2);
const echo = args.includes('--echo');
const secondsIdx = args.indexOf('--seconds');
// Der Wert hinter --seconds ist kein Rufziel
const target = args.find((a, i) => !a.startsWith('--') && i !== secondsIdx + 1 - (secondsIdx < 0 ? 1 : 0));
const config = loadConfig();
const maxSeconds = secondsIdx >= 0 ? Number(args[secondsIdx + 1]) : Math.min(30, config.maxCallSeconds);

const manager = new CallManager({
  sipServer: config.sipServer,
  sipUser: config.sipUser,
  sipPassword: config.sipPassword,
  sipLocalPort: config.sipLocalPort,
  rtpPort: config.rtpPort,
  localIp: config.localIp,
  sipDebug: config.sipDebug,
  maxCallSeconds: maxSeconds,
  liveListenEnabled: false,
});

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.stop();
  process.exit(code);
}
process.on('SIGINT', () => {
  log.info('Strg+C: beende ...');
  void shutdown();
});

manager.once('status', (s) => {
  if (s.phase === 'offline') return void shutdown(1);
  if (s.phase !== 'idle') return;
  if (!target) {
    log.info('Registrierung ok. Ohne Rufziel wird nur registriert – Strg+C zum Beenden.');
    return;
  }
  const statsTimer = setInterval(() => {
    const st = manager.status();
    if (st.phase === 'connected') log.info(`RTP: gesendet ${st.rtpSent}, empfangen ${st.rtpReceived}`);
  }, 5000);
  manager.once('callEnded', () => {
    clearInterval(statsTimer);
    void shutdown(0);
  });
  try {
    manager.dial(target, echo ? 'echo' : 'tone', echo ? new EchoHandler() : new ToneHandler());
  } catch (err) {
    log.error((err as Error).message);
    void shutdown(1);
  }
});

await manager.start();
