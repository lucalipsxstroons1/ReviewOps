---
name: review-issue
description: "Prüft die Umsetzung eines Issues, bevor sie committet wird: jedes Akzeptanzkriterium mit Beleg, dazu Projektregeln, Sicherheit, Tests und ein aktuelles dist/. Liefert eine nach Schwere geordnete Befundliste und ein klares Urteil. Verwende diesen Skill nach /implement und immer, wenn gefragt wird, ob ein Issue fertig, abnahmereif oder sauber umgesetzt ist. Das eingebaute /review sucht allgemein nach Fehlern im Diff; dieser Skill prüft zusätzlich gegen das Issue und die Projektregeln."
argument-hint: "[issue-nummer]"
---

# Review Issue

Prüfe, ob die Umsetzung eines Issues wirklich fertig ist.

Issue: $ARGUMENTS

## Haltung

Prüfe wie jemand, der den Code nicht geschrieben hat. Meist hast du ihn in derselben Sitzung selbst geschrieben, und genau dann ist die Versuchung groß, dem eigenen Bericht zu glauben. Verlass dich deshalb auf nichts, was du nicht jetzt neu gelesen oder ausgeführt hast.

Der Skill ändert nichts. Er berichtet, und der Maintainer entscheidet, was nachgebessert wird.

## Vorgehen

1. **Maßstab lesen.** `gh issue view <nr> --json title,state,body,comments`. Maßgeblich sind die Akzeptanzkriterien und, falls vorhanden, der Plan aus `/drilling`.
2. **Umfang bestimmen.** Alles, was sich gegenüber `main` unterscheidet: Commits auf dem Branch, uncommittete Änderungen und neue Dateien (`git status --porcelain`, `git diff main`).
3. **Prüfläufe starten.** `npm run lint`, `npm test` und `npm run build`, soweit vorhanden. Zeigt `git status` nach dem Build Änderungen in `dist/`, war `dist/` veraltet.
4. **Akzeptanzkriterien prüfen.** Jedes einzeln, belegt durch einen Befehl, eine Ausgabe oder eine Stelle im Code. Mögliche Ergebnisse: erfüllt, nicht erfüllt, erst nach dem Push prüfbar.
5. **Umfang gegen das Issue halten.** Sind alle Tasks erledigt? Ist etwas dabei, das nicht zu diesem Issue gehört?
6. **Code lesen**, mit diesen Fragen:
   - Stimmt das Verhalten auch an den Rändern: leere Eingabe, sehr große Eingabe, fehlende Felder, Fehler der API?
   - Enden Fehler in einer verständlichen Meldung, oder werden sie verschluckt?
   - Kann ein Secret in ein Log, eine Fehlermeldung, einen Kommentar oder eine Testdatei gelangen? Achte auf ausgegebene Payloads, Header und ganze Fehlerobjekte.
   - Werden Diff-Inhalte und Modellantworten geprüft, bevor sie etwas auslösen?
   - Haben Workflows nur die Rechte, die sie brauchen?
   - Prüfen die Tests das Verhalten, auch den Fehlerfall, und kommen sie ohne echte API aus?
   - Ist etwas komplizierter als nötig?
7. **Repository ansehen.** Unter den Änderungen sind keine `.env`-Dateien, keine Schlüssel und kein `node_modules/`. `package-lock.json` passt zu `package.json`.

## Bericht

```
## Review #<nr> <Titel>

**Urteil:** Bereit für /ship | Nacharbeit nötig

**Akzeptanzkriterien**
| Kriterium | Status | Beleg |
|---|---|---|

**Befunde**
- **Blocker** <Datei und Zeile>: <Problem> → <Vorschlag>
- **Sollte** …
- **Hinweis** …
```

- **Blocker:** ein verfehltes Akzeptanzkriterium, ein Fehler im Verhalten, ein Sicherheitsproblem oder ein roter Prüflauf.
- **Sollte:** macht den Code spürbar robuster oder verständlicher, hält den Abschluss aber nicht auf.
- **Hinweis:** eine Beobachtung ohne Handlungsdruck.

Gibt es keine Befunde, sag das in einem Satz, statt welche zu erfinden. Bei „Nacharbeit nötig“ frag, welche Befunde du beheben sollst. Bei „Bereit“ ist der nächste Schritt `/ship <nr>`.
