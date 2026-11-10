// G.711 A-law (PCMA) und µ-law (PCMU) <-> 16-bit linear PCM. Unabhängig von der Abtastrate.
import type { G711Law } from '../sip/sdp.js';

function linearToAlaw(sample: number): number {
  let pcm = sample >> 3; // 13 Bit
  let mask: number;
  if (pcm >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const segEnd = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
  let seg = 0;
  while (seg < 8 && pcm > segEnd[seg]) seg++;
  if (seg >= 8) return 0x7f ^ mask;
  const aval = (seg << 4) | ((seg < 2 ? pcm >> 1 : pcm >> seg) & 0x0f);
  return aval ^ mask;
}

function alawToLinear(aval: number): number {
  aval ^= 0x55;
  let t = (aval & 0x0f) << 4;
  const seg = (aval & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return aval & 0x80 ? t : -t;
}

function linearToUlaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  let pcm = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function ulawToLinear(uval: number): number {
  uval = ~uval & 0xff;
  let t = ((uval & 0x0f) << 3) + 0x84;
  t <<= (uval & 0x70) >> 4;
  return uval & 0x80 ? 0x84 - t : t - 0x84;
}

const ALAW_DECODE = Int16Array.from({ length: 256 }, (_, i) => alawToLinear(i));
const ULAW_DECODE = Int16Array.from({ length: 256 }, (_, i) => ulawToLinear(i));

export function encodeG711(pcm: Int16Array, law: G711Law): Buffer {
  const enc = law === 'PCMA' ? linearToAlaw : linearToUlaw;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = enc(pcm[i]);
  return out;
}

export function decodeG711(data: Uint8Array, law: G711Law): Int16Array {
  const table = law === 'PCMA' ? ALAW_DECODE : ULAW_DECODE;
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = table[data[i]];
  return out;
}

export function silenceByte(law: G711Law): number {
  return law === 'PCMA' ? 0xd5 : 0xff;
}
