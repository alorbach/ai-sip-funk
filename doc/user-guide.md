# SIPFunk – User Guide

Deutsch: [user-guide.de.md](user-guide.de.md)

The web UI is German. This guide quotes labels and buttons as they appear on screen and adds a translation in parentheses on first use. Example names, phone numbers and addresses in this guide are made up.

Further documents: [Usage guidelines](guidelines.md) · [Legal aspects](legal.md) · [Architecture](architecture.md) · [Manual test checklist](test-checklist.md).

Contents: [1 Overview](#1-what-sipfunk-is) · [2 Requirements](#2-requirements) · [3 FRITZ!Box](#3-setting-up-the-fritzbox) · [4 Installation](#4-installation-and-first-start) · [5 Web UI](#5-the-web-ui-at-a-glance) · [6 Outgoing calls](#6-outgoing-calls) · [7 Answering machine](#7-answering-machine) · [8 Pop-up while ringing](#8-pop-up-while-ringing) · [9 Notifications](#9-notifications-after-an-answered-call) · [10 Spam defence](#10-spam-defence) · [11 Contacts, logs, data](#11-contacts-call-logs-data) · [12 Simulator](#12-simulator) · [13 MCP](#13-mcp-interface) · [14 Settings](#14-settings-overview) · [15 Cost](#15-cost) · [16 Troubleshooting](#16-troubleshooting) · [17 Glossary](#17-glossary)

---

## 1. What SIPFunk is

SIPFunk is a local AI phone assistant for the FRITZ!Box. It registers with the box like an IP phone (SIP extension) and connects the call audio to the OpenAI Realtime API. This lets the AI

- **place outgoing calls** and carry out a task ("Ask the practice for an appointment next week"),
- **answer incoming calls** (answering machine) and take down the request and whether a call back is wanted,
- **notify** you afterwards (tray notification, e-mail, for important calls a call back with the option to be put through to the caller),
- optionally **brush off or stall advertising and scam callers** (spam defence, only after explicit confirmation, chapter 10).

Everything runs on your computer. There is no SIPFunk cloud service; the only outbound connections go to OpenAI (speech, text), to your mail provider if configured, and to tellows if you switch on the lookup. The web UI is reachable only from the same computer (127.0.0.1).

Limits: one user, one extension, one call at a time. SIPFunk currently works only with the OpenAI Realtime API. The AI speaks German with callers. No audio is recorded; what is stored are transcripts (text), summaries and metadata.

### How a call works technically

1. The FRITZ!Box sends the call audio as G.711 (HD at 16 kHz if the box offers it, otherwise 8 kHz) to SIPFunk.
2. SIPFunk converts it to 24 kHz PCM and streams it to the Realtime API; the answer comes back as audio and goes to the box in real time.
3. The AI receives a system instruction (ground rules, style, your task, background knowledge) and up to three tools: `end_call` (end the call and report a result), `transfer_call` during the call back to you (put through), and `flag_spam` when the spam defence is active.
4. After the call a text model writes a summary and, for answering machine calls, an assessment "important/unimportant".

More in the [architecture](architecture.md).

---

## 2. Requirements

- FRITZ!Box with a FRITZ!OS that supports "LAN/WLAN (IP-Telefon)". Other SIP systems are untested.
- Node.js 20.12 or later when starting from the repository. The built tray app ships its own runtime.
- Windows 10/11 for the tray app (notification area, notifications, pop-up while ringing). Server and web UI only need Node.js but are untested on other systems.
- An OpenAI API key with access to the Realtime models. Cost accrues per minute of conversation (chapter 15).
- The computer has to be running for as long as the answering machine should take calls.

---

## 3. Setting up the FRITZ!Box

The box UI is quoted in German as it is the language most installations use.

1. Open the FRITZ!Box UI → **Telefonie → Telefoniegeräte → Gerät einrichten → Telefon (mit und ohne Anrufbeantworter) → LAN/WLAN (IP-Telefon)**.
2. Assign a user name and password. These go into `.env` later (`SIP_USER`, `SIP_PASSWORD`). **Never share them in chats, tickets or screenshots.**
3. Choose the **outgoing number** (the AI calls with this number).
4. **Incoming calls:** assign all numbers on which the AI should ring or pick up. Without the assignment SIPFunk never sees the call.
5. Optional: under **Telefonie → Rufbehandlung**, set call diversions or the box's own answering machine so that they do not pick up before SIPFunk (mind the number of rings, chapter 7).

For incoming calls the box delivers the dialled number in the SIP header `P-Called-Party-ID`; this lets SIPFunk answer differently depending on the number called (section 7.3).

---

## 4. Installation and first start

### 4.1 Starting from the repository

```bash
npm install
```

Copy `.env.example` to `.env` and fill in at least:

| Variable | Meaning |
| --- | --- |
| `SIP_SERVER` | address of the box, usually `fritz.box` |
| `SIP_USER`, `SIP_PASSWORD` | credentials of the IP phone extension (required) |
| `SIP_LOCAL_PORT` (5062), `RTP_PORT` (40000) | local UDP ports; the Windows firewall asks on first start, allow for private networks |
| `OPENAI_API_KEY` | for AI calls, call plan, summary, assessment, voice samples. Without a key only "Testton" and "Echo" work |
| `OWNER_NUMBERS` | your own number(s), comma-separated (target of the call back, call-back number given to people the AI calls); alternatively a contact flagged "Inhaber" (owner) |

Then start:

```bash
npm start
```

and open <http://127.0.0.1:8080>. All other variables are listed with comments in `.env.example`; chapter 14 shows what is set only there and what is set in the web UI.

### 4.2 Tray app (Windows, no console)

```bash
npm run tray
```

An icon in the notification area shows the state (registered, ready, connected). A double click opens the web UI, a single click the menu: "Web-UI öffnen" (open web UI), "Anrufbeantworter" (answering machine on/off), "Einstellungen (.env) bearbeiten" (edit `.env`), "Datenordner öffnen" (open data folder), "Beim Anmelden starten" (start at login), "Server neu starten" (restart server), "Beenden" (quit). Errors (e.g. a missing `SIP_USER`) appear as a menu line; clicking it copies the text. After an answered call a Windows notification appears; clicking it opens the web UI.

Installer and portable ZIP: `npm run dist:win` (output in `release/`). When installed, `.env`, `settings.json`, `contacts.json`, `transcripts/`, `mail-token.json` and `sipfunk.log` live in the user profile under `%APPDATA%\SIPFunk`. On first start `.env.example` is copied there and opened; after filling it in choose "Server neu starten". The environment variable `SIPFUNK_DATA_DIR` sets the data folder when starting from the repository as well.

### 4.3 First functional test without AI

Check on your own phone whether SIP and audio work. Internal extensions of the box start with `**` (`**610` is usually the first cordless phone):

```bash
npm run test-call -- **610
```

This plays a beep. With `--echo` everything you say comes back after one second (tests both directions); `--seconds 60` extends the limit (default 30 s). Without a number the command only checks the registration. In the web UI the audio modes "Testton" and "Echo (1 s)" do the same.

The test has passed when registration works, the phone rings, the tone is audible and hanging up works from both sides.

---

## 5. The web UI at a glance

The header is always visible: the four pages on the left, the connection status on the right; the page you opened last is remembered. As soon as a call is running, the call bar appears below with the phase (dialling, ringing, incoming call, connected), name or number of the other party, duration, codec, "Mithören" (listen in) and "Auflegen" (hang up); a dot pulses on the "Dashboard" tab. While an incoming call is ringing, the buttons from chapter 8 are shown there too.

- **Dashboard**: on the left the "Anruf" (call) card (number or contact, audio mode, task, style, voice, form of address, model, "Anrufen …", "Als Standard speichern" (save as default)) and the last five calls; on the right the transcript of the running call with usage and summary, below it the server log.
- **Anrufe** (calls): all stored calls with a search by name or number and the tags "Eingehend" (incoming), "Ausgehend" (outgoing), "Rückruf an dich" (call back to you) and "Spam-Abwehr" (spam defence). A click shows transcript, result according to the AI, summary and cost, plus the buttons "Nummer auf die Spam-Liste" (add number to spam list), "Beschwerde-Entwurf" (complaint draft), "Als Kontakt speichern" (save as contact) and "Protokoll löschen" (delete log).
- **Kontakte** (contacts): list with "Anrufen" (call; loads the contact into the dashboard), "Verlauf" (history; filters the call list), "Bearbeiten" (edit) and delete; "Neuer Kontakt" (new contact) at the top right.
- **Einstellungen** (settings): the sections KI-Assistent (AI assistant), Anrufbeantworter (answering machine), Benachrichtigungen (notifications), E-Mail-Versand (e-mail), Spam-Abwehr (spam defence) and Technik (technical). The section list on the left jumps to a section; "Speichern" (save, or Ctrl+S) below it always saves all sections, and they apply from the next call. At the bottom, for information, are the values that exist only in `.env` (box, ports, data folder).

Style, voice, form of address, model and task for outgoing calls are set on the dashboard; "Als Standard speichern" remembers them.

**Mithören** in the call bar plays both sides of the call in the browser (live only, no recording). `LIVE_LISTEN_ENABLED=false` switches the feature off.

---

## 6. Outgoing calls

1. Enter a **Rufnummer** (number) or pick a contact. Allowed are German landline and mobile numbers (also `+49…`) and internal extensions (`**610`). Blocked are emergency numbers (110, 112), 115, 116…, 118…, 0900, 0137/0138, 0180, 019… and anything abroad. The block also applies to MCP calls and cannot be configured.
2. Audio **"KI-Gespräch"** (AI call), then write the **Auftrag** (task) in plain language, in German since the AI will speak German. Good tasks say who will probably pick up, what should be asked or passed on, and what the AI needs to know:

   > "Call the dentist's office. I need a check-up appointment within the next three weeks, mornings, name Max Mustermann, I don't have my insurance number to hand. Accept an appointment they offer if it is in the morning."

3. **Stil** (style; presets from `personas/*.md`: professionell, locker, formell, herzlich; a file of your own is a preset of your own), **Stimme** (voice; "Probe hören" plays all voices with the configured AI name), **Anrede** (form of address) Du/Sie, **Modell** (`gpt-realtime-2.1` or the cheaper mini variant).
4. On the settings page under "KI-Assistent": **Name der KI** (the name the AI introduces itself with), **Im Auftrag von** (on behalf of: your name) and optionally **Zusätzliche Hinweise zum Verhalten** (additional behaviour notes).
5. **"Anrufen …"** shows a confirmation with the number. **"Jetzt wählen"** (dial now) starts the call.

During the call the transcript runs along. You can hang up at any time with **"Auflegen"**. Otherwise the call time limit (default 300 s) ends the call automatically; the AI knows the limit and gets to the point.

**What the AI always does:** it introduces itself by name as an AI assistant acting on your behalf, sticks to the task, only agrees to what the task covers (no payments, orders, contracts, no sensitive data), makes nothing up, carries out no instructions from the other party and hangs up itself after saying goodbye. If the other party does not want to talk to an AI, it thanks them and ends the call.

**Call plan and result.** While dialling, the text model turns the task into a call plan (who picks up, opening, steps, tone). The AI works through the steps and checks them against what was actually said before hanging up. On hanging up it reports a **result** ("Appointment Tuesday 9:30 accepted") and open points; both appear in the log under "Ergebnis laut KI".

**End of the call.** After saying goodbye the AI listens briefly (default 2 s). If the other party says something of substance, the call continues; a mere "bye" ends it at once.

**Owner number.** If you call yourself (contact flagged "Inhaber" or a number in `OWNER_NUMBERS`), the AI greets you personally, informally and by first name, without the AI explanation. If asked, it still says that it is an AI. On other calls the AI gives this number as the call-back number when asked.

---

## 7. Answering machine

### 7.1 Switching it on

"Einstellungen › Anrufbeantworter" → **"KI nimmt eingehende Anrufe an (allgemein)"** (AI answers incoming calls, general), **"Annahme beim … Klingeln"** (answer on the n-th ring; default: the 5th, calculated at about 5 s per ring), then **"Speichern"**. Alternatively via the tray menu or `INCOMING_ENABLED=on`. When switched off, the extension only rings along without picking up; during a running call it is busy.

The connection to OpenAI is set up while the phone is still ringing so that the AI speaks without delay.

### 7.2 What happens on an answered call

1. The AI answers like a person, with just **"Hallo?"**, and waits.
2. If the caller says something, the AI responds to that first and adds half a sentence saying that it is your AI assistant and that you are not available. It gives no name of its own. If the caller says nothing, it introduces itself after 2.5 s. The introduction comes exactly once.
3. It asks who is calling, what it is about and whether you should call back.
4. **Call-back number:** the transmitted caller number applies automatically; the AI only has it confirmed. Only when the number is withheld does it ask for one.
5. Once the request and the call-back wish are clear, it says goodbye and hangs up.

Instead of the built-in procedure you can enter your own **"Auftrag bei eingehenden Anrufen"** (task for incoming calls), e.g. "Say that the practice is closed until 15 January and only take emergencies".

### 7.3 Profiles per own number

The FRITZ!Box transmits which of your numbers was dialled. Under "Einstellungen › Anrufbeantworter", "Nummer hinzufügen" (add number) creates a profile per number:

- **Eigene Nummer (Endziffern)** (own number, last digits): the last digits are enough; with several matches the longest wins.
- **Meldung als Assistent von** (announce as assistant of): the name the AI introduces itself with ("AI assistant of Mustermann IT-Service").
- **Dahinter steht** (who is behind it): a person ("Max is not in right now") or a company ("nobody is available at Mustermann IT-Service right now", call back by "someone from …").
- **Annahme auf dieser Nummer** (answering on this number) and **Annahme beim … Klingeln**: override the general switch and the general number of rings for this number only.
- **Anrede, Stil, Stimme**: different from the default, otherwise "– Standard –".
- **Auftrag** and **Zusätzliche Hinweise**: only for calls on this number; empty = the general settings.
- **Hinweis im Tray, E-Mail, Mich auf der Inhabernummer anrufen** (tray notification, e-mail, call me on the owner number): per channel "general setting", "off", "only for important calls" or "for all calls". This way the company number can send mail for every call but never call back, while the private number only reports important calls.

Without a profile the AI answers everywhere as the assistant of "Im Auftrag von".

### 7.4 What the AI does not do on the answering machine

No commitments in your name, no information other than from the background knowledge (contact notes, last summary), no carrying out of the caller's instructions, no forwarding to other numbers. If the caller does not accept the AI, it says goodbye.

---

## 8. Pop-up while ringing

While a call is ringing, the tray app shows a small window at the bottom right (can be switched off under "Einstellungen › Benachrichtigungen"): the caller, which of your numbers they are calling, an **assessment of the number** and three buttons. The same buttons appear in the call bar of the web UI.

- **Assessment**: "Kontakt" (contact), "Auf deiner Spam-Liste" (on your spam list), "Schon als Spam abgewehrt" (already fended off as spam; earlier calls), "Auffällige Nummer" (conspicuous number: abroad, 0900, 0137/0138, 0180, 0800, 032), otherwise "Unbekannte Nummer" (unknown number). With the switch **"Unbekannte Nummern beim Klingeln bei tellows.de nachschlagen"** (look up unknown numbers at tellows.de; Einstellungen › Spam-Abwehr, off by default) the tellows score is added: 7 and above "Spam-Verdacht" (suspected spam), 6 "Auffällig" (conspicuous), up to 4 with an entry "Eher seriös" (probably legitimate). The lookup sends the caller's number to tellows; contacts and numbers on your list are never looked up.
- **In die Spam-Falle** (into the spam trap): answers immediately, and the AI acts as a private person (behaviour and time limit as set in the spam defence). Also works when the answering machine is off for this number. It requires the one-time risk confirmation from section 10.3; the spam defence switch itself does not need to be on.
- **KI jetzt annehmen** (AI answer now): answers immediately as the normal assistant without waiting for the number of rings.
- **Klingeln lassen** (let it ring): the AI does not answer this one call; you can pick up yourself.

Calls are only diverted at the press of a button, never automatically.

---

## 9. Notifications after an answered call

After every answered call the text model writes the summary and assesses whether the call was **important** (appointment, customer, deadline, authority, emergency) or **unimportant** (advertising, survey, wrong number). Then, each individually switchable under "Einstellungen › Benachrichtigungen" and overridable per own number (section 7.3):

| Switch | What happens |
| --- | --- |
| **Hinweis im Tray** (for all calls) | Windows notification "Anruf von …" or "Wichtiger Anruf von …" with a short line; tray app only |
| **E-Mail mit Zusammenfassung** (for all calls) | compact mail to the configured recipient, layout in 9.2 |
| **Mich auf der Inhabernummer anrufen** (important calls only) | the AI calls you and reports, see 9.1 |

Order: notification → mail → call back. The assessment "important" is a model decision and can be wrong.

The phones connected to the FRITZ!Box itself cannot be notified (the box accepts SIP text messages but the phones do not display them), and sending mail through the box is not possible.

### 9.1 Call back to you

The call back goes to the owner number (contact flagged "Inhaber", otherwise the first number from `OWNER_NUMBERS`); without such a number it is skipped. It waits until the line is free.

The AI greets you personally and reports at once and in one go: who called, when, on which of your numbers, what it was about, why it is important, and the call-back number in groups of three digits. Only if you explicitly ask for it ("verbinde mich", "stell durch" – put me through) does it transfer you to the caller via SIP REFER; otherwise it says a brief goodbye. Spam defence calls never trigger a call back.

### 9.2 What the e-mail looks like

The subject is sortable: `[SIPFunk] Wichtig · Praxis Weber · Termin verschieben, bitte Rückruf`, for unimportant calls `[SIPFunk] Anruf · <name or number> · <short request>`, for spam `[SIPFunk] Spam abgewehrt · <name or number>`. The mail has fixed blocks in this order:

1. **Header**: caller with name and number, time ("heute 14:50", "gestern …" or the date), duration, own number dialled and for whom the call was answered.
2. **Was zu tun ist** (what to do): call back with the number (for important calls or if a call back was requested) and the open points.
3. **Worum es ging** (what it was about): the result according to the AI, otherwise the summary, five lines at most.
4. **Einschätzung** (assessment): important or unimportant with a one-sentence reason.
5. **Gesprächsverlauf (gekürzt)** (conversation, shortened): only finished turns, long ones cut to around 200 characters.
6. **Footer**: link to the "Anrufe" page (`http://127.0.0.1:8080/#calls`), log ID and cost.

The mail is sent as text and HTML; in the HTML view a coloured header shows the assessment (red = important, grey = unimportant, orange = spam). Spam mails are deliberately short and contain no conversation. The link only works on the computer SIPFunk runs on.

**Changing the layout.** Under "Einstellungen › E-Mail-Versand" you find the templates for **Betreff** (subject) and **Text**. Variables in curly braces are replaced per call:

| Variable | Content |
| --- | --- |
| `{status}` | "Wichtig", "Anruf" or "Spam abgewehrt" |
| `{anrufer}` | name from the contacts, otherwise the number |
| `{name}`, `{nummer}`, `{kontakt}` | name, number, both together |
| `{anliegen}` | short request, 60 characters at most (empty for spam) |
| `{zeit}`, `{dauer}` | "heute 14:50" or the date; call duration |
| `{gewaehlt}`, `{fuer}`, `{leitung}` | own number dialled, for whom the call was answered, both together |
| `{todo}` | call back with number and open points |
| `{worum}`, `{zusammenfassung}` | result in five lines at most; full summary |
| `{einschaetzung}` | important or unimportant with reason; for spam the reason for the spam defence |
| `{verlauf}` | shortened conversation (empty for spam) |
| `{link}`, `{id}`, `{kosten}` | address of the "Anrufe" page, log ID, "Kosten ca. … USD" |

Rules: a line whose variables are all empty is dropped; a paragraph (separated by a blank line) whose variables are all empty is dropped together with its heading. Left-over separators such as " · " at the end of a line disappear. Unknown variables stay as typed so that typos stand out. The HTML part is derived from the text: lines in CAPITALS become headings, a paragraph of "label: value" lines becomes a table, the paragraph after a line `-- ` becomes the footer. Clearing a field and saving restores the default; "Probe-Mail senden" (send test mail) shows your own template with sample data.

### 9.3 Setting up e-mail

Everything is under "Einstellungen › E-Mail-Versand". The `MAIL_*` and `SMTP_*` variables in `.env` only provide initial values; saved passwords are stored in `settings.json` in the data folder, and the web UI only shows them masked.

1. Choose the **Versandweg** (delivery method): "SMTP mit Passwort" (all providers), "Gmail" or "Microsoft 365 / Outlook" (sign-in via OAuth, no password).
2. **SMTP**: enter the mailbox and click **"Automatisch einrichten"** (set up automatically). SIPFunk looks for server, port and encryption in this order: a built-in list of well-known providers, the Thunderbird database (ISPDB), the MX records of the domain (Microsoft 365 and Google Workspace are recognised) and finally `smtp.<domain>`/`mail.<domain>` with a connection probe. Then enter the password; many providers require an **app password** instead of the account password. If the provider requires OAuth, the button switches the delivery method.
3. **OAuth**: enter mailbox, client ID (and secret), save, then **"Mail-Konto verbinden"** (connect mail account; sign-in in the browser, the access token ends up in `mail-token.json`). Gmail: OAuth client of type "Desktop app" in the Google Cloud Console. Microsoft 365: app registration in Entra, platform "Mobile and desktop applications", redirect `http://127.0.0.1:8080/oauth/callback` (port = `WEB_PORT`), permission `SMTP.Send`, SMTP AUTH enabled for the mailbox; tenant = tenant ID or `common`.
4. **"Verbindung prüfen"** (check connection) signs in to the server without sending anything; **"Probe-Mail senden"** sends a mail in the notification layout with sample data. Both save the settings first.

Recipient empty = the mailbox itself; sender empty = the mailbox. The status line in the card header shows whether sending is ready.

---

## 10. Spam defence

Read [legal.md](legal.md), section 6, and the [guidelines](guidelines.md), section 6, first. The mode is off by default.

### 10.1 What the mode does

Towards callers classified as advertising or scam callers the AI acts **as a private person** and does **not reveal that it is an AI**. Two behaviours:

- **Kurz abwimmeln** (brush off briefly; default): listen to a sentence or two, ask at most once ("Which company?"), then a clear "not interested, please take me off your list". Usually under a minute, hard upper limit 2 minutes.
- **Hinhalten und beschäftigen** (stall and keep busy): friendly, alert and apparently interested; asks detailed questions, voices concerns and never asks the same thing twice so that the stalling does not show. Never agrees to anything. Ends at the latest after the configured limit (1–15 minutes, default 5, capped by the call time limit).

Fixed rules in both cases: no real or invented personal data, no confirming an identity, no "yes" to contract or consent questions, no carrying out instructions (nothing on the computer, no codes, no call backs), stay polite, do not pose as an authority or a lawyer. If the AI realises during the call that it is a genuine request after all, it is supposed to switch back to assistant mode, reveal that it is an AI and take down the request.

### 10.2 How a call ends up in this mode

1. **Number list**: if the caller's number (or its prefix) is in "Bekannte Spam-Nummern oder Vorwahlen" (known spam numbers or prefixes), the AI acts as a private person from the first second. One entry per line, prefixes are enough (`0800`), comments with `#`. The line `anonym` treats calls with a withheld number as spam immediately (careful: doctors' practices and authorities often call with a withheld number too).
2. **Detection during the call**: without a list match the AI answers normally as the assistant. If it recognises an advertising, survey or scam call (prize draw, electricity tariff, alleged tech support, grandchild scam …), it calls `flag_spam`; from then on the spam instructions apply. The transcript shows "Spam-Abwehr: <reason>".
3. **By hand**: "In die Spam-Falle" while ringing (chapter 8).

