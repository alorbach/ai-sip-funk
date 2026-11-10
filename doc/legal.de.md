# SIPFunk – Rechtliche Aspekte

Stand der Rechtsrecherche: November 2026. Bezugsrahmen: Betrieb in Deutschland, EU-Recht. **Dies ist keine Rechtsberatung.** Die Hinweise stammen von einem Entwickler, nicht von einem Juristen, und können falsch oder überholt sein. Sie fassen die einschlägigen Regelungen zusammen, damit du die Risiken einschätzen und bei Bedarf gezielt nachfragen kannst. Gesetzesstände ändern sich; prüfe insbesondere die Übergangsfristen der KI-Verordnung und die Nutzungsbedingungen von OpenAI zum Zeitpunkt deiner Nutzung.

Siehe auch: [Richtlinien](guidelines.de.md) · [Benutzerhandbuch](user-guide.de.md). English: [legal.md](legal.md).

---

## 1. Rollen und Verantwortung

SIPFunk ist eine Software, die du selbst betreibst. Es gibt keinen Dienstanbieter zwischen dir und den Angerufenen. Rechtlich bist du daher in allen Rollen zugleich:

- **Anrufer bzw. Angerufener** im Sinne des Telekommunikations- und Wettbewerbsrechts: Was die KI am Telefon sagt, wird dir zugerechnet.
- **Verantwortlicher** nach DSGVO für die Verarbeitung der Gesprächsdaten (sofern die DSGVO überhaupt greift, Abschnitt 3).
- **Anbieter und Betreiber** eines KI-Systems im Sinne der KI-Verordnung, soweit sie anwendbar ist (Abschnitt 2), denn du setzt das System selbst zusammen und nutzt es.

OpenAI verarbeitet Sprache und Text in deinem Auftrag, ist aber nicht dein Vertragspartner gegenüber den Angerufenen. Auftragsverarbeiter im Sinne der DSGVO ist OpenAI nur, wenn du den dafür nötigen Vertrag abgeschlossen hast (Abschnitt 3.5).

---

## 2. KI-Verordnung (Verordnung (EU) 2024/1689, „AI Act“)

### 2.1 Transparenzpflicht bei Interaktion mit Menschen (Art. 50 Abs. 1)

KI-Systeme, die direkt mit natürlichen Personen interagieren, müssen so gestaltet sein, dass die Personen informiert werden, dass sie mit einer KI interagieren, **es sei denn, das ist aus den Umständen und dem Nutzungskontext für eine vernünftige, aufmerksame Person offensichtlich.** Die Pflicht gilt nach dem Zeitplan der Verordnung ab dem 2. August 2026; prüfe, ob zwischenzeitliche Änderungen („Digital Omnibus“) Fristen verschoben haben.

**Standardbetrieb von SIPFunk:** Die KI stellt sich bei jedem ausgehenden Anruf ausdrücklich als KI-Assistent vor und bestreitet es auch auf Nachfrage nicht. Am Anrufbeantworter meldet sie sich zunächst nur mit „Hallo?“ und gibt sich in ihrem nächsten Beitrag als KI-Assistent zu erkennen (spätestens nach 2,5 s von selbst); der Hinweis kommt also zu Beginn, aber nicht im ersten Wort. Der Rückruf an dich selbst („dein Agent“) lässt die Erklärung weg, weil der Umstand dir offensichtlich ist; auf Nachfrage sagt die KI es trotzdem. Damit ist die Transparenzpflicht nach heutigem Verständnis erfüllt.

**Spam-Abwehr:** Hier verzichtet die KI auf Wunsch des Betreibers bewusst auf den Hinweis (Abschnitt 6).

### 2.2 Ausnahme für private Nutzung (Art. 2 Abs. 10)

Die Verordnung gilt nicht für Betreiber, die natürliche Personen sind und KI-Systeme im Rahmen einer **ausschließlich persönlichen und nicht beruflichen Tätigkeit** verwenden. Ein privater Anrufbeantworter und private Anrufe fallen darunter. Sobald SIPFunk für eine Firma abnimmt („KI-Assistent von Mustermann IT-Service“) oder geschäftliche Anrufe führt, greift die Ausnahme nicht mehr.

