# Änderungen

[English](CHANGELOG.md) · **Deutsch**

Wesentliche Änderungen je Version. Die Versionen folgen der `package.json`.

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