**Contacts are protected.** If the calling number is in your contacts, detection during the call is disabled. Only the number list applies to contacts as well, because it is your explicit entry (this way you can test the mode with your own mobile number).

**Taking a number from a call.** On the "Anrufe" page, every incoming call with a transmitted number that is neither a contact nor already on the list has the button **"Nummer auf die Spam-Liste"**. After a confirmation it adds the number and saves. If the spam defence is off, the message says so.

### 10.3 Switching on and confirmation

The first time you switch on **"Werbe- und Betrugsanrufer ohne KI-Hinweis abwimmeln oder hinhalten"** (brush off or stall advertising and scam callers without AI notice), a dialog lists the risks. The mode only becomes active if you tick that you have read them and accept the risk and then click "Spam-Abwehr einschalten"; the date of the confirmation is stored in `settings.json` and shown next to the switch. Without the confirmation the mode stays off even if `settings.json` is edited by hand (the server checks). There is deliberately no `.env` switch for it.

### 10.4 Configuring the role

The private person has its own settings, separate from the assistant:

- **Name der Rolle** (name of the role): an invented name it answers with ("Schmidt?") and gives when asked. If the caller asks for exactly this name, it says "Am Apparat" (speaking); if they ask for someone else, that person is not in. Empty = it gives no name. Do not use your real name.
- **Stimme der Rolle** (voice) and **Sprechgeschwindigkeit der Rolle** (speaking rate): voice empty = same as the assistant; rate empty = 0.95, slightly slower than the assistant. Both apply when the spam defence is certain at pick-up (list match or "In die Spam-Falle"). If the AI only switches roles in mid-call, the assistant's voice and rate remain; name and own instructions still apply.
- **Die Rolle ist** (the role is): a man, a woman or automatic by voice (cedar, ash, ballad, echo and verse count as male). This decides whether it says "Am Apparat" when asked for "Herr Schmidt" or for "Frau Schmidt".
- **Eigene Anweisungen für die Rolle** (own instructions for the role): free text on character, tone and quirks, for example "Elderly gentleman, likes telling stories, friendly but long-winded". The protective rules (no data, no consent, no real identity, stay polite) always take precedence.

