// Kurze Zusammenfassung nach dem Gespräch per OpenAI Responses API (Text).
import type { CallOutcome, TranscriptEntry } from './realtimeBridge.js';

export async function summarize(apiKey: string, model: string, task: string | undefined, entries: TranscriptEntry[], outcome?: CallOutcome): Promise<string> {
  const dialog = entries
    .filter((e) => e.final)
    .map((e) => (e.speaker === 'system' ? `[System: ${e.text}]` : `${e.speaker === 'ki' ? 'KI' : 'Gegenüber'}: ${e.text}`))
    .join('\n');
  if (!entries.some((e) => e.final && e.speaker !== 'system')) return 'Kein Gesprächsinhalt (keine Transkription vorhanden).';

  const prompt = [
    'Du fasst ein Telefonat zusammen, das ein KI-Assistent im Auftrag eines Nutzers geführt hat. Antworte auf Deutsch, knapp, ohne Einleitung, als Markdown mit genau diesen Abschnitten:',
    '**Ergebnis:** erledigt / teilweise / nicht erledigt / abgebrochen – plus ein Satz. Bei mehreren Punkten im Auftrag: je Punkt ein Halbsatz, ob er erledigt wurde.',
    '**Kernaussagen:** 1–4 Stichpunkte mit dem, was das Gegenüber gesagt, zugesagt oder dem Auftraggeber ausrichten lassen hat.',
    '**Offen / Unsicher:** Stichpunkte zu offenen Punkten, Unklarheiten oder möglichen Transkriptionsfehlern; „keine", wenn nichts offen ist.',
    'Erfinde nichts, was nicht im Transkript steht. Zeilen in [System: …] sind Ereignisse der App (z. B. der end_call der KI), kein gesprochener Text – bewerte sie nicht als fehlend oder fehlerhaft.',
    '',
    task ? `Auftrag an die KI war: ${task}` : 'Es gab keinen konkreten Auftrag (Testgespräch).',
    ...(outcome ? ['', `Die KI selbst meldete als Ergebnis: ${outcome.result}${outcome.open ? ` – offen: ${outcome.open}` : ''}. Prüfe das am Transkript.`] : []),
    '',
    'Transkript:',
    dialog,
  ].join('\n');

  return responsesText(apiKey, model, prompt, 2000);
}

/**
 * Textantwort des Textmodells (Responses API) auf einen Prompt; wirft bei Fehler oder leerer Antwort.
 * Mit `format` antwortet das Modell als JSON nach dem angegebenen Schema (der Aufrufer parst den Text).
 */
export async function responsesText(apiKey: string, model: string, prompt: string, maxOutputTokens: number, format?: { name: string; schema: object }): Promise<string> {
  const ask = (reasoning: boolean) =>
    fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // Reasoning-Modelle denken vor der Antwort; das Budget muss Reasoning + Text decken
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: maxOutputTokens,
        ...(reasoning ? { reasoning: { effort: 'low' } } : {}),
        ...(format ? { text: { format: { type: 'json_schema', name: format.name, strict: true, schema: format.schema } } } : {}),
      }),
    });
  let res = await ask(true);
  let failure = res.ok ? '' : (await res.text()).slice(0, 200);
  // Das Textmodell ist frei wählbar: Modelle ohne Reasoning lehnen die Angabe ab, dann ohne sie fragen
  if (res.status === 400 && /reasoning/i.test(failure)) {
    res = await ask(false);
    failure = res.ok ? '' : (await res.text()).slice(0, 200);
  }
  if (!res.ok) throw new Error(`Textmodell fehlgeschlagen: ${res.status} ${failure}`);
  const data = (await res.json()) as {
    output_text?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    output?: { type: string; content?: { type: string; text?: string }[] }[];
  };
  const text =
    data.output_text ||
    data.output
      ?.filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
  if (!text?.trim()) {
    throw new Error(`Antwort leer (Status ${data.status ?? '?'}${data.incomplete_details?.reason ? `, ${data.incomplete_details.reason}` : ''})`);
  }
  return text.trim();
}
