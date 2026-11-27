# SIPFunk – Texte für den Microsoft Store

Vorlage für das Partner Center: Store-Listing (Deutsch und Englisch), Begründung der eingeschränkten Fähigkeiten und weitere Angaben. Bei einer neuen Version nur „Neuigkeiten“ anpassen.

## Allgemeine Angaben (Eigenschaften)

- Kategorie: Produktivität (Productivity)
- Datenschutz-URL: https://github.com/alorbach/ai-sip-funk/blob/main/doc/privacy.md
- Website: https://github.com/alorbach/ai-sip-funk
- Support: https://github.com/alorbach/ai-sip-funk/issues
- Generative KI: ja, Live-Sprach-KI von OpenAI oder Google während der Telefonate
- Copyright: Copyright © 2026 Andre Lorbach
- Zusätzliche Lizenzbedingungen: GNU Affero General Public License v3.0, Quellcode: https://github.com/alorbach/ai-sip-funk (Lizenztext: https://github.com/alorbach/ai-sip-funk/blob/main/LICENSE)

## Begründung der eingeschränkten Fähigkeiten (Englisch, Feld „Submission options“)

```text
runFullTrust: SIPFunk is a packaged Win32 desktop application (Electron). It runs as a tray app,
registers as an IP phone with the user's own router or SIP server (SIP and RTP over UDP on the local
network), serves its user interface on 127.0.0.1 only, starts its bundled fax modem and Ghostscript
executables, and can set up a local "SIPFunk Fax" printer on request. None of this is possible in an
AppContainer.

unvirtualizedResources: file system write virtualization is disabled so that SIPFunk keeps its data in
the regular %APPDATA%\SIPFunk folder, the same folder used by the edition distributed on GitHub.
The tray menu opens this folder in Explorer and the settings file (.env) in the user's editor; both run
outside the package and would only see an empty folder under virtualization. Users switching from the
GitHub edition keep their settings, contacts and logs, and uninstalling does not delete the user's
credentials and contacts without notice. SIPFunk writes nothing outside the user's profile.
```

## Hinweise für die Prüfer (Englisch, Feld „Notes for certification“)

```text
SIPFunk needs a SIP account on the user's own phone system (developed for an AVM FRITZ!Box,
"LAN/WLAN (IP phone)") and an API key of OpenAI or Google Gemini that the user enters in the setup
assistant. Without them the app starts, shows its tray icon and opens the setup assistant in its own
window; calls are not possible. The app does not contact any server of the publisher. The source code
is public under the AGPL-3.0: https://github.com/alorbach/ai-sip-funk
```

---

## Store-Listing Deutsch (de-DE)

### Beschreibung

```text
Benötigt: eine eigene Telefonanlage mit SIP (entwickelt für die AVM FRITZ!Box) und einen eigenen API-Schlüssel von OpenAI oder Google Gemini. Die Gespräche führt eine generative Sprach-KI dieser Anbieter; dafür fallen dort Kosten nach deren Preisen an.

SIPFunk ist ein lokaler KI-Telefonassistent für Windows. Das Programm meldet sich wie ein IP-Telefon an deiner FRITZ!Box an und verbindet das Telefonaudio mit einem Live-Sprachmodell von OpenAI oder Google. Die KI ruft für dich an und erledigt einen Auftrag, nimmt als Anrufbeantworter Anrufe an und benachrichtigt dich danach.

Alles läuft auf deinem Rechner. Der Herausgeber betreibt keinen Server und erhält keine Daten. Gesprächsaudio geht live an den von dir gewählten KI-Anbieter und wird nicht gespeichert; Protokolle bleiben als Text auf deinem Rechner und werden nach einer einstellbaren Frist gelöscht.

Die KI stellt sich am Telefon als KI vor. Ihre Antworten können falsch sein; prüfe die Protokolle. Du bist für jeden Anruf verantwortlich, den die KI für dich führt oder annimmt. Hinweise zu Recht und Datenschutz stehen im Projekt auf GitHub.

Was SIPFunk kann:
• Ausgehende Anrufe mit Auftrag in normaler Sprache, mit Gesprächsplan und Ergebnis
• Anrufbeantworter mit Profilen je eigener Rufnummer
• Benachrichtigung nach dem Anruf per Windows-Hinweis, E-Mail oder Rückruf
• Pop-up beim Klingeln mit Einschätzung der Nummer
• Spam-Abwehr für Werbe- und Betrugsanrufe
• Kontakte mit Notizen, Import aus Google, Microsoft oder vCard/CSV
• Faxe senden über die FRITZ!Box: aus jedem Programm auf den Drucker „SIPFunk Fax“ drucken
• Schnittstelle (MCP) für KI-Agenten wie Claude oder Codex, standardmäßig aus

SIPFunk ist Open Source (GNU AGPL-3.0) und ein privates Projekt ohne Support-Zusage.
```

