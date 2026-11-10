import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAuthorization, parseChallenge } from '../src/sip/digest.js';
import { getHeader, getParam, parseMessage, serialize, splitList, topViaBranch } from '../src/sip/message.js';
import { buildAnswer, buildOffer, parseAnswer } from '../src/sip/sdp.js';
import { Resampler } from '../src/rtp/resample.js';
import { decodeG711, encodeG711 } from '../src/rtp/g711.js';
import { checkDialTarget } from '../src/dialPolicy.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

test('Digest ohne qop', () => {
  const header = buildAuthorization({
    challenge: 'Digest realm="fritz.box", nonce="abc123"',
    method: 'REGISTER',
    uri: 'sip:fritz.box',
    username: 'user',
    password: 'pw',
  });
  const expected = md5(`${md5('user:fritz.box:pw')}:abc123:${md5('REGISTER:sip:fritz.box')}`);
  assert.equal(parseChallenge(header).response, expected);
});

test('Digest mit qop=auth', () => {
  const header = buildAuthorization({
    challenge: 'Digest realm="fritz.box", nonce="n1", qop="auth"',
    method: 'INVITE',
    uri: 'sip:**610@fritz.box',
    username: 'user',
    password: 'pw',
    nc: 1,
    cnonce: 'c1',
  });
  const ha1 = md5('user:fritz.box:pw');
  const ha2 = md5('INVITE:sip:**610@fritz.box');
  assert.equal(parseChallenge(header).response, md5(`${ha1}:n1:00000001:c1:auth:${ha2}`));
  assert.match(header, /qop=auth, nc=00000001/);
});

test('SIP-Response parsen inkl. Compact-Header', () => {
  const raw = [
    'SIP/2.0 200 OK',
    'v: SIP/2.0/UDP 192.168.178.20:5062;branch=z9hG4bKabc;rport=5062',
    't: <sip:**610@fritz.box>;tag=xyz',
    'i: call1',
    'CSeq: 2 INVITE',
    'Record-Route: <sip:a>, <sip:b>',
    '',
    'v=0',
  ].join('\r\n');
  const msg = parseMessage(raw);
  assert.equal(msg.status, 200);
  assert.equal(topViaBranch(msg), 'z9hG4bKabc');
  assert.equal(getParam(getHeader(msg, 'To')!, 'tag'), 'xyz');
  assert.deepEqual(splitList(getHeader(msg, 'Record-Route')!), ['<sip:a>', '<sip:b>']);
  assert.equal(msg.body, 'v=0');
  assert.match(serialize(msg), /Content-Length: 3\r\n\r\nv=0$/);
});

test('SDP-Angebot und -Antwort', () => {
  assert.match(buildOffer('192.168.178.20', 40000), /m=audio 40000 RTP\/AVP 120 121 8 0 101/);
  assert.match(buildOffer('192.168.178.20', 40000), /a=rtpmap:120 PCMA\/16000/);
  assert.match(buildOffer('192.168.178.20', 40000, false), /m=audio 40000 RTP\/AVP 8 0 101/);
  const answer = parseAnswer('v=0\r\nc=IN IP4 192.168.178.1\r\nm=audio 7078 RTP/AVP 8 101\r\n');
  assert.deepEqual(answer, { ip: '192.168.178.1', port: 7078, codec: { payloadType: 8, law: 'PCMA', sampleRate: 8000 } });
});

test('SDP: FRITZ!Box-Angebot mit HD – 16-kHz-A-law gewinnt, ohne HD der 8-kHz-Codec', () => {
  const box = ['v=0', 'c=IN IP4 192.0.2.1', 'm=audio 7080 RTP/AVP 9 8 0 2 102 100 99 101 97 120 121', 'a=rtpmap:9 G722/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:120 PCMA/16000', 'a=rtpmap:121 PCMU/16000', 'a=rtpmap:101 telephone-event/8000', ''].join('\r\n');
  assert.deepEqual(parseAnswer(box).codec, { payloadType: 120, law: 'PCMA', sampleRate: 16000 });
  assert.deepEqual(parseAnswer(box, false).codec, { payloadType: 8, law: 'PCMA', sampleRate: 8000 });
  // Antwort auf unser Angebot mit anderem dynamischen PT
  assert.deepEqual(parseAnswer('v=0\r\nc=IN IP4 10.0.0.1\r\nm=audio 5000 RTP/AVP 96\r\na=rtpmap:96 PCMU/16000\r\n').codec, { payloadType: 96, law: 'PCMU', sampleRate: 16000 });
  const sdp = buildAnswer('10.0.0.2', 40000, { payloadType: 120, law: 'PCMA', sampleRate: 16000 });
  assert.match(sdp, /m=audio 40000 RTP\/AVP 120 101/);
  assert.match(sdp, /a=rtpmap:120 PCMA\/16000/);
});

test('Resampler: 16→24 kHz und zurück erhält einen 1-kHz-Ton, Blockgrößen stimmen', () => {
  const up = new Resampler(16000, 24000);
  const down = new Resampler(24000, 16000);
  let total = 0;
  const back: number[] = [];
  for (let f = 0; f < 25; f++) {
    const frame = Int16Array.from({ length: 320 }, (_, i) => Math.round(10000 * Math.sin((2 * Math.PI * 1000 * (f * 320 + i)) / 16000)));
    const hi = up.process(frame);
    total += hi.length;
    for (const v of down.process(hi)) back.push(v);
  }
  assert.equal(total, 25 * 480);
  assert.equal(back.length, 25 * 320);
  // Nach dem Einschwingen: Amplitude bleibt (±5 %), gemessen als RMS über die letzten 10 Frames
  const tail = back.slice(-3200);
  const rms = Math.sqrt(tail.reduce((a, v) => a + v * v, 0) / tail.length);
  assert.ok(Math.abs(rms - 10000 / Math.SQRT2) < 0.05 * (10000 / Math.SQRT2), `RMS ${rms.toFixed(0)}`);
  // 8 kHz <-> 24 kHz: Faktor 3
  assert.equal(new Resampler(8000, 24000).process(new Int16Array(160)).length, 480);
  assert.equal(new Resampler(24000, 8000).process(new Int16Array(480)).length, 160);
});

test('G.711 Roundtrip bleibt nah am Original', () => {
  const pcm = Int16Array.from([0, 100, -100, 1000, -1000, 12000, -12000, 32000]);
  for (const law of ['PCMU', 'PCMA'] as const) {
    const back = decodeG711(encodeG711(pcm, law), law);
    pcm.forEach((v, i) => assert.ok(Math.abs(back[i] - v) <= Math.max(16, Math.abs(v) * 0.07), `${law}: ${v} -> ${back[i]}`));
  }
});

test('Rufzielschutz', () => {
  assert.equal(checkDialTarget('**610'), undefined);
  assert.equal(checkDialTarget('0171 3920012'), undefined);
  assert.equal(checkDialTarget('+49 171 3920012'), undefined);
  assert.ok(checkDialTarget('112'));
  assert.ok(checkDialTarget('0900123456'));
  assert.ok(checkDialTarget('0044123456'));
  assert.ok(checkDialTarget('+44123456'));
  assert.ok(checkDialTarget('abc'));
});