Ob die Anbieter-Pflichten (du baust das System selbst zusammen) im privaten Kontext greifen, ist umstritten; die Transparenzpflicht ist aber ohnehin leicht einzuhalten, weshalb SIPFunk sie standardmäßig erfüllt.

### 2.3 Verbotene Praktiken (Art. 5)

Verboten sind u. a. KI-Systeme, die unterschwellige, manipulative oder täuschende Techniken einsetzen, um das Verhalten von Personen wesentlich zu verändern und ihnen dadurch erheblichen Schaden zuzufügen. Der Standardbetrieb von SIPFunk tut das nicht. Die Spam-Abwehr täuscht über die Natur des Gesprächspartners, verändert aber nicht das Verhalten des Anrufers in schädigender Weise; sie ist nach verbreiteter Lesart kein Art.-5-Fall, aber ein Art.-50-Fall. Das ist eine Einschätzung, keine gesicherte Rechtslage.

### 2.4 Risikoklasse

Ein Telefonassistent ist kein Hochrisiko-System nach Anhang III. Es gibt keine Registrierungs- oder Konformitätsbewertungspflichten; es bleiben die Transparenzpflichten.

---

## 3. Datenschutz (DSGVO, BDSG)

### 3.1 Gilt die DSGVO überhaupt?

Die DSGVO gilt **nicht** für die Verarbeitung durch natürliche Personen zur Ausübung **ausschließlich persönlicher oder familiärer Tätigkeiten** (Art. 2 Abs. 2 lit. c). Private Anrufe und ein privater Anrufbeantworter sind davon erfasst, solange die Daten im privaten Bereich bleiben (keine Veröffentlichung, keine geschäftliche Nutzung).

Sie gilt **voll**, wenn SIPFunk geschäftlich eingesetzt wird: eine Firmennummer, Kundenanrufe, geschäftliche Rückfragen bei Lieferanten. Dann gelten die folgenden Abschnitte.

### 3.2 Welche Daten verarbeitet werden

- Rufnummern (Anrufer, Angerufener), Zeitpunkte, Dauer.
- Gesprächsinhalt als Audio (nur live, Durchleitung an OpenAI, keine Speicherung) und als Text (Transkript, Zusammenfassung, Ergebnis, Einschätzung).
- Kontaktdaten und Notizen in `contacts.json`.
- Hintergrundwissen, das du der KI mitgibst.
- Betriebslog mit Rufnummern.

Inhalte können besondere Kategorien (Art. 9, z. B. Gesundheit bei Arztanrufen) enthalten. Die KI ist angewiesen, solche Angaben nicht zu erfragen; verhindern lässt sich nicht, dass das Gegenüber sie nennt.

### 3.3 Rechtsgrundlage (Art. 6)

Im geschäftlichen Betrieb kommen in Betracht: Vertragserfüllung/Anbahnung (Art. 6 Abs. 1 lit. b) für Kunden- und Lieferantenkontakte; berechtigtes Interesse (lit. f) für den Anrufbeantworter und die Zusammenfassung, mit Interessenabwägung (kurze Speicherdauer, keine Audiodaten, Zweck Erreichbarkeit). Einwilligung ist am Telefon unpraktisch und nicht nötig, wenn lit. b oder f tragen.

### 3.4 Informationspflichten (Art. 13)

Anrufer müssen bei Erhebung informiert werden: Verantwortlicher, Zwecke, Rechtsgrundlage, Empfänger (OpenAI als Auftragsverarbeiter, Drittland USA), Speicherdauer, Rechte. Am Telefon genügt ein kurzer Hinweis mit Verweis auf eine ausführliche Information (Website, Datenschutzerklärung). Praktisch: im „Auftrag bei eingehenden Anrufen“ einen Satz vorgeben, z. B. „Weise kurz darauf hin, dass das Gespräch durch einen KI-Assistenten geführt und als Text protokolliert wird; Einzelheiten stehen in der Datenschutzerklärung auf unserer Website.“ Die Datenschutzerklärung der Firma ergänzen (Abschnitt „Telefonassistent“).

