# SIPFunk – Manuelle Testliste

English: [test-checklist.md](test-checklist.md)

Die automatischen Tests (`npm test`) laufen gegen eine simulierte Telefonanlage und prüfen weder echtes Audio noch das Verhalten des Sprachmodells. Diese Liste beschreibt, was sich nur am echten Anschluss prüfen lässt. Sie ist so geordnet, dass sich möglichst viel in einem Durchgang erledigen lässt; nachsehen jeweils im Log und auf der Seite „Anrufe“.

Getestet wird nur mit eigenen Nummern und Nebenstellen oder mit eingeweihten Personen.

## 0. Vorbereitung

- [ ] `npm run typecheck` und `npm test` laufen fehlerfrei.
- [ ] Tray-App läuft mit aktuellem Build (`npm run tray`), der Status zeigt die Registrierung und „Anrufbeantworter an“.
- [ ] Ein Kontakt mit Kennzeichen „Inhaber“ (eigene Mobilnummer) ist angelegt; „Mich auf der Inhabernummer anrufen“ ist an.
- [ ] Ruhige Umgebung (die Spracherkennung reagiert auf Hintergrundgeräusche).

## 1. Grundfunktion ohne KI

- [ ] `npm run test-call -- **610` (eigene interne Nebenstelle): Telefon klingelt, Piepton hörbar.
- [ ] Mit `--echo`: Gesprochenes kommt nach einer Sekunde zurück.
- [ ] Auflegen funktioniert von beiden Seiten.

## 2. Ausgehender KI-Anruf

Über das Dashboard die eigene Mobilnummer oder eine interne Nebenstelle mit einem zweiteiligen Auftrag anrufen.

- [ ] Bestätigungsdialog zeigt die Nummer; erst „Jetzt wählen“ startet.
- [ ] Die KI stellt sich vor, arbeitet beide Teile des Auftrags ab und legt nach der Verabschiedung selbst auf.
- [ ] Unterbrechen funktioniert; ein Husten oder „mhm“ schneidet den Satz nicht ab.
- [ ] Transkript läuft live mit; „Mithören“ gibt beide Seiten wieder.
- [ ] Protokoll enthält Gesprächsplan, Ergebnis laut KI, Zusammenfassung und Kosten.
- [ ] Eine gesperrte Nummer (z. B. 0900 …) wird abgelehnt.

## 3. Anrufbeantworter

Von einem zweiten Telefon die eigene Nummer anrufen, die Klingelzahl abwarten, ein normales Anliegen vortragen („Ich wollte fragen, ob der Termin morgen steht, bitte Rückruf“).

- [ ] Begrüßung „Hallo?“ ohne Knacken oder Aussetzer; im Log steht der ausgehandelte Codec.
- [ ] Die KI stellt sich genau einmal als KI-Assistent vor, nimmt Anliegen und Rückrufwunsch auf und fragt nichts Überflüssiges.
- [ ] Die Meldung passt zur gewählten Nummer (Profil „Person“ bzw. „Firma“).
- [ ] Nach dem Abschiedssatz legt sie innerhalb weniger Sekunden auf.
- [ ] Keine lange Stille mitten im Gespräch; falls doch, spricht die KI nach der Zeit des Stillstandswächters von selbst weiter (Log: „Stillstand“).
- [ ] Mit Profil „Nur klingeln lassen“ bzw. abweichender Klingelzahl verhält sich nur diese Nummer anders.

## 4. Einschätzung und Benachrichtigung

Direkt nach Punkt 3.

- [ ] Tray-Benachrichtigung erscheint mit lesbarem Titel.
- [ ] Protokoll zeigt die Einschätzung mit kurzer Begründung; nichts ist fälschlich als „Spam-Abwehr“ markiert.
- [ ] E-Mail kommt an: Betreff, Blöcke und Kurzfassung stimmen (vorher „Verbindung prüfen“ und „Probe-Mail senden“).
- [ ] Bei „wichtig“: Der Rückruf kommt, die KI berichtet am Stück und nennt die vollständige Rückrufnummer.
- [ ] „Verbinde mich“ stellt zum Anrufer durch; ohne diesen Wunsch verabschiedet sich die KI kurz.

## 5. Pop-up beim Klingeln

- [ ] Beim Klingeln erscheint unten rechts das Fenster mit Anrufer, Leitung und Einschätzung.
- [ ] „Klingeln lassen“: Die KI nimmt nicht an.
- [ ] „KI jetzt annehmen“: Annahme sofort, ohne die Klingelzahl abzuwarten.
- [ ] „In die Spam-Falle“ (nach Risiko-Bestätigung): Annahme sofort als Privatperson, Protokoll mit „Spam-Abwehr“.
- [ ] Mit eingeschaltetem tellows-Nachschlagen und einer Nummer, die kein Kontakt ist: Der Score erscheint nach kurzer Zeit.

## 6. Spam-Abwehr

Vorher [legal.de.md](legal.de.md), Abschnitt 6, lesen. Die Erkennung im Gespräch ist für Kontakte ausgeschaltet; dieser Teil braucht also ein Telefon, dessen Nummer nicht in den Kontakten steht, oder den Simulator (`npm run sim -- strom bank`). Der Listentreffer funktioniert auch mit einem Kontakt.

- [ ] Schalter an: Der Dialog kommt nur beim ersten Mal, das Datum steht danach neben dem Schalter.
- [ ] `settings.json` von Hand auf `"scamMode": "on"` ohne `scamAccepted`, Neustart: Die Web-UI zeigt „aus“.
- [ ] **Erkennung im Gespräch** (Liste leer, einen Werbeanruf spielen): Begrüßung zunächst als KI-Assistent, nach ein bis zwei Sätzen Werbung Wechsel zur Privatperson ohne KI-Nennung; keine Zustimmung, keine Daten; Transkript enthält „Spam-Abwehr: <Grund>“; kein Rückruf.
- [ ] **Listentreffer** (eigene Mobilnummer in die Liste): Begrüßung sofort als Privatperson mit Rollenname, Stimme und Tempo der Rolle.
- [ ] **Rückwechsel** (Nummer in der Liste, echtes Anliegen vortragen): Die KI wechselt in den Assistenten-Modus, stellt sich als KI vor und nimmt das Anliegen auf.
- [ ] **Hinhalten** (Verhalten „Hinhalten“, Limit 1 Minute): Die KI stellt Fragen, sagt nichts zu, und nach etwa 60 s legt der Server auf.
- [ ] „Nummer auf die Spam-Liste“ an einem eingehenden Gespräch: Rückfrage, Eintrag erscheint, Knopf verschwindet.
- [ ] „Beschwerde-Entwurf“ an einem Spam-Protokoll: Der Inhalt stimmt mit dem Protokoll überein, nichts ist erfunden.
- [ ] Danach die eigene Nummer aus der Liste löschen und das Verhalten zurückstellen.

## 7. Simulator

- [ ] `npm run sim` läuft durch; die Berichte in `sim-results/` zeigen keine schweren Fehler (Daten genannt, „Ja“ gesagt, KI-Nennung im Spam-Modus).

## 8. Verteilung und MCP

- [ ] `npm run dist:win`: Installer auf einem frischen Windows-Benutzer (Installation, erster Start mit `.env`, Autostart, Deinstallation).
- [ ] MCP: aus einem Client `get_status`, dann `start_call` an eine eigene Nebenstelle und `wait_for_call`.
