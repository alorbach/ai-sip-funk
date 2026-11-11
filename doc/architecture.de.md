# SIPFunk – Architektur

English: [architecture.md](architecture.md)

Überblick für alle, die den Code lesen oder ändern wollen. Die Bedienung steht im [Benutzerhandbuch](user-guide.de.md).

## Grundidee

```
Web-UI / Tray / MCP ──HTTP, WebSocket──▶ Node-Prozess (ein Gespräch gleichzeitig)
                                          │
        FRITZ!Box ◀──SIP über UDP────────┤ SipClient      Registrierung, INVITE, BYE, REFER
        (Telefonnetz) ◀──RTP, G.711─────┤ RtpSession     20-ms-Takt, 8 oder 16 kHz
                                          │
        KI-Anbieter, live ◀──WebSocket──┤ RealtimeBridge Gesprächslogik, Werkzeuge, Transkript
        (OpenAI Realtime / Gemini Live)   │   LiveSession  Adapter des Anbieters: Protokoll, PCM16
        KI-Anbieter, Text ◀──HTTPS──────┘ Plan, Zusammenfassung, Einschätzung, Beschwerde
```

SIPFunk meldet sich als IP-Telefon an der Box an und reicht das Telefonaudio an das Live-Sprachmodell des gewählten KI-Anbieters durch (OpenAI-Realtime-API oder Gemini Live API). SIP, RTP und G.711 sind selbst umgesetzt, bewusst nur so weit, wie es eine FRITZ!Box-Nebenstelle braucht; es gibt keine native Abhängigkeit. Laufzeit-Abhängigkeiten sind `ws`, `nodemailer`, `zod` und das MCP-SDK.

## Aufbau des Quelltexts

