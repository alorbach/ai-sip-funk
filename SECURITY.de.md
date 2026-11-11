# Sicherheit

[English](SECURITY.md) · **Deutsch**

## Bedrohungsmodell

SIPFunk ist für einen einzelnen Benutzer auf dem eigenen Rechner im eigenen Heim- oder Büronetz gedacht. Daraus folgt, was das Programm schützt und was nicht:

- Die Web-UI und ihre API sind nur an `127.0.0.1` gebunden und haben **keine Anmeldung**. Jedes Programm, das auf demselben Rechner unter deinem Benutzer läuft, kann Anrufe starten und Protokolle lesen. Fremde Webseiten im Browser können das nicht: API und WebSocket prüfen Host und Herkunft der Anfrage. Gib den Port nicht frei (kein Port-Forwarding, kein Reverse-Proxy, kein Tunnel).
- Der Einrichtungsassistent und die Karte „KI-Verbindungen“ nehmen SIP-Kennwort und die Schlüssel der KI-Verbindungen (OpenAI, Google Gemini, optional den OpenAI-Admin-Schlüssel) über diese lokale API entgegen, prüfen sie und schreiben sie in die `.env`: `OPENAI_API_KEY` und `GEMINI_API_KEY` für die beiden mitgelieferten Verbindungen, `AI_KEY_<ID>` für jede weitere Verbindung. Das Entfernen einer Verbindung löscht ihren Schlüssel aus der `.env`. Die API liefert sie nie zurück; sie meldet nur, ob ein Wert hinterlegt ist. Weil die API keine Anmeldung hat, könnte ein Programm unter deinem Benutzer diese Zugangsdaten auch *ersetzen* (lesen kann es sie über die API nicht, wohl aber direkt aus der `.env`). Ein hinterlegtes SIP-Kennwort wird nur weiterverwendet, solange Adresse und Benutzername gleich bleiben; es lässt sich also nicht an einen anderen Server umleiten.
- Die MCP-Schnittstelle für KI-Agenten läuft über dieselbe lokale API (`/mcp` und `/api/mcp/…`), ist standardmäßig ausgeschaltet und prüft im Programm, was ein Agent darf: erlaubte Ziele, Bestätigung vor dem Wählen, Limits. Das schützt bei Agenten, die nur die MCP-Tools haben. Ein Agent, der auf deinem Rechner beliebige Befehle ausführen darf, kann wie jedes andere Programm die API direkt ansprechen und diese Prüfungen umgehen (erster Punkt). Über MCP gehen keine Schlüssel, Kennwörter oder Einstellungen hinaus; Gesprächstexte liest der Agent mit.
- SIP und RTP laufen unverschlüsselt über UDP zur Telefonanlage im LAN.
- Zugangsdaten liegen im Klartext im Datenordner: SIP-Kennwort und die Schlüssel aller KI-Verbindungen in der `.env`, Mail-Kennwort und OAuth-Secret in `settings.json`, das OAuth-Token in `mail-token.json`. Protokolle, Kontakte und Log enthalten Rufnummern und Gesprächsinhalte. Der Datenordner ist der Projektordner bzw. `%APPDATA%\SIPFunk`; schütze ihn wie ein Postfach (Benutzerkonto mit Kennwort, Festplattenverschlüsselung, verschlüsselte Backups).
- Gesprächsaudio und Texte gehen an den Anbieter der aktiven KI-Verbindung (OpenAI oder Google), Benachrichtigungen an deinen Mail-Anbieter, bei eingeschaltetem Nachschlagen die Anrufernummer an tellows.
- Was Anrufer sagen, ist für die KI Gesprächsinhalt und keine Anweisung. Die KI kann nur auflegen, beim Rückruf an den Inhaber zum Anrufer durchstellen, einen Anruf als Spam melden und in einem Agenten-Anruf beim Agenten nachfragen; sie kann keine Nummern wählen. Über die Rückfrage und das mitgelesene Transkript erreicht Gesagtes den Agenten: Für ihn ist es ebenfalls Inhalt und kein Auftrag. Der Rufzielschutz (Notruf, Sonder-, Mehrwert- und Auslandsnummern) und das Gesprächslimit werden im Kern geprüft, nicht vom Modell.

## Schwachstelle melden

Bitte nicht als öffentliches Issue. Nutze die private Meldefunktion der Plattform, auf der das Repository liegt (bei GitHub: „Security → Report a vulnerability“). Beschreibe, wie sich das Problem nachstellen lässt, und füge keine echten Rufnummern, Zugangsdaten oder Gesprächsinhalte bei.

Es gibt keine zugesagten Reaktionszeiten und kein Prämienprogramm. Unterstützt wird nur der aktuelle Stand des Hauptzweigs.

## Wenn Zugangsdaten nach außen gelangt sind

SIP-Kennwort in der Telefonanlage ändern, die Schlüssel aller KI-Verbindungen bei ihren Anbietern (auch einen hinterlegten OpenAI-Admin-Schlüssel) widerrufen und neu erzeugen, App-Passwort des Postfachs ändern bzw. den OAuth-Zugriff beim Anbieter entfernen und `mail-token.json` löschen.
