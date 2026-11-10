// Rufzielschutz: wird im Kern geprüft, bevor gewählt wird.

const BLOCKED_PREFIXES: [string, string][] = [
  ['110', 'Notruf'],
  ['112', 'Notruf'],
  ['115', 'Behördennummer'],
  ['116', 'Sondernummer'],
  ['118', 'Auskunftsdienst'],
  ['0900', 'Mehrwertnummer'],
  ['0137', 'Massenverkehr/Televoting'],
  ['0138', 'Massenverkehr/Televoting'],
  ['0180', 'Service-Nummer'],
  ['019', 'Sondernummer'],
  // Call-by-Call-Vorwahl: dahinter könnte eine sonst gesperrte Nummer stehen
  ['010', 'Call-by-Call'],
  ['00', 'Ausland'],
];

export function normalizeTarget(target: string): string {
  return target.replace(/[\s\-/()]/g, '');
}

/** Liefert einen Sperrgrund oder undefined, wenn das Ziel erlaubt ist. */
export function checkDialTarget(rawTarget: string): string | undefined {
  const target = normalizeTarget(rawTarget);
  if (!/^(\*\*\d+|\+?\d+)$/.test(target)) return 'Ungültige Rufnummer';
  if (target.startsWith('**')) return undefined; // interne FRITZ!Box-Nebenstelle
  if (target.startsWith('+')) {
    // „+49 (0)30 …“ ist eine übliche Schreibweise: die eingeklammerte Null nicht doppelt zählen
    return target.startsWith('+49') ? checkDialTarget('0' + target.slice(3).replace(/^0/, '')) : 'Ausland';
  }
  for (const [prefix, reason] of BLOCKED_PREFIXES) {
    if (target.startsWith(prefix)) return `Gesperrt: ${reason}`;
  }
  return undefined;
}