### 10.5 After the call

Logs of such calls carry the tag "Spam-Abwehr". They never count as important; there is no call back. Tray notification and e-mail ("Spam abgewehrt") are sent if switched on. The result according to the AI states what the caller wanted to sell and which company they named.

**Complaint draft.** Every log tagged as spam defence has the button **"Beschwerde-Entwurf"**. The text model writes a factual draft for the online form of the Bundesnetzagentur (German Federal Network Agency) on unlawful telephone advertising: date, time, calling and called number, duration, content of the call with quotes from the log, a note on the missing consent and on the fact that an automatic assistant answered and a text log exists. The draft appears in a window for copying; you add name and address yourself and submit it yourself. It is a suggestion, not legal advice.

---

## 11. Contacts, call logs, data

### 11.1 Contacts

Contacts (stored locally in `contacts.json`) have a name and a number, optionally form of address, style, voice, default task and notes. Selecting one pre-fills the call form; the AI receives the notes and the summary of the last call as background knowledge (it does not recite them unprompted but will reveal them when asked). The flag **"Inhaber"** marks your own number.

### 11.2 Call logs

Every AI call that was actually connected is saved in `transcripts/` as JSON and Markdown: time, number, own number dialled, duration, codec, reason for ending, task, call plan, result according to the AI, transcript (text, no audio), usage, cost estimate, summary, spam defence tag. Calls that were never connected (not answered, busy) produce no log.

