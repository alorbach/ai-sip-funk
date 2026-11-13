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
- [ ] Nach einem Update von einer Version ohne Verbindungen: „Einstellungen › KI-Verbindungen“ zeigt „OpenAI“ und „Google Gemini“, der bisher gewählte Anbieter ist „✓ aktiv“, seine Modelle sind weiterhin eingestellt, und er spricht mit der bisher gespeicherten Stimme.
- [ ] Liste zum Aufklappen: Beim ersten Öffnen ist die aktive Verbindung aufgeklappt. Ein Klick auf eine Zeile (oder Enter bzw. die Leertaste) klappt sie auf, ein zweiter zu; zwei Verbindungen können gleichzeitig offen sein. Ein eingetippter, noch nicht gespeicherter Schlüssel bleibt stehen, wenn du eine andere Verbindung auf- und zuklappst.
- [ ] „Einstellungen › KI-Verbindungen“, Verbindung „OpenAI“, „Verbindung testen“: drei Zeilen (Schlüssel, Sprachmodell, Live-Verbindung), alle bestanden. Solange an dieser Verbindung kein Schlüssel hinterlegt ist, lässt sich der Knopf nicht drücken.
- [ ] Gemini-Schlüssel: unter „KI-Verbindungen“ die Verbindung „Google Gemini“ aufklappen; ein ungültiger Schlüssel wird abgelehnt, ein gültiger aus Google AI Studio gespeichert („Schlüssel prüfen und speichern“). Die Karte zeigt danach, dass ein Schlüssel hinterlegt ist, der Schlüssel selbst wird nie wieder angezeigt, und in der `.env` steht `GEMINI_API_KEY`.
- [ ] „Verbindung testen“ mit der Verbindung „Google Gemini“: alle drei Zeilen bestanden. Das ist die erste echte Verbindung zu Google; ein Telefonat ist damit nicht geprüft.
- [ ] Verbindung umschalten: Nach „Diese Verbindung verwenden“ bei „Google Gemini“ nennt die Meldung die Stimme, die jetzt gilt; das Feld „Stimme“ auf dem Dashboard zeigt die Gemini-Stimmen (z. B. Kore) und steht auf „– Standard: … –“, das Sprachmodell der Verbindung ist `gemini-3.8-live`, und die Hinweise „Was mit Gemini anders ist“ und zum kostenlosen Kontingent erscheinen, solange die Gemini-Verbindung aktiv oder aufgeklappt ist. Nach dem Zurückschalten auf „OpenAI“ gelten wieder dessen Standardstimme und Modelle.
- [ ] Standardstimme: an einer Verbindung eine andere „Standardstimme“ wählen (gilt ohne „Speichern“); „Probe hören“ daneben spielt die Stimmen ihres Anbieters vor, auch wenn die Verbindung nicht aktiv ist. Das nächste Gespräch über diese Verbindung benutzt die Stimme; eine auf dem Dashboard gewählte Stimme gilt nur für den nächsten Anruf von dort, und „Als Standard speichern“ merkt sie nicht.
- [ ] Zweite Verbindung: „Neue Verbindung bei“ OpenAI → „Verbindung hinzufügen“ legt ohne „Speichern“ einen dritten Eintrag an; gib ihm einen Namen. Sein Anbieter lässt sich nicht ändern.
- [ ] Schlüssel der zweiten Verbindung: Ein ungültiger Schlüssel wird abgelehnt, ein gültiger gespeichert; die Kennzeichnung „Schlüssel fehlt“ an ihrer Zeile verschwindet, und in der `.env` steht eine neue Zeile `AI_KEY_<ID>`. Der Schlüssel der Verbindung „OpenAI“ (`OPENAI_API_KEY`) ist unverändert.
- [ ] Modelle der zweiten Verbindung: „Modelle aktualisieren“ lädt die Liste mit ihrem Schlüssel; wähl ein anderes Sprachmodell (z. B. ein günstigeres) und ein Textmodell. Die Verbindung „OpenAI“ behält ihre eigenen Modelle. In „Erweitert“ wird eine eigene Modell-ID des anderen Anbieters abgelehnt.
- [ ] Umschalten auf dem Dashboard: im Feld „KI-Verbindung“ die zweite Verbindung wählen; der Hinweis nennt sie als aktiv, die Karte kennzeichnet sie mit „✓ aktiv“, und das nächste KI-Gespräch benutzt ihr Modell (das Protokoll des Gesprächs zeigt Anbieter und Modell).
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
- [ ] Textmodell im Gespräch (Schalter unter „Technik“ an): Vor dem Abschiedssatz entsteht keine Pause; das Urteil kommt, bevor aufgelegt wird (Log: „Textmodell (Auflegen) nach … ms“, kein „antwortet nicht in 8000 ms“). Ein Abschied, den die Wortliste nicht kennt („Ihnen auch einen schönen Feierabend“), führt zum Auflegen; ein Nachtrag („Ach, eins noch …“) nicht.
- [ ] Regie: Bei einem ausgehenden Anruf mit mehreren Punkten einer Frage ausweichen und früh verabschieden. Im Transkript steht höchstens ein passender „Hinweis der Regie an die KI“ oder eine „Prüfung vor dem Auflegen: noch offen“, und die KI holt den Punkt nach („Eine Sache noch: …“), ohne dass es aufgesetzt klingt. Bei einem glatten Gespräch erscheint kein Hinweis.

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

