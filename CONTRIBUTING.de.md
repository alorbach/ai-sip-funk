# Mitarbeit

[English](CONTRIBUTING.md) · **Deutsch**

SIPFunk ist ein kleines Projekt eines einzelnen Entwicklers. Fehlerberichte und Verbesserungen sind willkommen; eine Zusage, wann etwas bearbeitet wird, gibt es nicht.

## Fehler melden

- Beschreibe, was du getan hast, was du erwartet hast und was passiert ist.
- Nenne Betriebssystem, Node-Version, Modell und FRITZ!OS-Version der Box sowie das verwendete Realtime-Modell.
- Füge die passenden Zeilen aus dem Log bei, **nachdem du sie bereinigt hast**: keine Rufnummern, Namen, E-Mail-Adressen, Zugangsdaten oder Gesprächsinhalte. Dasselbe gilt für Screenshots und Protokolle.
- Sicherheitslücken nicht öffentlich melden, siehe [SECURITY.de.md](SECURITY.de.md).

## Änderungen einreichen

- Vor dem Einreichen müssen beide Befehle fehlerfrei laufen:

  ```bash
  npm run typecheck
  ```

  ```bash
  npm test
  ```

- Wer Anweisungen an die KI ändert (`src/ai/personas.ts`, `src/ai/scam.ts`, `src/ai/plan.ts`), lässt danach den Simulator laufen (`npm run sim`, braucht einen API-Schlüssel) und liest die Berichte.
- Kleine, in sich geschlossene Änderungen mit einer Commit-Meldung, die sagt, was sich für den Benutzer ändert. Oberfläche, Anweisungen an die KI, Kommentare und Commit-Meldungen sind deutsch; die Dokumentation ist mehrsprachig angelegt: Englisch ohne Zusatz (`user-guide.md`), jede Übersetzung mit Sprachkürzel vor der Endung (`user-guide.de.md`, `.env.example.de`). Wer ein Dokument ändert, ändert alle Fassungen; eine neue Sprache kommt als weiterer Satz von Dateien mit ihrem Kürzel dazu und wird in der Tabelle im README verlinkt.
- Keine neuen Abhängigkeiten ohne guten Grund. SIP, RTP und G.711 sind absichtlich selbst und schlank umgesetzt.
- Beispiele in Code, Tests und Dokumentation verwenden erfundene Namen und reservierte Beispielwerte (`example.com`, `192.0.2.x`, Rufnummern aus den für Film und Fernsehen reservierten Bereichen der Bundesnetzagentur), nie echte.
- Was sich nur am Telefon prüfen lässt, steht in [doc/test-checklist.de.md](doc/test-checklist.de.md). Schreib dazu, was du am echten Anschluss geprüft hast und was nicht.

## Tests und Releases auf GitHub

- Jeder Push nach `main` und jeder Pull Request lässt Typprüfung und Tests laufen (`.github/workflows/ci.yml`).
- Ein neuer Tag `v1.2.3` baut den Windows-Installer und die portable ZIP-Datei und veröffentlicht beide als GitHub-Release (`.github/workflows/release.yml`). Die Version kommt aus dem Tag. Der Release-Text nennt die Änderungen seit dem vorigen Tag: von GitHub Copilot aus den Commit-Meldungen geschrieben, wenn im Repository das Secret `COPILOT_GITHUB_TOKEN` hinterlegt ist, sonst die von GitHub erzeugten Hinweise; die reine Commit-Liste hängt immer an.
- Die Bilder in `doc/images/` erzeugt `npm run screenshots`: Es startet eine Demo-Instanz mit erfundenen Daten in einem temporären Ordner (nichts aus der eigenen Einrichtung, kein Netzzugriff) und nimmt die Web-UI auf Deutsch und Englisch auf. Nach sichtbaren Änderungen an der Oberfläche neu laufen lassen und die Bilder vor dem Einchecken ansehen.
- Vor dem Tag die Einträge unter „Unveröffentlicht“ in beiden Changelogs zur neuen Version verschieben.

## Was nicht angenommen wird

Änderungen, die den Rufzielschutz aufweichen, mehrere Gespräche gleichzeitig oder Serienanrufe ermöglichen, die Bestätigung vor der Spam-Abwehr umgehen oder die Web-UI ohne Anmeldung ins Netz öffnen. Die Gründe stehen in den [Richtlinien](doc/guidelines.de.md).

## Lizenz der Beiträge

SIPFunk steht unter der GNU Affero General Public License, Version 3 oder später ([LICENSE](LICENSE)). Mit dem Einreichen einer Änderung erklärst du, dass du sie unter dieser Lizenz beitragen darfst und beiträgst.