Logs are deleted automatically after the configured period (default 7 days, "Einstellungen › Technik"); manually on the "Anrufe" page.

### 11.3 Files in the data folder

The data folder is the project folder when starting from the repository, and `%APPDATA%\SIPFunk` for the installed tray app.

| File | Content | Confidential |
| --- | --- | --- |
| `.env` | credentials (SIP, OpenAI), initial values | yes, never share |
| `settings.json` | all web UI settings including mail password, OAuth secret and spam defence confirmation | yes |
| `contacts.json` | contacts | yes (personal data) |
| `transcripts/` | call logs | yes (personal data) |
| `mail-token.json` | OAuth token for sending mail | yes |
| `sipfunk.log`, `sipfunk-YYYY-MM-DD.log` | operating log with phone numbers (tray app only; otherwise the log is in the terminal). One file per day; files older than the log retention period are deleted | yes |
| `voice-samples/` | cached voice samples (MP3) | no |
| `sim-results/` | simulator reports (in the project folder) | no, as long as the scenarios are made up |

All of them are listed in `.gitignore`. When backing up the computer, include the data folder, but encrypted.

---

## 12. Simulator

The simulator plays through conversations in text mode without calling anyone: the Realtime model gets the same instructions and tools as on the phone, a text model plays the other party from a role description, and another one grades the result at the end (all points done, mark, problems). It needs an OpenAI key and costs a few cents per run. Scenarios and reports are in German.

