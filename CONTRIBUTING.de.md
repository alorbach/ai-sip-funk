# Mitarbeit

[English](CONTRIBUTING.md) · **Deutsch**

SIPFunk ist ein kleines Projekt eines einzelnen Entwicklers. Fehlerberichte und Verbesserungen sind willkommen; eine Zusage, wann etwas bearbeitet wird, gibt es nicht.

## Fehler melden

- Beschreibe, was du getan hast, was du erwartet hast und was passiert ist.
- Nenne Betriebssystem, Node-Version, Modell und FRITZ!OS-Version der Box sowie den verwendeten KI-Anbieter und das Sprachmodell.
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
- Weitere Befehle: `npm run dev` (Server, startet bei Änderungen neu), `npm run tray` (Tray-App bauen und starten), `npm run build`, `npm run mcp` (der MCP-stdio-Prozess), `npm run icons`, `npm run dist:win` (Installer); eine einzelne Testdatei mit `node --import tsx --test test/<name>.test.ts`. Die CI läuft unter Windows mit Node 22; `engines` verlangt Node 20.12 oder neuer.
- Was sich nur am Telefon prüfen lässt, steht in [doc/test-checklist.de.md](doc/test-checklist.de.md). Schreib dazu, was du am echten Anschluss geprüft hast und was nicht.

## Tests und Releases auf GitHub

- Jeder Push nach `main` und jeder Pull Request lässt Typprüfung und Tests laufen (`.github/workflows/ci.yml`).
- Ein neuer Tag `v1.2.3` baut den Windows-Installer und die portable ZIP-Datei und veröffentlicht beide als GitHub-Release (`.github/workflows/release.yml`). Die Version kommt aus dem Tag. Der Release-Text nennt die Änderungen: von GitHub Copilot aus den Commit-Meldungen seit dem vorigen Tag geschrieben, wenn im Repository das Secret `COPILOT_GITHUB_TOKEN` hinterlegt ist, sonst der Abschnitt dieser Version aus `CHANGELOG.md` und ohne einen solchen die von GitHub erzeugten Hinweise; die reine Commit-Liste hängt immer an.
- Die Bilder in `doc/images/` erzeugt `npm run screenshots`: Es startet eine Demo-Instanz mit erfundenen Daten in einem temporären Ordner (nichts aus der eigenen Einrichtung, kein Netzzugriff) und nimmt die Web-UI auf Deutsch und Englisch auf. Nach sichtbaren Änderungen an der Oberfläche neu laufen lassen und die Bilder vor dem Einchecken ansehen.
- Die installierte App beim Entwickeln nutzen: `npm run install:local` baut den Installer aus dem Arbeitsordner und lässt ihn still über eine vorhandene Installation laufen (installiert nie neu, aktualisiert nur eine Installation des angemeldeten Benutzers, baut den Arbeitsordner, wie er ist, wartet auf das Ende eines laufenden Gesprächs, lässt Einstellungen und Daten liegen und startet die App nicht, wenn sie vorher aus war). `npm run install:auto` richtet lokale Git-Hooks ein (`post-commit`, `post-merge`), die das nach jedem Commit oder Merge auf `main` im Hintergrund tun; `npm run install:auto -- --off` entfernt sie. Das Protokoll steht in `release/install-local.log`. Installierte App und `npm run tray` können nicht gleichzeitig laufen: Beide nutzen denselben Web-Port und dieselbe Anmeldung an der Telefonanlage.
- Mitgelieferte App-Registrierungen für den Kontakt-Import (Ein-Klick-Anmeldung): `oauth-clients.json` im Projektordner, nicht im Repository (`.gitignore`), Inhalt `{ "google": { "clientId": "…", "clientSecret": "…" }, "microsoft": { "clientId": "…" } }`. Der Installer nimmt die Datei mit: lokal bei `npm run dist:win` und `npm run install:local`, im Release-Workflow aus dem Repository-Secret `OAUTH_CLIENTS_JSON` (derselbe Inhalt). Fehlt sie, richtet jeder Nutzer eine eigene App ein. Registriert wird wie im Handbuch (Abschnitt 11.1) beschrieben, mit diesen Unterschieden: bei Microsoft die Kontotypen „beliebiges Organisationsverzeichnis und persönliche Microsoft-Konten“; bei Google die App unter „Zielgruppe“ auf „In Produktion“ stellen und, damit Nutzer keine Warnung sehen, die Prüfung durch Google beantragen (`contacts.readonly` ist ein sensibler Bereich: Datenschutzerklärung, Startseite und Domain-Nachweis nötig). Wer einen Fork veröffentlicht, nimmt eigene Registrierungen.
- Versionsnummern: Seit 1.0.0 erhöht jede neue Version die letzte Ziffer (1.0.1, 1.0.2, …). Der Tag heißt `v<Version>`, z. B. `v1.0.1`, ist annotiert und sitzt auf dem Commit auf `main`, der diese Version trägt.
- Vor dem Tag: die Version in `package.json` und `package-lock.json` setzen (`npm version 1.0.1 --no-git-tag-version`), die Einträge unter „Unveröffentlicht“ in beiden Changelogs mit Datum zur neuen Version verschieben und die Überschrift „Unveröffentlicht“ leer für das Nächste stehen lassen.

## Was nicht angenommen wird

Änderungen, die den Rufzielschutz aufweichen, mehrere Gespräche gleichzeitig oder Serienanrufe ermöglichen, die Bestätigung vor der Spam-Abwehr umgehen oder die Web-UI ohne Anmeldung ins Netz öffnen. Die Gründe stehen in den [Richtlinien](doc/guidelines.de.md).

## Lizenz der Beiträge

SIPFunk steht unter der GNU Affero General Public License, Version 3 oder später ([LICENSE](LICENSE)). Mit dem Einreichen einer Änderung erklärst du, dass du sie unter dieser Lizenz beitragen darfst und beiträgst.
