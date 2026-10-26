/* Nachspielzeit – Datenzugriff (Supabase REST): Verbindung, Teamfilter, Lesen/Schreiben/Löschen mit Zeitlimit.
   Klassisches Skript nach js/sitzung.js, vor der App. Hängt nur von Sitzung ab (Code und Team werden bei jedem Aufruf gelesen).
   Der Server entscheidet über den Zugriff (RLS), der Teamfilter hier ist nur Komfort. */

/* ---------- Supabase-Verbindung ---------- */
const SUPABASE_URL = "https://ttydglqmpkgfqkrovdjf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0eWRnbHFtcGtnZnFrcm92ZGpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NjY4NzIsImV4cCI6MjEwNDE0Mjg3Mn0.GW-ppcVrqrFmuCs1FGfPsez3O-b23YSy4VzgooIrqCk";
const REST = SUPABASE_URL + "/rest/v1/";

const baseHeaders = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});
const dbHeaders = (extra = {}) => baseHeaders({ "x-access-code": Sitzung.code, ...extra });

/* ---------- Teams (Mandanten) ----------
   Das aktuelle Team steht in Sitzung.team (aus Hostname, ?team=… oder, im Admin, aus der Team-Auswahl).
   Tabellen in TEAM_TABLES werden nach team_id gefiltert; neue Zeilen bekommen automatisch die team_id.
   Fehlt die Spalte noch in der Datenbank, arbeitet die App wie bisher ohne Filter. */
const TEAM_TABLES = [
  "players", "basisqualitaet", "trainingstermine", "trainings", "entwicklungen", "gegner", "spieltage", "spiele", "torschuetzen",
  "spieltag_gegner", "spieltag_teilnehmer", "material_bestand", "uebungen", "training_uebungen", "app_features", "taktik_boards", "training_boards",
];
const teamFilterAktiv = (table) => TEAM_TABLES.includes(table);

const mitTeamId = (table, rowOrRows) => {
  if (!teamFilterAktiv(table)) return rowOrRows;
  const tag = (r) =>
    table === "uebungen"
      ? r.team_ids === undefined
        ? { ...r, team_ids: [Sitzung.team] }
        : r
      : r.team_id === undefined
      ? { ...r, team_id: Sitzung.team }
      : r;
  return Array.isArray(rowOrRows) ? rowOrRows.map(tag) : tag(rowOrRows);
};

async function pruefeZugang(code) {
  const res = await nszFetch(REST + "rpc/check_access", { method: "POST", headers: baseHeaders(), body: JSON.stringify({ code }) });
  if (res.ok) {
    const j = await res.json();
    return { ok: !!(j && j.ok), team_id: (j && j.team_id) || null };
  }
  throw new Error("Zugang konnte nicht geprüft werden");
}

/* fetch mit Zeitlimit: hängt das Netz (z. B. am Platz), kommt nach 20 s (Uploads 60 s) eine verständliche Meldung statt endlosem Warten.
   Bei Schreibzugriffen ist nach einem Zeitlimit offen, ob der Server die Änderung noch angenommen hat, daher die vorsichtige Formulierung. */
async function nszFetch(url, opts = {}, ms = String(url).includes("/storage/v1/") ? 60000 : 20000) {
  const schreibt = !!opts.method && opts.method !== "GET";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(schreibt
        ? "Verbindung zu schwach, Speichern nicht bestätigt. Bitte prüfen und nochmal versuchen."
        : "Verbindung zu schwach. Bitte nochmal versuchen.");
    }
    if (e instanceof TypeError) throw new Error("Keine Verbindung. Bitte Netz prüfen und nochmal versuchen.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function dbSelect(table, opts = {}) {
  const SEITE = 1000;
  const filter = !opts.alle && teamFilterAktiv(table);
  let alle = [];
  for (let von = 0; ; von += SEITE) {
    const teamQs = !filter
      ? ""
      : table === "uebungen"
      ? `&or=(team_ids.cs.{${encodeURIComponent(Sitzung.team)}},team_ids.cs.{alle})`
      : `&team_id=eq.${encodeURIComponent(Sitzung.team)}`;
    const res = await nszFetch(REST + table + "?select=*" + teamQs, {
      headers: dbHeaders({ Range: `${von}-${von + SEITE - 1}`, "Range-Unit": "items" }),
    });
    if (!res.ok) {
      throw new Error(`Laden von "${table}" fehlgeschlagen: ${await res.text()}`);
    }
    const teil = await res.json();
    alle = alle.concat(teil);
    if (teil.length < SEITE) break;
  }
  return alle;
}