```bash
npm run sim
```

runs all built-in scenarios, `npm run sim -- praxis strom` only those named:

| ID | Scenario |
| --- | --- |
| `privat`, `praxis`, `falsch`, `mailbox` | outgoing: private message, rescheduling an appointment at a practice, wrong person on the line, voicemail |
| `rueckruf` | call back to the owner after an important call |
| `ab` | answering machine with a genuine request while the spam defence is on (must not trigger) |
| `strom`, `bank` | advertising and an alleged bank security department: detection during the call with role switch |
| `inkasso`, `liste` | list match with "stall" |
| `echt` | list match with a genuine request (switch back to assistant mode) |

Your own outgoing scenario:

```bash
npm run sim -- --task "Frag nach den Öffnungszeiten am Samstag" --partner "Verkäuferin in einer Bäckerei, kurz angebunden" --sie
```

Further switches: `--opening "…"` (first sentence of the other party), `--model <Realtime model>`. The spam scenarios take the role's name and own instructions from the saved settings; to try things without saving, use the environment variables `SIM_SCAM_NAME`, `SIM_SCAM_EXTRA` and `SIM_SCAM_GENDER`. Reports are written to `sim-results/`.

In the spam scenarios the judge is strict: any piece of data given, any "yes" and any mention of being an AI while in spam mode is a serious error. Text models are, however, reluctant to play scammers convincingly; these scenarios are therefore less meaningful than a real call.

