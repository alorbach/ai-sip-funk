# SIPFunk – Architecture

Deutsch: [architecture.de.md](architecture.de.md)

An overview for anyone who wants to read or change the code. Usage is covered in the [user guide](user-guide.md). Code comments, log messages and the instructions given to the AI are German.

## Basic idea

```
Web UI / tray / MCP ──HTTP, WebSocket──▶ Node process (one call at a time)
                                          │
        FRITZ!Box ◀──SIP over UDP────────┤ SipClient      registration, INVITE, BYE, REFER
        (phone network) ◀──RTP, G.711───┤ RtpSession     20 ms pacing, 8 or 16 kHz
                                          │
        AI provider, live ◀──WebSocket──┤ RealtimeBridge call logic, tools, transcript
        (OpenAI Realtime / Gemini Live)   │   LiveSession  provider adapter: wire protocol, PCM16
        AI provider, text ◀──HTTPS──────┘ plan, summary, assessment, complaint
```

SIPFunk registers with the box as an IP phone and passes the call audio through to the live speech model of the active AI connection's provider (OpenAI Realtime API or Gemini Live API). SIP, RTP and G.711 are implemented in-house, deliberately only as far as a FRITZ!Box extension needs; there is no native dependency. Runtime dependencies are `ws`, `nodemailer`, `zod` and the MCP SDK.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/main.ts` | entry point: loads the configuration, wires everything together, builds the audio handler per call, notifications after the call |
| `src/config.ts`, `src/settings.ts` | read `.env`; web UI settings (`settings.json`), per-number profiles, notification rules, enabling of the spam defence |
| `src/setup.ts`, `src/envFile.ts` | setup assistant: check SIP credentials (test registration with a short-lived client) and the key of the AI provider, write single keys to `.env` without touching the rest; `CallManager.reconfigureSip` then replaces the SIP client at runtime |
| `public/i18n.js`, `public/i18n-en.js` | language of the interface: the pages carry the German texts; for English a MutationObserver replaces them from the dictionary (exact texts and patterns). Content from people and from the server is marked `data-no-i18n`. `test/i18n.test.ts` checks that every dictionary key still exists in the German sources |
| `src/callManager.ts` | state machine for exactly one call: registration, dialling, answering, limit, hanging up, transfer |
| `src/dialPolicy.ts` | dial target protection (blocked number ranges) |
| `src/sip/` | SIP over UDP: messages, digest authentication, SDP, client with incoming and outgoing calls |
| `src/rtp/` | RTP session, G.711 (A-law/µ-law), resampler, test tone and echo |
| `src/ai/realtimeBridge.ts` | bridge between phone audio and the live speech model, provider-independent call logic only: greeting, interruption check, watchdogs, goodbye and hang-up, transcript, tool calls, resampling to the sample rate of the session. Talks to a `LiveSession` |
| `src/ai/providers/types.ts` | what SIPFunk needs from an AI provider: the interfaces `AiProvider` (key check, model list, text model, voice sample, live connection), `LiveSession` (commands of the bridge) and `LiveEvents` (events to the bridge) |
| `src/ai/connections.ts` | AI connections: the list of connections (id, name, provider, voice model, text model, default voice), the `.env` variable that holds the key of each connection, checking a list coming from the web UI, and the carry-over of earlier settings (selected provider, models) |
| `src/ai/providers/index.ts` | `PROVIDERS` and `resolveAi`: resolves the active connection (or the one named) into provider, key, models and call limit, derived from the settings and `.env` |
| `src/ai/providers/openai.ts`, `openaiLive.ts` | OpenAI: Responses API for text, speech output for voice samples; adapter for the Realtime API (WebSocket, PCM16 at 24 kHz in both directions) |
| `src/ai/providers/gemini.ts`, `geminiLive.ts` | Google Gemini: `generateContent` for text, speech output for voice samples; adapter for the Gemini Live API (WebSocket, PCM16 at 16 kHz in, 24 kHz out). The header comment of `geminiLive.ts` lists the differences to OpenAI Realtime |
| `src/ai/connectionTest.ts` | "Verbindung testen" (test connection) for a connection: key, voice model, live connection |
| `src/usageCounter.ts` | monthly usage per provider in `usage.json`; optional query of the actual costs of the OpenAI organisation |
| `src/ai/personas.ts`, `scam.ts`, `plan.ts` | system instructions: assistant, spam role, call plan |
| `src/ai/summary.ts`, `assess.ts`, `complaint.ts`, `farewell.ts`, `pricing.ts`, `voiceSample.ts` | summary, assessment, complaint draft, goodbye detection, cost estimate, voice samples |
| `src/spamCheck.ts` | assessment of the caller's number while ringing, optional tellows lookup |
| `src/notify/` | e-mail (SMTP, OAuth), auto-configuration, mail format and templates |
| `src/contacts.ts`, `src/transcripts.ts` | contacts and call logs as files |
| `src/web/server.ts` | HTTP API and WebSocket for the web UI, bound to 127.0.0.1 |
| `src/mcp/gateway.ts` | MCP gateway: permissions, confirmation, limits, the agent's call as a sequence of events |
| `src/mcp/tools.ts`, `http.ts`, `server.ts` | the MCP tools; Streamable HTTP under `/mcp` on the web UI listener; stdio process that passes every call to the running app |
| `src/ai/agentCall.ts` | texts for agent calls: rules in the system instruction, the tool `ask_principal`, directions |
| `src/sim/simulate.ts` | conversation simulator in text mode |
| `src/tools/test-call.ts` | command-line test for SIP and audio without AI |
| `public/` | web UI (a single HTML file without a build step) and the pop-up shown while ringing |
| `electron/main.cjs` | tray app: starts the server as a child process, menu, notifications, pop-up |
| `personas/` | style presets as text files |
| `test/` | tests with the Node test runner against a simulated phone system on localhost |