async function dbInsert(table, rowOrRows) {
  const res = await nszFetch(REST + table, {
    method: "POST",
    headers: dbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(mitTeamId(table, rowOrRows)),
  });
  if (!res.ok) throw new Error(`Speichern in "${table}" fehlgeschlagen: ${await res.text()}`);
  return res.json();
}

async function dbUpsert(table, row, conflictCol) {
  // Tabellen mit team_id: Konflikt-Schlüssel enthält das Team (app_features, material_bestand haben dafür einen zusammengesetzten Schlüssel)
  const mitTeam = teamFilterAktiv(table) && conflictCol !== "id" && conflictCol !== "player_id";
  const col = mitTeam ? `team_id,${conflictCol}` : conflictCol;
  const res = await nszFetch(`${REST}${table}?on_conflict=${col}`, {
    method: "POST",
    headers: dbHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(mitTeamId(table, row)),
  });
  if (!res.ok) throw new Error(`Speichern in "${table}" fehlgeschlagen: ${await res.text()}`);
  return res.json();
}

async function dbUpdate(table, id, patch, idCol = "id") {
  const res = await nszFetch(`${REST}${table}?${idCol}=eq.${id}`, {
    method: "PATCH",
    headers: dbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Aktualisieren von "${table}" fehlgeschlagen: ${await res.text()}`);
  return res.json();
}

/* Team-Konfiguration ändern: erst frisch laden, dann nur die gewünschte Änderung anwenden.
   Nie die ganze Konfiguration aus einer älteren Kopie zurückschreiben (sonst gehen z. B. die Farben verloren). */
async function dbConfigAendern(teamId, aendere) {
  const res = await nszFetch(`${REST}teams?id=eq.${encodeURIComponent(teamId)}&select=config`, { headers: dbHeaders() });
  if (!res.ok) throw new Error(`Laden von "teams" fehlgeschlagen: ${await res.text()}`);
  const zeilen = await res.json();
  const frisch = (zeilen[0] && zeilen[0].config) || {};
  return dbUpdate("teams", teamId, { config: aendere({ ...frisch }) });
}

async function dbDelete(table, id, idCol = "id") {
  const res = await nszFetch(`${REST}${table}?${idCol}=eq.${id}`, { method: "DELETE", headers: dbHeaders() });
  if (!res.ok) throw new Error(`Löschen in "${table}" fehlgeschlagen: ${await res.text()}`);
}

async function dbDeleteWhere(table, qs) {
  if (teamFilterAktiv(table)) qs += `&team_id=eq.${encodeURIComponent(Sitzung.team)}`;
  const res = await nszFetch(`${REST}${table}?${qs}`, { method: "DELETE", headers: dbHeaders() });
  if (!res.ok) throw new Error(`Löschen in "${table}" fehlgeschlagen: ${await res.text()}`);
}

// Nur die IDs der Zeilen holen, die auf den Filter passen (für Konfliktprüfung und "erst einfügen, dann Altes löschen")
async function dbIdsWhere(table, qs) {
  if (teamFilterAktiv(table)) qs += `&team_id=eq.${encodeURIComponent(Sitzung.team)}`;
  const res = await nszFetch(`${REST}${table}?select=id&${qs}`, { headers: dbHeaders() });
  if (!res.ok) throw new Error(`Laden von "${table}" fehlgeschlagen: ${await res.text()}`);
  return (await res.json()).map((r) => String(r.id));
}

// Sammel-Speichern ohne Datenverlust: erst die neuen Zeilen einfügen, danach nur die alten löschen.
// Bricht das Einfügen ab, bleiben die alten Daten vollständig erhalten.
async function ersetzeGruppe(table, filterQs, rows) {
  const neueIds = rows.map((r) => String(r.id));
  await dbInsert(table, rows);
  const alt = await dbIdsWhere(table, filterQs);
  const weg = alt.filter((id) => !neueIds.includes(id));
  for (let i = 0; i < weg.length; i += 50) {
    await dbDeleteWhere(table, `id=in.(${weg.slice(i, i + 50).map(encodeURIComponent).join(",")})`);
  }
}
