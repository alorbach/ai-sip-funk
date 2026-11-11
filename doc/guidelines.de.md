# SIPFunk – Richtlinien für den Einsatz

English: [guidelines.md](guidelines.md)

Diese Richtlinien beschreiben, wie SIPFunk gedacht ist und wofür nicht. Sie ergänzen das [Benutzerhandbuch](user-guide.de.md) und die [rechtlichen Hinweise](legal.de.md). Wer SIPFunk betreibt, ist für jeden Anruf verantwortlich, den die KI führt, so als hätte er selbst angerufen oder abgenommen.

---

## 1. Grundsätze

1. **Transparenz.** Die KI stellt sich in jedem Gespräch als KI vor und bestreitet es auch auf Nachfrage nicht. Einzige, bewusst eingeschränkte Ausnahme ist die Spam-Abwehr ohne KI-Kennung (Abschnitt 6), die der Betreiber ausdrücklich auf eigenes Risiko einschaltet.
2. **Ein Mensch bleibt verantwortlich.** Jeder ausgehende Anruf wird von dir ausgelöst und bestätigt (Web-UI-Dialog) oder von einem Agenten, dem du die MCP-Schnittstelle bewusst gegeben hast. Die KI entscheidet nie selbst, wen sie anruft.
3. **Datensparsamkeit.** Es wird kein Audio gespeichert. Transkripte werden nur so lange aufbewahrt, wie sie gebraucht werden („Protokolle aufbewahren“ unter Einstellungen › Technik). Hintergrundwissen für die KI enthält nur, was sie für den Auftrag braucht.
4. **Keine Entscheidungen mit Tragweite.** Die KI schließt keine Verträge, zahlt nichts, bestellt nichts, gibt keine sensiblen Daten (Gesundheit, Zahlung, Ausweis, Passwörter) weiter und nimmt keine an. Was der Auftrag nicht abdeckt, nimmt sie als Frage mit.
5. **Keine Täuschung über Identität.** Die KI gibt sich nicht als eine reale Person aus. „Im Auftrag von“ ist dein Name oder der Name deiner Firma, nicht der eines Dritten.
6. **Lokal und privat.** Die Web-UI ist nur auf dem eigenen Rechner erreichbar. Gesprächsinhalte gehen nur an den Anbieter der aktiven KI-Verbindung (OpenAI oder Google Gemini). Zugangsdaten bleiben im Datenordner. Weder Rufnummern noch Schlüssel gehören in Chats, Tickets oder Screenshots.

---

## 2. Zulässige Einsätze

- Termine anfragen, bestätigen, verschieben (Praxis, Werkstatt, Friseur, Behörde mit Terminvergabe).
- Nachrichten an Familie, Freunde, Bekannte, Kollegen überbringen und Antworten einholen.
- Rückfragen bei Dienstleistern und Lieferanten, mit denen bereits eine Geschäftsbeziehung besteht (Lieferstatus, Öffnungszeiten, Rückruf erbitten).
- Anrufbeantworter für private und geschäftliche Rufnummern: Anliegen und Rückrufwunsch aufnehmen, Hinweise aus dem Hintergrundwissen geben.
- Benachrichtigung des Inhabers über angenommene Anrufe, einschließlich Rückruf und Durchstellen.
- Test- und Entwicklungsanrufe an eigene Nummern und Nebenstellen.

---

## 3. Unzulässige Einsätze

- **Werbung und Akquise** gegenüber Verbrauchern oder Unternehmen, die nicht eingewilligt haben. Die KI ist technisch eine „automatische Anrufmaschine“; Werbeanrufe damit sind ohne vorherige ausdrückliche Einwilligung verboten (UWG § 7). Auch „nur mal nachfragen, ob Interesse besteht“ ist Werbung.
- **Massenanrufe**, Serienanrufe, automatisiertes Durchprobieren von Nummern. SIPFunk führt absichtlich nur ein Gespräch gleichzeitig; das ist kein Fehler, sondern Teil des Konzepts.
- **Belästigung**: wiederholte Anrufe gegen den erklärten Willen, Anrufe zu Nachtzeiten ohne Anlass, Scherzanrufe, Druck ausüben, Einschüchtern.
- **Täuschung**: sich als eine andere reale Person, Firma, Behörde, Bank oder Polizei ausgeben; Identität des Angerufenen erschleichen; „Social Engineering“ jeder Art, auch im Rahmen von Sicherheitstests ohne schriftlichen Auftrag der betroffenen Organisation.
- **Erhebung sensibler Daten** (Gesundheit, Finanzen, Ausweis, Zugangsdaten) am Telefon, auch wenn das Gegenüber sie freiwillig nennt. Die KI ist angewiesen, solche Angaben nicht aufzunehmen; gib ihr keine Aufträge, die das verlangen.
- **Notruf- und Sondernummern.** Sie sind gesperrt und bleiben gesperrt. Im Notfall rufst du selbst an.
- **Umgehung des Rufzielschutzes** (Auslandsnummern, Mehrwertnummern) durch Umschreiben der Nummer oder Code-Änderung ohne Prüfung der Kosten- und Rechtsfolgen.
- **Anrufe gegenüber Personen, die nicht mit einer KI sprechen wollen.** Hat jemand das einmal erklärt, trag es in die Kontaktnotizen ein und ruf dort nicht mehr mit der KI an.

