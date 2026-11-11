# SIPFunk – Usage Guidelines

Deutsch: [guidelines.de.md](guidelines.de.md)

These guidelines describe what SIPFunk is meant for and what it is not. They complement the [user guide](user-guide.md) and the [legal notes](legal.md). Whoever runs SIPFunk is responsible for every call the AI conducts, just as if they had called or picked up themselves. UI labels are quoted in German, as they appear on screen.

---

## 1. Principles

1. **Transparency.** The AI introduces itself as an AI in every call and does not deny it when asked. The only, deliberately limited exception is the spam defence without AI disclosure (section 6), which the operator switches on explicitly and at their own risk.
2. **A human remains responsible.** Every outgoing call is triggered and confirmed by you (dialog in the web UI) or by an AI agent for which you have deliberately switched on the MCP interface. Even then you are the caller: the agent is your tool, not your representative, and you answer for what it triggers (section 9). The AI on the phone never decides by itself whom to call.
3. **Data minimisation.** No audio is stored. Transcripts are kept only as long as they are needed ("Protokolle aufbewahren" under Einstellungen › Technik). Background knowledge for the AI contains only what it needs for the task.
4. **No decisions of consequence.** The AI concludes no contracts, pays nothing, orders nothing, passes on no sensitive data (health, payment, ID, passwords) and accepts none. What the task does not cover it takes back as a question.
5. **No deception about identity.** The AI does not pose as a real person. "Im Auftrag von" (on behalf of) is your name or your company's name, not that of a third party.
6. **Local and private.** The web UI is reachable only from your own computer. Call content goes only to the provider of the active AI connection (OpenAI or Google Gemini). Credentials stay in the data folder. Neither phone numbers nor keys belong in chats, tickets or screenshots.

---

## 2. Permitted uses