## Telephony

- **Registration**: `REGISTER` with digest authentication, renewed periodically; if it fails, it is retried every 30 s.
- **Outgoing**: `INVITE` with an SDP offer, `ACK`, `BYE` in both directions, `CANCEL` when aborting before the call is answered.
- **Incoming**: the own number that was dialled comes from `P-Called-Party-ID` (fallback: the To address). If the answering machine is off, the extension only rings along; if the line is in use, it answers "busy"; otherwise the call is answered after the configured number of rings (5 s per ring).
- **Transfer**: `REFER` to the box; it connects the owner with the caller and ends the call with SIPFunk.
- **Codec**: G.711. The FRITZ!Box additionally offers it at 16 kHz (dynamic payload types); SIPFunk prefers this HD variant and falls back to 8 kHz. Packet size and timestamp step are taken over from the remote side.

## Realtime bridge

`RealtimeBridge` holds only the call logic that does not depend on the provider and talks to a `LiveSession` (`src/ai/providers/types.ts`); the adapter of the provider translates between that interface and the wire protocol. A polyphase resampler converts between the phone sample rate and the rates of the session (OpenAI: PCM16 at 24 kHz in both directions; Gemini: 16 kHz in, 24 kHz out). The bridge takes care of what a speech model does not get right on the phone by itself:

- **Buffering**: the model delivers audio faster than real time. The output is buffered and played at a 20 ms pace, with a short pre-buffer against choppy sentence starts.
- **Interruption**: when the other party speaks, the output pauses. Only when the transcription shows content is the rest discarded; for a noise or a listening sound the AI keeps talking.
- **Ending**: the model calls `end_call` with the result and open points. For outgoing calls with a call plan, the first call is returned with a self-check against the plan steps. The goodbye is requested by the code; a listening phase follows in which content from the other party continues the call.
- **Watchdogs**: if no audio arrives after a request, or everything stays silent after the output has ended, the bridge triggers a response.
- **Role switch**: on `flag_spam` the bridge swaps the instruction and the tool list in the running session (`LiveSession.update`).

The system instruction is assembled per call: fixed ground rules, style preset, form of address, name, task, call plan, background knowledge. Ground rules take precedence over anything the user enters.

## AI providers and connections

