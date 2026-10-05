---
name: diagnose
description: "Findet die Ursache eines fehlgeschlagenen oder auffälligen GitHub-Actions-Laufs in diesem Repository, egal ob CI oder ReviewOps selbst, anhand der Logs und schlägt die kleinste passende Korrektur vor. Verwende diesen Skill, wenn ein Workflow rot ist, ein Check am Pull Request fehlschlägt, die Action nichts oder etwas Falsches kommentiert oder gefragt wird, warum ein Lauf fehlgeschlagen ist."
argument-hint: "[run-id oder pr-nummer]"
---

# Diagnose

Finde heraus, warum ein Workflow-Lauf fehlgeschlagen ist, und belege die Ursache mit dem Log.

Aufruf-Argument: $ARGUMENTS

Eine GitHub Action scheitert auf GitHub, nicht lokal. Die Versuchung ist groß, aus der Fehlermeldung am Pull Request auf eine Ursache zu schließen und gleich etwas zu ändern. Lies erst das Log: Die meisten Fehlschläge in diesem Projekt haben eine von wenigen bekannten Ursachen, und die steht dort wörtlich.

## Vorgehen

1. **Lauf bestimmen.** Mit einer Run-ID direkt. Mit einer PR-Nummer über `gh pr checks <pr>`. Ohne Argument ist es der jüngste fehlgeschlagene Lauf des aktuellen Branches: `gh run list --branch <branch> --limit 10 --json databaseId,workflowName,conclusion,headSha,event,createdAt`
2. **Einordnen.** `gh run view <id> --json jobs,headSha,event,workflowName`. Welcher Workflow, welcher Job, welcher Step? Auf welchem Commit lief er, und ist das der Stand, den du erwartest?
3. **Log lesen.** `gh run view <id> --log-failed`. Reicht das nicht, lies das ganze Log mit `--log`.
4. **Ursache benennen**, mit der Log-Zeile als Beleg.
5. **Mehr Detail holen**, wenn das Log zu wenig sagt: `gh run rerun <id> --debug` wiederholt den Lauf mit Debug-Ausgabe. Frag vorher, denn ein neuer Lauf kann erneut einen KI-Aufruf kosten.

## Bekannte Ursachen in diesem Projekt

Prüfe sie in dieser Reihenfolge. Die oberen sind die häufigeren.

| Symptom | Ursache |
|---|---|
| Eine Änderung unter `src/` zeigt im Lauf keine Wirkung, oder der dist-Check der CI schlägt fehl | `dist/` wurde nicht neu gebaut. GitHub führt aus, was in `dist/` liegt. |
| Der dist-Check schlägt fehl, obwohl gebaut wurde | Zeilenenden (CRLF statt LF) oder lokal andere Paketversionen als in der CI (`npm install` statt `npm ci`) |
| `Can't find 'action.yml'` bei `uses: ./` | `actions/checkout` fehlt vor dem Step |
| `Input required and not supplied: openai-api-key` | Das Secret `OPENAI_API_KEY` fehlt, oder der Pull Request kommt aus einem Fork oder von Dependabot. Dort gibt GitHub keine Secrets heraus. |
| `403 Resource not accessible by integration` | Dem Workflow fehlt `permissions: pull-requests: write` |
| `422 Unprocessable Entity` beim Posten des Reviews | Eine kommentierte Zeile gehört nicht zum Diff, oder `commit_id` ist der Merge-Commit statt `pull_request.head.sha` |
| `401` von OpenAI | Der API-Key ist ungültig oder abgelaufen |
| `429` von OpenAI | Rate-Limit oder Kontingent erschöpft |
| Der Workflow startet gar nicht | Der Trigger passt nicht zum Ereignis, oder die Workflow-Datei ist auf dem Branch ungültig |

Passt keine davon, ist das kein Grund zu raten. Sag, was das Log zeigt und was es offen lässt.

## Umgang mit Logs

Logs können Inhalte aus Diffs und Modellantworten enthalten. Kopiere daraus nichts in Issues oder Pull Requests, was wie ein Token oder Schlüssel aussieht. Steht ein Secret lesbar im Log, sag das sofort: Es muss ersetzt werden, und die Stelle, die es ausgibt, ist ein Fehler mit Vorrang.

## Bericht

```
**Lauf:** <Workflow> #<id> auf <branch> (<commit>)
**Fehlgeschlagen:** <Job> › <Step>
**Ursache:** <ein Satz>
**Beleg:** <Log-Zeile>
**Korrektur:** <kleinste passende Änderung>
```

Setze die Korrektur erst um, wenn der Maintainer zustimmt. Gehört sie zu einem Issue, nenne es.
