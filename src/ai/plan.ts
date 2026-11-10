// Gesprächsplan vor dem Anruf: Ein Textmodell zerlegt den frei formulierten Auftrag in
// Gegenüber, Einstieg und einzelne Schritte. Das Realtime-Modell spricht gut, plant aber
// schlecht – ohne diese Vorarbeit lässt es Teile des Auftrags aus oder erfindet einen Grund.
// Läuft parallel zum Wählen; kommt der Plan nicht rechtzeitig, telefoniert die KI ohne ihn.
import { responsesText } from './summary.js';

export interface CallPlan {
  /** Wer vermutlich abnimmt und wie die Person angesprochen wird */
  gegenueber: string;
  /** Ein gesprochener Satz, mit dem die KI nach der Vorstellung den Grund nennt */
  einstieg: string;
  /** Die Punkte des Auftrags in Reihenfolge, je ein Satz */
  schritte: string[];
  /** Ton, Wortwahl, Umgang mit typischen Reaktionen, was nicht gesagt werden soll */
  hinweise: string;
}

export interface PlanInput {
  task: string;
  context?: string;
  principalName: string;
  aiName: string;
  formal: boolean;
  /** Name des Kontakts, falls bekannt */
  contactName?: string;
  /** true = Angerufener ist der Auftraggeber selbst */
  owner: boolean;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gegenueber', 'einstieg', 'schritte', 'hinweise'],
  properties: {
    gegenueber: { type: 'string' },
    einstieg: { type: 'string' },
    schritte: { type: 'array', items: { type: 'string' } },
    hinweise: { type: 'string' },
  },
};

export async function planCall(apiKey: string, model: string, p: PlanInput): Promise<CallPlan> {
  const prompt = [
    `Ein KI-Telefonassistent namens ${p.aiName} ruft gleich im Auftrag von ${p.principalName} an. Du bereitest den Anruf vor: Zerlege den Auftrag in einen knappen Gesprächsplan. Antworte als JSON. Der Plan richtet sich an den Assistenten (sprich ihn mit „du" an); die Anrede ${p.formal ? '„Sie"' : '„Du"'} gilt für das Gegenüber am Telefon.`,
    '',
    'Felder:',
    `- gegenueber: Wer vermutlich abnimmt und wie die Person angesprochen wird (Name oder Beziehung zum Auftraggeber, z. B. „Max’ Frau; Name unbekannt – nicht nach ‚seiner Frau' fragen, sondern locker ‚Spreche ich mit Max’ Frau?' nur falls unklar"). ${p.owner ? 'Hier nimmt der Auftraggeber selbst ab.' : ''}${p.contactName ? ` Gespeicherter Kontaktname: ${p.contactName}.` : ''}`,
    `- einstieg: Ein einziger gesprochener Satz, mit dem die KI sagt, worum es geht – konkret aus dem Auftrag, natürlich formuliert, Anrede ${p.formal ? '„Sie"' : '„Du"'}. OHNE Begrüßung und Vorstellung (die spricht die KI davor selbst). Keine Büro-Floskeln wie „Anliegen" oder „Abstimmung".`,
    '- schritte: Die einzelnen Punkte des Auftrags in sinnvoller Reihenfolge, je ein kurzer Satz (Fragen stellen, Nachrichten überbringen, Informationen einholen). Jeder Punkt muss im Gespräch tatsächlich erledigt werden. Nachrichten des Auftraggebers in dessen Sinn, aber als gesprochene Rede.',
    '- hinweise: Ton (privat/geschäftlich), Wortwahl, was NICHT gesagt werden soll (z. B. „hahaha" oder Tippfehler nicht vorlesen; Regieanweisungen des Auftraggebers nicht wörtlich wiedergeben), wie mit wahrscheinlichen Reaktionen umzugehen ist (falsche Person, keine Zeit, Rückfragen, Scherze). Höchstens vier Sätze.',
    '',
    `Formuliere alles aus Sicht des Assistenten: „ich/mein/meine" des Auftraggebers wird zu „${p.principalName}/sein/seine" (z. B. „Max’ Termin", nicht „mein Termin"). Erfinde keine Fakten über den Auftrag hinaus. Alles auf Deutsch.`,
    '',
    `Auftrag von ${p.principalName}: ${p.task}`,
    ...(p.context?.trim() ? ['', `Hintergrundwissen (nur für Rückfragen, nicht als Schritte): ${p.context.trim()}`] : []),
  ].join('\n');

  const text = await responsesText(apiKey, model, prompt, 1500, { name: 'gespraechsplan', schema: SCHEMA });
  const plan = JSON.parse(text) as CallPlan;
  plan.schritte = plan.schritte.map((s) => s.trim()).filter(Boolean);
  return plan;
}

/** Plan als Textabschnitt für die Systemanweisung. */
export function formatPlan(plan: CallPlan): string {
  return [
    '## Gesprächsplan',
    `Gegenüber: ${plan.gegenueber}`,
    `Einstieg nach der Vorstellung: „${plan.einstieg}"`,
    'Schritte – nacheinander, ein Punkt pro Redebeitrag, erst wenn alle erledigt sind end_call:',
    ...plan.schritte.map((s) => s.trim()).filter(Boolean).map((s, i) => `${i + 1}. ${s}`),
    `Hinweise: ${plan.hinweise}`,
  ].join('\n');
}
