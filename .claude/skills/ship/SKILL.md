---
name: ship
description: "Schließt ein umgesetztes und geprüftes Issue ab: committen, Branch pushen, Pull Request öffnen und Checks auswerten. Mit dem Zusatz merge zusätzlich den Pull Request mergen, die Checkboxen im Issue abhaken und lokal aufräumen. Läuft nur auf ausdrücklichen Aufruf."
argument-hint: "[issue-nummer] [merge]"
disable-model-invocation: true
---

# Ship

Bring ein fertiges Issue nach GitHub und hake es ab.

Aufruf-Argumente: $ARGUMENTS

Commit, Push und Pull Request sind nach außen sichtbar und lassen sich nicht sauber zurücknehmen. Deshalb läuft dieser Skill nur, wenn der Maintainer ihn aufruft. Der Aufruf gibt Commit, Push und Pull Request frei. Den Merge gibt erst der Zusatz `merge` frei.

## Stufe 1: bis zum offenen Pull Request

1. **Voraussetzungen prüfen.** Du bist auf dem Issue-Branch, nicht auf `main`. `/review-issue` hat in dieser Sitzung keine Blocker gemeldet; ist es nicht gelaufen, hol es jetzt nach. `npm run lint`, `npm test` und `npm run build` laufen jetzt noch einmal durch, soweit vorhanden.
2. **Änderungen sichten.** `git status --porcelain`. Stage gezielt die Dateien dieses Issues, nicht pauschal alles. Nicht ins Repository gehören `.env`-Dateien, Schlüssel und `node_modules/`. Gehört eine Änderung nicht zum Issue, frag nach.
3. **Committen.** Der Betreff ist deutsch, höchstens etwa 70 Zeichen lang und trägt die Issue-Nummer am Ende, zum Beispiel `action.yml mit Metadaten und Inputs anlegen (#2)`. Darunter steht in ein bis drei Zeilen, was sich ändert und warum. Schreibe die Message in eine UTF-8-Datei und committe mit `git commit -F <datei>`.
4. **Pushen.** `git push -u origin <branch>`.
5. **Pull Request öffnen.** `gh pr create --base main --title <titel> --body-file <datei>`. Die Beschreibung enthält, was sich ändert, die Tabelle der Akzeptanzkriterien mit Beleg, die offenen Schritte des Maintainers und die Zeile `Closes #<nr>`. Bleiben nach dem Merge Kriterien offen, schreibe stattdessen `Refs #<nr>`, damit das Issue offen bleibt.
6. **Checks auswerten.** `gh pr checks <pr> --watch`. Gibt es noch keine Workflows, sag das. Schlägt ein Check fehl, lies die Ursache mit `/diagnose` aus, statt zu raten. Hat ReviewOps selbst kommentiert, fasse die Kommentare zusammen.
7. **Nachträglich Prüfbares belegen.** Belege jetzt die Akzeptanzkriterien, die erst mit dem Lauf auf GitHub prüfbar waren.
8. **Berichten und anhalten.** Nenne den Link zum Pull Request, das Ergebnis der Checks und was noch offen ist. Der Merge ist die Entscheidung des Maintainers.

## Stufe 2: mergen und abhaken (nur mit `merge`)

1. **Bereitschaft prüfen.** Die Checks sind grün und der Pull Request ist mergebar: `gh pr view <pr> --json mergeable,statusCheckRollup`.
2. **Mergen.** `gh pr merge <pr> --squash --delete-branch`. Ein Squash-Merge ergibt auf `main` genau einen Commit je Issue.
3. **Lokal aufräumen.** `git switch main`, `git pull --ff-only`, und den lokalen Branch löschen, falls er noch existiert.
4. **Abhaken.** Zeige die Checkboxen des Issues an und hake nur ab, was nachweislich erledigt ist:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/issue-tasks.mjs" list <nr>
   node "${CLAUDE_SKILL_DIR}/scripts/issue-tasks.mjs" check <nr> 1 2 5-8
   node "${CLAUDE_SKILL_DIR}/scripts/issue-tasks.mjs" check <nr> all
   ```

   Das Skript ändert den Issue-Text über `gh`, ohne dass die Umlaute darin Schaden nehmen.
5. **Status prüfen.** `gh issue view <nr> --json state,stateReason`. Durch `Closes` schließt GitHub das Issue beim Merge selbst. Ist es geschlossen, obwohl Punkte offen sind, öffne es wieder (`gh issue reopen <nr>`) und sag, was fehlt.
6. **Phase im Blick behalten.** Sind jetzt alle Issues des Milestones geschlossen, weise darauf hin. Den Milestone schließt du nur auf Wunsch.
7. **Berichten und warten.** Beginne kein weiteres Issue.