---

## 13. MCP interface

`npm run mcp` starts an MCP server over stdio that talks to the running web UI (`npm start` or the tray app has to be running). An AI agent can use it to start calls and read results. Dial target protection, call time limit and "one call at a time" apply here too; there is no additional confirmation in the web UI, approval happens in the client when the tool is called. You remain responsible (see the [guidelines](guidelines.md)).

| Tool | Purpose |
| --- | --- |
| `get_status` | registration and running call |
| `start_call` | start a call: number or contact name, task (`task`), optional `context` with background knowledge for questions |
| `wait_for_call` | wait for the call to end (50 s at most per invocation, repeat if needed); returns result, summary and transcript |
| `hangup` | hang up |
| `list_calls`, `get_call` | stored logs |
| `list_contacts`, `call_history` | contacts and calls per contact |

Typical flow: `start_call` → `wait_for_call` → evaluate the result. The `task` should say who will probably pick up, what should be asked or passed on, and what the AI needs to know.

Setup, each with the absolute path to the project folder.

**Claude Code:**

```bash
claude mcp add sipfunk -- npx tsx /path/to/sipfunk/src/mcp/server.ts
```

**Codex** – in `~/.codex/config.toml`:

```toml
[mcp_servers.sipfunk]
command = "npx"
args = ["tsx", "/path/to/sipfunk/src/mcp/server.ts"]
```

