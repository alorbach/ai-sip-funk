// SDP-Angebot und -Auswertung. Codecs: G.711 A-law/µ-law mit 16 kHz (AVM-„HD“, dynamische Payload-Typen
// wie bei der FRITZ!Box: 120/121) und klassisch mit 8 kHz (statische PT 8/0). Immer 20 ms pro Frame.

export const PT_PCMU = 0;
export const PT_PCMA = 8;
export const PT_DTMF = 101;
/** Dynamische Payload-Typen für 16-kHz-G.711, so wie die FRITZ!Box sie anbietet */
export const PT_PCMA_16K = 120;
export const PT_PCMU_16K = 121;

export type G711Law = 'PCMA' | 'PCMU';

export interface Codec {
  payloadType: number;
  law: G711Law;
  sampleRate: 8000 | 16000;
}

/** Unsere Reihenfolge: HD zuerst, A-law vor µ-law (deutsches Festnetz). */
export const CODECS_HD: Codec[] = [
  { payloadType: PT_PCMA_16K, law: 'PCMA', sampleRate: 16000 },
  { payloadType: PT_PCMU_16K, law: 'PCMU', sampleRate: 16000 },
];
export const CODECS_NB: Codec[] = [
  { payloadType: PT_PCMA, law: 'PCMA', sampleRate: 8000 },
  { payloadType: PT_PCMU, law: 'PCMU', sampleRate: 8000 },
];

export function codecLabel(c: Codec): string {
  return c.sampleRate === 16000 ? `${c.law} HD` : c.law;
}

function sdpHead(localIp: string): string[] {
  const id = Date.now();
  return ['v=0', `o=- ${id} ${id} IN IP4 ${localIp}`, 's=SIPFunk', `c=IN IP4 ${localIp}`, 't=0 0'];
}

function rtpmap(c: Codec): string {
  return `a=rtpmap:${c.payloadType} ${c.law}/${c.sampleRate}`;
}

export function buildOffer(localIp: string, rtpPort: number, hd = true): string {
  const codecs = hd ? [...CODECS_HD, ...CODECS_NB] : CODECS_NB;
  return [
    ...sdpHead(localIp),
    `m=audio ${rtpPort} RTP/AVP ${codecs.map((c) => c.payloadType).join(' ')} ${PT_DTMF}`,
    ...codecs.map(rtpmap),
    `a=rtpmap:${PT_DTMF} telephone-event/8000`,
    `a=fmtp:${PT_DTMF} 0-16`,
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n');
}

/** SDP-Antwort auf ein eingehendes Angebot: genau der ausgehandelte Codec. */
export function buildAnswer(localIp: string, rtpPort: number, codec: Codec): string {
  return [
    ...sdpHead(localIp),
    `m=audio ${rtpPort} RTP/AVP ${codec.payloadType} ${PT_DTMF}`,
    rtpmap(codec),
    `a=rtpmap:${PT_DTMF} telephone-event/8000`,
    `a=fmtp:${PT_DTMF} 0-16`,
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n');
}

export interface SdpAnswer {
  ip: string;
  port: number;
  codec: Codec;
}

/**
 * Wertet Angebot oder Antwort der Gegenseite aus und wählt den besten Codec, den wir können:
 * 16-kHz-G.711 (per rtpmap erkannt, Payload-Typ beliebig) vor 8-kHz-G.711 (statisch 8/0 oder per rtpmap).
 */
export function parseAnswer(sdp: string, hd = true): SdpAnswer {
  const lines = sdp.split(/\r?\n/);
  let sessionIp: string | undefined;
  let mediaIp: string | undefined;
  let port: number | undefined;
  let payloads: number[] = [];
  const maps = new Map<number, { law: G711Law; rate: number }>();
  let inAudio = false;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ');
      if (inAudio) {
        const parts = line.slice(2).split(' ');
        port = Number(parts[1]);
        payloads = parts.slice(3).map(Number);
      }
    } else if (line.startsWith('c=IN IP4 ')) {
      const ip = line.slice(9).trim();
      if (inAudio) mediaIp = ip;
      else if (port === undefined) sessionIp = ip;
    } else if (inAudio && line.startsWith('a=rtpmap:')) {
      const m = /^a=rtpmap:(\d+)\s+(PCMA|PCMU)\/(\d+)/i.exec(line);
      if (m) maps.set(Number(m[1]), { law: m[2].toUpperCase() as G711Law, rate: Number(m[3]) });
    }
  }

  const offered: Codec[] = [];
  for (const pt of payloads) {
    const map = maps.get(pt);
    if (map && (map.rate === 16000 || map.rate === 8000)) offered.push({ payloadType: pt, law: map.law, sampleRate: map.rate });
    else if (!map && (pt === PT_PCMA || pt === PT_PCMU)) offered.push({ payloadType: pt, law: pt === PT_PCMA ? 'PCMA' : 'PCMU', sampleRate: 8000 });
  }
  const codec =
    (hd ? offered.find((c) => c.sampleRate === 16000 && c.law === 'PCMA') ?? offered.find((c) => c.sampleRate === 16000) : undefined) ??
    offered.find((c) => c.sampleRate === 8000 && c.law === 'PCMA') ??
    offered.find((c) => c.sampleRate === 8000);

  const ip = mediaIp ?? sessionIp;
  if (!ip || !port || !codec) {
    throw new Error('SDP ohne verwendbares G.711-Audio');
  }
  return { ip, port, codec };
}