---

## 4. Gute Aufträge schreiben

Die Qualität des Gesprächs hängt vom Auftrag ab. Bewährt hat sich:

- **Wer nimmt vermutlich ab?** („Praxis-Empfang“, „meine Frau“, „Herr Meier vom Autohaus“). Ohne Kontakt braucht die KI diesen Hinweis.
- **Was genau soll passieren?** Fragen in Reihenfolge, was ausgerichtet werden soll, was angenommen werden darf („einen Termin vormittags annehmen“) und was nicht („keinen Termin vor dem 20. zusagen“).
- **Was muss die KI wissen?** Name, Kundennummer (wenn unkritisch), Zeitfenster, Anlass. Alles andere weglassen.
- **Ton.** Privat oder geschäftlich? Du oder Sie? Der Stil kommt aus dem Preset; der Auftrag kann es präzisieren („locker, sie ist eine alte Freundin“).
- **Nicht hineinschreiben:** Passwörter, Zahlungsdaten, Gesundheitsdiagnosen Dritter, Anweisungen, die Richtlinie 3 verletzen.

Der Gesprächsplan, den das Textmodell daraus baut, steht nach dem Gespräch im Protokoll. Passt er nicht zum Auftrag, war der Auftrag unklar.

---

## 5. Anrufbeantworter verantwortungsvoll betreiben

- **Auftraggeber korrekt angeben.** „Im Auftrag von“ und „Meldung als Assistent von“ in den Profilen je Rufnummer müssen der Wahrheit entsprechen: Die KI sagt Anrufern, für wen sie abnimmt.
- **Hintergrundwissen prüfen.** Kontaktnotizen und letzte Zusammenfassungen gibt die KI auf Rückfrage preis. Dort stehen also nur Dinge, die der Anrufer wissen darf.
- **Geschäftliche Nummern.** Für Firmen gelten die Informationspflichten der DSGVO (siehe Rechtliches). Ein Satz in einem eigenen Auftrag bei eingehenden Anrufen kann sie erfüllen helfen („Weise darauf hin, dass das Gespräch als Text protokolliert wird“).
- **Rückruf an dich** nur dort einschalten, wo der Rückruf nicht stört (Fahrt, Besprechung). Die Einschätzung „wichtig“ ist eine Modellentscheidung und kann falsch liegen.
- **Protokolle löschen**, sobald sie erledigt sind, oder die Aufbewahrung kurz halten.

---

## 6. Spam-Abwehr: Bedingungen für den Einsatz

Standardmäßig gibt sich die KI auch in der Spam-Abwehr als KI zu erkennen (Schalter „KI-Kennung“). Ohne KI-Kennung weicht die Spam-Abwehr vom Transparenzgrundsatz ab. Das ist nur vertretbar unter diesen Bedingungen; wer die Kennung ausschaltet, bestätigt sie in der Web-UI. Die Punkte 2 bis 7 gelten auch mit KI-Kennung.

