# ReviewOps

ReviewOps ist eine Custom GitHub Action (JavaScript). Sie startet bei neuen und aktualisierten Pull Requests, liest den Diff über die GitHub-API, schickt ihn an die OpenAI-API (Standardmodell `gpt-4o-mini`) und postet das Feedback als Review mit Inline-Kommentaren am betroffenen Code.

Der Backlog liegt in den GitHub Issues dieses Repositories. Die Milestones „Phase 1“ bis „Phase 5“ geben die Reihenfolge vor. Jedes Issue nennt seine Tasks, seine Akzeptanzkriterien und in der Fußzeile seine Abhängigkeiten („Abhängig von: #n“).

## Arbeitsweise

- **Ein Issue nach dem anderen.** Der Maintainer gibt jede Phase und jedes Issue selbst frei. Ist ein Issue abgeschlossen, wird berichtet und gewartet, statt das nächste zu beginnen.
- **Kein Code auf Vorrat.** Gebaut wird, was das aktuelle Issue verlangt. Was ein späteres Issue liefert, bleibt dort.
- **Kleine, nachvollziehbare Schritte.** Vor jedem Schritt kurz sagen, was entsteht und wozu. Nie den gesamten Code auf einmal abliefern.
- **Ein Branch und ein Pull Request je Issue.** Der Branch heißt `issue-<nr>-<kurzname>`. `main` ändert sich nur über Pull Requests, damit ReviewOps seine eigenen Änderungen reviewt. Issue-Branches bleiben nach dem Merge stehen.
- **Sprache.** Antworten, Issues, Pull Requests und Commit-Messages sind deutsch. Bezeichner, Kommentare und Log-Ausgaben im Code sind englisch.

## Regeln für den Code

- Die Laufzeit ist Node.js 24, der Code besteht aus ES Modules (`import`/`export`). `@actions/core` liefert Inputs, Outputs und Logging, `@actions/github` den Octokit-Client, das offizielle `openai`-SDK den KI-Aufruf.
- Asynchroner Code nutzt `async/await`. Fehler werden mit `try/catch` abgefangen und enden in einer verständlichen Meldung über `core.setFailed()`.
- Secrets (GitHub-Token, OpenAI-Key) tauchen nirgends auf: nicht in Logs, Fehlermeldungen, Kommentaren oder Testdaten.
- Zero-Trust: Diff-Inhalte und Modellantworten sind nicht vertrauenswürdige Eingaben und werden geprüft, bevor sie etwas auslösen.
- `dist/` wird eingecheckt und muss zum Quellcode passen. Nach jeder Änderung unter `src/` neu bauen.
- Workflows binden fremde Actions über einen vollen Commit-SHA ein, die Version steht als Kommentar dahinter. Sie bekommen nur die Rechte, die sie brauchen.
- Module bekommen `core`, `context` und andere Runner-Objekte als Parameter, statt sie selbst zu importieren. Nur `src/main.js` verdrahtet die echten Module. So lassen sich alle Zweige mit `test/helpers/fake-core.js` und `test/helpers/fake-context.js` testen.
- `src/index.js` lädt `main.js` erst zur Laufzeit (`await import`) und meldet Fehler beim Laden über `core.setFailed()`. Manche Pakete arbeiten schon beim Laden, `@actions/github` liest zum Beispiel die Event-Datei ein. Deshalb gehört in `index.js` kein weiterer statischer Import außer `@actions/core`.
- Werte aus dem Event und aus dem PR (Titel, Branch-Namen, Dateinamen, Patches) stammen vom PR-Autor. Ins Log und in Fehlermeldungen kommen nur geprüfte Werte wie Nummer, SHA und Repository-Name. Dateinamen gehen vorher durch `printable()` aus `src/printable.js`, Patch-Inhalte werden nie geloggt.
- Tests rufen nie die echte GitHub-API auf. Unit-Tests nutzen `createFakeOctokit()`, alles andere den lokalen Testserver `startGitHubApi()` aus `test/helpers/github-api.js`. Prozess-Tests zeigen ohne eigene Angabe auf eine tote lokale Adresse.
- In Quelldateien stehen keine unsichtbaren Zeichen und keine Unicode-Escapes für sie. Sonderzeichen entstehen über `String.fromCodePoint()` oder Unicode-Kategorien wie `\p{Zl}`. `test/source-hygiene.test.js` prüft das.

## Logging

Ausgaben laufen ausschließlich über `@actions/core`; `console.*` ist unter `src/` per ESLint verboten.

- `core.info()` meldet den Fortschritt, eine Zeile je Schritt.
- `core.notice()` ist für Hinweise an den Nutzer der Action, etwa einen übersprungenen Lauf.
- `core.warning()` meldet, was übersprungen oder nur teilweise erledigt wurde, ohne dass der Lauf scheitert.
- `core.debug()` nimmt Details und Stacktraces auf. Sie erscheinen nur bei eingeschaltetem Debug-Logging.
- `core.setFailed()` wird nur in `run()` aufgerufen, mit einer Meldung, die sagt, was zu tun ist.
- Nie ausgegeben werden Payloads, Header und ganze Fehlerobjekte. Fehlertexte gehen vor der Ausgabe durch den Schwärzer aus `src/redact.js`.

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
- `npm run build` leert `dist/` und bündelt `src/index.js` mit `@vercel/ncc` neu dorthin: `index.js`, weitere nummerierte `.js`-Dateien für spät geladene Teile, `package.json` und `licenses.txt`. Alle Dateien in `dist/` werden eingecheckt. `test/dist.test.js` startet das eingecheckte Bundle, also erst bauen, dann testen.

Die CI (`.github/workflows/ci.yml`) führt bei jedem Pull Request und bei jedem Push auf `main` `npm ci`, Lint, Tests und Build aus. Sie wird rot, wenn der Build `dist/` verändert, das eingecheckte Bundle also nicht zum Quellcode passt. `test/workflow.test.js` prüft die Regeln für alle Workflow-Dateien.

## Werkzeuge

- Der GitHub-Zugriff läuft über die GitHub CLI (`gh`). Ist sie nicht angemeldet (`gh auth status`), um `gh auth login` bitten, statt einen anderen Weg zu suchen.
- Texte für Git und GitHub (Commit-Messages, PR-Beschreibungen, Kommentare) als UTF-8-Datei übergeben: `git commit -F <datei>`, `gh … --body-file <datei>`. Als Shell-Argument gehen unter Windows Umlaute und Zeilenumbrüche kaputt.
- `gh … --jq`-Ausdrücke mit Anführungszeichen in der Bash ausführen. PowerShell entfernt die inneren Anführungszeichen, und der Ausdruck wird ungültig.
