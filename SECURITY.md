# Security

**English** · [Deutsch](SECURITY.de.md)

## Threat model

SIPFunk is meant for a single user on their own computer in their own home or office network. That determines what the program protects and what it does not:

- The web UI and its API are bound to `127.0.0.1` only and have **no login**. Any program running on the same computer under your user account can start calls and read call logs. Other websites open in your browser cannot: API and WebSocket check the host and origin of each request. Do not expose the port (no port forwarding, no reverse proxy, no tunnel).
- The setup assistant and the "KI-Verbindungen" (AI connections) card accept the SIP password and the keys of the AI connections (OpenAI, Google Gemini, optionally the OpenAI admin key) through this local API, check them and write them to `.env`: `OPENAI_API_KEY` and `GEMINI_API_KEY` for the two built-in connections, `AI_KEY_<ID>` for every further connection. Removing a connection deletes its key from `.env`. The API never returns them; it only reports whether a value is stored. Because the API has no login, a program running under your user account could also *replace* these credentials (it cannot read them through the API, but it can read `.env` directly anyway). A stored SIP password is only reused while address and user name stay the same, so it cannot be redirected to another server.
- The MCP interface for AI agents runs over the same local API (`/mcp` and `/api/mcp/…`), is switched off by default and checks inside the program what an agent may do: permitted targets, confirmation before dialling, limits. That protects with agents that have only the MCP tools. An agent that may run arbitrary commands on your computer can, like any other program, address the API directly and bypass these checks (first point). No keys, passwords or settings leave through MCP, apart from the permissions and limits of the interface that `get_status` states; the agent reads along the text of the call.
- SIP and RTP run unencrypted over UDP to the phone system in the LAN.
- Credentials are stored in plain text in the data folder: SIP password and the keys of all AI connections in `.env`, mail password and OAuth secret in `settings.json`, the OAuth token in `mail-token.json`. Call logs, contacts and the log contain phone numbers and call content. The data folder is the project folder or `%APPDATA%\SIPFunk`; protect it like a mailbox (user account with a password, disk encryption, encrypted backups).
- Call audio and text go to the provider of the active AI connection (OpenAI or Google), notifications to your mail provider and, if the lookup is switched on, the caller's number to tellows.
- What callers say is call content to the AI, not an instruction. The AI can only hang up, put the owner through to the caller during the call back, flag a call as spam and, in an agent call, ask the agent a question; it cannot dial numbers. Through that question and the transcript the agent reads along, what is said reaches the agent: for the agent it is likewise content and not a task. The dial target protection (emergency, special, premium-rate and international numbers) and the call time limit are enforced in the core, not by the model.

## Reporting a vulnerability

Please do not open a public issue. Use the private reporting feature of the platform hosting the repository (on GitHub: "Security → Report a vulnerability"). Describe how to reproduce the problem, and do not include real phone numbers, credentials or call content.

There are no guaranteed response times and no bounty programme. Only the current state of the main branch is supported.

## If credentials have leaked

Change the SIP password in the phone system, revoke and recreate the keys of all AI connections at their providers (including a stored OpenAI admin key), change the mailbox's app password or remove the OAuth access at the provider and delete `mail-token.json`.