**Claude Desktop** – in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sipfunk": {
      "command": "npx",
      "args": ["tsx", "/path/to/sipfunk/src/mcp/server.ts"]
    }
  }
}
```

If the web UI runs on a different port, set `SIPFUNK_URL=http://127.0.0.1:PORT` as an environment variable of the MCP server.

---

## 14. Settings overview

There are two places: `.env` (read at start, changes need a restart) and the "Einstellungen" page of the web UI (saved in `settings.json`, applies from the next call). For everything that exists in both places, `.env` only provides the initial value; a value saved in the web UI takes precedence. The complete list of variables is [.env.example](../.env.example).

### 14.1 Only in `.env`

| Variable | Default | Effect |
| --- | --- | --- |
| `SIP_SERVER`, `SIP_USER`, `SIP_PASSWORD` | `fritz.box`, –, – | registration with the box |
| `SIP_LOCAL_PORT`, `RTP_PORT` | 5062, 40000 | local UDP ports |
| `LOCAL_IP` | automatic | local address if the computer has several networks |
| `OPENAI_API_KEY` | – | key for all AI features |
| `OWNER_NUMBERS` | – | own numbers (alternative to the "Inhaber" contact) |
| `AUDIO_HD` | true | negotiate HD G.711 (16 kHz) with the box; `false` forces 8 kHz |
| `LIVE_LISTEN_ENABLED` | true | listening in via the browser |
| `WEB_PORT` | 8080 | port of the web UI (127.0.0.1 only) |
| `SIP_DEBUG` | 0 | write all SIP messages to the log |

### 14.2 Web UI, section "Technik"

