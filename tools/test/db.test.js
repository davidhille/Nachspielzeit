// Datenzugriff: Teamfilter, Konfliktschlüssel, Speicherreihenfolge ("erst einfügen, dann Altes löschen") und Zeitlimit-Meldungen.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const quelle = (n) => fs.readFileSync(path.join(__dirname, "..", "..", "js", n), "utf8");

/** Lädt sitzung.js + db.js in eine Sandbox mit gefälschtem fetch; antwortet über antwort(url, opts). */
function lade(antwort, { team = "u8", code = "c0de" } = {}) {
  const aufrufe = [];
  const fakeFetch = async (url, opts = {}) => {
    aufrufe.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    const r = antwort(String(url), opts) || { json: [] };
    if (r.wirf) throw r.wirf;
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => r.text || "" };
  };
  const ctx = vm.createContext({
    window: { location: { hostname: `${team}.nachspielzeit.app`, search: "" } },
    localStorage: { getItem: () => code, setItem() {}, removeItem() {} },
    URLSearchParams, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, encodeURIComponent, JSON, String, Error, TypeError, Array,
  });
  vm.runInContext(quelle("sitzung.js") + "\n" + quelle("db.js") + "\nthis.__a = { Sitzung, dbSelect, dbInsert, dbUpsert, dbUpdate, dbDeleteWhere, dbIdsWhere, ersetzeGruppe, mitTeamId, TEAM_TABLES, nszFetch };", ctx);
  return { ...ctx.__a, aufrufe };
}

test("Lesen filtert nach Team und sendet den Zugangscode", async () => {
  const d = lade(() => ({ json: [] }), { team: "u9", code: "geheim" });
  await d.dbSelect("players");
  assert.match(d.aufrufe[0].url, /players\?select=\*&team_id=eq\.u9$/);
  assert.equal(d.aufrufe[0].headers["x-access-code"], "geheim");
});

test("Übungen werden über team_ids bzw. 'alle' gefiltert", async () => {
  const d = lade(() => ({ json: [] }));
  await d.dbSelect("uebungen");
  assert.match(decodeURIComponent(d.aufrufe[0].url), /or=\(team_ids\.cs\.\{u8\},team_ids\.cs\.\{alle\}\)/);
});

test("Tabellen ohne Teamspalte (teams, access_codes) werden nicht gefiltert", async () => {
  const d = lade(() => ({ json: [] }));
  await d.dbSelect("teams");
  assert.doesNotMatch(d.aufrufe[0].url, /team_id=/);
});

test("Neue Zeilen bekommen das aktuelle Team, vorhandene team_id bleibt", () => {
  const d = lade(() => ({}), { team: "u9" });
  assert.deepEqual(JSON.parse(JSON.stringify(d.mitTeamId("players", { id: "1" }))), { id: "1", team_id: "u9" });
  assert.deepEqual(JSON.parse(JSON.stringify(d.mitTeamId("players", { id: "1", team_id: "u8" }))), { id: "1", team_id: "u8" });
  assert.deepEqual(JSON.parse(JSON.stringify(d.mitTeamId("uebungen", { id: "1" }))), { id: "1", team_ids: ["u9"] });
});

test("Upsert: Teamtabellen nutzen (team_id, Spalte) als Konfliktschlüssel, player_id und id nicht", async () => {
  const d = lade(() => ({ json: [] }));
  await d.dbUpsert("app_features", { key: "x" }, "key");
  await d.dbUpsert("basisqualitaet", { player_id: "p" }, "player_id");
  assert.match(d.aufrufe[0].url, /on_conflict=team_id,key$/);
  assert.match(d.aufrufe[1].url, /on_conflict=player_id$/);
});

test("ersetzeGruppe fügt zuerst ein und löscht danach nur alte Zeilen", async () => {
  const d = lade((url, opts) => (url.includes("select=id") ? { json: [{ id: "alt1" }, { id: "neu1" }, { id: "alt2" }] } : { json: [] }));
  await d.ersetzeGruppe("trainings", "date=eq.2026-10-24", [{ id: "neu1" }]);
  const ablauf = d.aufrufe.map((a) => a.method);
  assert.deepEqual(ablauf, ["POST", "GET", "DELETE"]);
  assert.match(decodeURIComponent(d.aufrufe[2].url), /id=in\.\(alt1,alt2\)/);
});

test("ersetzeGruppe löscht nichts, wenn das Einfügen fehlschlägt", async () => {
  const d = lade((url, opts) => (opts.method === "POST" ? { ok: false, status: 500, text: "kaputt" } : { json: [{ id: "alt1" }] }));
  await assert.rejects(() => d.ersetzeGruppe("trainings", "date=eq.x", [{ id: "n" }]), /Speichern in "trainings" fehlgeschlagen/);
  assert.deepEqual(d.aufrufe.map((a) => a.method), ["POST"]);
});

test("Netzfehler liefern verständliche Meldungen, Schreiben mit vorsichtiger Formulierung", async () => {
  const d = lade(() => ({ wirf: new TypeError("Failed to fetch") }));
  await assert.rejects(() => d.dbSelect("players"), /Keine Verbindung/);
  const abbruch = Object.assign(new Error("abgebrochen"), { name: "AbortError" });
  const d2 = lade(() => ({ wirf: abbruch }));
  await assert.rejects(() => d2.dbInsert("players", { id: "1" }), /Speichern nicht bestätigt/);
  await assert.rejects(() => d2.dbSelect("players"), /Verbindung zu schwach\. Bitte nochmal/);
});
