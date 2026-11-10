# SIPFunk – Legal Aspects

Deutsch: [legal.de.md](legal.de.md)

Legal research as of November 2026. Frame of reference: operation in Germany, EU law. **This is not legal advice.** The notes were written by a developer, not a lawyer, and may be wrong or outdated. They summarise the relevant rules so that you can assess the risks and ask targeted questions where needed. Laws change; check in particular the transition periods of the AI Act and OpenAI's terms of use at the time you use the software. If you operate SIPFunk outside Germany, other rules apply that are not covered here. Where this translation and the German version differ, the German version is the original.

See also: [Guidelines](guidelines.md) · [User guide](user-guide.md).

---

## 1. Roles and responsibility

SIPFunk is software you run yourself. There is no service provider between you and the people called. Legally you are therefore in all roles at once:

- **Caller or called party** within the meaning of telecommunications and competition law: what the AI says on the phone is attributed to you.
- **Controller** under the GDPR for the processing of the call data (if the GDPR applies at all, section 3).
- **Provider and deployer** of an AI system within the meaning of the AI Act, as far as it applies (section 2), because you assemble the system yourself and use it.

OpenAI processes speech and text on your behalf but is not your contracting party towards the people called. OpenAI is a processor within the meaning of the GDPR only if you have concluded the agreement required for that (section 3.5).

---

## 2. AI Act (Regulation (EU) 2024/1689)

### 2.1 Transparency obligation when interacting with people (Art. 50(1))

AI systems that interact directly with natural persons have to be designed so that the persons are informed that they are interacting with an AI, **unless this is obvious from the circumstances and the context of use to a reasonably well-informed, observant person.** According to the Regulation's timetable the obligation applies from 2 August 2026; check whether interim amendments ("Digital Omnibus") have shifted deadlines.

**Standard operation of SIPFunk:** on every outgoing call the AI expressly introduces itself as an AI assistant and does not deny it when asked. On the answering machine it first answers with just "Hallo?" and identifies itself as an AI assistant in its next turn (after 2.5 s at the latest, unprompted); the notice therefore comes at the beginning, but not in the first word. The call back to yourself omits the explanation because the fact is obvious to you; when asked, the AI says so anyway. By today's understanding this meets the transparency obligation.

**Spam defence:** here the AI deliberately omits the notice at the operator's request (section 6).

### 2.2 Exception for private use (Art. 2(10))

The Regulation does not apply to deployers who are natural persons using AI systems in the course of a **purely personal, non-professional activity**. A private answering machine and private calls fall under this. As soon as SIPFunk answers for a company ("AI assistant of Mustermann IT-Service") or makes business calls, the exception no longer applies.

Whether the provider obligations (you assemble the system yourself) apply in a private context is disputed; the transparency obligation is easy to meet anyway, which is why SIPFunk meets it by default.

### 2.3 Prohibited practices (Art. 5)

Prohibited are, among others, AI systems that use subliminal, manipulative or deceptive techniques to materially distort a person's behaviour and thereby cause them significant harm. SIPFunk's standard operation does not do this. The spam defence deceives about the nature of the conversation partner but does not change the caller's behaviour in a harmful way; on a common reading it is not an Art. 5 case but an Art. 50 case. That is an assessment, not settled law.

### 2.4 Risk class

A phone assistant is not a high-risk system under Annex III. There are no registration or conformity assessment obligations; the transparency obligations remain.

---

## 3. Data protection (GDPR, German Federal Data Protection Act)

### 3.1 Does the GDPR apply at all?

The GDPR does **not** apply to processing by natural persons in the course of a **purely personal or household activity** (Art. 2(2)(c)). Private calls and a private answering machine are covered as long as the data stays in the private sphere (no publication, no business use).

It applies **in full** when SIPFunk is used for business: a company number, customer calls, business queries to suppliers. Then the following sections apply.

### 3.2 Which data is processed

- Phone numbers (caller, called party), times, duration.
- Call content as audio (live only, passed through to OpenAI, not stored) and as text (transcript, summary, result, assessment).
- Contact data and notes in `contacts.json`.
- Background knowledge you give the AI.
- Operating log with phone numbers.