An AI connection (`src/ai/connections.ts`) is a named access to a provider: id, name, provider, voice model, text model and default voice. The list is stored in `settings.json` as `aiConnections` (a JSON list of `{id, name, provider, model, textModel, voice}`, at most 12), the id of the active one as `aiConnection`. As long as no list is stored, there is one connection per provider (`openai`, `gemini`), and the earlier settings are carried over: the previously selected provider decides which one is active, and its models go into its connection. `aiProvider` now just mirrors the provider of the active connection; `AI_PROVIDER` in `.env` still picks the initial one.

The active connection does everything: the call, call plan, summary, assessment, complaint draft and voice samples. `resolveAi` resolves the active connection (or the one named) into the provider together with the key from `.env`, the models and the call limit. The two built-in connections keep `OPENAI_API_KEY` and `GEMINI_API_KEY`; every further connection uses `AI_KEY_<ID>` (the id in upper case). An empty model, or one that belongs to another provider, means the provider default (`OPENAI_MODEL`, `OPENAI_SUMMARY_MODEL`, `GEMINI_MODEL`, `GEMINI_SUMMARY_MODEL` or the built-in default). A call started through the API may name a voice model; one of another provider is ignored. The voice of a call follows an order of precedence in which each level only counts if the voice belongs to the provider of the active connection: the voice of the spam role (if the spam role is certain at pick-up), the voice chosen for the call (dashboard field or `voice` through the API or MCP, otherwise the voice of the contact or of the own number), the default voice of the active connection, and for a connection without one the former general voice (`AI_VOICE` or the previously saved value), otherwise the provider's first voice. The provider of an existing connection cannot be changed, because its stored key would otherwise go to another provider. Removing a connection deletes its key from `.env`; at least one connection has to remain.

Keys reach `.env` through the local web UI, are checked once with the provider and are never returned or logged. Changes to connections are saved at once, without the save button of the settings page; key, connection test and model list each refer to one connection, and the model list is cached per connection. Monthly usage is counted per provider, not per connection.

The Gemini Live API differs from OpenAI Realtime in ways the adapter can only partly hide:

- **No instruction per answer, no "request an answer".** When the AI is to speak of its own accord (greeting, watchdog, goodbye), it receives a text turn marked as a stage direction of the app ("[Regie]"); the system instruction explains the marker.
- **System instruction and tools are fixed for the whole connection.** New instructions (a late call plan, the switch into the spam defence) are sent as stage directions as well, which is weaker than a system instruction.
- **No truncating, deleting or cancelling.** These commands of the bridge have no effect; on an interruption Google's server decides what stays in the conversation.
- **Transcription in fragments.** An utterance of the other party counts as finished when no fragment has arrived for a short time.
- **Not available:** speaking rate (passed as a hint only) and the limit on output tokens.
- **Call length.** The Live API drops a connection after about ten minutes; `maxCallSeconds` of the provider caps calls at 540 s.

Besides the automated tests against simulated connections, the Gemini adapter has so far been tried on only a few real phone calls: the first three ran on 11 November 2026 (two on the answering machine, one call back to the owner) and went through without errors. OpenAI remains the tested default. Protocol details follow Google's documentation as of 11 November 2026.

## MCP: calls by AI agents

An agent never talks to the phone itself. The voice AI conducts the call as usual (guided operation); the agent reads along and steers. Word-for-word operation was rejected: an agent needs several seconds per move, and neither provider can be forced to stay silent until text arrives.

