# SIPFunk – Datenschutzerklärung

English: [privacy.md](privacy.md)

Stand: November 2026. Gilt für SIPFunk aus dem Microsoft Store und aus den GitHub-Releases.

## Kurz gesagt

SIPFunk läuft vollständig auf deinem Computer. Der Herausgeber von SIPFunk betreibt keinen Server, erhebt keine Daten, misst keine Nutzung und bekommt nichts von dem zu sehen, was du mit SIPFunk tust. Daten verlassen deinen Computer nur in Richtung der Dienste, die du selbst einrichtest und einschaltest. Für diese Dienste gelten deren Bedingungen und Datenschutzerklärungen.

## Was auf deinem Computer gespeichert wird

Im Datenordner (`%APPDATA%\SIPFunk`, bei der Store-Fassung ohne vorherige Installer-Fassung im Paketordner der App; im Tray-Menü „Datenordner öffnen“):

- `.env`: Zugangsdaten zu Telefonanlage, KI-Anbieter und ggf. Mail, im Klartext.
- `settings.json`, `contacts.json`: Einstellungen, Kontakte und Notizen, auch aus einem Adressbuch importierte Kontakte.
- Gesprächsprotokolle als Text (Mitschrift, Zusammenfassung, Ergebnis) und das Betriebslog mit Rufnummern. Beides löscht SIPFunk nach der eingestellten Frist (Standard 7 Tage).

SIPFunk speichert keine Gesprächsaudios. Der Datenordner ist nicht verschlüsselt; schütze deinen Computer entsprechend (z. B. BitLocker). Beim Deinstallieren bleibt `%APPDATA%\SIPFunk` erhalten, damit eine Neuinstallation oder die andere Fassung weiterarbeiten kann; einen Paketordner der Store-Fassung löscht Windows mit. Löschen kannst du ihn jederzeit selbst.

## Wohin Daten gehen

| Empfänger | Was | Wann |
|---|---|---|
| Deine Telefonanlage (z. B. FRITZ!Box) bzw. dein SIP-Anbieter | Rufnummern, Gesprächsaudio | bei jedem Anruf |
| Der eingestellte KI-Anbieter: OpenAI (USA) oder Google Gemini (USA) | Gesprächsaudio live, Auftrag, Name und Notizen des Kontakts, Mitschrift | während jedes Gesprächs |
| Dein Mail-Anbieter (Gmail, Microsoft 365 oder SMTP-Server) | Zusammenfassung und gekürztes Gespräch | nur wenn Mail-Benachrichtigung eingeschaltet |
| autoconfig.thunderbird.net (Mozilla) | Domain deiner Mail-Adresse | nur beim Einrichten der Mail, um die Servereinstellungen zu finden |
| tellows | Rufnummer unbekannter Anrufer | nur wenn die Nummernprüfung eingeschaltet ist (Standard: aus) |
| Google oder Microsoft | Anmeldung und Lesen deines Adressbuchs | nur beim Kontakt-Import; die Daten gehen direkt zu SIPFunk, nicht über den Herausgeber |
| Der Anbieter deines KI-Agenten (MCP) | Gesprächsinhalt als Text | nur wenn du einen KI-Agenten anbindest und er einen Anruf führt |

Die Web-Oberfläche läuft nur lokal auf deinem Computer (127.0.0.1) und ist aus dem Netz nicht erreichbar.

## Mikrofon

SIPFunk nutzt das Mikrofon nur, wenn du in der Oberfläche einen Auftrag einsprichst. Die Aufnahme geht zur Umwandlung in Text an den eingestellten KI-Anbieter und wird nicht gespeichert.

## Künstliche Intelligenz

SIPFunk führt Telefonate mit einer generativen Sprach-KI von OpenAI oder Google. Die KI stellt sich am Telefon als KI vor. Ihre Antworten können falsch oder unpassend sein. Unangemessene Inhalte meldest du über [GitHub Issues](https://github.com/alorbach/ai-sip-funk/issues) und zusätzlich beim jeweiligen KI-Anbieter.

## Deine Verantwortung

Wenn du SIPFunk beruflich einsetzt, bist du für die Gesprächsdaten selbst verantwortlich, auch gegenüber den Menschen, die du anrufst oder die dich anrufen. Was das bedeutet, steht in den [rechtlichen Hinweisen](legal.de.md).

## Kinder

SIPFunk richtet sich an Erwachsene. Die Nutzungsbedingungen der KI-Anbieter setzen ein Mindestalter voraus (Gemini API: 18 Jahre).

## Kontakt und Änderungen

Fragen zum Datenschutz: [GitHub Issues](https://github.com/alorbach/ai-sip-funk/issues). Änderungen an dieser Erklärung stehen in der Versionsgeschichte dieses Repositorys.
