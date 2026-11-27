# SIPFunk – Privacy Policy

Deutsch: [privacy.de.md](privacy.de.md)

As of November 2026. Applies to SIPFunk from the Microsoft Store and from the GitHub releases. Where this translation and the German version differ, the German version is the original.

## In short

SIPFunk runs entirely on your computer. The publisher of SIPFunk runs no server, collects no data, does not measure usage and sees nothing of what you do with SIPFunk. Data leaves your computer only towards the services you set up and switch on yourself. Their terms and privacy policies apply to those services.

## What is stored on your computer

In the data folder (`%APPDATA%\SIPFunk`, tray menu "Open data folder"):

- `.env`: credentials for the phone system, the AI provider and, if used, mail, in plain text.
- `settings.json`, `contacts.json`: settings, contacts and notes, including contacts imported from an address book.
- Call logs as text (transcript, summary, result) and the operating log with phone numbers. SIPFunk deletes both after the configured period (default 7 days).

SIPFunk stores no call audio. The data folder is not encrypted; protect your computer accordingly (e.g. BitLocker). Uninstalling leaves the data folder in place so that a reinstallation or the other edition can carry on. You can delete it yourself at any time.

## Where data goes

| Recipient | What | When |
|---|---|---|
| Your phone system (e.g. FRITZ!Box) or SIP provider | phone numbers, call audio | on every call |
| The selected AI provider: OpenAI (USA) or Google Gemini (USA) | live call audio, task, the contact's name and notes, transcript | during every call |
| Your mail provider (Gmail, Microsoft 365 or SMTP server) | summary and shortened conversation | only if mail notification is switched on |
| autoconfig.thunderbird.net (Mozilla) | the domain of your mail address | only while setting up mail, to find the server settings |
| tellows | number of unknown callers | only if the number lookup is switched on (default: off) |
| Google or Microsoft | sign-in and reading your address book | only during the contact import; the data goes straight to SIPFunk, not through the publisher |
| The provider of your AI agent (MCP) | call content as text | only if you connect an AI agent and it makes a call |

The web UI runs only locally on your computer (127.0.0.1) and cannot be reached from the network.

## Microphone

SIPFunk uses the microphone only when you dictate a task in the UI. The recording goes to the selected AI provider to be turned into text and is not stored.

## Artificial intelligence

SIPFunk makes phone calls with a generative voice AI from OpenAI or Google. The AI introduces itself as an AI on the phone. Its answers can be wrong or inappropriate. Report inappropriate content through [GitHub Issues](https://github.com/alorbach/ai-sip-funk/issues) and also to the AI provider concerned.

## Your responsibility

If you use SIPFunk for business, you are responsible for the call data yourself, including towards the people you call or who call you. What that means is described in the [legal notes](legal.md).

## Children

SIPFunk is meant for adults. The AI providers' terms require a minimum age (Gemini API: 18).

## Contact and changes

Privacy questions: [GitHub Issues](https://github.com/alorbach/ai-sip-funk/issues). Changes to this policy are in the version history of this repository.
