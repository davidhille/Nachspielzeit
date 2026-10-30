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

test("Spielminute: 1. Minute ab 0:00, Nachspielzeit als 12+n", () => {
  const B = ladeAusApp(["spielminute"]);
  assert.equal(B.spielminute(0, 12), "1'");
  assert.equal(B.spielminute(59, 12), "1'");
  assert.equal(B.spielminute(60, 12), "2'");
  assert.equal(B.spielminute(11 * 60 + 59, 12), "12'");
  assert.equal(B.spielminute(12 * 60 + 5, 12), "12+1'");
  assert.equal(B.spielminute(14 * 60, 12), "12+3'");
  assert.equal(B.spielminute(undefined, undefined), "1'");
});

test("Gegnerbilanz: Punkte (Sieg 3, Unentschieden 1, Niederlage 0) und Sortierung", () => {
  const G = ladeAusApp(["GEGNER_PUNKTE", "gegnerPunkte", "sortiereGegnerBilanz"]);
  assert.deepEqual({ ...G.GEGNER_PUNKTE }, { sieg: 3, unentschieden: 1, niederlage: 0 });
  assert.equal(G.gegnerPunkte(2, 1), 7);
  assert.equal(G.gegnerPunkte(0, 0), 0);
  const z = [
    { name: "B", spiele: 2, siege: 0, unentschieden: 2, niederlagen: 0, toreFuer: 2, toreGegen: 2 },
    { name: "A", spiele: 3, siege: 1, unentschieden: 0, niederlagen: 2, toreFuer: 4, toreGegen: 6 },
    { name: "C", spiele: 1, siege: 1, unentschieden: 0, niederlagen: 0, toreFuer: 3, toreGegen: 0 },
  ];
  const namen = (s, r) => G.sortiereGegnerBilanz(z, s, r).map((x) => x.name);
  assert.deepEqual(namen("punkte", "desc"), ["A", "C", "B"]); // A=3, C=3 (Gleichstand nach Name), B=2
  assert.deepEqual(namen("diff", "asc"), ["A", "B", "C"]); // -2, 0, +3
  assert.deepEqual(namen("name", "desc"), ["C", "B", "A"]);
  assert.deepEqual(namen("spiele", "desc"), ["A", "B", "C"]);
  assert.deepEqual(namen("toreFuer", "desc"), ["A", "C", "B"]);
});

test("Wechsel-Erinnerung: Intervall und nächster Wechsel", () => {
  const W = ladeAusApp(["wechselIntervallMin", "naechsterWechselSek"]);
  assert.equal(W.wechselIntervallMin(null, null, 12), 4); // automatisch: Spielzeit ÷ 3
  assert.equal(W.wechselIntervallMin(undefined, null, 15), 5);
  assert.equal(W.wechselIntervallMin(null, 6, 12), 6); // Teamstandard
  assert.equal(W.wechselIntervallMin(3, 6, 12), 3); // Spieltag überschreibt
  assert.equal(W.wechselIntervallMin(0, 6, 12), 0); // aus
  assert.equal(W.wechselIntervallMin(null, 0, 12), 0);
  assert.equal(W.naechsterWechselSek(0, 4, 12), 240);
  assert.equal(W.naechsterWechselSek(240, 4, 12), 480); // genau auf dem Wechsel: der nächste
  assert.equal(W.naechsterWechselSek(500, 4, 12), null); // 12:00 ist das Spielende, kein Wechsel mehr
  assert.equal(W.naechsterWechselSek(0, 0, 12), null);
  assert.equal(W.naechsterWechselSek(100, 3, 12), 180);
});
