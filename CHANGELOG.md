# Changelog

**English** · [Deutsch](CHANGELOG.de.md)

Notable changes per version. Versions follow `package.json`.

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
