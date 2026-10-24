# Nachspielzeit – Projektanweisungen

## Projekt
- Einzeldatei-App: `index.html`. Die React-Quelle (JSX) steht in `<script type="text/plain" id="app-source">` und wird im Browser von Babel kompiliert.
- Backend: Supabase. Deployment: `git push origin main` → Cloudflare Workers (Repo davidhille/Nachspielzeit, Branch main).
- Trainer-App: u8.nachspielzeit.app, Admin: admin.nachspielzeit.app. Nach jedem Push einmal hart neu laden.
- Sprache der App und der Antworten: Deutsch. Kurz, konkret, handlungsorientiert. Subtiler Humor, nie platt.

## Arbeitsweise
- Bei Design- oder Ablaufänderungen erst einen kurzen Vorschlag (bei Optik gern mit Mockup), dann umsetzen.
- Kleine, gezielte Änderungen. Größere Umbauten in eigenen Commits, damit sie sich zurückdrehen lassen.
- Nach jeder Änderung Syntaxprüfung der App-Quelle (acorn + acorn-jsx, Ausgabe "ACORN_OK"). Im Sandbox-Browser ist kein Test möglich, das immer offen sagen ("nur Syntax geprüft").
- Commit-Nachricht endet mit:
  Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
  Claude-Session: <aktuelle Session-URL>
- Nie Zugangscodes oder Passwörter eintippen. Bei Anmeldung im Browser den Nutzer bitten.
- Was ich nicht sicher weiß oder nicht verifizieren kann, sage ich offen, statt zu raten.

## Datenbank
- Neue Tabellen brauchen: RLS an, GRANT für anon/authenticated/service_role, Policy "access via code" mit `nsz_code_ok(team_id)`, danach `notify pgrst, 'reload schema'`.
- Team-Tabellen in `TEAM_TABLES` und `BACKUP_TABELLEN` eintragen. SQL immer dem Nutzer zum einmaligen Ausführen im Supabase SQL Editor geben (und in der App als Hinweis zeigen, nur für Admin).
- Löschen: Soft-Delete/Papierkorb bevorzugen.

## Design-Regeln
- Tokens nutzen (`--accent`, `--surface`, `--muted` …), keine festen Hex-Werte, damit der Dunkelmodus stimmt.
- Radien nur 8 / 12 / 16 / 999. Schrift in 12, 13, 14, 16, 20. Schatten nur `--sh-1/2/3`.
- Touch-Ziele mindestens 44 px, Fließtext mindestens 13 px.
- Formularelemente erben die Schrift (Inter). Überschriften: Space Grotesk.
- Karten mit `KartenTitel` (einklappbar), Leerzustände mit `EmptyState` (Icon, Überschrift, Button), Bestätigungen mit `confirmAnd`, Meldungen mit `meldung`, Eingaben mit `frageAnd`. Keine Browser-Dialoge (`alert`/`confirm`/`prompt`).
- Gefahr-Aktionen mit `styles.dangerBtn`. Umschalter mit `aria-pressed`.
- Mobil zuerst: untere Navigation unter 900 px, Desktop darüber. Kein horizontales Scrollen.

## Barrierefreiheit
- Kontrast mindestens 4,5:1 (Text) bzw. 3:1 (Bedienelemente), in Hell und Dunkel.
- Beschriftungen mit Feldern verknüpfen, sichtbarer Fokus, `lang="de"`, eine `h1` pro Seite.

## Nicht anfassen / Vorsicht
- Taktik-Editor (Code ca. Zeilen 3000–4950): Schriftgrößen bewusst frei, nicht auf 12 px vereinheitlichen (Entscheidung von David). Geometrie über `tkGeo`, Rotation über `getScreenCTM`. Änderungen dort immer separat melden.
- Berechnungen für Punkte und Anwesenheit nicht ohne Rückfrage ändern.

## Technische Details (Muster im Code)
- Prüfung: `cd /opt/node-tools && node -e "…"` parst den Inhalt von `app-source` mit acorn + acorn-jsx und gibt `ACORN_OK` aus.
- Aktionen mit `wrapAction(fn, successMsg, undo)` (liefert true/false) und `showToast`. Globale Helfer: `confirmAnd`, `meldung`, `frageAnd` (nutzen `TkDialog`).
- Kontexte: `FeatureCtx`, `TrainingBoardCtx`, `NavCtx` (setTab).
- `styles`-Objekt: `card`, `primaryBtn`/`secondaryBtn`, `linkBtn`, `dangerBtn`, `iconBtn`, `segNav`/`segBtn`, `chip`, `playerNameBtn`, `fieldRow`, `range`, `empty`. Neue Stile dort ergänzen, nicht inline duplizieren.
- Hilfsklassen: `.nz-tabelle` (fixierte erste Spalte), `.nz-sr` (nur für Screenreader, z. B. verstecktes h1), `.nz-nur-maus` (bei Touch ausgeblendet).
- Zahlen in Tabellen mit `tabular-nums`.

## Browser-Prüfungen
- Der eingebaute Browser braucht `request_access` für die Seite. Audits sind nur lesend.
- Anmeldung und Zugangscode tippt David selbst.

## Bekannte offene Punkte
- U8-Übungsfilter: Bedeutung und Wunschfilter noch nicht geklärt, bei Bedarf nachfragen.
- Eigentore werden nicht separat gespeichert (bräuchte eine neue DB-Spalte).
- Saisonwechsel vor der nächsten Saison klären; tägliches Backup gelegentlich prüfen.
- Sprint-Zeiten in Sekunden (z. B. "11:89") sind korrekt, kein Fehler.