Content may include special categories (Art. 9, e.g. health in calls from a doctor). The AI is instructed not to ask for such information; it cannot be prevented that the other party mentions it.

### 3.3 Legal basis (Art. 6)

In business operation the following come into question: performance or preparation of a contract (Art. 6(1)(b)) for customer and supplier contacts; legitimate interest (point (f)) for the answering machine and the summary, with a balancing of interests (short retention, no audio data, purpose of being reachable). Consent is impractical on the phone and unnecessary where (b) or (f) apply.

### 3.4 Information duties (Art. 13)

Callers have to be informed at the time of collection: controller, purposes, legal basis, recipients (OpenAI as processor, third country USA), retention period, rights. On the phone a short notice with a reference to detailed information (website, privacy policy) is sufficient. In practice: specify a sentence in the "Auftrag bei eingehenden Anrufen" (task for incoming calls), e.g. "Briefly point out that the call is conducted by an AI assistant and logged as text; details are in the privacy policy on our website." Extend the company's privacy policy (section "phone assistant").

### 3.5 Processing agreement and third country (Art. 28, 44 ff.)

OpenAI processes audio and text. For business use you need a **data processing agreement** with OpenAI (OpenAI offers a Data Processing Addendum for the API that is concluded online). The transfer to the USA relies on the adequacy decision for the **EU-US Data Privacy Framework**, provided OpenAI is certified under it, otherwise on standard contractual clauses; check the current status in the OpenAI trust portal. According to OpenAI's API terms, API data is not used for training by default and is stored for a limited time for abuse monitoring; the periods are stated in OpenAI's policies.

Mail providers (Gmail, Microsoft 365, your SMTP provider) receive summary and transcript by e-mail. For companies the same applies here: a processing agreement with the mail provider, usually covered by the business customer contracts.

If the lookup of unknown numbers is switched on (off by default), the caller's number is transmitted to tellows while the phone is ringing. In business operation this needs a legal basis too.

### 3.6 Retention, erasure, security (Art. 5, 17, 32)

- Logs are deleted after the configured period (default 7 days); set the period as short as possible and document the reason if you extend it.
- Delete logs manually when a caller requests it (Art. 17), and remove the contact when there is no longer a reason to store it.
- The data folder is stored unencrypted on the computer. For business operation: disk encryption (BitLocker), access protection, encrypted backups.
- The web UI is reachable only locally. Do not open it to a network (no port forwarding, no reverse proxy without authentication).

### 3.7 Record of processing activities, data protection impact assessment

Companies add the phone assistant to their record of processing activities (Art. 30). A data protection impact assessment (Art. 35) is usually not required for a single answering machine without profiling, but may be advisable if health or financial data arises regularly (medical practice, law firm, tax consultancy).

---

## 4. Confidentiality of the spoken word (§ 201 German Criminal Code) and professional secrecy

§ 201 of the German Criminal Code (StGB) makes it a criminal offence to **record the non-publicly spoken word on a sound carrier** without consent, and likewise for third parties to intercept it with a listening device.

- SIPFunk **stores no audio**. The audio is streamed live to OpenAI and processed there in real time.
- The **transcript** is a text version of the call. Whether automatic live transcription is equivalent to a "recording on a sound carrier" has not been decided by the highest courts; the prevailing reading does not regard the written record made by the conversation partner themselves as a sound recording, but as data processing (section 3). A transient buffering of the audio at the processor is technically unavoidable.
- **Listening in via the browser** ("Mithören") is listening by the operator themselves, who is a party to the call (the AI acts for them). Do not let third parties listen in.
- **Recommendation:** in business operation, point out the logging during the call (section 3.4); privately you decide yourself whether to inform callers. Legally the notice is the safest course in any case.

Persons bound by professional secrecy (§ 203 StGB: doctors, lawyers, tax advisers and others) may pass call content to service providers only under the conditions of § 203(3) (obligation of confidentiality, necessity). Using SIPFunk in such practices and firms needs its own assessment.

