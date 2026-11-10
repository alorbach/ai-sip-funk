// Offline-Ablauftest gegen eine simulierte FRITZ!Box (UDP auf localhost):
// REGISTER mit 401, INVITE mit 407, 180, 200 + SDP, RTP in beide Richtungen, BYE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { getHeader, getHeaders, parseMessage, serialize, type SipMessage } from '../src/sip/message.js';
import { parseChallenge } from '../src/sip/digest.js';
import { CallManager, type Status } from '../src/callManager.js';
import { ToneHandler } from '../src/rtp/testSources.js';

function reply(req: SipMessage, status: number, reason: string, extra: [string, string][] = [], body = ''): string {
  return serialize({
    status,
    reason,
    headers: [
      ...getHeaders(req, 'Via').map((v): [string, string] => ['Via', v]),
      ['From', getHeader(req, 'From')!],
      ['To', `${getHeader(req, 'To')!}${status > 100 ? ';tag=box1' : ''}`],
      ['Call-ID', getHeader(req, 'Call-ID')!],
      ['CSeq', getHeader(req, 'CSeq')!],
      ...extra,
    ],
    body,
  });
}

test('Registrierung, Anruf, Audio, Mithör-Mix und Auflegen', async () => {
  const box = dgram.createSocket('udp4');
  await new Promise<void>((r) => box.bind(0, '127.0.0.1', r));
  const boxPort = box.address().port;
  const seen: string[] = [];
  const boxRtp = dgram.createSocket('udp4');
  await new Promise<void>((r) => boxRtp.bind(0, '127.0.0.1', r));
  let rtpFromClient = 0;
  let clientRtp: dgram.RemoteInfo | undefined;
  boxRtp.on('message', (buf, rinfo) => {
    rtpFromClient++;
    clientRtp = rinfo;
    // Als "Gegenseite" ein RTP-Paket zurückschicken (A-law-Stille)
    const pkt = Buffer.concat([buf.subarray(0, 12), Buffer.alloc(160, 0xd5)]);
    boxRtp.send(pkt, rinfo.port, rinfo.address);
  });

  box.on('message', (buf, rinfo) => {
    const req = parseMessage(buf.toString());
    if (req.status) return;
    const send = (raw: string) => box.send(raw, rinfo.port, rinfo.address);
    const authorized = !!(getHeader(req, 'Authorization') ?? getHeader(req, 'Proxy-Authorization'));
    seen.push(`${req.method}${authorized ? '+auth' : ''}`);
    if (req.method === 'REGISTER') {
      if (!authorized) return send(reply(req, 401, 'Unauthorized', [['WWW-Authenticate', 'Digest realm="fritz.box", nonce="n1"']]));
      assert.equal(parseChallenge(getHeader(req, 'Authorization')!).username, 'tester');
      return send(reply(req, 200, 'OK', [['Expires', '300']]));
    }
    if (req.method === 'INVITE') {
      if (!authorized) return send(reply(req, 407, 'Proxy Authentication Required', [['Proxy-Authenticate', 'Digest realm="fritz.box", nonce="n2", qop="auth"']]));
      send(reply(req, 180, 'Ringing'));
      const sdp = `v=0\r\nc=IN IP4 127.0.0.1\r\nm=audio ${boxRtp.address().port} RTP/AVP 8\r\n`;
      return setTimeout(() => send(reply(req, 200, 'OK', [['Contact', `<sip:box@127.0.0.1:${boxPort}>`]], sdp)), 50);
    }
    if (req.method === 'BYE') return send(reply(req, 200, 'OK'));
  });

  const manager = new CallManager({
    sipServer: '127.0.0.1',
    sipServerPort: boxPort,
    sipUser: 'tester',
    sipPassword: 'pw',
    sipLocalPort: 0,
    rtpPort: 0,
    localIp: '127.0.0.1',
    sipDebug: false,
    maxCallSeconds: 60,
    liveListenEnabled: true,
  });
  const phases: string[] = [];
  manager.on('status', (s: Status) => {
    if (phases.at(-1) !== s.phase) phases.push(s.phase);
  });
  let mixFrames = 0;
  manager.on('audio', (pcm: Int16Array) => {
    assert.equal(pcm.length, 160);
    mixFrames++;
  });

  await manager.start();
  assert.equal(manager.status().phase, 'idle');
  assert.throws(() => manager.prepare('112'), /Notruf/);

  manager.dial('**610', 'tone', new ToneHandler());
  await new Promise<void>((r) => manager.on('status', (s: Status) => s.phase === 'connected' && r()));
  assert.equal(manager.status().codec, 'PCMA');
  await new Promise((r) => setTimeout(r, 300));

  manager.hangup();
  const reason: string = await new Promise((r) => manager.once('callEnded', r));
  await manager.stop();
  box.close();
  boxRtp.close();

  assert.equal(reason, 'aufgelegt');
  assert.deepEqual(phases, ['idle', 'calling', 'ringing', 'connected', 'ended']);
  assert.deepEqual(seen.slice(0, 5), ['REGISTER', 'REGISTER+auth', 'INVITE', 'ACK', 'INVITE+auth']);
  assert.ok(seen.includes('BYE'));
  assert.ok(rtpFromClient >= 10, `nur ${rtpFromClient} RTP-Pakete`);
  assert.ok(mixFrames >= 10, `nur ${mixFrames} Mithör-Frames`);
  assert.ok(clientRtp);
  assert.match(manager.status().result ?? '', /Gesprächsdauer/);
});
