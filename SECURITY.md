# Security

**English** · [Deutsch](SECURITY.de.md)

## Threat model

SIPFunk is meant for a single user on their own computer in their own home or office network. That determines what the program protects and what it does not:

- The web UI and its API are bound to `127.0.0.1` only and have **no login**. Any program running on the same computer under your user account can start calls and read call logs. Other websites open in your browser cannot: API and WebSocket check the host and origin of each request. Do not expose the port (no port forwarding, no reverse proxy, no tunnel).
- The setup assistant accepts the SIP password and the OpenAI key through this local API, checks them and writes them to `.env`. The API never returns them; it only reports whether a value is stored. Because the API has no login, a program running under your user account could also *replace* these credentials (it cannot read them through the API, but it can read `.env` directly anyway). A stored SIP password is only reused while address and user name stay the same, so it cannot be redirected to another server.
- SIP and RTP run unencrypted over UDP to the phone system in the LAN.
- Credentials are stored in plain text in the data folder: SIP password and OpenAI key in `.env`, mail password and OAuth secret in `settings.json`, the OAuth token in `mail-token.json`. Call logs, contacts and the log contain phone numbers and call content. The data folder is the project folder or `%APPDATA%\SIPFunk`; protect it like a mailbox (user account with a password, disk encryption, encrypted backups).
- Call audio and text go to OpenAI, notifications to your mail provider and, if the lookup is switched on, the caller's number to tellows.
- What callers say is call content to the AI, not an instruction. The AI can only hang up, put the owner through to the caller during the call back, and flag a call as spam; it cannot dial numbers. The dial target protection (emergency, special, premium-rate and international numbers) and the call time limit are enforced in the core, not by the model.

## Reporting a vulnerability

Please do not open a public issue. Use the private reporting feature of the platform hosting the repository (on GitHub: "Security → Report a vulnerability"). Describe how to reproduce the problem, and do not include real phone numbers, credentials or call content.

There are no guaranteed response times and no bounty programme. Only the current state of the main branch is supported.

## If credentials have leaked

Change the SIP password in the phone system, revoke and recreate the OpenAI key, change the mailbox's app password or remove the OAuth access at the provider and delete `mail-token.json`.
