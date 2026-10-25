// Absicherung der Punkte- und Saisonlogik. Die Tests halten den heutigen Stand fest:
// Ändert sich eine Gewichtung oder Grenze, schlägt hier ein Test an und die Änderung muss bewusst bestätigt werden.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ladeAusApp } = require("./lade-app");

const A = ladeAusApp(["KARTEN", "TEILNAHME", "SAISON", "seasonKeyOf", "trainingPunkte", "basisNachMonat", "aktuelleBasis", "monatsBewertungProzent", "kartenZaehlen"]);

test("Gewichtungen sind unverändert", () => {
  assert.deepEqual({ ...A.KARTEN }, { keine: 0, gelb: -0.5, blau: -1, rot: -2 });
  assert.deepEqual({ ...A.TEILNAHME }, {
    anwesend: 0.5,
    anwesend_nicht_angemeldet: 0.25,
    verspaetet: 0.25,
    verspaetet_nicht_angemeldet: 0,
    unentschuldigt: -0.25,
    entschuldigt: 0,
  });
});

test("Saison läuft von September bis Juli", () => {
  assert.equal(A.seasonKeyOf("2026-09"), "2026-2027");
  assert.equal(A.seasonKeyOf("2026-12"), "2026-2027");
  assert.equal(A.seasonKeyOf("2027-01"), "2026-2027");
  assert.equal(A.seasonKeyOf("2027-07"), "2026-2027");
  assert.equal(A.seasonKeyOf("2027-08"), null); // Sommerpause
});

test("Trainingspunkte = Vorkommnis + Karte + Teilnahme", () => {
  const p = (vorkommnis, karte, teilnahme) => A.trainingPunkte({ vorkommnis, karte, teilnahme });
  assert.equal(p(0, "keine", "anwesend"), 0.5);
  assert.equal(p(1, "keine", "anwesend"), 1.5);
  assert.equal(p(-1, "gelb", "anwesend"), -1);
  assert.equal(p(0, "rot", "unentschuldigt"), -2.25);
  assert.equal(p(0, "keine", "entschuldigt"), 0);
  assert.equal(p("0.5", "blau", "verspaetet"), -0.25); // Vorkommnis kommt teils als Text aus der Datenbank
  assert.equal(p(undefined, "keine", "verspaetet_nicht_angemeldet"), 0);
});

test("Basis: Entwicklung wirkt erst ab dem Folgemonat (exklusive Grenze)", () => {
  const basis = { a: 5 };
  const entw = [
    { playerId: "a", month: "2026-09", punkte: 0.5 },
    { playerId: "a", month: "2026-10", punkte: -0.25 },
    { playerId: "b", month: "2026-09", punkte: 1 },
  ];
  assert.equal(A.aktuelleBasis("a", basis, entw, "2026-09"), 5);
  assert.equal(A.aktuelleBasis("a", basis, entw, "2026-10"), 5.5);
  assert.equal(A.aktuelleBasis("a", basis, entw, "2026-11"), 5.25);
  assert.equal(A.aktuelleBasis("c", basis, entw, "2026-11"), 0); // ohne Basis: 0
  assert.equal(A.basisNachMonat("a", basis, entw, "2026-11"), A.aktuelleBasis("a", basis, entw, "2026-11"));
});

test("Monatsbewertung in Prozent, begrenzt auf 0 bis 100", () => {
  const t = (date, teilnahme, karte = "keine", vorkommnis = 0) => ({ date, teilnahme, karte, vorkommnis });
  assert.equal(A.monatsBewertungProzent([], "2026-10"), null);
  assert.equal(A.monatsBewertungProzent([t("2026-09-30", "anwesend")], "2026-10"), null);
  assert.equal(A.monatsBewertungProzent([t("2026-10-01", "anwesend"), t("2026-10-08", "anwesend")], "2026-10"), 100);
  assert.equal(A.monatsBewertungProzent([t("2026-10-01", "anwesend"), t("2026-10-08", "entschuldigt")], "2026-10"), 50);
  assert.equal(A.monatsBewertungProzent([t("2026-10-01", "anwesend", "keine", 5)], "2026-10"), 100); // nach oben begrenzt
  assert.equal(A.monatsBewertungProzent([t("2026-10-01", "unentschuldigt", "rot")], "2026-10"), 0); // nach unten begrenzt
});

test("Karten zählen, unbekannte Karten werden ignoriert", () => {
  const z = A.kartenZaehlen([{ karte: "gelb" }, { karte: "gelb" }, { karte: "rot" }, { karte: "keine" }, { karte: "xyz" }]);
  assert.deepEqual({ ...z }, { gelb: 2, blau: 0, rot: 1 });
});

test("Torprotokoll: Spielstand nach jedem Tor", () => {
  const B = ladeAusApp(["torfolgeStand", "torfolgePasst"]);
  const f = [{ typ: "wir", playerId: "a" }, { typ: "gegner" }, { typ: "eigen" }, { typ: "wir", playerId: "b" }];
  const st = B.torfolgeStand(f).map((e) => `${e.wir}:${e.gegner}`);
  assert.deepEqual(st, ["1:0", "1:1", "2:1", "3:1"]);
  assert.deepEqual(B.torfolgeStand([]), []);
});

test("Torprotokoll passt nur zum stimmigen Ergebnis", () => {
  const B = ladeAusApp(["torfolgeStand", "torfolgePasst"]);
  const f = [{ typ: "wir", playerId: "a" }, { typ: "gegner" }, { typ: "eigen" }];
  assert.equal(B.torfolgePasst(f, 2, 1), true);
  assert.equal(B.torfolgePasst(f, "2", "1"), true);
  assert.equal(B.torfolgePasst(f, 3, 1), false);
  assert.equal(B.torfolgePasst(f, 2, 0), false);
  assert.equal(B.torfolgePasst([], 0, 0), false);
});
