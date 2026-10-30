# Nachspielzeit – Projektanweisungen

## Projekt
- App: Quelle ist `src/app.jsx` (React/JSX). **Nach jeder Änderung daran `node tools/bauen.js` ausführen** und `src/app.jsx`, die neue `app.<Hash>.js` und `index.html` gemeinsam committen; `index.html` lädt nur die gebaute Datei, der Browser übersetzt nichts mehr (CI schlägt fehl, wenn vergessen). Dazu `index.html` (Gerüst, Styles) plus `js/logik.js` (reine Rechenlogik: Punkte, Saison, Karten; klassisches Skript vor der App, von den Tests direkt geprüft) und `js/sitzung.js` (`Sitzung.code`, `.team`, `.info`; Anmelden/Abmelden nur über `Sitzung.merkeCode` / `Sitzung.vergiss`, nie `localStorage` direkt) und `js/db.js` (Supabase-Zugriff: `dbSelect`/`dbInsert`/`dbUpsert`/`dbUpdate`/`dbDelete`/`dbDeleteWhere`/`dbIdsWhere`/`ersetzeGruppe`, `nszFetch`, `TEAM_TABLES`; hängt nur von `Sitzung` ab). Ladereihenfolge in `index.html`: logik, sitzung, db, dann die App.
- Backend: Supabase. Deployment: `git push origin main` → Cloudflare Workers (Repo davidhille/Nachspielzeit, Branch main).
- Trainer-App: u8.nachspielzeit.app, Admin: admin.nachspielzeit.app. Nach jedem Push einmal hart neu laden.
- Sprache der App und der Antworten: Deutsch. Kurz, konkret, handlungsorientiert. Subtiler Humor, nie platt.

## Arbeitsweise
- Änderungen an der Eltern-Seite erst in `KartenSeiteVorschau`; sobald David zufrieden ist, immer auch in `KartenSeitePlus` (freigegebene Seite) übernehmen, ohne dass er es erneut anstoßen muss.
- Bei Design- oder Ablaufänderungen erst einen kurzen Vorschlag (bei Optik gern mit Mockup), dann umsetzen.
- Kleine, gezielte Änderungen. Größere Umbauten in eigenen Commits, damit sie sich zurückdrehen lassen.
- Branches: Kleine Änderungen direkt auf `main` (kleine, getrennte Commits, Rollback per `git revert`). Größere Umbauten und alles mit riskanter Datenmigration auf `feature/<name>`, Merge nach `main` erst, wenn David zufrieden ist. `main` ist live (Deployment per Push). Datenbank-SQL lässt sich nicht per Git zurückrollen, deshalb wiederholbar schreiben.
- Nach jeder Änderung Syntaxprüfung der App-Quelle (acorn + acorn-jsx, Ausgabe "ACORN_OK"). Im Sandbox-Browser ist kein Test möglich, das immer offen sagen ("nur Syntax geprüft").
- Commit-Nachricht endet mit:
  Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
  Claude-Session: <aktuelle Session-URL>
- Nie Zugangscodes oder Passwörter eintippen. Bei Anmeldung im Browser den Nutzer bitten.
- Was ich nicht sicher weiß oder nicht verifizieren kann, sage ich offen, statt zu raten.

## Datenbank
- Neue Tabellen brauchen: RLS an, GRANT für anon/authenticated/service_role, Policy "access via code" mit `nsz_code_ok(team_id)`, danach `notify pgrst, 'reload schema'`.
- Team-Tabellen in `TEAM_TABLES` und `BACKUP_TABELLEN` eintragen. SQL immer dem Nutzer im Chat zum einmaligen Ausführen im Supabase SQL Editor geben (und in `supabase/schema.sql` ablegen), nicht als Block in der App anzeigen.
- Löschen: Soft-Delete/Papierkorb bevorzugen.
- Der Server entscheidet, der Client filtert nur: Zugriffsschutz liegt in RLS (`nsz_code_ok`, `nsz_is_admin`), der Teamfilter im Client ist Komfort.
- Sonderfall `uebungen`: nutzt `team_ids[]` statt `team_id` (`'alle'` = für alle Teams lesbar, Prüfung über `nsz_code_ok_arr`). Schema und Wiederherstellung: `supabase/`.
- Entwicklungsdateien (README, CLAUDE.md, DESIGN.md, supabase/) stehen in `.assetsignore` und werden nicht ausgeliefert.