| Pfad | Aufgabe |
| --- | --- |
| `src/main.ts` | Einstieg: lädt Konfiguration, verdrahtet alle Teile, baut je Anruf den Audio-Handler, Benachrichtigungen nach dem Anruf |
| `src/config.ts`, `src/settings.ts` | `.env` lesen; Einstellungen der Web-UI (`settings.json`), Profile je Rufnummer, Benachrichtigungsregeln, Freigabe der Spam-Abwehr |
| `src/setup.ts`, `src/envFile.ts` | Einrichtungsassistent: SIP-Zugangsdaten (Probe-Anmeldung mit einem kurzlebigen Client) und Schlüssel des KI-Anbieters prüfen, einzelne Schlüssel in die `.env` schreiben, ohne den Rest anzufassen; `CallManager.reconfigureSip` tauscht danach den SIP-Client zur Laufzeit |
| `public/i18n.js`, `public/i18n-en.js` | Sprache der Oberfläche: Die Seiten enthalten die deutschen Texte; für Englisch ersetzt ein MutationObserver sie anhand des Wörterbuchs (genaue Texte und Muster). Inhalte von Menschen und vom Server sind mit `data-no-i18n` ausgenommen. `test/i18n.test.ts` prüft, dass jeder Schlüssel des Wörterbuchs noch in den deutschen Quellen steht |
| `src/callManager.ts` | Zustandsmaschine für genau ein Gespräch: Registrierung, Wählen, Annehmen, Limit, Auflegen, Durchstellen |
| `src/dialPolicy.ts` | Rufzielschutz (gesperrte Rufnummerngassen) |
| `src/sip/` | SIP über UDP: Nachrichten, Digest-Authentifizierung, SDP, Client mit ein- und ausgehenden Anrufen |
| `src/rtp/` | RTP-Sitzung, G.711 (A-law/µ-law), Resampler, Testton und Echo |
| `src/ai/realtimeBridge.ts` | Brücke zwischen Telefonaudio und Live-Sprachmodell, nur die anbieterunabhängige Gesprächslogik: Begrüßung, Unterbrechung prüfen, Wächter, Verabschiedung und Auflegen, Transkript, Werkzeug-Aufrufe, Resampling auf die Abtastrate der Sitzung. Spricht mit einer `LiveSession` |
| `src/ai/providers/types.ts` | was SIPFunk von einem KI-Anbieter braucht: die Schnittstellen `AiProvider` (Schlüsselprüfung, Modell-Liste, Textmodell, Hörprobe, Live-Verbindung), `LiveSession` (Befehle der Brücke) und `LiveEvents` (Ereignisse an die Brücke) |
| `src/ai/providers/index.ts` | `PROVIDERS` und `resolveAi`: der gewählte Anbieter samt Schlüssel, Modellen und Gesprächslimit, abgeleitet aus Einstellungen und `.env` |
| `src/ai/providers/openai.ts`, `openaiLive.ts` | OpenAI: Responses-API für Text, Sprachausgabe für Hörproben; Adapter für die Realtime-API (WebSocket, PCM16 mit 24 kHz in beide Richtungen) |
| `src/ai/providers/gemini.ts`, `geminiLive.ts` | Google Gemini: `generateContent` für Text, Sprachausgabe für Hörproben; Adapter für die Gemini Live API (WebSocket, PCM16 mit 16 kHz hin, 24 kHz zurück). Der Kopfkommentar von `geminiLive.ts` nennt die Unterschiede zu OpenAI Realtime |
| `src/ai/connectionTest.ts` | „Verbindung testen“ für einen Anbieter: Schlüssel, Sprachmodell, Live-Verbindung |
| `src/usageCounter.ts` | Monatsverbrauch je Anbieter in `usage.json`; optionaler Abruf der tatsächlichen Kosten der OpenAI-Organisation |
| `src/ai/personas.ts`, `scam.ts`, `plan.ts` | Systemanweisungen: Assistent, Spam-Rolle, Gesprächsplan |
| `src/ai/summary.ts`, `assess.ts`, `complaint.ts`, `farewell.ts`, `pricing.ts`, `voiceSample.ts` | Zusammenfassung, Einschätzung, Beschwerde-Entwurf, Verabschiedungserkennung, Kostenschätzung, Stimmproben |
| `src/spamCheck.ts` | Einschätzung der Anrufernummer beim Klingeln, optionale tellows-Abfrage |
| `src/notify/` | E-Mail (SMTP, OAuth), Autokonfiguration, Format und Vorlagen der Mail |
| `src/contacts.ts`, `src/transcripts.ts` | Kontakte und Gesprächsprotokolle als Dateien |
| `src/web/server.ts` | HTTP-API und WebSocket für die Web-UI, gebunden an 127.0.0.1 |
| `src/mcp/server.ts` | MCP-Server über stdio, spricht per HTTP mit der laufenden Web-UI |
| `src/sim/simulate.ts` | Gesprächssimulator im Textmodus |
| `src/tools/test-call.ts` | Kommandozeilentest für SIP und Audio ohne KI |
| `public/` | Web-UI (eine HTML-Datei ohne Build-Schritt) und das Pop-up beim Klingeln |
| `electron/main.cjs` | Tray-App: startet den Server als Kindprozess, Menü, Benachrichtigungen, Pop-up |
| `personas/` | Stil-Presets als Textdateien |
| `test/` | Tests mit dem Node-Testrunner gegen eine simulierte Telefonanlage auf localhost |

## Telefonie

- **Registrierung**: `REGISTER` mit Digest-Authentifizierung, regelmäßige Erneuerung; schlägt sie fehl, wird alle 30 s neu versucht.
- **Ausgehend**: `INVITE` mit SDP-Angebot, `ACK`, `BYE` in beide Richtungen, `CANCEL` beim Abbruch vor der Annahme.
- **Eingehend**: Die gewählte eigene Nummer kommt aus `P-Called-Party-ID` (Rückfall: To-Adresse). Ist der Anrufbeantworter aus, klingelt die Nebenstelle nur mit; ist die Leitung belegt, antwortet sie mit „besetzt“; sonst wird nach der eingestellten Klingelzahl angenommen (5 s je Klingeln).
- **Durchstellen**: `REFER` an die Box; sie verbindet den Inhaber mit dem Anrufer und beendet das Gespräch mit SIPFunk.
- **Codec**: G.711. Die FRITZ!Box bietet es zusätzlich mit 16 kHz an (dynamische Payload-Typen); SIPFunk bevorzugt diese HD-Variante und fällt auf 8 kHz zurück. Paketgröße und Zeitstempel-Takt werden von der Gegenstelle übernommen.

## Realtime-Brücke

