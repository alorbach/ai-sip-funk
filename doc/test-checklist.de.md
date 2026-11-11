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

- [ ] Erster Start mit leerem Datenordner: Die Web-UI öffnet den Einrichtungsassistenten; ein falsches Kennwort wird mit einem klaren Satz abgelehnt und nichts gespeichert; mit dem richtigen wechselt der Kopf ohne Neustart auf „Telefonanlage verbunden“.
- [ ] Schritt „KI-Verbindung“ mit der Verbindung „OpenAI“: Ein ungültiger Schlüssel wird abgelehnt, ein gültiger gespeichert; danach ist „KI-Gespräch“ wählbar. Keiner der beiden Werte wird je wieder angezeigt.
- [ ] Einstellungen als Reiter: Ein Klick in der Abschnittsliste links zeigt nur die Karte dieses Abschnitts; nach dem Neuladen der Seite ist derselbe Abschnitt offen; „Technik“ gibt es nur in „Erweitert“. Ein in einem Abschnitt und ein in einem anderen Abschnitt geänderter Wert werden mit einem einzigen „Speichern“ (oder Strg+S) beide gespeichert.
- [ ] Nach einem Update von einer Version ohne Verbindungen: „Einstellungen › KI-Verbindungen“ zeigt „OpenAI“ und „Google Gemini“, der bisher gewählte Anbieter ist „aktiv“, und seine Modelle sind weiterhin eingestellt.
- [ ] „Einstellungen › KI-Verbindungen“, Verbindung „OpenAI“, „Verbindung testen“: drei Zeilen (Schlüssel, Sprachmodell, Live-Verbindung), alle bestanden. Solange an der gewählten Verbindung kein Schlüssel hinterlegt ist, lässt sich der Knopf nicht drücken.
- [ ] Gemini-Schlüssel: unter „KI-Verbindungen“ die Verbindung „Google Gemini“ auswählen; ein ungültiger Schlüssel wird abgelehnt, ein gültiger aus Google AI Studio gespeichert („Schlüssel prüfen und speichern“). Die Karte zeigt danach, dass ein Schlüssel hinterlegt ist, der Schlüssel selbst wird nie wieder angezeigt, und in der `.env` steht `GEMINI_API_KEY`.
- [ ] „Verbindung testen“ mit der Verbindung „Google Gemini“: alle drei Zeilen bestanden. Das ist die erste echte Verbindung zu Google; ein Telefonat ist damit nicht geprüft.
- [ ] Verbindung umschalten: Nach „Diese Verbindung verwenden“ bei „Google Gemini“ bittet der Hinweis, die Stimme zu prüfen; die Stimmenlisten zeigen die Gemini-Stimmen (z. B. Kore), das Sprachmodell der Verbindung ist `gemini-3.8-live`, und die Hinweise „Was mit Gemini anders ist“ und zum kostenlosen Kontingent erscheinen, solange die Gemini-Verbindung ausgewählt ist. Nach dem Zurückschalten auf „OpenAI“ sind dessen Stimmen und Modelle wieder da.
- [ ] Zweite Verbindung: „Neue Verbindung bei“ OpenAI → „Verbindung hinzufügen“ legt ohne „Speichern“ einen dritten Eintrag an; gib ihm einen Namen. Sein Anbieter lässt sich nicht ändern.
- [ ] Schlüssel der zweiten Verbindung: Ein ungültiger Schlüssel wird abgelehnt, ein gültiger gespeichert; die Liste zeigt „Schlüssel hinterlegt“, und in der `.env` steht eine neue Zeile `AI_KEY_<ID>`. Der Schlüssel der Verbindung „OpenAI“ (`OPENAI_API_KEY`) ist unverändert.
- [ ] Modelle der zweiten Verbindung: „Modelle aktualisieren“ lädt die Liste mit ihrem Schlüssel; wähl ein anderes Sprachmodell (z. B. ein günstigeres) und ein Textmodell. Die Verbindung „OpenAI“ behält ihre eigenen Modelle. In „Erweitert“ wird eine eigene Modell-ID des anderen Anbieters abgelehnt.
- [ ] Umschalten auf dem Dashboard: im Feld „KI-Verbindung“ die zweite Verbindung wählen; der Hinweis nennt sie als aktiv, die Karte kennzeichnet sie mit „aktiv“, und das nächste KI-Gespräch benutzt ihr Modell (das Protokoll des Gesprächs zeigt Anbieter und Modell).
- [ ] Entfernen: „Verbindung entfernen“ bei der zweiten Verbindung fragt nach; danach fehlt sie in der Karte und auf dem Dashboard, die Zeile `AI_KEY_<ID>` in der `.env` enthält keinen Schlüssel mehr, und eine andere Verbindung ist aktiv. Ist nur noch eine Verbindung übrig, ist der Knopf gesperrt.
- [ ] „Verbrauch in diesem Monat“: Nach einem KI-Gespräch zählt die Zeile des verwendeten Anbieters ein Gespräch mehr, gleich welche Verbindung dieses Anbieters es geführt hat; `usage.json` liegt im Datenordner.
- [ ] Letzter Schritt: Der Echo-Testanruf an die eigene Nebenstelle klingelt, und du hörst dich selbst.
- [ ] Installierte Tray-App, erster Start: Der Browser öffnet sich mit dem Assistenten; „Server neu starten“ und „Beenden“ während eines Gesprächs legen das Gespräch auf.
- [ ] Schalter „Einfach / Erweitert“: wirkt sofort; ein in „Erweitert“ geänderter Technik-Wert ist nach dem Zurückschalten und dem Speichern von etwas anderem in „Einfach“ noch da.
- [ ] Sprache: „Sprache“ → „English“ lädt die Seite auf Englisch neu; das Tray-Menü ist nach dem erneuten Öffnen englisch; das Pop-up beim Klingeln erscheint auf Englisch.

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
- [ ] KI-Kennung an, Abwehr an (ohne Bestätigungsdialog): Spam-Anruf aus der Liste – die KI stellt sich als KI-Assistent vor, nennt keinen Namen und wimmelt ab.
- [ ] KI-Kennung aus: roter Warnkasten sichtbar; der Dialog erscheint, „Abbrechen“ stellt den Schalter zurück.
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