## Design-Regeln
- Bausteinkatalog und Tokens: `DESIGN.md` (neue Bausteine dort eintragen).
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
- Taktik-Editor (Code in `src/app.jsx`, ca. Zeilen 2800–4750): Schriftgrößen bewusst frei, nicht auf 12 px vereinheitlichen (Entscheidung von David). Geometrie über `tkGeo`, Rotation über `getScreenCTM`. Änderungen dort immer separat melden.
- Berechnungen für Punkte und Anwesenheit (`js/logik.js`) nicht ohne Rückfrage ändern. Neue Rechenfunktionen ohne React/DB-Bezug dorthin, nicht in `index.html`.

## Technische Details (Muster im Code)
- Prüfung: `cd /opt/node-tools && node -e "…"` parst `src/app.jsx` mit acorn + acorn-jsx und gibt `ACORN_OK` aus. Einfacher: `cd tools && npm run alles` (Syntax, Lint, Design-Check, Build-Prüfung, Tests). Der Design-Check (`npm run design`) meldet `outline: none`, undefinierte Tokens, Hex-Fallbacks in `var()`, Radien außerhalb 8/12/16/999 und Schatten ohne `--sh-`-Token (Taktik-Editor ausgenommen). Bewusste Ausnahmen stehen in `tools/design-ausnahmen.json`; neue nur mit Begründung per `npm run design -- --ausnahmen-schreiben` aufnehmen.
- Aktionen mit `wrapAction(fn, successMsg, undo)` (liefert true/false) und `showToast`. Globale Helfer: `confirmAnd`, `meldung`, `frageAnd` (nutzen `TkDialog`).
- Kontexte: `FeatureCtx`, `TrainingBoardCtx`, `NavCtx` (setTab).
- `styles`-Objekt: `card`, `primaryBtn`/`rowBtn`, `linkBtn`, `dangerBtn`, `iconBtn`, `segNav`/`segBtn`, `chip`, `playerNameBtn`, `fieldRow`, `range`, `empty`. Neue Stile dort ergänzen, nicht inline duplizieren.
- Hilfsklassen: `.nz-tabelle` (fixierte erste Spalte), `.nz-sr` (nur für Screenreader, z. B. verstecktes h1), `.nz-nur-maus` (bei Touch ausgeblendet).
- Zahlen in Tabellen mit `tabular-nums`.

## Browser-Prüfungen
- Der eingebaute Browser braucht `request_access` für die Seite. Audits sind nur lesend.
- Anmeldung und Zugangscode tippt David selbst.

## Bekannte offene Punkte
- U8-Übungsfilter: Bedeutung und Wunschfilter noch nicht geklärt, bei Bedarf nachfragen.
- Eigentore werden nicht separat gespeichert (bräuchte eine neue DB-Spalte).
- Saisonwechsel vor der nächsten Saison klären; tägliches Backup gelegentlich prüfen.
- Mehrere Vereine (später, kein Termin): neue Ebene Verein über Team, Rollen Haupt-Admin / Vereins-Admin / Trainer, Logo und Farbe je Verein, Nachspielzeit-Logo für die Haupt-Administration. Erst umsetzen, wenn ein zweiter Verein konkret ansteht (Datenmodell, Rechte/RLS, Oberfläche in getrennten Commits).
- Sprint-Zeiten in Sekunden (z. B. "11:89") sind korrekt, kein Fehler.
