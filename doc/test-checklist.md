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
- [ ] OpenAI key: an invalid key is rejected, a valid one is saved; afterwards "KI-Gespräch" can be selected. Neither value is ever shown again.
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
