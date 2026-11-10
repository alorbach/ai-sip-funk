# Changelog

**English** · [Deutsch](CHANGELOG.de.md)

Notable changes per version. Versions follow `package.json`.

## Unreleased

- **Setup assistant**: the app now starts without SIP credentials and without an OpenAI key. On first start the web UI walks through the essentials (phone system with a test registration, OpenAI key with a check, names, answering machine and own number, optional e-mail, test call in echo mode). It can be skipped and reopened from "Einstellungen". Credentials are accepted on `127.0.0.1` only, checked, written to `.env` and never returned; the SIP client re-registers without restarting the app.
- **Two levels, "Einfach" and "Erweitert"**: the web UI shows only what is needed for everyday use by default; "Erweitert" adds all technical settings. The switch is in the header, applies immediately and is stored in `settings.json`. Hidden settings keep their values.
- **English interface**: web UI, ring pop-up and tray menu are available in English. By default the language follows the browser (tray: the system); "Sprache" (language) on the settings page fixes it to German or English. German stays the source: `public/i18n-en.js` holds the English texts, and a text without a translation simply appears in German. The AI itself still speaks German on the phone, and the system log and call results are not translated.
- **Mail password**: changing the mail server without entering the password again now discards the stored password, so it cannot be sent to another server. "Automatisch einrichten" saves server and a freshly typed password in one step.
- **Design and accessibility**: visible borders on fields and switches (at least 3:1), tags with at least 4.5:1, keyboard-operable tabs, labelled dialogs, error messages that are announced, no overflow from 420 px width.
- **Fixes from a code review**: transfer now applies the dial target protection; call-by-call prefixes are blocked; saving settings no longer overwrites the dashboard defaults (and vice versa) and only sends what changed; a notification is sent even if the summary fails; the tray app shuts the server down cleanly (a running call is hung up); `settings.json` and `contacts.json` are written atomically; the SIP client stops cleanly and reports the end of a call immediately.

## 0.1.0 – first public version

- Own SIP client for a FRITZ!Box extension (registration, incoming and outgoing calls, transfer) with G.711 audio at 8 or 16 kHz.
- Bridge to the OpenAI Realtime API with interruption handling, enforced goodbye and watchdogs against silence.
- Outgoing AI calls with a task, call plan, result report, summary and cost estimate.
- Answering machine with profiles per own number.
- Notifications after a call: tray, e-mail (SMTP, Gmail and Microsoft 365 via OAuth, editable templates), call back to the owner with transfer to the caller.
- Pop-up while ringing with an assessment of the number and optional tellows lookup.
- Spam defence with its own role, only after confirming the risk; complaint draft for the Bundesnetzagentur.
- Contacts, call logs with automatic deletion, operating log trimmed after the same period.
- Web UI (local only, with host and origin check), tray app for Windows, MCP interface, text simulator.
- Documentation in English and German; licensed under AGPL-3.0-or-later.
