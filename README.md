# Nachspielzeit

Web-App zur Spielerbewertung für Jugendmannschaften (SV Heimstetten). Einzeldatei-App: `index.html` enthält Styles und die React-Quelle (JSX in `<script type="text/plain" id="app-source">`), die der Browser mit dem mitgelieferten Babel (`vendor/`) übersetzt. Es gibt keinen Build-Schritt.

## Aufbau
| Teil | Ort |
|---|---|
| App | `index.html` |
| Bibliotheken, Schriften (selbst gehostet) | `vendor/` (Versionen in `vendor/VERSIONEN.txt`) |
| Datenbank | Supabase, Schema in `supabase/` |
| Hosting | Cloudflare Workers (`wrangler.toml`), Deployment per `git push origin main` |
| Backup | täglich per GitHub Actions in ein privates Repo (siehe unten) |

Adressen: Trainer-App `u8.nachspielzeit.app` (Team aus dem Hostnamen oder `?team=`), Administration `admin.nachspielzeit.app`. Nach einem Push einmal hart neu laden.

## Entwickeln
- Projektregeln (Design, Barrierefreiheit, Vorgehen) stehen in `CLAUDE.md`.
- Syntaxprüfung der App-Quelle: Inhalt von `app-source` mit acorn + acorn-jsx parsen.
- Lokal: `python3 -m http.server` im Ordner, dann `http://localhost:8000/index.html`.
- Neue Tabellen: RLS an, Policy „access via code“ mit `nsz_code_ok(team_id)`, in `TEAM_TABLES` und `BACKUP_TABELLEN` eintragen.

## Betrieb
- **Backup**: Workflow „Supabase Backup“ im Repo `nachspielzeit-backup`, täglich (geplant 05:17 Uhr, GitHub startet den Lauf oft Stunden später). Er sichert Schema, Daten und verlinkte Bilder, bricht bei unplausiblen Dumps ab und meldet fehlende Bilder als Fehler. Stände älter als 90 Tage werden zu einem zusammengefasst.
- **Löschkonzept**: Austritt/Widerruf → Papierkorb, nach 30 Tagen Erinnerung zum endgültigen Löschen (von Hand, Frist einstellbar). Aus dem Backup verschwinden gelöschte Daten nach spätestens ca. 90 Tagen.
- **Fehlerprotokoll**: anonyme Fehlermeldungen (ohne Namen/Codes) unter Administration → Fehler.
- **Datenschutz**: Einwilligung der Eltern, Verträge mit Dienstleistern und Hinweise für Eltern gehören dem Verein; Arbeitsunterlagen liegen nicht im Repo.
