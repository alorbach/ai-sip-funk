// Woran SIPFunk erkennt, dass ein Modell gerade nicht kann (Kontingent, Überlast) und ein Ausweichmodell eine Chance hat.
// Andere Fehler (falscher Schlüssel, unbekanntes Modell, abgelehnte Anfrage) träfen das nächste Modell genauso oder
// sollen sichtbar bleiben.

/** Höchstens so viele Ausweichmodelle je Liste */
export const MAX_FALLBACKS = 6;

/** true = die Meldung (Fehlertext eines Abrufs, Schließgrund einer Verbindung) deutet auf ein Limit oder eine Überlastung. */
export function isLimitError(message: string): boolean {
  return /\b(429|50[0-4]|529)\b|quota|exhaust|overload|rate.?limit|unavailable|too many requests/i.test(message);
}