`RealtimeBridge` enthält nur die Gesprächslogik, die nicht vom Anbieter abhängt, und spricht mit einer `LiveSession` (`src/ai/providers/types.ts`); der Adapter des Anbieters übersetzt zwischen dieser Schnittstelle und dem Protokoll des Anbieters. Zwischen der Abtastrate des Telefons und denen der Sitzung rechnet ein Polyphasen-Resampler um (OpenAI: PCM16 mit 24 kHz in beide Richtungen; Gemini: 16 kHz hin, 24 kHz zurück). Die Brücke kümmert sich um das, was ein Sprachmodell am Telefon nicht von selbst richtig macht:

- **Pufferung**: Das Modell liefert Audio schneller als Echtzeit. Die Ausgabe wird gepuffert und im 20-ms-Takt abgespielt, mit kurzem Vorpuffer gegen abgehackte Satzanfänge.
- **Unterbrechung**: Spricht das Gegenüber, pausiert die Ausgabe. Erst wenn die Transkription Inhalt zeigt, wird der Rest verworfen; bei einem Geräusch oder Zuhör-Laut spricht die KI weiter.
- **Beenden**: Das Modell ruft `end_call` mit Ergebnis und offenen Punkten auf. Bei ausgehenden Gesprächen mit Gesprächsplan wird der erste Aufruf mit einer Selbstprüfung gegen die Planschritte zurückgegeben. Die Verabschiedung fordert der Code an; danach folgt eine Nachhörphase, in der Inhalt des Gegenübers das Gespräch fortsetzt.
- **Wächter**: bleibt nach einer Anforderung das Audio aus oder nach dem Ende der Ausgabe alles still, stößt die Brücke eine Antwort an.
- **Rollenwechsel**: Bei `flag_spam` tauscht die Brücke Anweisung und Werkzeugliste in der laufenden Sitzung aus (`LiveSession.update`).

Die Systemanweisung wird je Anruf zusammengesetzt: feste Grundregeln, Stil-Preset, Anrede, Name, Auftrag, Gesprächsplan, Hintergrundwissen. Grundregeln haben Vorrang vor allem, was der Benutzer eingibt.

## KI-Anbieter

Die Einstellung `aiProvider` (`openai`, der Standard, oder `gemini`; Startwert `AI_PROVIDER`) wählt einen Anbieter für alles: das Gespräch, Gesprächsplan, Zusammenfassung, Einschätzung, Beschwerde-Entwurf und Hörproben. `resolveAi` liefert den Anbieter samt seinem Schlüssel aus der `.env` (`OPENAI_API_KEY`, `GEMINI_API_KEY`), den Modellen und dem Gesprächslimit; ein gespeichertes Modell des anderen Anbieters wird ignoriert, und es gilt die Vorgabe (`OPENAI_MODEL`, `OPENAI_SUMMARY_MODEL`, `GEMINI_MODEL`, `GEMINI_SUMMARY_MODEL` oder die eingebaute Vorgabe). Schlüssel kommen über die lokale Web-UI in die `.env`, werden einmal beim Anbieter geprüft und nie zurückgeliefert oder protokolliert.

Die Gemini Live API unterscheidet sich von OpenAI Realtime in Punkten, die der Adapter nur zum Teil verbergen kann:

- **Keine Anweisung je Antwort, kein „Antwort anfordern“.** Soll die KI von sich aus sprechen (Begrüßung, Wächter, Verabschiedung), bekommt sie einen Text-Zug, der als Regieanweisung der App gekennzeichnet ist („[Regie]“); die Systemanweisung erklärt das Kennzeichen.
- **Systemanweisung und Werkzeuge stehen für die ganze Verbindung fest.** Neue Anweisungen (ein spät fertiger Gesprächsplan, der Wechsel in die Spam-Abwehr) gehen ebenfalls als Regieanweisung hinaus; das wirkt schwächer als eine Systemanweisung.
- **Kein Kürzen, Löschen oder Abbrechen.** Diese Befehle der Brücke bleiben ohne Wirkung; bei einer Unterbrechung entscheidet Googles Server, was im Verlauf bleibt.
- **Transkription in Stücken.** Eine Äußerung des Gegenübers gilt als fertig, wenn kurz kein Stück mehr kommt.
- **Nicht verfügbar:** Sprechgeschwindigkeit (nur als Hinweis mitgegeben) und die Obergrenze für Ausgabe-Token.
- **Gesprächsdauer.** Die Live API trennt eine Verbindung nach etwa zehn Minuten; `maxCallSeconds` des Anbieters begrenzt Gespräche auf 540 s.

