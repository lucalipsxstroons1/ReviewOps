---
name: drilling
description: "Schärft ein Issue vor der Umsetzung durch gezieltes Nachbohren: liest das Issue und den betroffenen Code, deckt offene Entscheidungen, Randfälle und Widersprüche auf und klärt sie mit dem Maintainer in einzelnen Rückfragen, jeweils mit einer Empfehlung. Am Ende steht ein kurzer, abgestimmter Umsetzungsplan. Verwende diesen Skill, bevor ein Issue umgesetzt wird, und immer, wenn ein Issue unklar, mehrdeutig oder zu groß wirkt oder jemand ein Issue durchsprechen, hinterfragen, schärfen oder planen will."
argument-hint: "[issue-nummer]"
---

# Drilling

Bohre so lange nach, bis klar ist, was genau gebaut wird, und der Maintainer die offenen Entscheidungen selbst getroffen hat. Danach soll `/implement` ohne Rückfragen durchlaufen können.

Zwei Dinge unterscheiden das von einer bloßen Zusammenfassung des Issues: Du suchst aktiv nach dem, was das Issue nicht sagt. Und du belastest den Maintainer nur mit Fragen, die wirklich seine Entscheidung sind.

Dieser Skill ändert keinen Code.

Issue: $ARGUMENTS

## 1. Verstehen

- Lies das Issue mit `gh issue view <nr> --json title,state,body,comments`. Die Option `--comments` allein liefert ohne Terminal nur die Kommentare, nicht den Issue-Text.
- Lies die Issues, von denen es abhängt, und die Issues, die darauf aufbauen. Dort stehen die Schnittstellen, an die sich dieses Issue halten muss.
- Sieh dir den betroffenen Code und die vorhandene Struktur an.

## 2. Lücken sammeln

Sammle alle offenen Punkte, bevor du die erste Frage stellst. Gehe dafür diese Blickwinkel durch:

- **Verhalten:** Defaults, Grenzfälle und Fehlerfälle. Was passiert bei leerer, riesiger oder kaputter Eingabe?
- **Schnittstellen:** Namen, Formate und Modulgrenzen, vor allem dort, wo spätere Issues anknüpfen.
- **Technik:** Bibliothek oder selbst schreiben, Versionen, Dateistruktur.
- **Sicherheit:** Wo fließen Secrets, und wo kommen nicht vertrauenswürdige Daten herein?
- **Nachweis:** Wie lässt sich jedes Akzeptanzkriterium belegen? Ein Kriterium, das sich nicht prüfen lässt, ist selbst eine Lücke.
- **Umfang:** Was gehört ausdrücklich nicht in dieses Issue?

## 3. Selbst klären, was sich klären lässt

Beantworte alles selbst, was aus dem Code, den Issues, `CLAUDE.md` oder der Dokumentation der verwendeten Bibliotheken hervorgeht. Übrig bleiben echte Entscheidungen: Fragen von Geschmack, Aufwand und Risiko, bei denen mehrere Antworten vertretbar sind.

## 4. Fragen

- Stelle die Frage mit der größten Tragweite zuerst.
- Stelle eine Entscheidung pro Frage. Zusammengehörige Fragen dürfen gemeinsam kommen, aber nie alle auf einmal: Antworten verändern oft die Folgefragen.
- Gib zu jeder Frage zwei bis drei konkrete Optionen mit ihrer Konsequenz und sag, welche du empfiehlst und warum. Nutze das Rückfrage-Werkzeug (AskUserQuestion), wenn es verfügbar ist.
- Bohre nach, wenn eine Antwort neue Fragen aufwirft oder einem Akzeptanzkriterium, einer Projektregel oder einem anderen Issue widerspricht. Sag das offen und begründe es. Zustimmen, um schneller fertig zu werden, hilft niemandem.
- Hör auf, sobald weitere Fragen die Umsetzung nicht mehr verändern würden.

Wirkt das Issue zu groß für einen Pull Request, schlage eine Teilung vor, statt es durchzuwinken.

## 5. Plan festhalten

Fasse das Ergebnis in dieser Form zusammen. Der Plan gehört ins Issue, nicht in den Chat:

```
## Plan für #<nr> <Titel>

**Entscheidungen**
- <Frage> → <Entscheidung> (<Grund in einem Halbsatz>)

**Schritte**
1. <Schritt in der Reihenfolge der Umsetzung>

**Nachweis**
- <Akzeptanzkriterium> → <wie es belegt wird>

**Nicht Teil dieses Issues**
- <Abgrenzung>
```

Poste den Plan ohne weitere Rückfrage als Kommentar im Issue, über eine UTF-8-Datei: `gh issue comment <nr> --body-file <datei>`. Dort findet ihn `/implement` auch in einer späteren Sitzung wieder. Im Chat steht danach nur der Link zum Kommentar, nicht der Plan. Haben sich Tasks oder Akzeptanzkriterien geändert, schlage die Anpassung des Issue-Textes vor und nimm sie ebenfalls erst nach Zustimmung vor.

Beginne nicht mit der Umsetzung. Nenne als nächsten Schritt `/implement <nr>`.