1. **Eigenes Risiko, eigene Entscheidung.** Die Rechtslage ist nicht abschließend geklärt (KI-Verordnung, DSGVO, Nutzungsbedingungen des KI-Anbieters). Siehe [legal.de.md](legal.de.md). Die Bestätigung in der UI dokumentiert, dass du das weißt.
2. **Nur gegen unerbetene Anrufe.** Der Modus ist für Werbung, Umfragen und Betrugsversuche gedacht, die dich ohne Einwilligung anrufen, also selbst rechtswidrig handeln. Er ist nicht dafür da, lästige, aber legitime Anrufer (Vermieter, Behörde, Inkasso mit echtem Bezug) hinzuhalten. Dafür gibt es den normalen Anrufbeantworter mit eigenem Auftrag.
3. **Listen pflegen, nicht raten.** Nummern kommen auf die Liste, wenn sie dich tatsächlich belästigt haben (Knopf „Nummer auf die Spam-Liste“ am Gespräch). „anonym“ nur eintragen, wenn du bewusst in Kauf nimmst, dass auch Arzt oder Behörde zunächst als Privatperson empfangen werden. Kontakte sind vor der Erkennung im Gespräch geschützt; wer dir wichtig ist, gehört deshalb in die Kontakte.
4. **Hinhalten mit Maß.** Das Zeitlimit ist eine Obergrenze, keine Zielgröße. Je länger das Gespräch, desto höher Kosten und Fehlerrisiko. Für die meisten reicht „kurz abwimmeln“.
5. **Keine Eskalation.** Die KI ist angewiesen, höflich zu bleiben, keine Daten zu nennen, nichts zuzusagen, sich nicht als Behörde auszugeben und keine Anweisungen auszuführen. Ändere diese Regeln nicht, auch nicht über „Eigene Anweisungen für die Rolle“.
6. **Fehlerkennung ernst nehmen.** Wechselt die KI bei einem echten Anrufer in den Spam-Modus, entschuldige dich bei der Person und trag sie als Kontakt ein (Kontakte sind der KI bekannt). Prüfe das Transkript („Spam-Abwehr: <Grund>“) und passe ggf. die Liste an.
7. **Beschwerde statt Rache.** Nutze die aus dem Ergebnis gewonnenen Informationen (Firma, Produkt, Nummer) für eine Beschwerde bei der Bundesnetzagentur über unerlaubte Telefonwerbung; der Knopf „Beschwerde-Entwurf“ am Protokoll liefert einen Entwurf. Prüfe ihn Wort für Wort: Behaupte nichts, was das Protokoll nicht belegt, und verschweige nicht, dass ein automatischer Assistent abgenommen hat. Das wirkt nachhaltiger als jedes Hinhalten.

---

## 7. Umgang mit Daten und Zugängen

- `.env`, `settings.json`, `contacts.json`, `transcripts/`, `mail-token.json`, `sipfunk.log` sind vertraulich und nicht Teil des Repositories; dasselbe gilt für den Monatszähler `usage.json`.
- Den Schlüssel jeder KI-Verbindung (OpenAI oder Google) beim Anbieter mit einer Budgetgrenze versehen, bei Verdacht auf Weitergabe sofort rotieren.
- Der optionale OpenAI-Admin-Schlüssel (`OPENAI_ADMIN_KEY`, für die tatsächlichen Monatskosten) kann auch Nutzer, Projekte und Schlüssel der Organisation verwalten. Hinterlege ihn nur bewusst, gib ihm ein Ablaufdatum und entferne ihn in der Web-UI, wenn du ihn nicht mehr brauchst.
- Google Gemini: Lies Googles Bedingungen, bevor du das kostenlose Kontingent nutzt; siehe [legal.de.md](legal.de.md), Abschnitt 3.5. Google Gemini ist erst in wenigen echten Telefonaten erprobt (erste Gespräche am 11.11.2026), OpenAI bleibt der erprobte Standard; prüfe die Protokolle der ersten Gespräche deshalb weiterhin genau.
- Mail-OAuth-Token (`mail-token.json`) berechtigt zum Mailversand in deinem Namen. Bei Weitergabe des Rechners widerrufen (Google-Konto / Entra: App-Zugriff entfernen) und Datei löschen.
- Der Rechner, auf dem SIPFunk läuft, ist faktisch dein Telefon: Bildschirmsperre, aktuelle Updates, kein Fernzugriff auf den Port der Web-UI.
- Protokolle enthalten Rufnummern und Gesprächsinhalte Dritter. Behandle sie wie Briefe: nicht weitergeben, nicht in Cloud-Ordner synchronisieren, die andere einsehen.

---

## 8. Wenn etwas schiefgeht

- **Falsche Nummer angerufen:** Die KI stellt sich als KI vor, fragt nach der gesuchten Person und beendet höflich. Prüfe die Nummer im Protokoll, korrigiere den Kontakt.
- **Die KI hat etwas Falsches zugesagt:** Ruf selbst zurück und stell es richtig. Formuliere den Auftrag beim nächsten Mal enger („nichts zusagen, nur Termine erfragen“).
- **Jemand beschwert sich über einen KI-Anruf:** Nimm es an, vermerke es im Kontakt, ruf dort nicht mehr mit der KI an.
- **Verdacht auf Missbrauch des Rechners / der Nebenstelle:** Server stoppen, SIP-Kennwort in der Box ändern, API-Schlüssel rotieren, Log prüfen (jeder Anruf steht darin).
- **Unklare Rechtslage in einem konkreten Fall:** Modus ausschalten, Gespräch mit einem Anwalt oder der zuständigen Datenschutzaufsicht suchen. Diese Dokumentation ersetzt keine Rechtsberatung.
