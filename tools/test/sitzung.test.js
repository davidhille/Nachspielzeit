// Sitzung: Teamermittlung (Hostname, ?team=) und Code-Speicher, auch wenn localStorage nicht nutzbar ist.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const quelle = fs.readFileSync(path.join(__dirname, "..", "..", "js", "sitzung.js"), "utf8");

function lade({ host = "u8.nachspielzeit.app", suche = "", speicher = {}, speicherKaputt = false } = {}) {
  const ls = speicherKaputt
    ? { getItem() { throw new Error("gesperrt"); }, setItem() { throw new Error("gesperrt"); }, removeItem() { throw new Error("gesperrt"); } }
    : { getItem: (k) => (k in speicher ? speicher[k] : null), setItem: (k, v) => { speicher[k] = String(v); }, removeItem: (k) => { delete speicher[k]; } };
  const ctx = vm.createContext({ window: { location: { hostname: host, search: suche } }, localStorage: ls, URLSearchParams });
  return vm.runInContext(quelle + "\n;Sitzung", ctx);
}

test("Team kommt aus dem Hostnamen, admin/www und fremde Hosts ergeben u8", () => {
  assert.equal(lade({ host: "u8.nachspielzeit.app" }).team, "u8");
  assert.equal(lade({ host: "u9.nachspielzeit.app" }).team, "u9");
  assert.equal(lade({ host: "admin.nachspielzeit.app" }).team, "u8");
  assert.equal(lade({ host: "localhost" }).team, "u8");
});

test("?team=… hat Vorrang, ungültige Werte werden ignoriert", () => {
  assert.equal(lade({ host: "localhost", suche: "?team=U10" }).team, "u10");
  assert.equal(lade({ host: "u9.nachspielzeit.app", suche: "?team=a/b" }).team, "u9");
});

test("Code wird gemerkt und beim Abmelden vergessen", () => {
  const speicher = { nsz_access_code: "abc" };
  const s = lade({ speicher });
  assert.equal(s.code, "abc");
  s.merkeCode("neu");
  assert.equal(speicher.nsz_access_code, "neu");
  s.info = { ok: true };
  s.vergiss();
  assert.equal(s.code, "");
  assert.equal(s.info, null);
  assert.equal("nsz_access_code" in speicher, false);
});

test("Ohne nutzbaren Speicher bleibt der Code bis zum Neuladen erhalten", () => {
  const s = lade({ speicherKaputt: true });
  assert.equal(s.code, "");
  s.merkeCode("x1");
  assert.equal(s.code, "x1");
  s.vergiss();
  assert.equal(s.code, "");
});
