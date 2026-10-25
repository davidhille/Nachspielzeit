# Nachspielzeit – Design-System (Kurzkatalog)

Gilt für Trainer-App und Admin. Die Regeln stehen in `CLAUDE.md`, der Design-Check (`cd tools && npm run design`) prüft sie automatisch. Dieser Katalog sagt, **was es gibt und wofür**. Stand: 25.10.2026, aus dem Code gelesen (`index.html`, `src/app.jsx`), nicht im Browser nachgemessen.

## 1. Grundlagen (perceptual patterns)

| Bereich | Wert |
|---|---|
| Tokens | Alle in `index.html` (`:root`, dazu Dunkel für `prefers-color-scheme` und `data-theme="dark"`). Neue Tokens immer in **allen drei** Blöcken anlegen. |
| Flächen | `--bg`, `--surface`, `--surface-2`, `--divider`, `--border`, `--border-strong`, `--track` (neutraler Grau-Ton für Tags, Leer-Symbole, Song-Zeile) |
| Text | `--text`, `--text-2`, `--muted`, `--muted-2`, `--accent-text`, `--danger-text`, `--success-text`, `--loss-text` |
| Akzent | `--accent` (Teamfarbe, wird per `wendeTeamfarbeAn` überschrieben), `--focus`. Kein blasses Akzent-Rosa mehr: Gewählte Umschalter/Chips = Vollfläche in `--auswahl` (Weinrot, aus `--accent` abgedunkelt, folgt der Teamfarbe; bewusst anders als Kopfzeile und Buttons), Hintergründe neutral über `--track` |
| Status | `--pos-bg/-text`, `--neg-bg`, `--win-bg`, `--loss-bg`, `--draw-bg`, `--warn-bg/-text`, `--info-bg/-text` |
| Einzelfarben je Team | `--auswahl` (Umschalter), `--chip` (Filter-Chips, Standard = Umschalter), `--trikot` / `--trikot-text` (Trikot-Symbol), `--regler` (Schieberegler, Standard = Akzent); einstellbar im Admin (Kopfzeile, Buttons & Akzent, Umschalter, Filter-Chips, Trikot, Regler), Standard folgt der Teamfarbe |
| Sonstige Töne | `--gold`, `--gold-2`, `--tan-*`, `--lav-*` |
| Kopfzeile | `--header-grad` (Trainer), `--header-grad-admin` (Admin), Text darauf: `--on-header`, `--on-header-soft` |
| Schatten | `--sh-1` Karten, `--sh-2` Überlagerungen, `--sh-3` Dialoge; `--sh-glow-sm` roter Schein (nur runde Play-Knöpfe) |
| Radien | 8 (Felder, Chips), 12 (Karten-Inhalte, Knöpfe), 16 (Karten), 999 (Pillen, runde Knöpfe), 50 % (Kreise) |
| Schrift | Fließtext Inter 13/14, Auszeichnung 12, Überschriften Space Grotesk 16/20. Mindestens 13 px für Fließtext. Ausnahme: die Spieluhr (`styles.uhrZeit`, 40 px), damit sie auf dem Spielfeld lesbar ist. |
| Touch | Mindestens 44 × 44 px |
| Fokus | Globales `:focus-visible` in `index.html`; nie `outline: none` ohne Ersatz-Rahmen |
| Zahlen | `tabular-nums` in Tabellen |

Bewusste Ausnahmen (Wrapped, Karten-Vorschau, Taktik-Editor, Canvas-Farben): `tools/design-ausnahmen.json` und `CLAUDE.md`.

## 2. Bausteine (functional patterns)

Neue Stile im `styles`-Objekt (`src/app.jsx`) ergänzen, nicht inline duplizieren.

| Baustein | Zweck | Varianten / Zustände | Hinweise |
|---|---|---|---|
| `styles.primaryBtn` | Hauptaktion einer Ansicht (Speichern) | Volle Breite, 44 px hoch | Pro Ansicht höchstens eine |
| `styles.rowBtn` | Weitere Aktion in Zeilen (Hinzufügen) | Höhe 44, Breite nach Inhalt | Zeilenknopf, bewusst mit Akzentfläche (früher `secondaryBtn`, umbenannt, weil der Name eine zurückgenommene Optik versprach) |
| `styles.linkBtn` | Textaktion, z. B. "Alle anzeigen" | Transparent, 44 px Tippfläche | |
| `styles.dangerBtn` | Löschen, Zurücksetzen (nur rote Schrift, keine Fläche) | **Teilstil**, immer mit Grundknopf kombinieren: `{ ...styles.rowBtn, ...styles.dangerBtn }` | Löschen über `confirmAnd` bestätigen |
| `styles.iconBtn` (+ `iconBtnLavender`, `iconBtnDanger`) | Runde Icon-Aktion in Karten | 44 px, Kreis, braucht `aria-label` | |
| `styles.chip` / `chipActive` | Filter, Mehrfachauswahl | Umschalter mit `aria-pressed` | |
| `styles.segNav` / `segBtn` / `segBtnActive` | Umschalten zwischen Ansichten | Weißer Rahmen, aktiver Reiter Vollfläche `--auswahl` (Weinrot) mit weißem Text, wie `chipActive` | `aria-pressed`. Auswahl = Vollfläche, nie blasse Tönung |
| `styles.card` | Inhaltsblock | Radius 16, Schatten `--sh-1` | Titel mit `KartenTitel` |
| `KartenTitel` | Einklappbarer Kartentitel | `block`, `aktion`, `zuStart` | Zustand pro Titel gemerkt (`NZ_ZU`) |
| `EmptyState` | Leerzustand: Icon, Überschrift, Hinweis, Weiter-Link | Text "Satz. Hinweis." wird geteilt | Nutzt `NavCtx` für den Sprung |
| `confirmAnd(text, fn)` | Bestätigung vor Gefahraktionen | | Nie `window.confirm` |
| `meldung(text, typ)` | Rückmeldung als Toast | `info`, Fehler | Nie `window.alert` |
| `frageAnd(titel, wert, fn)` | Texteingabe im Dialog | | Nie `window.prompt` |
| `wrapAction(fn, ok, undo)` | Aktion mit Toast und Rückgängig | liefert true/false | |
| `Avatar` | Spielerbild oder Initialen | `size`, `photoUrl`, `ring` | Farben aus `AVATAR_FARBEN` |
| `Header` / `TeamWechsler` | Kopfzeile mit Team-Menü | Admin-Variante mit "Zur Trainer-App" | Team-Menü ist `position: fixed` (Header schneidet sonst ab) |
| `.nz-tabelle`, `.nz-sr`, `.nz-nur-maus` | Hilfsklassen | | siehe `CLAUDE.md` |

## 3. Neuen Baustein aufnehmen

1. Wird er an mindestens **zwei** Stellen gebraucht? Sonst inline lassen.
2. Name nach Zweck, nicht nach Aussehen (`Gefahr`, nicht `RoterKnopf`).
3. Nur Tokens und Skalenwerte aus Abschnitt 1.
4. Zustände prüfen: normal, Fokus, deaktiviert, leer, Dunkelmodus.
5. `cd tools && npm run alles` und hier eintragen.

## 4. Offene Punkte

- Kartenfarben (`KARTEN_FARBE`) und Avatar-Palette haben keine Dunkelmodus-Prüfung.
