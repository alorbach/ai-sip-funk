// HTTP-Digest-Authentifizierung für SIP (RFC 2617 / 3261), MD5 mit und ohne qop=auth.
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

export function parseChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  for (let m; (m = re.exec(header.replace(/^Digest\s+/i, ''))); ) {
    params[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return params;
}

export interface DigestInput {
  challenge: string;
  method: string;
  uri: string;
  username: string;
  password: string;
  nc?: number;
  cnonce?: string;
}

export function buildAuthorization(input: DigestInput): string {
  const c = parseChallenge(input.challenge);
  const algorithm = c.algorithm ?? 'MD5';
  if (algorithm.toUpperCase() !== 'MD5') throw new Error(`Digest-Algorithmus nicht unterstützt: ${algorithm}`);

  const ha1 = md5(`${input.username}:${c.realm}:${input.password}`);
  const ha2 = md5(`${input.method}:${input.uri}`);
  const qop = c.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined;

  const parts = [
    `username="${input.username}"`,
    `realm="${c.realm}"`,
    `nonce="${c.nonce}"`,
    `uri="${input.uri}"`,
  ];
  let response: string;
  if (qop) {
    const nc = (input.nc ?? 1).toString(16).padStart(8, '0');
    const cnonce = input.cnonce ?? randomBytes(8).toString('hex');
    response = md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    parts.push(`response="${response}"`, `qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${c.nonce}:${ha2}`);
    parts.push(`response="${response}"`);
  }
  parts.push(`algorithm=MD5`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}