### 3.5 Auftragsverarbeitung und Drittland (Art. 28, 44 ff.)

OpenAI verarbeitet Audio und Text. Für den geschäftlichen Einsatz brauchst du einen **Auftragsverarbeitungsvertrag** mit OpenAI (OpenAI bietet ein Data Processing Addendum für die API an, das online abgeschlossen wird). Die Übermittlung in die USA stützt sich auf den Angemessenheitsbeschluss zum **EU-US Data Privacy Framework**, sofern OpenAI dort zertifiziert ist, andernfalls auf Standardvertragsklauseln; prüfe den aktuellen Stand im OpenAI-Trust-Portal. Nach OpenAIs API-Bedingungen werden API-Daten standardmäßig nicht zum Training genutzt und zur Missbrauchskontrolle zeitlich begrenzt gespeichert; die Fristen stehen in den OpenAI-Richtlinien.

Mail-Anbieter (Gmail, Microsoft 365, dein SMTP-Anbieter) erhalten Zusammenfassung und Transkript per E-Mail. Für Firmen gilt auch hier: Auftragsverarbeitung mit dem Mail-Anbieter, meist durch die Geschäftskundenverträge abgedeckt.

Ist das Nachschlagen unbekannter Nummern eingeschaltet (standardmäßig aus), wird die Anrufernummer beim Klingeln an tellows übermittelt. Im geschäftlichen Betrieb braucht auch das eine Rechtsgrundlage.

### 3.6 Speicherdauer, Löschung, Sicherheit (Art. 5, 17, 32)

- Protokolle werden nach der eingestellten Frist (Standard 7 Tage) gelöscht; stelle die Frist so kurz wie möglich ein und dokumentiere die Begründung, wenn du sie verlängerst.
- Lösche Protokolle manuell, wenn ein Anrufer es verlangt (Art. 17), und entferne den Kontakt, wenn kein Grund für die Speicherung mehr besteht.
- Der Datenordner liegt unverschlüsselt auf dem Rechner. Für den geschäftlichen Betrieb: Festplattenverschlüsselung (BitLocker), Zugriffsschutz, Backups verschlüsselt.
- Die Web-UI ist nur lokal erreichbar. Öffne sie nicht ins Netz (kein Port-Forwarding, kein Reverse-Proxy ohne Authentifizierung).

### 3.7 Verarbeitungsverzeichnis, Datenschutz-Folgenabschätzung

Firmen nehmen den Telefonassistenten in das Verzeichnis der Verarbeitungstätigkeiten (Art. 30) auf. Eine Datenschutz-Folgenabschätzung (Art. 35) ist bei einem einzelnen Anrufbeantworter ohne Profilbildung in der Regel nicht erforderlich, kann aber ratsam sein, wenn regelmäßig Gesundheits- oder Finanzdaten anfallen (Praxis, Kanzlei, Steuerberatung).

---

## 4. Vertraulichkeit des Wortes (§ 201 StGB) und Berufsgeheimnisse

§ 201 StGB stellt das **Aufnehmen des nichtöffentlich gesprochenen Wortes auf einen Tonträger** ohne Einwilligung unter Strafe, ebenso das Abhören mit einem Abhörgerät durch Dritte.

- SIPFunk **speichert kein Audio**. Das Audio wird live zu OpenAI gestreamt und dort in Echtzeit verarbeitet.
- Das **Transkript** ist eine Textfassung des Gesprächs. Ob eine automatische Live-Transkription einer „Aufnahme auf Tonträger“ gleichsteht, ist nicht höchstrichterlich geklärt; die herrschende Lesart sieht die Verschriftlichung durch den Gesprächspartner selbst nicht als Tonträgeraufnahme, jedoch als Datenverarbeitung (Abschnitt 3). Eine flüchtige Zwischenspeicherung des Audios beim Verarbeiter ist technisch unvermeidlich.
- **Mithören im Browser** („Mithören“) ist das Mithören durch den Betreiber selbst, der Gesprächspartei ist (die KI handelt für ihn). Lass keine Dritten mithören.
- **Empfehlung:** Weise im geschäftlichen Betrieb im Gespräch auf die Protokollierung hin (Abschnitt 3.4); privat entscheidest du selbst, ob du Anrufer informierst. Rechtlich am sichersten ist der Hinweis in jedem Fall.

