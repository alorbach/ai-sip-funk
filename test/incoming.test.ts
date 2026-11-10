// Eingehender Anruf gegen eine simulierte FRITZ!Box: INVITE -> 100/180 -> (Klingelzahl) -> 200 + SDP -> ACK,
// RTP, BYE vom Anrufer. Plus: Anrufbeantworter aus -> nur 180, CANCEL -> 487.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { getHeader, parseMessage, serialize, type SipMessage } from '../src/sip/message.js';
import { CallManager, type Status } from '../src/callManager.js';
import { ToneHandler } from '../src/rtp/testSources.js';

function reply(req: SipMessage, status: number, reason: string, extra: [string, string][] = []): string {
  return serialize({
    status,
    reason,
    headers: [['Via', getHeader(req, 'Via')!], ['From', getHeader(req, 'From')!], ['To', `${getHeader(req, 'To')!};tag=box1`], ['Call-ID', getHeader(req, 'Call-ID')!], ['CSeq', getHeader(req, 'CSeq')!], ...extra],
    body: '',
  });
}

async function setup(incomingEnabled: boolean, rings = 1) {
  const box = dgram.createSocket('udp4');
  await new Promise<void>((r) => box.bind(0, '127.0.0.1', r));
  const boxRtp = dgram.createSocket('udp4');
  await new Promise<void>((r) => boxRtp.bind(0, '127.0.0.1', r));
  const responses: number[] = [];
  let clientAddr: dgram.RemoteInfo | undefined;
  let rtpFromClient = 0;
  boxRtp.on('message', (buf, rinfo) => {
    rtpFromClient++;
    boxRtp.send(Buffer.concat([buf.subarray(0, 12), Buffer.alloc(160, 0xd5)]), rinfo.port, rinfo.address);
  });
  box.on('message', (buf, rinfo) => {
    const msg = parseMessage(buf.toString());
    if (msg.status !== undefined) {
      responses.push(msg.status);
      return;
    }
    clientAddr = rinfo;
    if (msg.method === 'REGISTER') box.send(reply(msg, 200, 'OK', [['Expires', '300']]), rinfo.port, rinfo.address);
    if (msg.method === 'BYE') box.send(reply(msg, 200, 'OK'), rinfo.port, rinfo.address);
  });
  let handlerCalls = 0;
  const handlerOpts: boolean[] = [];
  const manager = new CallManager({
    sipServer: '127.0.0.1',
    sipServerPort: box.address().port,
    sipUser: 'tester',
    sipPassword: 'pw',
    sipLocalPort: 0,
    rtpPort: 0,
    localIp: '127.0.0.1',
    sipDebug: false,
    maxCallSeconds: 60,
    liveListenEnabled: false,
    incoming: { enabled: incomingEnabled, answerAfterRings: rings },
    createIncomingHandler: (_caller, _called, opts) => {
      handlerCalls++;
      handlerOpts.push(opts?.forceScam === true);
      return new ToneHandler();
    },
  });
  await manager.start();
  const sendInvite = (callId: string) => {
    const sdp = `v=0\r\nc=IN IP4 127.0.0.1\r\nm=audio ${boxRtp.address().port} RTP/AVP 8 0\r\n`;
    const invite: SipMessage = {
      method: 'INVITE',
      uri: `sip:tester@127.0.0.1`,
      headers: [
        ['Via', `SIP/2.0/UDP 127.0.0.1:${box.address().port};branch=z9hG4bK${callId}`],
        ['From', `"Anrufer" <sip:0171555@127.0.0.1>;tag=caller1`],
        ['To', `<sip:tester@127.0.0.1>`],
        ['Call-ID', callId],
        ['CSeq', '1 INVITE'],
        ['Contact', `<sip:0171555@127.0.0.1:${box.address().port}>`],
        ['Content-Type', 'application/sdp'],
      ],
      body: sdp,
    };
    box.send(serialize(invite), clientAddr!.port, clientAddr!.address);
    return invite;
  };
  const sendCancel = (invite: SipMessage) => {
    const cancel: SipMessage = { method: 'CANCEL', uri: invite.uri, headers: invite.headers.filter(([k]) => !['Contact', 'Content-Type'].includes(k)).map(([k, v]) => (k === 'CSeq' ? ['CSeq', '1 CANCEL'] : [k, v])), body: '' };
    box.send(serialize(cancel), clientAddr!.port, clientAddr!.address);
  };
  const sendAck = (invite: SipMessage, toTag: string) => {
    const ack: SipMessage = { method: 'ACK', uri: invite.uri, headers: invite.headers.filter(([k]) => !['Contact', 'Content-Type'].includes(k)).map(([k, v]) => (k === 'CSeq' ? ['CSeq', '1 ACK'] : k === 'To' ? ['To', `${v};tag=${toTag}`] : [k, v])), body: '' };
    box.send(serialize(ack), clientAddr!.port, clientAddr!.address);
  };
  const sendBye = (invite: SipMessage, toTag: string) => {
    const bye: SipMessage = { method: 'BYE', uri: invite.uri, headers: invite.headers.filter(([k]) => !['Contact', 'Content-Type'].includes(k)).map(([k, v]) => (k === 'CSeq' ? ['CSeq', '2 BYE'] : k === 'To' ? ['To', `${v};tag=${toTag}`] : [k, v])), body: '' };
    box.send(serialize(bye), clientAddr!.port, clientAddr!.address);
  };
  const close = async () => {
    await manager.stop();
    box.close();
    boxRtp.close();
  };
  return { manager, box, responses, sendInvite, sendCancel, sendAck, sendBye, close, rtp: () => rtpFromClient, handlerCalls: () => handlerCalls, handlerOpts };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Anrufbeantworter an: eingehender Anruf wird angenommen, Audio läuft, Anrufer legt auf', async () => {
  const t = await setup(true);
  const phases: string[] = [];
  let toTag = '';
  t.manager.on('status', (s: Status) => phases.at(-1) !== s.phase && phases.push(s.phase));
  // 200 OK abfangen, um das To-Tag für ACK/BYE zu bekommen
  t.box.on('message', (buf) => {
    const msg = parseMessage(buf.toString());
    if (msg.status === 200 && getHeader(msg, 'CSeq')?.endsWith('INVITE')) toTag = /tag=([^;]+)/.exec(getHeader(msg, 'To') ?? '')?.[1] ?? '';
  });
  const invite = t.sendInvite('in1@box');
  await new Promise<void>((r) => t.manager.on('status', (s: Status) => s.phase === 'connected' && r()));
  // Das 200 OK ist per UDP noch unterwegs, wenn der Manager schon „verbunden" meldet
  for (let i = 0; i < 20 && !toTag; i++) await wait(10);
  assert.ok(toTag, 'kein To-Tag im 200 OK');
  t.sendAck(invite, toTag);
  await wait(300);
  assert.equal(t.manager.status().incoming, true);
  assert.equal(t.manager.status().target, '0171555');
  assert.equal(t.manager.status().codec, 'PCMA');
  assert.ok(t.rtp() >= 5, `nur ${t.rtp()} RTP-Pakete`);
  t.sendBye(invite, toTag);
  const reason: string = await new Promise((r) => t.manager.once('callEnded', r));
  await t.close();
  assert.equal(reason, 'Gegenseite hat aufgelegt');
  assert.deepEqual(phases, ['incoming', 'connected', 'ended']);
  assert.deepEqual(t.responses.slice(0, 3), [100, 180, 200]);
  assert.equal(t.handlerCalls(), 1);
});

