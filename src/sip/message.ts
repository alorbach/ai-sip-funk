// Minimaler SIP-Parser und -Serializer (RFC 3261), nur was wir brauchen.

export interface SipMessage {
  method?: string; // gesetzt bei Requests
  uri?: string;
  status?: number; // gesetzt bei Responses
  reason?: string;
  headers: [string, string][];
  body: string;
}

const COMPACT: Record<string, string> = {
  v: 'Via',
  f: 'From',
  t: 'To',
  i: 'Call-ID',
  m: 'Contact',
  l: 'Content-Length',
  c: 'Content-Type',
  k: 'Supported',
};

export function parseMessage(raw: string): SipMessage {
  const sep = raw.indexOf('\r\n\r\n');
  const head = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 4) : '';
  const lines = head.split(/\r\n(?![ \t])/); // Header-Folding zusammenhalten
  const first = lines.shift() ?? '';
  const msg: SipMessage = { headers: [], body };

  if (first.startsWith('SIP/2.0 ')) {
    const m = /^SIP\/2\.0 (\d{3}) ?(.*)$/.exec(first);
    if (!m) throw new Error(`Ungültige Statuszeile: ${first}`);
    msg.status = Number(m[1]);
    msg.reason = m[2];
  } else {
    const m = /^([A-Z]+) (\S+) SIP\/2\.0$/.exec(first);
    if (!m) throw new Error(`Ungültige Requestzeile: ${first}`);
    msg.method = m[1];
    msg.uri = m[2];
  }

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    let name = line.slice(0, idx).trim();
    name = COMPACT[name.toLowerCase()] ?? name;
    msg.headers.push([name, line.slice(idx + 1).replace(/\r\n[ \t]+/g, ' ').trim()]);
  }
  return msg;
}

export function serialize(msg: SipMessage): string {
  const first =
    msg.method !== undefined
      ? `${msg.method} ${msg.uri} SIP/2.0`
      : `SIP/2.0 ${msg.status} ${msg.reason ?? ''}`;
  const headers = msg.headers.filter(([n]) => n.toLowerCase() !== 'content-length');
  headers.push(['Content-Length', String(Buffer.byteLength(msg.body))]);
  return [first, ...headers.map(([n, v]) => `${n}: ${v}`), '', msg.body].join('\r\n');
}

export function getHeader(msg: SipMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return msg.headers.find(([n]) => n.toLowerCase() === lower)?.[1];
}

export function getHeaders(msg: SipMessage, name: string): string[] {
  const lower = name.toLowerCase();
  return msg.headers.filter(([n]) => n.toLowerCase() === lower).map(([, v]) => v);
}

/** Trennt Header-Werte an Kommas außerhalb von <...> und "...". */
export function splitList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') depth++;
    else if (!quoted && ch === '>') depth--;
    if (ch === ',' && depth === 0 && !quoted) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Liest einen Parameter wie ;tag=abc oder ;branch=z9hG4bK... */
export function getParam(value: string, param: string): string | undefined {
  const afterUri = value.includes('>') ? value.slice(value.lastIndexOf('>')) : value;
  const m = new RegExp(`;\\s*${param}=([^;,\\s]+)`, 'i').exec(afterUri);
  return m?.[1];
}

/** Extrahiert die URI aus "Name" <sip:...>;params oder sip:...;params */
export function extractUri(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  if (m) return m[1];
  return value.split(';')[0].trim();
}

export function cseqOf(msg: SipMessage): { seq: number; method: string } {
  const [seq, method] = (getHeader(msg, 'CSeq') ?? '0 UNKNOWN').split(/\s+/);
  return { seq: Number(seq), method };
}

export function topViaBranch(msg: SipMessage): string | undefined {
  const via = getHeaders(msg, 'Via').flatMap(splitList)[0];
  return via ? getParam(via, 'branch') : undefined;
}