Berufsgeheimnisträger (§ 203 StGB: Ärzte, Anwälte, Steuerberater u. a.) dürfen Gesprächsinhalte nur unter den Voraussetzungen des § 203 Abs. 3 an Dienstleister weitergeben (Verpflichtung zur Verschwiegenheit, Erforderlichkeit). Der Einsatz von SIPFunk in solchen Praxen und Kanzleien braucht eine eigene Prüfung.

---

## 5. Telefonwerbung und Telekommunikationsrecht

### 5.1 Unzumutbare Belästigung (§ 7 UWG)

Verboten ist Werbung per Telefon gegenüber **Verbrauchern ohne vorherige ausdrückliche Einwilligung** und gegenüber sonstigen Marktteilnehmern ohne mutmaßliche Einwilligung (§ 7 Abs. 2 Nr. 1). Zusätzlich verboten ist Werbung mit einer **automatischen Anrufmaschine** ohne ausdrückliche Einwilligung (§ 7 Abs. 2 Nr. 2) – SIPFunk ist eine solche Maschine. Verstöße sind Ordnungswidrigkeiten (§ 20 UWG, Bußgeld durch die Bundesnetzagentur) und begründen Unterlassungsansprüche.

Folge: **Kein Vertrieb, keine Akquise, keine „Interesse-Abfragen“ mit SIPFunk** ohne dokumentierte Einwilligung. Terminanfragen, Rückfragen bei bestehenden Vertragspartnern und private Anrufe sind keine Werbung.

### 5.2 Rufnummernanzeige

Bei Werbeanrufen darf die Rufnummer nicht unterdrückt werden (§ 120 TKG). SIPFunk unterdrückt sie nie; die Box überträgt die eingestellte ausgehende Nummer. Stelle in der Box keine Rufnummernunterdrückung für die Nebenstelle ein.

### 5.3 Notruf und Sondernummern

SIPFunk sperrt 110, 112, 115, 116xxx, 118xx, 0900, 0137/0138, 0180, 019x und Auslandsnummern. Das schützt vor Kosten und vor Missbrauch des Notrufs (§ 145 StGB). Die Sperre ist absichtlich nicht konfigurierbar.

### 5.4 Durchstellen (SIP REFER) und Rückruf

Das Durchstellen eines Anrufers zu dir ist eine Vermittlung innerhalb deines Anschlusses, keine Weitergabe an Dritte. Der Rückruf an deine eigene Nummer ist unproblematisch. Beides erzeugt Telefonkosten nach deinem Tarif.

---

## 6. Spam-Abwehr: besondere Risiken

Der Modus lässt die KI gegenüber als Spam eingestuften Anrufern als Privatperson auftreten, ohne KI-Hinweis. Der einstellbare Name der Rolle ist ein erfundener Name; trag dort keinen echten Namen ein, auch nicht deinen, damit die KI sich nicht als reale Person ausgibt. Eigene Anweisungen für die Rolle setzen die eingebauten Schutzregeln nicht außer Kraft. Risiken im Einzelnen:

