# SIPFunk – Manual Test Checklist

Deutsch: [test-checklist.de.md](test-checklist.de.md)

The automatic tests (`npm test`) run against a simulated phone system and check neither real audio nor the behaviour of the speech model. This list describes what can only be checked on a real line. It is ordered so that as much as possible can be done in one pass; look things up in the log and on the "Anrufe" (calls) page. UI labels are quoted in German, as they appear on screen.

Test only with your own numbers and extensions or with people who are in on it.

## 0. Preparation

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] The tray app is running with the current build (`npm run tray`); the status shows the registration and "Anrufbeantworter an".
- [ ] A contact flagged "Inhaber" (your own mobile number) exists; "Mich auf der Inhabernummer anrufen" is on.
- [ ] Quiet surroundings (voice detection reacts to background noise).

## 1. Basic function without AI

- [ ] First start with an empty data folder: the web UI opens the setup assistant; a wrong password is rejected with a clear sentence and nothing is saved; with the right one the header switches to "Telefonanlage verbunden" without a restart.
- [ ] Step "KI-Verbindung" (AI connection) with the connection "OpenAI": an invalid key is rejected, a valid one is saved; afterwards "KI-Gespräch" can be selected. Neither value is ever shown again.
- [ ] Settings as tabs: a click in the section list on the left shows only the card of that section; after reloading the page the same section is open; "Technik" is only offered in "Erweitert". A value changed in one section and one changed in another are both saved by a single "Speichern" (or Ctrl+S).
- [ ] After an update from a version without connections: "Einstellungen › KI-Verbindungen" lists "OpenAI" and "Google Gemini", the previously selected provider is "✓ aktiv", its models are still set, and it speaks with the previously saved voice.
- [ ] Expandable list: when first opened, the active connection is expanded. A click on a row (or Enter or the space bar) expands it, a second one collapses it; two connections can be open at the same time. A key that is typed but not saved yet stays in place when you expand and collapse another connection.
- [ ] "Einstellungen › KI-Verbindungen", connection "OpenAI", "Verbindung testen" (test connection): three lines (Schlüssel, Sprachmodell, Live-Verbindung), all passed. As long as this connection has no stored key, the button cannot be pressed.
- [ ] Gemini key: expand the connection "Google Gemini" under "KI-Verbindungen"; an invalid key is rejected, a valid one from Google AI Studio is saved ("Schlüssel prüfen und speichern"). The card then shows that a key is stored, the key itself is never shown again, and `.env` contains `GEMINI_API_KEY`.
- [ ] "Verbindung testen" with the connection "Google Gemini": all three lines passed. This is the first real connection to Google; it does not test a phone call.
- [ ] Switching the connection: after "Diese Verbindung verwenden" (use this connection) on "Google Gemini" the message names the voice that now applies; the field "Stimme" (voice) on the dashboard shows the Gemini voices (e.g. Kore) and is set to "– Standard: … –", the voice model of the connection is `gemini-3.8-live`, and the notes "Was mit Gemini anders ist" and on the free quota appear while the Gemini connection is active or expanded. After switching back to "OpenAI" its default voice and models apply again.
- [ ] Default voice: choose another "Standardstimme" (default voice) on a connection (applies without "Speichern"); "Probe hören" (listen to a sample) next to it plays the voices of its provider, even if the connection is not active. The next call over this connection uses the voice; a voice chosen on the dashboard applies only to the next call from there, and "Als Standard speichern" (save as default) does not remember it.
- [ ] Second connection: "Neue Verbindung bei" OpenAI → "Verbindung hinzufügen" (add connection) creates a third entry without "Speichern"; give it a name. Its provider cannot be changed.
- [ ] Key of the second connection: an invalid key is rejected, a valid one is saved; the tag "Schlüssel fehlt" (key missing) on its row disappears, and `.env` contains a new line `AI_KEY_<ID>`. The key of the connection "OpenAI" (`OPENAI_API_KEY`) is unchanged.
- [ ] Models of the second connection: "Modelle aktualisieren" (refresh models) loads the list with its key; choose another voice model (e.g. a cheaper one) and a text model. The connection "OpenAI" keeps its own models. In "Erweitert" a custom model ID of the other provider is rejected.
- [ ] Switching on the dashboard: choose the second connection in the field "KI-Verbindung"; the message names it as active, the card marks it "✓ aktiv", and the next AI call uses its model (the log of the call shows provider and model).
- [ ] Removing: "Verbindung entfernen" (remove connection) on the second connection asks for confirmation; afterwards it is gone from the card and from the dashboard, the line `AI_KEY_<ID>` in `.env` no longer contains a key, and another connection is active. With only one connection left, the button is disabled.
- [ ] "Verbrauch in diesem Monat" (usage this month): after an AI call the line of the provider used counts one call more, whichever connection of that provider handled it; `usage.json` exists in the data folder.
- [ ] Last step: the echo test call to your own extension rings and you hear yourself.
- [ ] Installed tray app, first start: the browser opens with the assistant; "Server neu starten" and "Beenden" during a call hang up the call.
- [ ] Switch "Einfach / Erweitert": applies at once; a technical value changed in "Erweitert" is still there after switching back and saving something else in "Einfach".
- [ ] Language: "Sprache" → "English" reloads the page in English; the tray menu is English after it is opened again; the pop-up while ringing appears in English.

- [ ] `npm run test-call -- **610` (your own internal extension): the phone rings, the beep is audible.
- [ ] With `--echo`: what you say comes back after one second.
- [ ] Hanging up works from both sides.