## 9. Google Gemini: erstes echtes Telefonat (offen)

**Offener Punkt.** Der Gemini-Weg lief bisher nur in den automatischen Tests gegen nachgestellte Verbindungen; ein echtes Telefonat gab es damit noch nicht. Unter „Einstellungen › KI-Verbindungen“ die Verbindung „Google Gemini“ aktiv schalten („Diese Verbindung verwenden“), dann:

- [ ] **Ausgehend** (wie Abschnitt 2): Die KI begrüßt, arbeitet einen zweiteiligen Auftrag ab, das Transkript zeigt beide Seiten, und das Protokoll enthält Anbieter, Modell, Gesprächsplan, Ergebnis und Kostenschätzung.
- [ ] **Anrufbeantworter** (wie Abschnitt 3): „Hallo?“, eine Vorstellung als KI-Assistent, Anliegen und Rückrufwunsch aufgenommen.
- [ ] **Unterbrechung**: Dazwischensprechen stoppt die KI, und sie geht auf das Gesagte ein; notieren, wie oft ein bloßes „mhm“ oder ein Husten den Satz abschneidet.
- [ ] **`end_call`**: Die KI verabschiedet sich, legt selbst auf, und Ergebnis und offene Punkte stehen im Protokoll; etwas Inhaltliches in der Nachhörphase setzt das Gespräch fort.
- [ ] **9-Minuten-Grenze**: Mit einem „Gesprächslimit“ über 540 s wird das Gespräch spätestens nach neun Minuten beendet.