- [ ] Installer aus dem Release (`SIPFunk-<Version>-win-x64.exe`) auf einem frischen Windows-Benutzer: SmartScreen-Warnung, Installation ohne Administratorrechte, Eintrag im Startmenü, erster Start mit dem Einrichtungsassistenten, Benachrichtigung zum Autostart.
- [ ] Autostart: ab- und wieder anmelden, SIPFunk erscheint im Infobereich ohne Fenster und Konsole; „Beim Anmelden starten“ hat einen Haken. Haken entfernen, neu anmelden: SIPFunk startet nicht.
- [ ] Update: einen neueren Installer über die alte Fassung laufen lassen; Einstellungen und Daten sind noch da, ein abgeschalteter Autostart bleibt aus.
- [ ] Deinstallation: Der Eintrag unter „Autostart-Apps“ in Windows ist weg, `%APPDATA%\SIPFunk` liegt noch da.
- [ ] MCP aus: Ein verbundener Agent bekommt auf jedes Tool den Hinweis, dass die Schnittstelle ausgeschaltet ist.
- [ ] MCP ein, Vorgaben („Nur gespeicherte Kontakte“, „Immer“ nachfragen): `get_status`, dann `start_call` an einen Kontakt mit einer eigenen Nummer oder Nebenstelle. Der Bestätigungsdialog erscheint in der Web-UI und als Pop-up der Tray-App unten rechts; nach „Anrufen“ (in einem von beiden) klingelt es, und das andere schließt sich. Bei geschlossener Web-UI genügt das Pop-up.
- [ ] Im selben Kontakt „KI-Agent darf ohne Nachfrage anrufen“ anhaken (die Liste zeigt „Agent ohne Nachfrage“): `start_call` an ihn wählt ohne Bestätigungsdialog; ein Kontakt ohne Haken fragt weiter nach.
- [ ] MCP im Gespräch: `wait_for_events` liefert, was du am Telefon sagst und was die KI sagt; eine Vorgabe mit `say` setzt die KI um; `end_call` lässt sie sich verabschieden; `get_call_result` liefert Ergebnis, Zusammenfassung und Transkript. Der Anruf steht unter „Anrufe“ mit „Von KI-Agent“.
- [ ] MCP-Rückfrage: Auftrag mit engem Spielraum geben und am Telefon etwas anderes anbieten. Die KI sagt „Einen Moment bitte, ich frage kurz nach“, der Agent bekommt die Rückfrage, seine Antwort mit `say` kommt am Telefon an. Ohne Antwort macht die KI nach etwa 25 Sekunden weiter.
- [ ] MCP-Sperren: Mit der Einstellung „Nur gespeicherte Kontakte“ lehnt `start_call` eine Nummer ohne Kontakt ab; „Ablehnen“ im Dialog und eine unbeantwortete Anfrage (zwei Minuten) wählen nicht; nach dem Limit je Stunde lehnt `start_call` ab.
- [ ] MCP aus der installierten App: Konfiguration aus „Agenten verbinden“ kopieren, für Codex oder Claude Code über HTTP, für Claude Desktop als Prozess; der Agent zeigt die acht Tools.
- [ ] Agenten mit einem Klick: Unter „Agenten verbinden“ bei einem installierten Agenten „Einrichten“ wählen. Die Meldung nennt die Sicherungskopie, die übrigen Einträge der Datei sind unverändert, und der Agent zeigt nach Neustart bzw. neuer Sitzung die acht Tools. „Entfernen“ nimmt nur den Eintrag „sipfunk“ heraus. Je Agent einmal prüfen (Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Copilot CLI).
- [ ] Port ändern: Unter „Einstellungen › Technik“ einen anderen Port speichern, „Jetzt neu starten“. Die Seite wechselt auf die neue Adresse, das Tray-Menü nennt den neuen Port, HTTP-Einträge der Agenten zeigen „Veraltet“ und lassen sich aktualisieren; Claude Desktop (Prozess) funktioniert ohne Änderung weiter.
- [ ] Port belegt: SIPFunk beenden, den eingestellten Port mit einem anderen Programm belegen, SIPFunk starten. Es läuft auf dem nächsten freien Port, die Tray-App meldet das, und der neue Port steht in den Einstellungen.