## 2. Outgoing AI call

From the dashboard, call your own mobile number or an internal extension with a two-part task.

- [ ] The confirmation dialog shows the number; only "Jetzt wählen" starts the call.
- [ ] The AI introduces itself, works through both parts of the task and hangs up itself after saying goodbye.
- [ ] Interrupting works; a cough or "mhm" does not cut the sentence off.
- [ ] The transcript runs live; "Mithören" plays both sides.
- [ ] The log contains call plan, result according to the AI, summary and cost.
- [ ] A blocked number (e.g. 0900 …) is rejected.

## 3. Answering machine

From a second phone, call your own number, wait for the number of rings, state a normal request ("I wanted to ask whether tomorrow's appointment is still on, please call back").

- [ ] Greeting "Hallo?" without crackling or dropouts; the log shows the negotiated codec.
- [ ] The AI introduces itself as an AI assistant exactly once, takes down the request and call-back wish and asks nothing superfluous.
- [ ] The announcement matches the number dialled (profile "Person" or "Firma").
- [ ] After the goodbye it hangs up within a few seconds.
- [ ] No long silence in mid-call; if there is one, the AI continues by itself after the stall watchdog time (log: "Stillstand").
- [ ] With the profile set to "Nur klingeln lassen" or a different number of rings, only this number behaves differently.

## 4. Assessment and notification

Directly after item 3.

- [ ] The tray notification appears with a readable title.
- [ ] The log shows the assessment with a short reason; nothing is wrongly tagged "Spam-Abwehr".
- [ ] The e-mail arrives: subject, blocks and short version are correct (first "Verbindung prüfen" and "Probe-Mail senden").
- [ ] For "important": the call back comes, the AI reports in one go and gives the complete call-back number.
- [ ] "Verbinde mich" puts you through to the caller; without this request the AI says a brief goodbye.

## 5. Pop-up while ringing

- [ ] While ringing, the window appears at the bottom right with caller, line and assessment.
- [ ] "Klingeln lassen": the AI does not answer.
- [ ] "KI jetzt annehmen": answered immediately, without waiting for the number of rings.
- [ ] "In die Spam-Falle" (after the risk confirmation): answered immediately as a private person, log tagged "Spam-Abwehr".
- [ ] With the tellows lookup switched on and a number that is not a contact: the score appears after a short time.

## 6. Spam defence

Read [legal.md](legal.md), section 6, first. Detection during the call is disabled for contacts; this part therefore needs a phone whose number is not in the contacts, or the simulator (`npm run sim -- strom bank`). The list match also works with a contact.

- [ ] Switch on: the dialog only appears the first time, afterwards the date is shown next to the switch.
- [ ] Set `"scamMode": "on"` in `settings.json` by hand without `scamAccepted`, restart: the web UI shows "off".
- [ ] AI disclosure on, defence on (no confirmation dialog): spam call from the list – the AI introduces itself as an AI assistant, gives no name and fends the caller off.
- [ ] AI disclosure off: red warning box visible; the dialog appears, "Abbrechen" (cancel) puts the switch back.
- [ ] **Detection during the call** (list empty, play an advertising call): greeting as AI assistant at first, after a sentence or two of advertising a switch to the private person without mentioning AI; no consent, no data; the transcript contains "Spam-Abwehr: <reason>"; no call back.
- [ ] **List match** (own mobile number on the list): greeting as a private person right away, with the role's name, voice and rate.
- [ ] **Switch back** (number on the list, state a genuine request): the AI switches to assistant mode, introduces itself as an AI and takes down the request.
- [ ] **Stalling** (behaviour "Hinhalten", limit 1 minute): the AI asks questions, agrees to nothing, and after about 60 s the server hangs up.
- [ ] "Nummer auf die Spam-Liste" on an incoming call: confirmation, entry appears, button disappears.
- [ ] "Beschwerde-Entwurf" on a spam log: the content matches the log, nothing is made up.
- [ ] Afterwards remove your own number from the list and reset the behaviour.

## 7. Simulator

- [ ] `npm run sim` runs through; the reports in `sim-results/` show no serious errors (data given, "yes" said, AI mentioned in spam mode).

## 8. Distribution and MCP

- [ ] `npm run dist:win`: installer on a fresh Windows user (installation, first start with `.env`, autostart, uninstallation).
- [ ] MCP: from a client `get_status`, then `start_call` to one of your own extensions and `wait_for_call`.

## 9. Google Gemini: real phone calls (only a few so far)

**Status.** The Gemini path has so far been tried on only a few real phone calls: on 11 November 2026 the first three (two on the answering machine, one call back to the owner) went through without errors; the introduction as an AI, the task, the goodbye and hanging up all worked. The items below stay open for further calls. Expand the connection "Google Gemini" under "Einstellungen › KI-Verbindungen" and make it the active one ("Diese Verbindung verwenden"), then:

- [ ] **Outgoing** (as in section 2): the AI greets, works through a two-part task, the transcript shows both sides, and the log contains provider, model, call plan, result and cost estimate.
- [ ] **Answering machine** (as in section 3): "Hallo?", one introduction as AI assistant, request and call-back wish taken down.
- [ ] **Interruption**: cutting in stops the AI and it responds to what was said; note how often a mere "mhm" or a cough cuts the sentence off.
- [ ] **`end_call`**: the AI says goodbye, hangs up itself, and result and open points are in the log; something of substance said during the listening phase continues the call.
- [ ] **9-minute cap**: with "Gesprächslimit" set above 540 s, the call is ended after nine minutes at the latest.
