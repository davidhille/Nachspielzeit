/* Nachspielzeit – reine Rechenlogik (Punkte, Saison, Karten).
   Wird als klassisches Skript vor der App geladen und von den Tests direkt geprüft (tools/test).
   Keine Abhängigkeit zu React, Datenbank oder Sitzung. Änderungen an Gewichtungen nur nach Rückfrage. */

/* ---------- Konstanten ---------- */
const KARTEN = { keine: 0, gelb: -0.5, blau: -1.0, rot: -2.0 };

const TEILNAHME = {
  anwesend: 0.5,
  anwesend_nicht_angemeldet: 0.25, // 0,5 Anwesenheit − 0,25 Abzug
  verspaetet: 0.25, // 0,5 Anwesenheit − 0,25 Abzug
  verspaetet_nicht_angemeldet: 0, // 0,5 − 0,25 (verspätet) − 0,25 (nicht angemeldet)
  unentschuldigt: -0.25,
  entschuldigt: 0,
};

/* Saison: Standard September bis Juli, die Monate dazwischen sind Sommerpause (Einstellungen pro Team) */
let SAISON = { start: 9, ende: 7 };

// Saison läuft von September bis einschließlich Juli des Folgejahres.
function seasonKeyOf(mkey) {
  const [y, m] = mkey.split("-").map(Number);
  if (m >= SAISON.start) return `${y}-${y + 1}`;
  if (m <= SAISON.ende) return `${y - 1}-${y}`;
  return null;
}

function trainingPunkte(entry) {
  return (Number(entry.vorkommnis) || 0) + KARTEN[entry.karte] + TEILNAHME[entry.teilnahme];
}

function basisNachMonat(playerId, basis, entwicklungen, monatKey) {
  // Eine Monatsentwicklung wirkt laut UI-Hinweis "ab dem Folgemonat" — also
  // dieselbe exklusive Grenze wie aktuelleBasis, nicht inklusive des eigenen Monats.
  const grund = Number(basis[playerId]) || 0;
  const bonus = entwicklungen
    .filter((e) => e.playerId === playerId && e.month < monatKey)
    .reduce((sum, e) => sum + Number(e.punkte || 0), 0);
  return grund + bonus;
}

function aktuelleBasis(playerId, basis, entwicklungen, biMonatKeyExklusiv) {
  const grund = Number(basis[playerId]) || 0;
  const bonus = entwicklungen
    .filter((e) => e.playerId === playerId && e.month < biMonatKeyExklusiv)
    .reduce((sum, e) => sum + Number(e.punkte || 0), 0);
  return grund + bonus;
}

/* Monatsbewertung (0-100): Punkte des Monats im Verhältnis zum Maximum (0,5 je Training); null ohne Trainings */
function monatsBewertungProzent(eintraege, monatKey) {
  const im = eintraege.filter((t) => t.date.slice(0, 7) === monatKey);
  if (im.length === 0) return null;
  const punkte = im.reduce((sum, t) => sum + trainingPunkte(t), 0);
  return Math.round(Math.max(0, Math.min(1, punkte / (im.length * Math.max(0.01, TEILNAHME.anwesend)))) * 100);
}

function kartenZaehlen(eintraege) {
  const z = { gelb: 0, blau: 0, rot: 0 };
  eintraege.forEach((t) => { if (z[t.karte] !== undefined) z[t.karte]++; });
  return z;
}

/* Torprotokoll eines Spiels: Einträge in Reihenfolge, je { typ: "wir" | "eigen" | "gegner", playerId? }.
   "eigen" = Eigentor des Gegners (zählt für uns). torfolgeStand ergänzt den Spielstand nach jedem Tor (wir/gegner). */
function torfolgeStand(folge) {
  let wir = 0;
  let gegner = 0;
  return (folge || []).map((e) => {
    if (e.typ === "gegner") gegner++;
    else wir++;
    return { ...e, wir, gegner };
  });
}

/* Das Protokoll gilt nur, wenn es zum Ergebnis passt: Anzahl unserer Tore (inkl. Eigentore) und der Gegner-Tore stimmen. */
function torfolgePasst(folge, ourGoals, theirGoals) {
  const l = folge || [];
  if (l.length === 0) return false;
  const gegner = l.filter((e) => e.typ === "gegner").length;
  return l.length - gegner === (Number(ourGoals) || 0) && gegner === (Number(theirGoals) || 0);
}

/* Spielminute eines Tors aus den gespielten Sekunden: 0:00–0:59 = 1., danach "12+2'" in der Nachspielzeit.
   spielzeitMin = geplante Spielzeit des Spieltags. */
function spielminute(sek, spielzeitMin) {
  const gesamt = Math.max(1, Number(spielzeitMin) || 12);
  const m = Math.floor(Math.max(0, Number(sek) || 0) / 60) + 1;
  return m > gesamt ? `${gesamt}+${m - gesamt}'` : `${m}'`;
}

/* Bilanz pro Gegner: Punkte wie in der Liga (Sieg 3, Unentschieden 1, Niederlage 0) */
const GEGNER_PUNKTE = { sieg: 3, unentschieden: 1, niederlage: 0 };
function gegnerPunkte(siege, unentschieden) {
  return (Number(siege) || 0) * GEGNER_PUNKTE.sieg + (Number(unentschieden) || 0) * GEGNER_PUNKTE.unentschieden;
}

/* Sortiert Zeilen der Gegnerbilanz nach einer Spalte (richtung "asc" | "desc").
   Schlüssel: name, spiele, siege, unentschieden, niederlagen, toreFuer, diff, punkte. Bei Gleichstand nach Name, damit die Reihenfolge stabil bleibt. */
function sortiereGegnerBilanz(zeilen, schluessel, richtung) {
  const wert = (z) => (schluessel === "diff" ? z.toreFuer - z.toreGegen : schluessel === "punkte" ? gegnerPunkte(z.siege, z.unentschieden) : z[schluessel]);
  const f = richtung === "asc" ? 1 : -1;
  return zeilen.slice().sort((a, b) => {
    const c = schluessel === "name" ? String(a.name).localeCompare(String(b.name), "de") : wert(a) - wert(b);
    return c !== 0 ? c * f : String(a.name).localeCompare(String(b.name), "de");
  });
}

/* Wechsel-Erinnerung am Spieltag. wert = Einstellung des Spieltags (null = Teamstandard, 0 = aus, sonst Minuten),
   standard = Teamstandard (null = automatisch: Spielzeit ÷ 3). Ergebnis: Intervall in Minuten, 0 = keine Erinnerung. */
function wechselIntervallMin(wert, standard, spielzeitMin) {
  const w = wert === null || wert === undefined ? standard : wert;
  if (w === 0) return 0;
  if (w === null || w === undefined) return Math.max(1, Math.round((Number(spielzeitMin) || 12) / 3));
  return Number(w);
}

/* Nächster Wechsel (in gespielten Sekunden) nach sek; null, wenn keiner mehr vor Spielende liegt oder das Intervall aus ist */
function naechsterWechselSek(sek, intervallMin, spielzeitMin) {
  const iv = Math.round(Number(intervallMin) * 60);
  if (!(iv > 0)) return null;
  const n = (Math.floor(sek / iv) + 1) * iv;
  return n < (Number(spielzeitMin) || 12) * 60 ? n : null;
}