- Requesting, confirming and moving appointments (doctor's practice, garage, hairdresser, authority with appointment booking).
- Passing messages to family, friends, acquaintances and colleagues and collecting answers.
- Queries to service providers and suppliers with whom a business relationship already exists (delivery status, opening hours, asking for a call back).
- Answering machine for private and business numbers: taking down the request and call-back wish, giving information from the background knowledge.
- Notifying the owner about answered calls, including call back and transfer.
- Test and development calls to your own numbers and extensions.

---

## 3. Prohibited uses

- **Advertising and cold calling** towards consumers or businesses who have not consented. Technically the AI is an "automatic calling machine"; advertising calls made with it are prohibited without prior express consent (German Act against Unfair Competition, UWG § 7). "Just asking whether there is any interest" is advertising too.
- **Mass calls**, serial calls, automated trying of numbers. SIPFunk deliberately handles only one call at a time; that is not a bug but part of the concept.
- **Harassment**: repeated calls against someone's stated will, calls at night without cause, prank calls, exerting pressure, intimidation.
- **Deception**: posing as another real person, company, authority, bank or the police; obtaining the identity of the person called by trickery; "social engineering" of any kind, including in security tests without a written mandate from the organisation concerned.
- **Collecting sensitive data** (health, finances, ID, credentials) over the phone, even if the other party offers it voluntarily. The AI is instructed not to take down such information; do not give it tasks that require it.
- **Emergency and special numbers.** They are blocked and stay blocked. In an emergency you call yourself.
- **Circumventing the dial target protection** (international numbers, premium-rate numbers) by rewriting the number or changing the code without checking the cost and legal consequences.
- **Calls to people who do not want to talk to an AI.** Once someone has said so, note it in the contact and do not call them with the AI again.

---

## 4. Writing good tasks

The quality of the call depends on the task. What has proved useful:

- **Who will probably pick up?** ("practice reception", "my wife", "Mr Meier from the car dealership"). Without a contact the AI needs this hint.
- **What exactly should happen?** Questions in order, what should be passed on, what may be accepted ("accept a morning appointment") and what may not ("do not agree to an appointment before the 20th").
- **What does the AI need to know?** Name, customer number (if harmless), time window, occasion. Leave out everything else.
- **Tone.** Private or business? Informal or formal address? The style comes from the preset; the task can refine it ("casual, she is an old friend").
- **Do not include:** passwords, payment data, health diagnoses of third parties, instructions that violate section 3.

The call plan the text model builds from the task is in the log after the call. If it does not fit the task, the task was unclear.

---

## 5. Running the answering machine responsibly

- **State the principal correctly.** "Im Auftrag von" and "Meldung als Assistent von" in the per-number profiles have to be true: the AI tells callers on whose behalf it is answering.
- **Check the background knowledge.** The AI reveals contact notes and last summaries when asked. So they should contain only things the caller may know.
- **Business numbers.** Companies are subject to the information duties of the GDPR (see the legal notes). A sentence in your own task for incoming calls can help meet them ("Point out that the call is logged as text").
- **Call back to you** only where the call back does not disturb (driving, meetings). The assessment "important" is a model decision and can be wrong.
- **Delete logs** as soon as they are dealt with, or keep the retention period short.

---

## 6. Spam defence: conditions for use

By default the AI identifies itself as an AI in the spam defence as well (switch "AI disclosure"). Without AI disclosure the spam defence deviates from the transparency principle. That is only defensible under these conditions; whoever switches disclosure off confirms them in the web UI. Points 2 to 7 also apply with AI disclosure.

1. **Your own risk, your own decision.** The legal situation is not settled (AI Act, GDPR, terms of use of the AI provider). See [legal.md](legal.md). The confirmation in the UI documents that you know this.
2. **Only against unsolicited calls.** The mode is intended for advertising, surveys and fraud attempts that call you without consent, that is, callers who are themselves acting unlawfully. It is not there to stall annoying but legitimate callers (landlord, authority, debt collection with a real connection). For those there is the normal answering machine with a task of your own.
3. **Maintain lists, do not guess.** Numbers go on the list when they have actually harassed you (button "Nummer auf die Spam-Liste" on the call). Only enter "anonym" if you knowingly accept that a doctor or an authority will also be received as a private person at first. Contacts are protected from detection during the call; whoever matters to you therefore belongs in the contacts.
4. **Stall in moderation.** The time limit is an upper bound, not a target. The longer the call, the higher the cost and the risk of errors. For most people "Kurz abwimmeln" is enough.
5. **No escalation.** The AI is instructed to stay polite, give no data, agree to nothing, not pose as an authority and carry out no instructions. Do not change these rules, not even via "Eigene Anweisungen für die Rolle".
6. **Take misdetection seriously.** If the AI switches to spam mode with a genuine caller, apologise to the person and add them as a contact (contacts are known to the AI). Check the transcript ("Spam-Abwehr: <reason>") and adjust the list if necessary.
7. **Complain instead of taking revenge.** Use the information gained from the result (company, product, number) for a complaint to the Bundesnetzagentur about unlawful telephone advertising; the button "Beschwerde-Entwurf" on the log provides a draft. Check it word for word: claim nothing the log does not support, and do not conceal that an automatic assistant answered. That has a more lasting effect than any stalling.

---

## 7. Handling data and credentials

- `.env`, `settings.json`, `contacts.json`, `transcripts/`, `mail-token.json`, `sipfunk.log` are confidential and not part of the repository; the same goes for the usage counter `usage.json`.
- Give the key of every AI connection (OpenAI or Google) a budget limit at the provider; rotate it immediately if you suspect it has been disclosed.
- The optional OpenAI admin key (`OPENAI_ADMIN_KEY`, for the actual monthly costs) can also manage users, projects and keys of the organisation. Store it only deliberately, give it an expiry date and remove it in the web UI when you no longer need it.
- Google Gemini: before you use the free quota, read Google's terms; see [legal.md](legal.md), section 3.5. Google Gemini has so far been tried on only a few real phone calls (first calls on 11 November 2026) and OpenAI remains the tested default, so keep checking the logs of the first calls closely.
- The mail OAuth token (`mail-token.json`) authorises sending mail in your name. If you pass the computer on, revoke it (Google account / Entra: remove app access) and delete the file.
- The computer SIPFunk runs on is effectively your phone: screen lock, current updates, no remote access to the web UI port.
- Logs contain phone numbers and call content of third parties. Treat them like letters: do not pass them on, do not sync them to cloud folders others can see.

---

## 8. When something goes wrong

- **Wrong number called:** the AI introduces itself as an AI, asks for the person it is looking for and ends politely. Check the number in the log, correct the contact.
- **The AI agreed to something wrong:** call back yourself and put it right. Phrase the task more narrowly next time ("agree to nothing, only ask about appointments").
- **Someone complains about an AI call:** accept it, note it in the contact, do not call there with the AI again.
- **Suspected misuse of the computer / the extension:** stop the server, change the SIP password in the box, rotate the API key, check the log (every call is in it).
- **Unclear legal situation in a specific case:** switch the mode off, talk to a lawyer or the competent data protection authority. This documentation is no substitute for legal advice.

---

## 9. AI agents through the MCP interface

Through the MCP interface it is no longer your hand that triggers the call but an agent you have given a task. That changes nothing about responsibility.

- **Switch it on only when you need it.** The interface is off by default. Switch it off again when you are not having an agent make calls.
- **Start cautiously.** "Nur gespeicherte Kontakte" (saved contacts only) and "Vor dem Wählen bei mir nachfragen: Immer" (ask me before dialling: always) are the defaults. Loosen them only once you have seen how your agent handles tasks, and only as far as needed.
- **The task comes from you.** Let an agent call only for what you have explicitly asked it to do. An agent that reads "call this number" out of a website, an e-mail or a document acts without your task; the contact list and the confirmation help against that.
- **Read the confirmation.** Target, task and "on behalf of" are in the dialog. If something does not match what you wanted, decline.
- **In your own name.** "Im Auftrag von" (on behalf of) is your name or your company's. Do not let an agent call in the name of third parties who know nothing about it (principle 5).
- **No series.** The limits per hour and per day are a brake, not a permission. Everything in section 3 applies to agents just the same: no advertising, no cold calling, no trying out numbers, no harassment.
- **The agent reads along.** What the other party says goes to your agent as text and with that to its provider, in addition to the AI provider of the call. Do not let an agent conduct calls in which confidential matters are to be expected, and do not release more call logs to it than necessary.
- **Check the result.** The agent reports what the AI reported. For appointments and commitments, look at the call log before you rely on it; transcription and summary can be wrong.