### Funktionen (je eine Zeile)

```text
Ruft für dich an und erledigt einen Auftrag, den du in normaler Sprache beschreibst
Anrufbeantworter mit KI, Profile je eigener Rufnummer
Zusammenfassung nach dem Anruf per Windows-Hinweis, E-Mail oder Rückruf
Pop-up beim Klingeln mit Einschätzung der Nummer
Spam-Abwehr für Werbe- und Betrugsanrufe
Kontakt-Import aus Google, Microsoft oder vCard/CSV
Faxe senden über die FRITZ!Box per Drucker „SIPFunk Fax“
Wahlweise OpenAI Realtime oder Google Gemini Live
Läuft lokal, speichert kein Audio, Protokolle mit Löschfrist
Open Source unter der GNU AGPL-3.0
```

### Suchbegriffe

```text
KI Telefon
Anrufbeantworter
FRITZ!Box
SIP
Telefonassistent
Fax
OpenAI
```

### Neuigkeiten (Version 1.0.5)

```text
Erste Fassung im Microsoft Store.
```

---

## Store listing English (en-US)

### Description

```text
Requires: your own phone system with SIP (developed for the AVM FRITZ!Box) and your own API key from OpenAI or Google Gemini. Calls are handled by a generative voice AI from these providers, which charge for it at their own prices.

SIPFunk is a local AI phone assistant for Windows. It registers with your FRITZ!Box like an IP phone and connects the call audio to a live voice model from OpenAI or Google. The AI calls on your behalf and completes a task, answers calls as an answering machine and notifies you afterwards.

Everything runs on your computer. The publisher runs no server and receives no data. Call audio goes live to the AI provider you choose and is not stored; logs stay on your computer as text and are deleted after a period you set.

The AI introduces itself as an AI on the phone. Its answers can be wrong; check the logs. You are responsible for every call the AI makes or answers for you. Legal and privacy notes are in the project on GitHub.

What SIPFunk does:
• Outgoing calls with a task in plain language, with a call plan and a result
• Answering machine with profiles per own phone number
• Notification after the call by Windows notification, e-mail or call back
• Pop-up while ringing with an assessment of the number
• Spam defence against sales and scam calls
• Contacts with notes, import from Google, Microsoft or vCard/CSV
• Send faxes through the FRITZ!Box: print to the "SIPFunk Fax" printer from any program
• Interface (MCP) for AI agents such as Claude or Codex, off by default

SIPFunk is open source (GNU AGPL-3.0) and a private project without a support commitment.
```

### Product features (one per line)

```text
Calls for you and completes a task you describe in plain language
AI answering machine with profiles per own phone number
Summary after the call by Windows notification, e-mail or call back
Pop-up while ringing with an assessment of the number
Spam defence against sales and scam calls
Contact import from Google, Microsoft or vCard/CSV
Send faxes through the FRITZ!Box with the "SIPFunk Fax" printer
Choice of OpenAI Realtime or Google Gemini Live
Runs locally, stores no audio, logs with a deletion period
Open source under the GNU AGPL-3.0
```

### Search terms

```text
AI phone
answering machine
FRITZ!Box
SIP
phone assistant
fax
OpenAI
```

### What's new (version 1.0.5)

```text
First release in the Microsoft Store.
```

---

## Screenshots

Die Bilder in `doc/images/store` (1366 × 768, erfundene Beispieldaten), jeweils `.de.png` für Deutsch und `.en.png` für Englisch, in dieser Reihenfolge: `dashboard`, `calls`, `settings-incoming`, `contacts`, `calls-fax`, `settings-mcp`. Neu aufnehmen: `npm run screenshots:store`.