| Bereich | Risiko | Einordnung |
| --- | --- | --- |
| **KI-Verordnung Art. 50** | Unterbliebener Hinweis auf die KI | Bei privater Nutzung durch die Ausnahme in Art. 2 Abs. 10 voraussichtlich nicht erfasst; bei geschäftlicher Nummer ein Verstoß, sofern keine Ausnahme greift. Bußgelder nach Art. 99 richten sich an Anbieter/Betreiber; Durchsetzung gegenüber Privatpersonen ist unwahrscheinlich, aber nicht ausgeschlossen. |
| **DSGVO** | Verarbeitung ohne Information, Transkript | Privat: nicht anwendbar. Geschäftlich: Informationspflicht verletzt; Interessenabwägung dürfte wegen des rechtswidrigen Werbeanrufs zugunsten des Angerufenen ausgehen, ersetzt die Information aber nicht. |
| **§ 201 StGB** | Transkript ohne Hinweis | Wie im Standardbetrieb (Abschnitt 4); durch den fehlenden Hinweis entfällt die Einwilligungsmöglichkeit. |
| **Täuschung / Betrug (§ 263 StGB)** | Kein Vermögensschaden beim Anrufer, keine Bereicherung | Keine Betrugsrelevanz. |
| **Amtsanmaßung (§ 132), Beleidigung (§ 185), Nötigung (§ 240)** | Nur bei entsprechendem Verhalten der KI | Die Anweisungen verbieten es ausdrücklich; eine Garantie gibt es bei generativen Modellen nicht. Prüfe Transkripte. |
| **Fehlerkennung** | Ein legitimer Anrufer (Arzt, Behörde, Kunde) wird hingehalten | Reputations- und ggf. Haftungsrisiko (z. B. verpasster Termin). Die KI soll zurückwechseln; verlasse dich nicht darauf. „anonym“ auf der Liste erhöht dieses Risiko deutlich. |
| **Nutzungsbedingungen von OpenAI** | OpenAIs Usage Policies untersagen u. a., Menschen über die Interaktion mit einer KI zu täuschen, und verlangen für automatisierte Systeme Hinweise auf den KI-Einsatz | Ein Verstoß kann zur Sperrung des API-Kontos führen. Lies die aktuelle Fassung der Usage Policies, bevor du den Modus einschaltest. |
| **Kosten** | Hinhalten verbraucht Realtime-Minuten | Eigenes finanzielles Risiko; Budgetgrenze setzen. |

**Was SIPFunk tut, um das Risiko zu begrenzen:** ausdrückliche Bestätigung mit Datum in der UI, kein `.env`-Schalter, serverseitige Prüfung der Bestätigung, feste Verhaltensregeln (keine Daten, keine Zustimmung, keine Beleidigung, keine Behörde, keine Anweisungen ausführen), Rückweg zum Assistenten-Modus bei echtem Anliegen, Zeitlimit, Markierung im Protokoll, nie „wichtig“, kein Rückruf.

**Was dir bleibt:** Die Entscheidung. Die rechtlich saubere Alternative ist der normale Anrufbeantworter, der sich als KI vorstellt und Werbeanrufe höflich abweist, plus eine Beschwerde bei der Bundesnetzagentur (Formular „Unerlaubte Telefonwerbung“ bzw. „Rufnummernmissbrauch“) mit Datum, Uhrzeit, Nummer, Firma und Inhalt aus dem Protokoll.

---

## 7. Haftung bei Fehlern der KI

Zusagen der KI werden dir zugerechnet, soweit sie im Rahmen des Auftrags liegen (Stellvertretung, §§ 164 ff. BGB analog; ob eine KI Erklärungen „abgeben“ kann, ist umstritten, praktisch gilt: Was du der KI aufträgst, trägst du). Die KI ist angewiesen, nur zuzusagen, was der Auftrag abdeckt, und keine Zahlungen, Bestellungen oder Verträge einzugehen. Formuliere Aufträge so eng, wie du es bei einem menschlichen Assistenten tun würdest. Verträge mit Tragweite schließt du selbst.

Kommt durch die KI ein Schaden zustande (verpasster Termin, falsche Information an Dritte), haftest du nach allgemeinen Regeln. Die Software wird ohne Gewährleistung bereitgestellt, die Nutzung geschieht auf eigene Verantwortung; OpenAI haftet gegenüber dir nach seinen Geschäftsbedingungen, gegenüber Dritten nicht.

---

## 8. Wer SIPFunk veröffentlicht oder weiterentwickelt

Die Abschnitte oben betrachten den Betrieb. Wer den Quelltext veröffentlicht, verändert weitergibt oder für andere bereitstellt, hat zusätzlich diese Punkte zu bedenken. Keiner davon ist abschließend geklärt.

