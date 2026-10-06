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
- Zeilennummern berechnet die Action selbst: `parsePatch()` aus `src/diff/parse.js` liefert je Datei die Hunks und `commentableLines`, die Nummern der hinzugefügten Zeilen. Nur diese Zeilen sind Kommentarziele. Eine Zeilennummer aus einer Modellantwort gilt erst, wenn sie in `commentableLines` steht. `annotateDiff()` aus `src/diff/annotate.js` erzeugt den Diff-Text für das Modell und zeigt Nummern nur an hinzugefügten Zeilen.
- Welche Dateien nicht reviewt werden, entscheidet `createExcludeFilter()` aus `src/exclude.js`: die Standardliste `DEFAULT_EXCLUDES` plus die Muster aus dem Input `exclude`. Der Abgleich läuft über `picomatch` mit festen Optionen. Eigene Muster sind begrenzt (höchstens zwei `*` und zwei `**` im ganzen Muster, 50 Muster, keine Negation, keine Klammern), weil Dateinamen vom PR-Autor stammen und ein Muster mit vielen Platzhaltern sonst minutenlang rechnet. Gezählt wird über das ganze Muster, weil sich Sterne in mehreren Verzeichnissen multiplizieren. Ein Verzeichnismuster wie `dist/**` meint die Dateien darunter, nicht eine Datei mit dem Namen `dist`. Ein ungültiges Muster lässt den Lauf vor dem ersten API-Aufruf scheitern.
- Der Ablauf in `run()` ist: abrufen, filtern, parsen, begrenzen. Bleibt danach keine Datei, endet der Lauf grün mit einer `core.notice()`. Alles, was Geld kostet oder etwas postet (KI-Aufruf, Review), steht hinter dieser Stelle.
- Die Größe eines Pull Requests begrenzen `max-files` (Standard 50) und `max-diff-chars` (Standard 200000): `parseLimits()` und `applyLimits()` aus `src/limits.js`. Gezählt werden die Zeichen des annotierten Diffs, also des Textes, der ans Modell geht. Gewählt wird in der Reihenfolge von GitHub. Eine Datei, die nicht mehr ins Restbudget passt, entfällt allein, spätere kleinere kommen noch hinein. Ausgelassene Dateien stehen mit Grund im Log und in einer Warnung, ein ungültiger Wert scheitert vor dem ersten API-Aufruf. Die Standardwerte stehen in `action.yml` und in `src/limits.js`, ein Test hält sie gleich. Wer den Text für das Modell braucht, nimmt `annotated` der gewählten Datei, statt `annotateDiff()` erneut aufzurufen.
- Den Aufruf des Modells kapselt `createAiClient()` aus `src/ai/client.js` (`complete({ system, user })`), das offizielle `openai`-SDK über die Chat-Completions-Schnittstelle. Die SDK-Optionen sind fest: Adresse `https://api.openai.com/v1`, keine Organisation, kein Projekt, SDK-Logging aus. Ohne sie übernähme das SDK `OPENAI_BASE_URL`, `OPENAI_ORG_ID` und `OPENAI_LOG` aus der Umgebung und schickte Key und Code dorthin. Timeout 120 Sekunden je Versuch, zwei Wiederholungen durch das SDK. Bis #14 ruft `run()` den Client nicht auf. Mehrere Aufrufe gleichzeitig sind erlaubt. Der API-Key muss aus sichtbaren ASCII-Zeichen bestehen (`assertInputs()`), sonst scheitert das SDK mit einer Meldung über einen Header.
- Prompt und Antwort des Modells enthalten Code aus dem Diff und werden nie geloggt, auch nicht im Debug-Log. Ins Log kommen nur Kennzahlen: Modell, Token-Verbrauch, Anfrage-ID.
- Fehler des Clients sind `AiError` mit eigenem Text und einem Feld `kind`. Der Text von OpenAI wird nie übernommen und nicht als `cause` angehängt: OpenAI nennt in der Meldung zu einem ungültigen Key dessen Anfang und Ende, und der Schwärzer kennt nur den ganzen Key. Werte aus der Antwort (Code, Typ, Anfrage-ID, Modellname) erscheinen im Log nur, wenn sie wie ein Bezeichner aussehen, die Token-Zahlen nur, wenn alle drei ganze Zahlen ab 0 sind. Nach `auth`, `permission`, `model` und `quota` lohnt kein weiterer Aufruf.
- Der Modellname kommt über `parseModel()` aus `src/ai/model.js`. Die Datei importiert das SDK nicht, damit `run()` es nicht ins Bundle zieht, solange der Client dort nicht gebraucht wird.
- Das Antwortformat des Modells steht an genau einer Stelle: `src/ai/schema.js` (`REVIEW_SCHEMA`, `REVIEW_FORMAT`, `MAX_OUTPUT_TOKENS`, `parseReview()`). Die Anfrage sendet es als Structured Output (`json_schema`, `strict: true`, `max_completion_tokens: 4096`), `parseReview()` prüft die Antwort mit `src/ai/json-schema.js` gegen dasselbe Objekt, auch wenn der Strict-Modus es schon erzwingt. Das Schema hält die Regeln des Strict-Modus ein (alle Felder in `required`, `additionalProperties: false`, keine Längen- und Mengengrenzen); `json-schema.js` kennt nur diesen Teil von JSON Schema und lehnt jedes andere Schlüsselwort ab. Die Tabelle in `docs/response-format.md` und das Schema bleiben gleich, ein Test prüft das. Eine abgeschnittene (`truncated`), gefilterte (`filtered`), abgelehnte (`refusal`) oder nicht passende (`response`) Antwort ist ein Fehler und nie „keine Findings“. Fehlermeldungen nennen nur die Stelle (`findings[2].severity`), nie Inhalt, auch nicht den Text einer Ablehnung. Ob ein einzelnes Finding brauchbar ist (Pfad, Zeile, leerer Text), prüft nicht `parseReview()`, sondern der Schritt je Finding. Ein Modell ohne Structured Outputs scheitert mit `kind: "model"` und dem Hinweis auf `openai-model`, ohne Rückfall auf ein anderes Format.
- `AiError` liegt in `src/ai/error.js` ohne SDK-Import, `client.js` exportiert sie weiter. Module, die nur den Fehler oder das Schema brauchen, ziehen so das SDK nicht ins Bundle.
- Inputs, die Zugangsdaten sind, nennt `secretsOf()` aus `src/inputs.js`. Nur sie werden maskiert und geschwärzt. Einstellungen wie `exclude` erscheinen im Log.
- Ein Patch, den `parsePatch()` nicht lesen kann, lässt den Lauf nicht scheitern. Die Datei wird mit Grund übersprungen, und die Meldung nennt nur die Stelle im Patch, nie dessen Inhalt.
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
