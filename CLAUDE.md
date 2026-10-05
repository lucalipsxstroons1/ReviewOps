# ReviewOps

ReviewOps ist eine Custom GitHub Action (JavaScript). Sie startet bei neuen und aktualisierten Pull Requests, liest den Diff über die GitHub-API, schickt ihn an die OpenAI-API (Standardmodell `gpt-4o-mini`) und postet das Feedback als Review mit Inline-Kommentaren am betroffenen Code.

Der Backlog liegt in den GitHub Issues dieses Repositories. Die Milestones „Phase 1“ bis „Phase 5“ geben die Reihenfolge vor. Jedes Issue nennt seine Tasks, seine Akzeptanzkriterien und in der Fußzeile seine Abhängigkeiten („Abhängig von: #n“).

## Arbeitsweise

- **Ein Issue nach dem anderen.** Der Maintainer gibt jede Phase und jedes Issue selbst frei. Ist ein Issue abgeschlossen, wird berichtet und gewartet, statt das nächste zu beginnen.
- **Kein Code auf Vorrat.** Gebaut wird, was das aktuelle Issue verlangt. Was ein späteres Issue liefert, bleibt dort.
- **Kleine, nachvollziehbare Schritte.** Vor jedem Schritt kurz sagen, was entsteht und wozu. Nie den gesamten Code auf einmal abliefern.
- **Ein Branch und ein Pull Request je Issue.** Der Branch heißt `issue-<nr>-<kurzname>`. `main` ändert sich nur über Pull Requests, damit ReviewOps seine eigenen Änderungen reviewt.
- **Sprache.** Antworten, Issues, Pull Requests und Commit-Messages sind deutsch. Bezeichner, Kommentare und Log-Ausgaben im Code sind englisch.

## Regeln für den Code

- Die Laufzeit ist Node.js 24, der Code besteht aus ES Modules (`import`/`export`). `@actions/core` liefert Inputs, Outputs und Logging, `@actions/github` den Octokit-Client, das offizielle `openai`-SDK den KI-Aufruf.
- Asynchroner Code nutzt `async/await`. Fehler werden mit `try/catch` abgefangen und enden in einer verständlichen Meldung über `core.setFailed()`.
- Secrets (GitHub-Token, OpenAI-Key) tauchen nirgends auf: nicht in Logs, Fehlermeldungen, Kommentaren oder Testdaten.
- Zero-Trust: Diff-Inhalte und Modellantworten sind nicht vertrauenswürdige Eingaben und werden geprüft, bevor sie etwas auslösen.
- `dist/` wird eingecheckt und muss zum Quellcode passen. Nach jeder Änderung unter `src/` neu bauen.

## Ablauf je Issue

| Schritt | Skill | Ergebnis |
|---|---|---|
| Standort klären | `/orientation` | Projektstand und nächstes umsetzbares Issue |
| Issue schärfen | `/drilling <nr>` | geklärte Entscheidungen und ein abgestimmter Plan |
| Umsetzen | `/implement <nr>` | Code, Tests und ein Nachweis je Akzeptanzkriterium |
| Prüfen | `/review-issue <nr>` | Befunde und ein Urteil |
| Abschließen | `/ship <nr>` | Commit und Pull Request, nach dem Merge ein abgehaktes Issue |
| Fehler suchen | `/diagnose` | Ursache eines fehlgeschlagenen Workflow-Laufs |

Fehlt beim Aufruf die Issue-Nummer, ergibt sie sich aus dem Branch-Namen. Auf `main` ist das nächste umsetzbare Issue gemeint: das offene Issue mit der kleinsten Nummer im frühesten Milestone mit offenen Issues, dessen Abhängigkeiten alle geschlossen sind. Der Maintainer bestätigt es, bevor gearbeitet wird.

## Befehle

- `npm ci` installiert die Abhängigkeiten exakt nach `package-lock.json`.
- `npm test` führt die Tests mit dem eingebauten Test-Runner aus (`node --test`). Testdateien liegen unter `test/` und heißen `*.test.js`.
- `npm run lint` prüft den Code mit ESLint und die Formatierung mit Prettier.
- `npm run format` formatiert den Code mit Prettier (Standardstil, Markdown ausgenommen).

## Werkzeuge

- Der GitHub-Zugriff läuft über die GitHub CLI (`gh`). Ist sie nicht angemeldet (`gh auth status`), um `gh auth login` bitten, statt einen anderen Weg zu suchen.
- Texte für Git und GitHub (Commit-Messages, PR-Beschreibungen, Kommentare) als UTF-8-Datei übergeben: `git commit -F <datei>`, `gh … --body-file <datei>`. Als Shell-Argument gehen unter Windows Umlaute und Zeilenumbrüche kaputt.
- `gh … --jq`-Ausdrücke mit Anführungszeichen in der Bash ausführen. PowerShell entfernt die inneren Anführungszeichen, und der Ausdruck wird ungültig.
