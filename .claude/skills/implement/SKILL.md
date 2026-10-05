---
name: implement
description: "Setzt genau ein Issue aus dem ReviewOps-Backlog um: Schritt für Schritt entlang seiner Tasks, mit Tests und einem Nachweis für jedes Akzeptanzkriterium. Verwende diesen Skill, wenn ein Issue oder eine Phase umgesetzt, gebaut, programmiert oder begonnen werden soll, zum Beispiel wenn es heißt: setz Issue 3 um, starte Phase 1, mach mit dem nächsten Issue weiter. Er committet und pusht nicht; das übernimmt /ship."
argument-hint: "[issue-nummer]"
---

# Implement

Setze genau ein Issue um, und zwar so, dass der Maintainer jedem Schritt folgen kann.

Issue: $ARGUMENTS

Ist das Issue nicht eindeutig benannt, nenne das nächste umsetzbare und lass es bestätigen. Eine genannte Phase meint ihr erstes umsetzbares Issue.

## Warum genau ein Issue

Der Backlog ist bewusst in kleine Schritte geschnitten, und der Maintainer gibt jeden einzeln frei. Was ein späteres Issue liefert, bleibt deshalb dort, auch wenn es sich gerade anbietet. Fehlt dir etwas, das erst ein späteres Issue bringt, dann halte an und sag es, statt es vorwegzunehmen.

## Vorbereiten

1. **Issue lesen.** `gh issue view <nr> --json title,state,body,comments`. In den Kommentaren steht der Plan aus `/drilling`, falls es einen gibt. Er gilt.
2. **Voraussetzungen prüfen.** Sind die Abhängigkeiten aus der Fußzeile geschlossen? Ist das Arbeitsverzeichnis sauber? Wenn nicht, kläre das zuerst mit dem Maintainer. Fremde Änderungen überschreibst du nicht.
3. **Offene Entscheidungen einschätzen.** Lässt das Issue etwas Wesentliches offen und es gibt keinen Plan, dann empfiehl `/drilling <nr>` und warte. Kleinigkeiten entscheidest du selbst und nennst sie im Bericht.
4. **Branch anlegen.** Von aktuellem `main` aus: `git switch main`, `git pull --ff-only`, `git switch -c issue-<nr>-<kurzname>`. Gibt es den Branch schon, arbeite dort weiter.

## Umsetzen

- Gehe die Tasks in der Reihenfolge des Issues durch. Sag vor jedem Task in ein, zwei Sätzen, was jetzt entsteht und wozu, und setze ihn dann um.
- Halte dich an die Regeln aus `CLAUDE.md`.
- Schreibe Tests zusammen mit dem Code, nicht hinterher. Tests rufen keine echte GitHub- oder OpenAI-API auf.
- Baue nach Änderungen unter `src/` neu, sobald es einen Build gibt. Bei einem veralteten `dist/` führt GitHub alten Code aus.
- Manche Tasks kann nur der Maintainer erledigen, etwa ein Repository-Secret anlegen oder Branch-Protection einschalten. Sammle sie unter „Dein Schritt“ mit dem genauen Klickweg, statt sie zu umgehen.
- Führt das Issue dauerhaft etwas Neues ein (Befehle, Ordner, Regeln), trage es in `CLAUDE.md` nach.

## Nachweisen

Fertig ist ein Issue erst, wenn jedes Akzeptanzkriterium belegt ist.

1. Lass `npm run lint`, `npm test` und `npm run build` laufen, soweit es sie schon gibt, und berichte das Ergebnis so, wie es ist.
2. Gehe jedes Akzeptanzkriterium einzeln durch und ordne es ein:
   - **erfüllt**, mit Beleg (ausgeführter Befehl, Ausgabe, Datei und Zeile)
   - **nicht erfüllt**, mit Grund
   - **erst nach dem Push prüfbar**, mit Angabe, woran es sich dann zeigt (etwa am Workflow-Lauf des Pull Requests)

## Bericht

```
## #<nr> <Titel>

**Gebaut:** <Dateien, je eine Zeile wozu>

**Akzeptanzkriterien**
| Kriterium | Status | Beleg |
|---|---|---|

**Selbst entschieden:** <Kleinigkeiten, die das Issue offen ließ>
**Dein Schritt:** <was nur der Maintainer tun kann>
**Offen:** <was nicht geklappt hat, oder „nichts“>
```

Committe und pushe nicht, und hake im Issue nichts ab. Das geschieht in `/ship`, nachdem `/review-issue <nr>` die Umsetzung geprüft hat. Nenne das als nächsten Schritt und beginne kein weiteres Issue.