- **Anbieter nach der KI-Verordnung.** Die Privatausnahme (Art. 2 Abs. 10) gilt nur für Betreiber, nicht für Anbieter. Die Ausnahme für frei und quelloffen lizenzierte KI-Systeme (Art. 2 Abs. 12) gilt ausdrücklich nicht für Systeme, die unter Art. 50 fallen, also auch nicht für einen Telefonassistenten. Offen ist, ob die kostenlose Veröffentlichung von Quelltext, den jeder selbst mit einem fremden Sprachmodell zusammensetzt, ein „Inverkehrbringen“ ist.
- **Spam-Abwehr.** Sie ist der kritische Punkt: Die Software enthält eine Funktion, die den KI-Hinweis bewusst weglässt. Sie ist deshalb standardmäßig aus, nur nach Bestätigung nutzbar und in dieser Dokumentation als Risiko beschrieben. Ob das genügt, ist nicht entschieden.
- **Kennzeichnung synthetischer Sprache (Art. 50 Abs. 2).** Anbieter von Systemen, die synthetische Audioinhalte erzeugen, müssen die Ausgaben maschinenlesbar kennzeichnen. Die Sprache erzeugt das Modell von OpenAI; ob daneben eine Pflicht desjenigen besteht, der sie ins Telefonnetz leitet, ist offen. Technisch lässt sich ein Telefongespräch nicht maschinenlesbar kennzeichnen.
- **Haftung bei unentgeltlicher Überlassung.** Der Gewährleistungs- und Haftungsausschluss der Lizenz gilt nach deutschem Recht nicht unbegrenzt; für Vorsatz und grobe Fahrlässigkeit haftet auch, wer Software verschenkt.
- **Daten außerhalb der Löschfrist.** Die Aufbewahrungsfrist gilt für die Protokolle. Das Betriebslog der Tray-App (`sipfunk.log`) enthält Rufnummern und wird nach derselben Frist gekürzt. Benachrichtigungs-Mails mit Zusammenfassung und Gesprächsverlauf liegen dagegen weiter im Postfach. Wer das Programm weitergibt, sollte darauf hinweisen; wer es betreibt, löscht die Mails selbst.

---

## 9. Checkliste vor dem Betrieb

**Privat**
- [ ] Nur eigene Nummern auf der Nebenstelle, „Im Auftrag von“ = dein Name.
- [ ] Aufbewahrung der Protokolle kurz, Datenordner im Backup verschlüsselt.
- [ ] Keine Werbung, keine Scherzanrufe, kein Hinhalten legitimer Anrufer.
- [ ] Spam-Abwehr nur nach Lektüre von Abschnitt 6, Nummernliste statt „anonym“.

**Geschäftlich zusätzlich**
- [ ] Rechtsgrundlage festgelegt (Art. 6 lit. b/f), Verarbeitungsverzeichnis ergänzt.
- [ ] Datenschutzerklärung um den Telefonassistenten ergänzt; Hinweis im Gespräch über „Auftrag bei eingehenden Anrufen“.
- [ ] Auftragsverarbeitungsvertrag mit OpenAI geschlossen, Drittlandübermittlung geprüft.
- [ ] Mail-Anbieter als Auftragsverarbeiter abgedeckt.
- [ ] Berufsgeheimnis (§ 203) geprüft, falls einschlägig.
- [ ] Spam-Abwehr aus, solange nicht anwaltlich geprüft.

---

## 10. Quellen

- Verordnung (EU) 2024/1689 (KI-Verordnung): Art. 2 Abs. 10 und 12, Art. 5, Art. 50, Art. 99, Art. 113 (Zeitplan).
- Verordnung (EU) 2016/679 (DSGVO): Art. 2, 5, 6, 9, 13, 17, 28, 30, 32, 35, 44 ff.
- Strafgesetzbuch: §§ 132, 145, 185, 201, 203, 240, 263.
- Gesetz gegen den unlauteren Wettbewerb: §§ 7, 20.
- Telekommunikationsgesetz: § 120 (Rufnummernanzeige bei Werbeanrufen).
- Bundesnetzagentur: Beschwerdeformulare zu unerlaubter Telefonwerbung und Rufnummernmissbrauch.
- OpenAI: Usage Policies, API Data Processing Addendum, Enterprise Privacy (Datenaufbewahrung API).