---

## 5. Telephone advertising and telecommunications law

### 5.1 Unacceptable nuisance (§ 7 UWG)

Advertising by phone is prohibited towards **consumers without prior express consent** and towards other market participants without presumed consent (§ 7(2) no. 1 of the Act against Unfair Competition, UWG). Also prohibited is advertising using an **automatic calling machine** without express consent (§ 7(2) no. 2) – SIPFunk is such a machine. Violations are administrative offences (§ 20 UWG, fine imposed by the Bundesnetzagentur) and give rise to claims for injunctive relief.

Consequence: **no sales, no cold calling, no "interest surveys" with SIPFunk** without documented consent. Appointment requests, queries to existing contractual partners and private calls are not advertising.

### 5.2 Caller ID

For advertising calls the number must not be withheld (§ 120 Telecommunications Act, TKG). SIPFunk never withholds it; the box transmits the configured outgoing number. Do not configure caller ID suppression for the extension in the box.

### 5.3 Emergency and special numbers

SIPFunk blocks 110, 112, 115, 116xxx, 118xx, 0900, 0137/0138, 0180, 019x and international numbers. This protects against costs and against misuse of emergency numbers (§ 145 StGB). The block is deliberately not configurable.

### 5.4 Transfer (SIP REFER) and call back

Putting a caller through to you is a transfer within your own line, not a disclosure to third parties. The call back to your own number is unproblematic. Both incur call charges according to your tariff.

---

## 6. Spam defence: particular risks

The mode lets the AI act as a private person towards callers classified as spam, without an AI notice. The configurable name of the role is an invented name; do not enter a real name there, not even your own, so that the AI does not pose as a real person. Your own instructions for the role do not override the built-in protective rules. The risks in detail:

| Area | Risk | Assessment |
| --- | --- | --- |
| **AI Act Art. 50** | Omitted notice of the AI | For private use probably not covered because of the exception in Art. 2(10); for a business number a violation unless an exception applies. Fines under Art. 99 are aimed at providers/deployers; enforcement against private individuals is unlikely but not excluded. |
| **GDPR** | Processing without information, transcript | Private: not applicable. Business: information duty violated; the balancing of interests is likely to favour the called party because the advertising call is itself unlawful, but that does not replace the information. |
| **§ 201 StGB** | Transcript without notice | As in standard operation (section 4); because the notice is missing, the caller has no opportunity to consent. |
| **Deception / fraud (§ 263 StGB)** | No financial loss for the caller, no enrichment | Not relevant as fraud. |
| **Arrogation of public office (§ 132), insult (§ 185), coercion (§ 240)** | Only if the AI behaves accordingly | The instructions expressly forbid it; with generative models there is no guarantee. Check transcripts. |
| **Misdetection** | A legitimate caller (doctor, authority, customer) is stalled | Reputational and possibly liability risk (e.g. a missed appointment). The AI is supposed to switch back; do not rely on it. "anonym" on the list increases this risk considerably. |
| **OpenAI's terms of use** | OpenAI's Usage Policies prohibit, among other things, deceiving people about interacting with an AI and require disclosure of AI use for automated systems | A violation can lead to the API account being suspended. Read the current version of the Usage Policies before you switch the mode on. |
| **Cost** | Stalling consumes Realtime minutes | Your own financial risk; set a budget limit. |

**What SIPFunk does to limit the risk:** explicit confirmation with date in the UI, no `.env` switch, server-side check of the confirmation, fixed behaviour rules (no data, no consent, no insults, no authority, no carrying out instructions), a way back to assistant mode for genuine requests, time limit, tag in the log, never "important", no call back.

**AI disclosure in the spam defence:** With the switch "AI disclosure" the AI introduces itself as an AI to spam callers as well and does not play a private person. The points of this section that follow from the missing AI notice then only concern the setting without disclosure (the default, still only after confirmation); misdetection, logging and cost apply in both cases.

