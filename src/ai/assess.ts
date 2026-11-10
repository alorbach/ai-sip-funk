// Einschätzung nach einem angenommenen Anruf: Lohnt es sich, den Inhaber sofort anzurufen?
import { responsesText } from './summary.js';

export interface Assessment {
  /** true = wichtig/dringend (Termin, Kunde, Frist, Familie, Notfall, konkreter Rückrufwunsch) */
  important: boolean;
  /** Ein Satz Begründung */
  reason: string;
  /** Kurzzeile für Tray/Betreff, z. B. „Praxis Dr. Meier: Termin Dienstag bestätigen" */
  headline: string;
}

export async function assessCall(apiKey: string, model: string, input: { caller: string; callerName?: string; summary: string; task?: string }): Promise<Assessment> {
  const prompt = [
    'Ein KI-Anrufbeantworter hat einen Anruf angenommen. Entscheide, ob der Inhaber sofort informiert werden sollte (wichtig) oder ob die E-Mail reicht (unwichtig).',
    'Wichtig: Arzt-, Kunden- oder Geschäftstermine, Fristen, Rückrufwünsche mit konkretem Anliegen, Familie, Behörden, Notfälle, alles mit Zeitdruck oder Geld.',
    'Unwichtig: Werbung, Verkaufsangebote, Umfragen, Gewinnspiele, Spam, Verwählt, Testanrufe ohne Anliegen, Anrufe ohne erkennbaren Inhalt.',
    'Antworte NUR als JSON: {"wichtig": true|false, "grund": "ein Satz", "kurz": "max. 8 Wörter: wer und worum es geht"}',
    '',
    `Anrufer: ${input.callerName ? `${input.callerName} (${input.caller})` : input.caller}`,
    ...(input.task ? [`Auftrag des Anrufbeantworters: ${input.task.split('\n')[0]}`] : []),
    '',
    'Zusammenfassung des Gesprächs:',
    input.summary,
  ].join('\n');
  const text = await responsesText(apiKey, model, prompt, 400);
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error(`Einschätzung ohne JSON: ${text.slice(0, 120)}`);
  const j = JSON.parse(m[0]) as { wichtig?: boolean; grund?: string; kurz?: string };
  return { important: j.wichtig === true, reason: String(j.grund ?? '').trim(), headline: String(j.kurz ?? '').trim() };
}