Der Gemini-Adapter ist bisher nur in den automatischen Tests gegen nachgestellte Verbindungen geprüft; es gab damit noch kein echtes Telefonat und keine echte Verbindung zu Google. Die Einzelheiten des Protokolls folgen Googles Dokumentation mit Stand 11. November 2026.

## Wo Regeln durchgesetzt werden

Was nicht schiefgehen darf, entscheidet der Code, nicht das Modell:

- Rufzielschutz und Gesprächslimit im `CallManager` bzw. in `dialPolicy.ts`; sie gelten für Web-UI und MCP gleichermaßen.
- Die KI hat kein Werkzeug zum Wählen. Durchstellen gibt es nur im Rückruf an den Inhaber und nur zur Nummer des ursprünglichen Anrufers.
- Die Spam-Abwehr wirkt nur mit eingeschalteter KI-Kennung oder gespeicherter Risiko-Bestätigung (`scamAllowed()` und `scamActive()` in `settings.ts`); beim Speichern ohne beides wird sie ausgeschaltet. Das Zeitlimit setzt ein Timer im Server durch.
- Kontakte sind von der Spam-Erkennung im Gespräch ausgenommen: Für sie steht `flag_spam` gar nicht in der Werkzeugliste.
- Kennwörter verlassen die API nur maskiert. Schlüssel der KI-Anbieter liefert sie nie zurück; sie meldet nur, ob einer hinterlegt ist.

## Daten

Alles liegt als Dateien im Datenordner (Projektordner oder `SIPFUNK_DATA_DIR`): `.env`, `settings.json`, `contacts.json`, `transcripts/` (JSON und Markdown je Gespräch), `mail-token.json`, `usage.json` (Monatsverbrauch je KI-Anbieter, 13 Monate), `voice-samples/`. Es gibt keine Datenbank. Protokolle werden beim Start und danach regelmäßig nach der Aufbewahrungsfrist gelöscht. Audio wird nie gespeichert.

## Tray-App

`electron/main.cjs` startet den gebauten Server (`dist/main.js`) als Kindprozess und erhält dessen Zustand über IPC. Die Tray-App enthält keine eigene Logik für Gespräche; sie zeigt Menü, Benachrichtigungen und das Pop-up beim Klingeln (`public/ring.html`) und schreibt das Log in eine Datei.

## Entscheidungen und verworfene Wege

- **Eigener SIP-Client statt SIP-Trunk zu OpenAI.** Eine FRITZ!Box-Nebenstelle ist kein Trunk; der dokumentierte SIP-Weg von OpenAI hätte einen zusätzlichen Anbieter und einen öffentlich erreichbaren Webhook verlangt.
- **Eigene SIP/RTP-Umsetzung statt nativer Bibliothek.** Vermeidet native Builds unter Windows und Lizenzfragen; der Preis ist ein kleiner Funktionsumfang (nur UDP, nur G.711, kein SRTP, kein DTMF).
- **PCM zur API statt G.711.** Erlaubt HD-Audio zur Box und eine einheitliche Verarbeitung; kostet einen Resampler.
- **Gesprächsplan durch ein Textmodell.** Das Realtime-Modell spricht gut, plant aber schlecht: Ohne Plan erledigte es mehrteilige Aufträge nur zum Teil. Für Anrufbeantworter und Rückruf gibt es keinen Plan, dort hat er den Ablauf verlangsamt.
- **Verabschiedung im Code.** Dem Modell überlassen, sprach es und legte im selben Atemzug auf oder kündigte das Ende an, ohne aufzulegen.
- **Keine Benachrichtigung der Telefone an der Box.** Die Box nimmt Textnachrichten per SIP an, die Telefone zeigen sie nicht an.
- **Keine Sicherheitsarchitektur über „nur lokal“ hinaus.** Ein Benutzer, ein Rechner; die Web-UI ist an 127.0.0.1 gebunden und hat deshalb keine Anmeldung (siehe [SECURITY.de.md](../SECURITY.de.md)).

## Nicht umgesetzt

Tastentöne (DTMF) und Sprachmenüs, Übernahme des Gesprächs per Mikrofon, mehrere gleichzeitige Gespräche, Fortsetzung der Sitzung bei Gemini für Gespräche über neun Minuten, der Simulator mit Gemini, Kontakt-Import aus der Box, Wiederholung bei Nichterreichen, andere Sprachen als Deutsch.