**What is left to you:** the decision. The legally clean alternative is the normal answering machine, which introduces itself as an AI and politely turns advertising calls away, plus a complaint to the Bundesnetzagentur (form "Unerlaubte Telefonwerbung" or "Rufnummernmissbrauch") with date, time, number, company and content from the log.

---

## 7. Liability for errors of the AI

Commitments made by the AI are attributed to you as far as they are within the scope of the task (agency, §§ 164 ff. German Civil Code by analogy; whether an AI can "make" declarations is disputed, in practice: what you task the AI with, you bear). The AI is instructed to agree only to what the task covers and not to enter into payments, orders or contracts. Phrase tasks as narrowly as you would for a human assistant. Contracts of consequence you conclude yourself.

If damage arises through the AI (missed appointment, wrong information given to third parties), you are liable under the general rules. The software comes with no warranty and is used at your own risk; OpenAI is liable to you under its terms and conditions, not to third parties.

---

## 8. Publishing or developing SIPFunk further

The sections above look at operation. Whoever publishes the source code, passes on a modified version or makes it available to others has to consider these additional points. None of them is settled.

- **Provider under the AI Act.** The private-use exception (Art. 2(10)) applies only to deployers, not to providers. The exception for AI systems released under free and open-source licences (Art. 2(12)) expressly does not apply to systems that fall under Art. 50, and hence not to a phone assistant. It is open whether publishing source code free of charge, which everyone assembles themselves with a third-party speech model, constitutes "placing on the market".
- **Spam defence.** This is the critical point: the software contains a feature that deliberately omits the AI notice. It is therefore off by default, usable only after confirmation, and described as a risk in this documentation. Whether that is sufficient has not been decided.
- **Marking synthetic speech (Art. 50(2)).** Providers of systems that generate synthetic audio content have to mark the output in a machine-readable way. The speech is generated by OpenAI's model; whether there is an additional duty on whoever routes it into the telephone network is open. Technically a phone call cannot be marked in a machine-readable way.
- **Liability when software is given away.** Under German law the licence's exclusion of warranty and liability does not apply without limits; someone who gives software away is still liable for intent and gross negligence.
- **Data outside the retention period.** The retention period applies to the logs. The tray app's operating log (`sipfunk.log`) contains phone numbers and is trimmed after the same period. Notification mails with summary and conversation, however, remain in the mailbox. Whoever passes the program on should point this out; whoever runs it deletes the mails themselves.

---

## 9. Checklist before operation

**Private**
- [ ] Only your own numbers on the extension, "Im Auftrag von" = your name.
- [ ] Short retention of logs, data folder encrypted in the backup.
- [ ] No advertising, no prank calls, no stalling of legitimate callers.
- [ ] Spam defence only after reading section 6, number list instead of "anonym".

**Additionally for business**
- [ ] Legal basis determined (Art. 6(1)(b)/(f)), record of processing activities updated.
- [ ] Privacy policy extended to cover the phone assistant; notice in the call via "Auftrag bei eingehenden Anrufen".
- [ ] Data processing agreement with OpenAI concluded, third-country transfer checked.
- [ ] Mail provider covered as a processor.
- [ ] Professional secrecy (§ 203 StGB) checked, if relevant.
- [ ] Spam defence off as long as it has not been reviewed by a lawyer.

---

## 10. Sources

- Regulation (EU) 2024/1689 (AI Act): Art. 2(10) and (12), Art. 5, Art. 50, Art. 99, Art. 113 (timetable).
- Regulation (EU) 2016/679 (GDPR): Art. 2, 5, 6, 9, 13, 17, 28, 30, 32, 35, 44 ff.
- German Criminal Code (Strafgesetzbuch, StGB): §§ 132, 145, 185, 201, 203, 240, 263.
- German Act against Unfair Competition (Gesetz gegen den unlauteren Wettbewerb, UWG): §§ 7, 20.
- German Telecommunications Act (Telekommunikationsgesetz, TKG): § 120 (caller ID for advertising calls).
- Bundesnetzagentur: complaint forms on unlawful telephone advertising and number misuse.
- OpenAI: Usage Policies, API Data Processing Addendum, Enterprise Privacy (API data retention).
