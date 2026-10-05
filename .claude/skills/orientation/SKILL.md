---
name: orientation
description: "Standortbestimmung im ReviewOps-Projekt: zeigt die aktuelle Phase, erledigte und offene Issues, den Git-Stand, offene Pull Requests und Workflow-Läufe und nennt das nächste umsetzbare Issue. Mit einer Issue-Nummer liefert er den Einstieg in genau dieses Issue. Verwende diesen Skill zu Beginn jeder Sitzung und immer, wenn gefragt wird, wo wir stehen, was als Nächstes dran ist, was noch offen ist oder ob ein Issue schon erledigt oder abgehakt ist."
argument-hint: "[issue-nummer]"
---

# Orientation

Verschaffe dem Maintainer und dir ein belastbares Bild vom Stand des Projekts.

Der Wert dieses Skills liegt darin, dass die Antwort aus dem tatsächlichen Zustand kommt und nicht aus der Erinnerung an frühere Sitzungen. Lies deshalb alles frisch aus Git und von GitHub, auch wenn du glaubst, den Stand zu kennen. Der Skill beobachtet nur: Er ändert keine Dateien, committet nichts und verändert nichts auf GitHub.

Aufruf-Argument: $ARGUMENTS

## Ohne Issue-Nummer: Projektstand

1. **Git lesen.** `git fetch --quiet`, dann `git status -sb` und `git log --oneline -5`. Halte fest: aktueller Branch, uncommittete Änderungen, Abstand zu `origin/main`.
2. **Backlog lesen.** `gh issue list --state all --limit 100 --json number,title,state,milestone,labels`
3. **Laufendes lesen.** `gh pr list --json number,title,headRefName,isDraft` und `gh run list --limit 5 --json databaseId,workflowName,conclusion,headBranch,createdAt`
4. **Aktuelle Phase bestimmen.** Das ist der früheste Milestone, in dem noch Issues offen sind.
5. **Nächstes umsetzbares Issue bestimmen.** Gehe die offenen Issues der aktuellen Phase in aufsteigender Reihenfolge durch und lies mit `gh issue view <nr>` die Fußzeile („Abhängig von: #n“). Das erste, dessen Abhängigkeiten alle geschlossen sind, ist das nächste.
6. **Auf Widersprüche achten.** Zum Beispiel: ein Branch `issue-3-…` mit Änderungen, obwohl Issue #3 geschlossen ist. Ein gemergter Pull Request, dessen Issue noch offen ist. Uncommittete Änderungen auf `main`. Ein fehlgeschlagener Lauf auf `main`.

## Mit Issue-Nummer: Einstieg in ein Issue

1. Lies das Issue mit `gh issue view <nr> --json title,state,body,comments`: Tasks, Akzeptanzkriterien, Abhängigkeiten und ein eventuell vorhandener Plan aus `/drilling`.
2. Prüfe, ob die Abhängigkeiten geschlossen sind.
3. Sieh im Repository nach, was es zu jedem Task schon gibt. Ordne jeden Task als erledigt, teilweise erledigt oder offen ein und nenne den Beleg (Datei, Zeile oder Befehl).
4. Nenne die betroffenen Stellen und die vorhandenen Bausteine, auf denen die Umsetzung aufbauen kann.
5. Benenne die Entscheidungen, die das Issue offen lässt.

## Bericht

Halte den Bericht so kurz, dass er auf einen Bildschirm passt. Für den Projektstand:

```
**Phase:** <Milestone>, <x> von <y> Issues erledigt
**Git:** <Branch>, <sauber oder n geänderte Dateien>, <Abstand zu origin/main>
**Offen in dieser Phase:** #<nr> <Titel>, …
**Als Nächstes:** #<nr> <Titel>, weil <ein Satz>
**Auffällig:** <Widersprüche, fehlgeschlagene Läufe, offene Pull Requests oder „nichts“>
```

Für ein einzelnes Issue: der Status je Task und Akzeptanzkriterium, die betroffenen Dateien und die offenen Entscheidungen.

Schließe mit dem einen Schritt, der jetzt sinnvoll ist, zum Beispiel `/drilling 4` bei offenen Entscheidungen oder `/implement 4`, wenn alles klar ist. Beginne ihn nicht selbst: Der Maintainer gibt jedes Issue frei.