test('Anrufbeantworter aus: es klingelt nur, CANCEL beendet mit 487', async () => {
  const t = await setup(false);
  const events: [string, boolean][] = [];
  t.manager.on('incoming', (caller: string, answered: boolean) => events.push([caller, answered]));
  const invite = t.sendInvite('in2@box');
  await wait(200);
  assert.equal(t.manager.status().phase, 'idle');
  t.sendCancel(invite);
  await wait(200);
  await t.close();
  assert.deepEqual(events, [['0171555', false]]);
  assert.deepEqual(t.responses.slice(0, 4), [100, 180, 200, 487]);
  assert.equal(t.handlerCalls(), 0);
});

test('Klingelnder Anruf ohne Anrufbeantworter: von Hand in die Spam-Falle umleiten', async () => {
  const t = await setup(false);
  const rings: boolean[] = [];
  let ringEnds = 0;
  t.manager.on('ring', (r: { willAnswer: boolean }) => rings.push(r.willAnswer));
  t.manager.on('ringEnd', () => ringEnds++);
  t.sendInvite('in3@box');
  await wait(150);
  assert.equal(t.manager.status().phase, 'idle');
  assert.deepEqual(rings, [false]);
  const connected = new Promise<void>((r) => t.manager.on('status', (s: Status) => s.phase === 'connected' && r()));
  assert.deepEqual(t.manager.divertIncoming('scam'), { ok: true, reason: 'Spam-Falle' });
  await connected;
  assert.equal(t.manager.status().incoming, true);
  assert.deepEqual(t.handlerOpts, [true]); // Handler mit forceScam erzeugt
  assert.equal(ringEnds, 1);
  assert.equal(t.manager.divertIncoming('answer').ok, false); // klingelt nicht mehr
  await t.close();
});

test('Klingelnder Anruf mit Anrufbeantworter: „klingeln lassen" und danach sofort annehmen', async () => {
  const t = await setup(true, 4); // Annahme erst nach 3 Klingelperioden – Zeit zum Eingreifen
  const ended: string[] = [];
  t.manager.on('callEnded', (r: string) => ended.push(r));
  const invite = t.sendInvite('in4@box');
  await wait(150);
  assert.equal(t.manager.status().phase, 'incoming');
  assert.equal(t.handlerCalls(), 1);
  assert.equal(t.manager.divertIncoming('skip').ok, true);
  assert.equal(t.manager.status().phase, 'idle'); // die KI nimmt nicht mehr an, es klingelt nur
  // umentschieden: jetzt normal annehmen (neuer Handler, ohne Spam-Falle)
  const connected = new Promise<void>((r) => t.manager.on('status', (s: Status) => s.phase === 'connected' && r()));
  assert.deepEqual(t.manager.divertIncoming('answer'), { ok: true, reason: 'angenommen' });
  await connected;
  assert.deepEqual(t.handlerOpts, [false, false]);
  void invite;
  await t.close();
  assert.equal(ended.length <= 1, true);
});
