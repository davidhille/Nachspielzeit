# Datenbank (Supabase)

`schema.sql` ist ein Abbild des Schemas `public` (Tabellen, Funktionen, Zeilenregeln/RLS). Es ist **keine Migration**: Es entsteht aus dem täglichen Backup (`pg_dump --schema-only`, Repo `nachspielzeit-backup`, Datei `dump/schema.sql`) und wird bei Schemaänderungen neu übernommen.

## Zugriffsmodell
- Die App spricht per REST mit dem öffentlichen anon-Schlüssel und schickt den Zugangscode im Header `x-access-code`.
- **Der Server entscheidet, der Client filtert nur.** Jede Tabelle hat RLS. Die Regeln prüfen den Code über `nsz_code_ok(team_id)` (Team-Zugang) oder `nsz_is_admin()` (Code ohne Team = Admin). Der Teamfilter im Client (`?team=`, Hostname) ist Komfort, kein Schutz.
- `access_codes` ist nur für Admin lesbar. `check_access(code)` liefert `{ok, team_id}` für die Anmeldung.
- Alle Teamtabellen haben `team_id` (Standardwert `u8`). Sonderfall: `uebungen` nutzt `team_ids text[]` (`'alle'` = für alle Teams lesbar, Prüfung über `nsz_code_ok_arr`). `team_settings` und `teams` haben keine `team_id`.
- Upserts: `app_features` (`team_id,key`) und `material_bestand` (`team_id,date,material`) haben zusammengesetzte Schlüssel.

## Wiederherstellen (Datenbank verloren)
1. Neues Supabase-Projekt anlegen, im SQL Editor `schema.sql` ausführen.
2. Daten einspielen: `dump/data.sql` aus dem Backup-Repo (reine INSERTs).
3. Bucket `profilbilder` (öffentlich) anlegen, Bilder aus `storage/profilbilder/` im Backup-Repo hochladen.
4. In `index.html` `SUPABASE_URL` und `SUPABASE_KEY` anpassen (die Bild-URLs in den Daten zeigen noch auf das alte Projekt und müssen ersetzt werden).
5. Mindestens einen Admin-Code in `access_codes` eintragen (`team_id` leer).

## Was dieses Schema nicht enthält (offen)
- **Berechtigungen (GRANTs)**: der Dump wird mit `--no-privileges` erstellt. Meldet PostgREST „permission denied“, die GRANT-Zeilen aus den SQL-Hinweisen in der App (Administration) ausführen.
- **Storage-Regeln** (Schema `storage`, Bucket `profilbilder`): liegen nicht in diesem Dump. Der Stand in der Live-Datenbank ist noch nicht ins Repo übernommen.
- Das Backup sichert Daten und Bilder, die in den Daten verlinkt sind. Nicht im Backup: `auth`-Daten (werden nicht genutzt) und Bilder ohne Verweis.
