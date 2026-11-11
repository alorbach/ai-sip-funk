// „Verbindung testen“ für einen KI-Anbieter, in drei Schritten: Schlüssel gültig? Modell in der Liste des Kontos?
// Baut die Live-Verbindung auf? Es wird kein Audio geschickt und keine Antwort angefordert; der Test kostet nichts
// außer dem Verbindungsaufbau. Schlüssel stehen in keiner Meldung.
import type { AiProvider, LiveEvents } from './providers/types.js';
import type WebSocket from 'ws';

export interface TestStep {
  id: 'key' | 'model' | 'live';
  ok: boolean;
  /** true = nicht geprüft, weil ein Schritt davor scheiterte */
  skipped?: boolean;
  /** Ein Satz für die Oberfläche (deutsch; die Oberfläche übersetzt) */
  text: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  provider: string;
  model: string;
  steps: TestStep[];
}

export interface ConnectionTestOptions {
  fetchImpl?: typeof fetch;
  /** Nur für Tests: nachgestellter WebSocket statt der echten Verbindung */
  createSocket?: (url: string) => WebSocket;
  timeoutMs?: number;
}

/** Live-Verbindung aufbauen, auf die Bestätigung der Sitzung warten, wieder schließen. */
export function testLive(provider: AiProvider, key: string, model: string, opts: ConnectionTestOptions = {}): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        session.close();
      } catch {
        // bereits zu
      }
      resolve({ ok, error });
    };
    const nothing = () => undefined;
    const events: LiveEvents = {
      open: nothing,
      ready: () => finish(true),
      responseStarted: nothing,
      audio: nothing,
      aiText: nothing,
      partnerText: nothing,
      speechStarted: nothing,
      speechStopped: nothing,
      toolCall: nothing,
      responseDone: nothing,
      error: (e) => finish(false, e.message || e.code || 'Fehler des Anbieters'),
      socketError: (message) => finish(false, explain(message)),
      closed: (code, reason) => finish(false, reason ? `Verbindung geschlossen: ${reason.slice(0, 200)}` : `Verbindung geschlossen (Code ${code})`),
    };
    const timer = setTimeout(() => finish(false, 'keine Antwort innerhalb der Wartezeit'), opts.timeoutMs ?? 10_000);
    const session = provider.createLive(
      {
        apiKey: key,
        model,
        instructions: 'Verbindungstest. Antworte nicht.',
        voice: provider.voices[0],
        tools: [],
        allowInterrupt: true,
        vadSilenceMs: 900,
        vadThreshold: 0.6,
        speechSpeed: 1,
        maxOutputTokens: 100,
        transcriptionHints: [],
        createSocket: opts.createSocket,
      },
      events,
    );
  });
}

/** Meldung des WebSocket in einen Satz übersetzen, mit dem man etwas anfangen kann. */
function explain(message: string): string {
  if (/\b(401|403)\b/.test(message)) return 'Der Anbieter hat den Schlüssel für die Live-Verbindung abgelehnt.';
  if (/\b404\b/.test(message)) return 'Der Anbieter kennt dieses Modell nicht.';
  if (/\b429\b/.test(message)) return 'Kontingent erschöpft oder zu viele Anfragen.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(message)) return 'Der Anbieter ist nicht erreichbar – besteht eine Internetverbindung?';
  return message.slice(0, 200);
}

export async function testConnection(provider: AiProvider, key: string | undefined, model: string, opts: ConnectionTestOptions = {}): Promise<ConnectionTestResult> {
  const steps: TestStep[] = [];
  const result = () => ({ ok: steps.every((s) => s.ok), provider: provider.id, model, steps });
  const skip = (id: TestStep['id'], text: string) => steps.push({ id, ok: false, skipped: true, text });

  if (!key) {
    steps.push({ id: 'key', ok: false, text: 'Es ist noch kein Schlüssel hinterlegt.' });
    skip('model', 'Nicht geprüft.');
    skip('live', 'Nicht geprüft.');
    return result();
  }
  // Schritt 1 und 2 in einem Abruf: Die Modell-Liste gibt es nur mit gültigem Schlüssel
  let listed: boolean | undefined;
  try {
    const lists = await provider.fetchModels(key, opts.fetchImpl);
    steps.push({ id: 'key', ok: true, text: 'Der Schlüssel ist gültig.' });
    listed = lists.realtime.some((m) => m.id === model);
  } catch (err) {
    steps.push({ id: 'key', ok: false, text: (err as Error).message });
    skip('model', 'Nicht geprüft.');
    skip('live', 'Nicht geprüft.');
    return result();
  }
  const live = await testLive(provider, key, model, opts);
  // Steht das Modell nicht in der Liste, entscheidet die Live-Verbindung: Nicht jede Liste nennt alle Modelle
  steps.push(
    listed || live.ok
      ? { id: 'model', ok: true, text: listed ? 'Das Sprachmodell steht in der Modell-Liste des Kontos.' : 'Das Sprachmodell steht nicht in der Modell-Liste, die Verbindung kam aber zustande.' }
      : { id: 'model', ok: false, text: 'Das Sprachmodell steht nicht in der Modell-Liste des Kontos.' },
  );
  steps.push(live.ok ? { id: 'live', ok: true, text: 'Die Live-Verbindung baut auf.' } : { id: 'live', ok: false, text: `Die Live-Verbindung kam nicht zustande: ${live.error ?? 'unbekannter Grund'}` });
  return result();
}