## 8a. Kontakt-Import (braucht eigene Konten)

- [ ] Mitgelieferte App (`oauth-clients.json` im Installer): Der Dialog zeigt bei Google und Microsoft „bereit“, ohne dass etwas eingetragen ist; „Verbinden“ öffnet die Anmeldung, nach dem Zulassen lädt das Adressbuch von selbst. Eine eingetragene eigene Client-ID hat Vorrang.
- [x] Google (13.11.2026: Anmeldung und Import mit eigenem Konto erprobt): eigener Desktop-App-Client mit People API und Testnutzer; „Verbinden“ öffnet die Anmeldung, danach meldet die Seite „Adressbuch verbunden“, „Adressbuch laden“ listet die Einträge mit Telefonnummer. „Trennen“ beendet den Zugriff; „Adressbuch laden“ verlangt danach eine neue Verbindung.
- [ ] Microsoft mit privatem Konto (Outlook.com) und, falls vorhanden, einem Firmenkonto: App-Registrierung mit `http://localhost/oauth/callback` und Contacts.Read; Anmeldung, Laden, Kontakte aus Unterordnern sind dabei.
- [ ] iCloud: exportierte vCard-Datei, Umlaute in Namen korrekt, alle Nummern da.
- [ ] Google-CSV und Outlook-CSV (auch ein deutscher Outlook-Export mit Semikolon).
- [ ] Dubletten: Ein vorhandener Kontakt mit Stil und Auftrag bleibt unverändert; mit „fehlende Nummern ergänzen“ bekommt er nur weitere Nummern; ein Anruf von einer weiteren Nummer zeigt den Namen des Kontakts.

## 9. Google Gemini: echte Telefonate (erst wenige)

**Stand.** Der Gemini-Weg ist erst in wenigen echten Telefonaten erprobt: Am 11. November 2026 liefen die ersten drei (zwei am Anrufbeantworter, ein Rückruf an den Inhaber) ohne Fehler durch; Vorstellung als KI, Auftrag, Verabschiedung und Auflegen funktionierten. Die Punkte unten bleiben für weitere Gespräche offen. Unter „Einstellungen › KI-Verbindungen“ die Verbindung „Google Gemini“ aufklappen und aktiv schalten („Diese Verbindung verwenden“), dann:

- [ ] **Ausgehend** (wie Abschnitt 2): Die KI begrüßt, arbeitet einen zweiteiligen Auftrag ab, das Transkript zeigt beide Seiten, und das Protokoll enthält Anbieter, Modell, Gesprächsplan, Ergebnis und Kostenschätzung.
- [ ] **Anrufbeantworter** (wie Abschnitt 3): „Hallo?“, eine Vorstellung als KI-Assistent, Anliegen und Rückrufwunsch aufgenommen.
- [ ] **Unterbrechung**: Dazwischensprechen stoppt die KI, und sie geht auf das Gesagte ein; notieren, wie oft ein bloßes „mhm“ oder ein Husten den Satz abschneidet.
- [ ] **`end_call`**: Die KI verabschiedet sich, legt selbst auf, und Ergebnis und offene Punkte stehen im Protokoll; etwas Inhaltliches in der Nachhörphase setzt das Gespräch fort.
- [ ] **9-Minuten-Grenze**: Mit einem „Gesprächslimit“ über 540 s wird das Gespräch spätestens nach neun Minuten beendet.