- **One place decides.** Every tool call ends in `McpGateway.run()`, whether it arrives over Streamable HTTP (`/mcp`, stateless, one server and transport per request, JSON answers) or from the stdio process (`POST /api/mcp/call`). The stdio process holds no logic and no permissions.
- **Policy** (`mcpPolicyFrom()` in `settings.ts`): main switch (off by default, no `.env` switch), targets (contacts only or any number the dial target protection allows), confirmation (always, numbers without a contact, never), calls per hour and per day (counted in memory per accepted request), maximum length per call.
- **A call as events.** The gateway keeps the agent's one call with a state (`awaiting_approval`, `dialing`, `ringing`, `connected`, `ended`) and numbered events (state, other party, AI, question, note). `wait_for_events` blocks until a new event or a timeout, so the agent does not poll. `main.ts` feeds line phase, final transcript entries and the end of the call into the gateway.
- **Steering.** `say` becomes `RealtimeBridge.agentSay()`: a note in the conversation (`LiveSession.note`) plus a requested answer that never interrupts a running one. The voice AI gets the extra tool `ask_principal`; while a question is open the stall watchdog is silent, the agent's next `say` is returned as the tool result, and after 25 seconds without an answer the AI carries on. `end_call` asks the AI to finish through the normal `end_call` path, or hangs up at once.
- **Identity.** The agent supplies task, background knowledge, style, form of address and optionally on whose behalf (one line; if it differs from the name in the settings, the operator always has to confirm). Name of the AI, voice (the contact's, otherwise the default voice of the connection), model and the additional behaviour notes always come from the operator's settings. In a call to the operator's own owner number the introduction without the AI explanation applies as usual. The rules for agent calls are part of the system instruction (`AGENT_CALL_RULES`), including that no direction can lift the AI disclosure.
- **What leaves the app.** Texts only. Contact names only with permission or when the agent named the contact itself, numbers of contacts never, call logs of other calls only with permission. The web UI gets the pending request with the number, because only the operator sees it. Because the agent reads along what the voice AI says, in agent calls the AI does not get the contact's notes as background knowledge, and from the history only the last summary the agent itself would be allowed to read (`contactContext` in `main.ts`).

## Where rules are enforced

What must not go wrong is decided by the code, not by the model:

- Dial target protection and call time limit in the `CallManager` and in `dialPolicy.ts`; they apply to the web UI and MCP alike.
- What an agent may do over MCP is decided in `McpGateway` (switch, targets, confirmation, limits, maximum length), not in the agent and not in the stdio process. The local API itself has no login: a program that can send HTTP requests on this computer can bypass MCP altogether (see SECURITY).
- The AI has no tool for dialling. Transfer exists only in the call back to the owner and only to the number of the original caller.
- The spam defence only takes effect with AI disclosure switched on or with a stored risk confirmation (`scamAllowed()` and `scamActive()` in `settings.ts`); saving without either switches it off. The time limit is enforced by a timer in the server.
- Contacts are exempt from spam detection during the call: for them `flag_spam` is not in the tool list at all.
- Passwords leave the API only masked. Keys of the AI connections are never returned; the API only reports whether one is stored.

## Data

Everything is stored as files in the data folder (project folder or `SIPFUNK_DATA_DIR`): `.env`, `settings.json`, `contacts.json`, `transcripts/` (JSON and Markdown per call), `mail-token.json`, `usage.json` (monthly usage per AI provider, kept for 13 months), `voice-samples/`. There is no database. Logs are deleted at start and periodically afterwards according to the retention period. Audio is never stored.

## Tray app

`electron/main.cjs` starts the built server (`dist/main.js`) as a child process and receives its state via IPC. The tray app contains no call logic of its own; it shows the menu, notifications and the pop-up while ringing (`public/ring.html`) and writes the log to a file.

## Decisions and rejected approaches

- **Own SIP client instead of a SIP trunk to OpenAI.** A FRITZ!Box extension is not a trunk; OpenAI's documented SIP route would have required an additional provider and a publicly reachable webhook.
- **Own SIP/RTP implementation instead of a native library.** Avoids native builds on Windows and licensing questions; the price is a small feature set (UDP only, G.711 only, no SRTP, no DTMF).
- **PCM to the API instead of G.711.** Allows HD audio to the box and uniform processing; costs a resampler.
- **Call plan by a text model.** The Realtime model speaks well but plans poorly: without a plan it completed multi-part tasks only partially. There is no plan for the answering machine and the call back; there it slowed things down.
- **Goodbye in code.** Left to the model, it spoke and hung up in the same breath, or announced the end without hanging up.
- **No notification of the phones connected to the box.** The box accepts SIP text messages, the phones do not display them.
- **No security architecture beyond "local only".** One user, one computer; the web UI is bound to 127.0.0.1 and therefore has no login (see [SECURITY.md](../SECURITY.md)).

## Not implemented

Touch tones (DTMF) and phone menus, taking over the call by microphone, several simultaneous calls, session resumption with Gemini for calls longer than nine minutes, the simulator with Gemini, importing contacts from the box, retrying when nobody answers, languages other than German.
