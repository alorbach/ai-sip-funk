# Änderungen

[English](CHANGELOG.md) · **Deutsch**

Wesentliche Änderungen je Version. Die Versionen folgen der `package.json`.

## Unveröffentlicht

- **Einrichtungsassistent**: Die App startet jetzt auch ohne SIP-Zugangsdaten und ohne OpenAI-Schlüssel. Beim ersten Start führt die Web-UI durch das Nötigste (Telefonanlage mit Probe-Anmeldung, OpenAI-Schlüssel mit Prüfung, Namen, Anrufbeantworter und eigene Rufnummer, optional E-Mail, Testanruf im Echo-Modus). Er lässt sich überspringen und unter „Einstellungen“ erneut öffnen. Zugangsdaten werden nur über `127.0.0.1` angenommen, geprüft, in die `.env` geschrieben und nie zurückgeliefert; der SIP-Client meldet sich ohne Neustart der App neu an.
- **Zwei Stufen „Einfach“ und „Erweitert“**: Die Web-UI zeigt standardmäßig nur, was man zum Benutzen braucht; „Erweitert“ zeigt zusätzlich alle technischen Einstellungen. Der Schalter steht im Kopf, wirkt sofort und wird in `settings.json` gespeichert. Ausgeblendete Einstellungen behalten ihre Werte.
- **Englische Oberfläche**: Web-UI, Pop-up beim Klingeln und Tray-Menü gibt es auch auf Englisch. Standardmäßig richtet sich die Sprache nach dem Browser (Tray: nach dem System); „Sprache“ auf der Seite „Einstellungen“ legt sie auf Deutsch oder Englisch fest. Deutsch bleibt die Quelle: `public/i18n-en.js` enthält die englischen Texte, und ein Text ohne Übersetzung erscheint einfach auf Deutsch. Die KI selbst spricht am Telefon weiterhin Deutsch; Systemprotokoll und Gesprächsergebnisse werden nicht übersetzt.
- **Mail-Passwort**: Wer den Mailserver ändert, ohne das Passwort neu einzugeben, verliert das gespeicherte Passwort – so kann es nicht an einen anderen Server gehen. „Automatisch einrichten“ speichert Server und ein frisch eingetipptes Passwort in einem Schritt.
- **Echo-Testanruf**: Bei HD-Ton schickt die FRITZ!Box 10-ms-Pakete, und das Echo spielte je 20 ms nur eines davon zurück – abgehackt und in halbem Tempo. Das Echo rechnet jetzt in Samples und gibt den Ton vollständig zurück.
- **Gestaltung und Barrierefreiheit**: sichtbare Ränder an Feldern und Schaltern (mindestens 3:1), Kennzeichnungen mit mindestens 4,5:1, per Tastatur bedienbare Reiter, beschriftete Dialoge, vorgelesene Fehlermeldungen, kein Überlaufen ab 420 px Breite.
- **Korrekturen aus einem Code-Review**: Vermitteln beachtet den Rufzielschutz; Call-by-Call-Vorwahlen sind gesperrt; das Speichern der Einstellungen überschreibt nicht mehr die Vorgaben des Dashboards (und umgekehrt) und schickt nur Geändertes; eine Benachrichtigung kommt auch, wenn die Zusammenfassung scheitert; die Tray-App beendet den Server sauber (ein laufendes Gespräch wird aufgelegt); `settings.json` und `contacts.json` werden atomar geschrieben; der SIP-Client stoppt sauber und meldet das Gesprächsende sofort.

## 0.1.0 – erste öffentliche Version

- Eigener SIP-Client für eine FRITZ!Box-Nebenstelle (Registrierung, ein- und ausgehende Anrufe, Durchstellen) mit G.711-Audio in 8 oder 16 kHz.
- Brücke zur OpenAI-Realtime-API mit Behandlung von Unterbrechungen, erzwungener Verabschiedung und Wächtern gegen Stille.
- Ausgehende KI-Anrufe mit Auftrag, Gesprächsplan, Ergebnismeldung, Zusammenfassung und Kostenschätzung.
- Anrufbeantworter mit Profilen je eigener Rufnummer.
- Benachrichtigungen nach einem Anruf: Tray, E-Mail (SMTP, Gmail und Microsoft 365 per OAuth, anpassbare Vorlagen), Rückruf an den Inhaber mit Durchstellen zum Anrufer.
- Pop-up beim Klingeln mit Einschätzung der Nummer und optionaler tellows-Abfrage.
- Spam-Abwehr mit eigener Rolle, nur nach Bestätigung des Risikos; Beschwerde-Entwurf für die Bundesnetzagentur.
- Kontakte, Gesprächsprotokolle mit automatischer Löschung, Betriebslog wird nach derselben Frist gekürzt.
- Web-UI (nur lokal, mit Host- und Herkunftsprüfung), Tray-App für Windows, MCP-Schnittstelle, Text-Simulator.
- Dokumentation auf Englisch und Deutsch; Lizenz AGPL-3.0-or-later.