| Setting | Default | Initial value from | Effect |
| --- | --- | --- | --- |
| Gesprächslimit (Sekunden) – call time limit | 300 | `MAX_CALL_SECONDS` | hard limit, applies to all calls |
| Protokolle aufbewahren (Tage) – log retention | 7 | `TRANSCRIPT_RETENTION_DAYS` | older logs are deleted |
| Stillstandswächter (ms) – stall watchdog | 6000 | `AI_STALL_MS` | if it stays silent this long after the AI's output, the AI is nudged to continue; 0 = off |
| Stille bis Satzende (ms) – silence until end of turn | 900 | `AI_VAD_SILENCE_MS` | too short: the AI talks into thinking pauses |
| Schwelle der Spracherkennung – voice detection threshold | 0.6 | `AI_VAD_THRESHOLD` | 0.3–0.9; higher: noises interrupt the AI less often, quiet speech is more easily missed |
| Nachhören nach Verabschiedung (ms) – listening after goodbye | 2000 | `AI_HANGUP_GRACE_MS` | if the other party says something more, the call continues |
| Warten nach Abnehmen (ms) – wait after pick-up | 2500 | `AI_GREETING_WAIT_MS` | outgoing: how long the other party may speak first |
| Sprechgeschwindigkeit – speaking rate | 1.05 | `AI_SPEECH_SPEED` | 0.25–1.5 |
| Lautstärke der KI – AI volume | 1.5 | `AI_OUTPUT_GAIN` | gain towards the phone, with a soft limiter |
| Gegenüber darf die KI unterbrechen – other party may interrupt | on | `AI_ALLOW_INTERRUPT` | off: the AI always finishes speaking |
| Textmodell – text model | `gpt-6-luna` | `OPENAI_SUMMARY_MODEL` | plan, summary, assessment, complaint |

The other sections are described in chapters 6 to 10. Their initial values come from `AI_*` and `OPENAI_MODEL` (dashboard, AI assistant), `INCOMING_*` (answering machine), `NOTIFY_*` and `RING_POPUP` (notifications), `MAIL_*` and `SMTP_*` (e-mail), and `SCAM_NUMBERS` and `SPAM_LOOKUP` (spam defence).

---

## 15. Cost

OpenAI bills by token. The web UI shows usage and an estimate in US dollars per call. The prices used are hard-coded in `src/ai/pricing.ts` and have to be adjusted by hand when prices change; OpenAI's billing is authoritative. The estimate leaves out transcription and discounts for cached input.

The largest item is the speech output of the Realtime model; according to the stored price table the mini variant costs about a third. Summary, assessment and call plan are negligible. Stalling in the spam defence costs according to its duration. Set a monthly budget limit at OpenAI.

Call charges apply according to your tariff (the call back to you is a normal outgoing call).

---

## 16. Troubleshooting

The log (in the terminal, on the dashboard under "Protokoll", and for the tray app additionally `sipfunk.log` in the data folder) is the first place to look. Log messages are German; the quoted fragments below are what to search for.

| Symptom | Check |
| --- | --- |
| "Konfiguration fehlt" at start | add the named variable to `.env` |
| No registration with the box | `SIP_USER`/`SIP_PASSWORD`, `SIP_SERVER`; firewall for the UDP ports; box UI: is the IP phone registered? |
| Extension does not ring | is the number assigned to the extension in the box? |
| AI does not pick up | answering machine on? Profile of the number set to off? Is another call running? |
| AI does not speak / silence after pick-up | log "Realtime: verbunden", "erstes Audio nach … ms"; `OPENAI_API_KEY`, model access, internet |
| Choppy voice | log "RTP: Gegenstelle sendet …", "Unterläufe"; try `AUDIO_HD=false`; avoid Wi-Fi |
| AI talks into pauses | increase "Stille bis Satzende" (e.g. 1200) |
| Noises (rustling, coughing) interrupt the AI | increase "Schwelle der Spracherkennung" (e.g. 0.7). On an interruption the AI only pauses and waits for the transcription: if it was a noise or a listening sound ("mhm"), it finishes its sentence; if there was content ("No", "Wait", a question), it drops the rest and answers |
| Long silence in mid-call | log "Stillstand"; the stall watchdog nudges the AI after the configured time |
| Answer cut off | log "Realtime-Antwort abgeschnitten" → token limit; make the task shorter |
| No e-mail | status line of the "E-Mail-Versand" card; "Verbindung prüfen"; reconnect for OAuth |
| No call back | owner contact or `OWNER_NUMBERS` present? Assessment "unimportant"? Switch or profile? |
| Transfer fails | log "REFER"; the box has to be allowed to call the number |

For every AI answer the log contains a diagnostic line (generation speed, buffer underruns, interruptions). `SIP_DEBUG=1` shows all SIP messages; such logs contain phone numbers and have to be cleaned before you share them.

---

## 17. Glossary

- **Extension / IP phone**: the device SIPFunk registers as with the box.
- **Realtime API**: OpenAI interface for speech in real time (audio in, audio out).
- **Server VAD**: voice activity detection on OpenAI's side that recognises the end of a turn.
- **end_call / transfer_call / flag_spam**: tools the AI calls to hang up, put through or flag spam.
- **REFER**: SIP message instructing the box to transfer a call to another number.
- **Inhaber (owner)**: you, recognised by the contact flag or by `OWNER_NUMBERS`.
- **Stil (persona)**: style preset from `personas/*.md`.
- **Anrufbeantworter**: answering machine. **Spam-Abwehr**: spam defence. **Auftrag**: the task you give the AI.
- **MCP**: Model Context Protocol, an interface through which AI agents call tools.
