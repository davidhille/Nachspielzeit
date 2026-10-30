const { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } = React;

function zugangFehler(info) {
  if (IS_ADMIN_HOST) return info.team_id ? "Dieser Code hat keinen Zugriff auf die Administration." : "";
  if (info.team_id && info.team_id !== Sitzung.team) return "Dieser Code gehört zu einem anderen Team.";
  return "";
}

/* ---------- Fehlerprotokoll (anonym) ----------
   Schreibt Fehler in die Tabelle "fehlerprotokoll"; der Admin sieht sie unter Administration → Fehler.
   Gespeichert: Team, Bereich, Art, gekürzte Meldung, Stand der App, grobes Gerät. Nie: Zugangscode, Namen, Eingaben, IP.
   Bremse: gleiche Meldung nur einmal pro Sitzung, höchstens 10 pro Sitzung. Ohne Netz wird nichts nachgereicht. */
let FEHLER_BEREICH = "";
let APP_STAND = "";
const FEHLER_SITZUNG = { gesendet: new Set(), anzahl: 0, aus: false };
function bereinigeFehlertext(t, max = 200) {
  let x = String(t == null ? "" : t);
  if (Sitzung.code) x = x.split(Sitzung.code).join("***");
  return x
    .replace(/\([^()]*\)=\([^()]*\)/g, "(…)=(…)") // Postgres-Detail: Key (spalte)=(wert) enthält echte Werte
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1") // keine Query-Parameter in URLs
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function geraetKurz() {
  const ua = navigator.userAgent || "";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "?";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "?";
  return `${os} ${br}`;
}
function meldeFehler(kontext, e) {
  try {
    if (FEHLER_SITZUNG.aus || FEHLER_SITZUNG.anzahl >= 10 || !Sitzung.code) return;
    const meldung = bereinigeFehlertext(e && e.message !== undefined ? e.message : e);
    if (!meldung || /^Keine Verbindung/.test(meldung) || /^Script error/i.test(meldung) || /ResizeObserver loop/.test(meldung)) return;
    const schluessel = `${kontext}|${meldung}`;
    if (FEHLER_SITZUNG.gesendet.has(schluessel)) return;
    FEHLER_SITZUNG.gesendet.add(schluessel);
    FEHLER_SITZUNG.anzahl += 1;
    const stack = bereinigeFehlertext(String((e && e.stack) || "").split("\n").slice(0, 4).join(" | "), 400);
    fetch(REST + "fehlerprotokoll", {
      method: "POST",
      keepalive: true,
      headers: dbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        team_id: IS_ADMIN_HOST ? "admin" : Sitzung.team,
        kontext,
        bereich: FEHLER_BEREICH || null,
        meldung,
        stack: stack || null,
        stand: APP_STAND || null,
        geraet: geraetKurz(),
      }),
    })
      .then((res) => { if (!res.ok) FEHLER_SITZUNG.aus = true; }) // Tabelle fehlt oder Zugriff verweigert: Sitzung über nicht weiter versuchen
      .catch(() => {});
  } catch (err) {
    // das Fehlerprotokoll darf nie selbst Fehler auslösen
  }
}

/* ---------- Versionshinweis ----------
   Beim Start merkt sich die App den Stand von index.html (ETag/Last-Modified des Servers). Ändert er sich später (neuer Deploy),
   erscheint ein Hinweis zum Neuladen. Liefert der Server keinen solchen Header, bleibt der Hinweis still aus. */
async function holeAppStand() {
  try {
    const res = await fetch("index.html", { method: "HEAD", cache: "no-store" });
    if (!res.ok) return "";
    const roh = res.headers.get("etag") || res.headers.get("last-modified") || "";
    return roh.replace(/[^a-zA-Z0-9]/g, "").slice(-12);
  } catch (e) {
    return "";
  }
}
function VersionsHinweis() {
  const [neu, setNeu] = useState(false);
  const [spaeter, setSpaeter] = useState(false);
  useEffect(() => {
    let aktiv = true;
    let basis = "";
    const pruefen = async () => {
      const stand = await holeAppStand();
      if (!aktiv || !stand) return;
      if (!basis) { basis = stand; APP_STAND = stand; return; }
      if (stand !== basis) setNeu(true);
    };
    pruefen();
    const timer = setInterval(pruefen, 30 * 60 * 1000);
    const sichtbar = () => { if (document.visibilityState === "visible") pruefen(); };
    document.addEventListener("visibilitychange", sichtbar);
    return () => { aktiv = false; clearInterval(timer); document.removeEventListener("visibilitychange", sichtbar); };
  }, []);
  if (!neu || spaeter) return null;
  return (
    <div role="status" style={{ position: "sticky", top: 0, zIndex: 1100, background: "var(--info-bg)", color: "var(--info-text)", borderBottom: "1px solid var(--border-strong)", padding: "8px 16px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap", fontSize: 14 }}>
      <span style={{ fontWeight: 600 }}>Neue Version verfügbar. Bitte neu laden.</span>
      <button style={{ ...styles.primaryBtn, width: "auto", height: 44, padding: "0 18px" }} onClick={() => window.location.reload()}>Neu laden</button>
      <button style={{ ...styles.linkBtn, minHeight: 44 }} onClick={() => { setSpaeter(true); setTimeout(() => setSpaeter(false), 30 * 60 * 1000); }}>Später</button>
    </div>
  );
}


/* ---------- Profilbilder ---------- */

const PHOTO_BUCKET = "profilbilder";
// Bilder pro Team trennen: U8 behält die bisherigen Pfade, alle anderen Teams schreiben unter "<team>/…" (die Datenbank erlaubt ihnen nur diesen Ordner).
// Nicht betroffen: karten/… (öffentlicher Elternlink, die Elternseite kennt das Team nicht; der Token ist geheim).
const teamPfad = (p, team = Sitzung.team) => (team === "u8" ? p : `${team}/${p}`);

async function resizeImageFile(file, maxSize = 320, quality = 0.82) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Bild konnte nicht gelesen werden."));
    img.src = dataUrl;
  });
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, w, h);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Bild konnte nicht verarbeitet werden."))), "image/jpeg", quality);
  });
  return blob;
}

async function uploadProfilbild(playerId, file) {
  // Kleine Version für Listen/Avatare, zusätzlich hochauflösend (-hd) für die Sammelkarte
  const blob = await resizeImageFile(file);
  const blobHd = await resizeImageFile(file, 1000, 0.9);
  const path = teamPfad(`players/${playerId}.jpg`);
  const put = (p, b) =>
    nszFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${p}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "x-access-code": Sitzung.code,
        "x-upsert": "true",
        "Content-Type": "image/jpeg",
      },
      body: b,
    });
  const res = await put(path, blob);
  if (!res.ok) throw new Error(`Hochladen des Profilbilds fehlgeschlagen: ${await res.text()}`);
  try {
    await put(teamPfad(`players/${playerId}-hd.jpg`), blobHd);
  } catch (e) {
    // HD ist optional; die Sammelkarte nutzt sonst die kleine Version
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}?t=${Date.now()}`;
}

async function uploadTeamFoto(file, team = Sitzung.team) {
  const blob = await resizeImageFile(file, 1200, 0.85);
  const path = teamPfad(team === "u8" ? `team/foto.jpg` : `team/foto-${team}.jpg`, team);
  const res = await nszFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "x-access-code": Sitzung.code,
      "x-upsert": "true",
      "Content-Type": "image/jpeg",
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`Hochladen des Mannschaftsfotos fehlgeschlagen: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}?t=${Date.now()}`;
}

async function uploadVereinsLogo(team, file) {
  // als PNG (Transparenz bleibt erhalten), max. 400 px hoch
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
  URL.revokeObjectURL(url);
  const f = Math.min(1, 400 / img.naturalHeight, 800 / img.naturalWidth);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * f));
  c.height = Math.max(1, Math.round(img.naturalHeight * f));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const path = teamPfad(`team/wappen-${team}.png`, team);
  const res = await nszFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "x-access-code": Sitzung.code, "x-upsert": "true", "Content-Type": "image/png" },
    body: blob,
  });
  if (!res.ok) throw new Error(`Hochladen des Wappens fehlgeschlagen: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}?t=${Date.now()}`;
}

async function uploadUebungBild(uebungId, file) {
  const blob = await resizeImageFile(file, 900, 0.85);
  const path = teamPfad(`uebungen/${uebungId}.jpg`);
  const res = await nszFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "x-access-code": Sitzung.code,
      "x-upsert": "true",
      "Content-Type": "image/jpeg",
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`Hochladen des Übungsbilds fehlgeschlagen: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}?t=${Date.now()}`;
}

async function uploadTextBild(file) {
  const blob = await resizeImageFile(file, 1000, 0.85);
  const path = teamPfad(`textbilder/${uid()}.jpg`);
  const res = await nszFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "x-access-code": Sitzung.code,
      "Content-Type": "image/jpeg",
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`Hochladen des Bilds fehlgeschlagen: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
}

async function uploadSpieltagFoto(spieltagId, file) {
  const blob = await resizeImageFile(file, 1200, 0.85);
  const path = teamPfad(`spieltage/${spieltagId}.jpg`);
  const res = await nszFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "x-access-code": Sitzung.code,
      "x-upsert": "true",
      "Content-Type": "image/jpeg",
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`Hochladen des Spieltagfotos fehlgeschlagen: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}?t=${Date.now()}`;
}

/* ---------- Logo ---------- */
const LOGO_DATA_URI = "data:image/png;base64,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";
/* Verein (Name + Wappen): Standard SV Heimstetten, pro Team in den Einstellungen änderbar */
const CLUB_STD = { name: "SV Heimstetten", logo: LOGO_DATA_URI, farbe: "#C4271F", titel: "Unsere Saison" };
let CLUB = { ...CLUB_STD };
let TEAM_NAME = "U8"; // Anzeigename des Teams (aus teams.name, sonst Kürzel aus der Adresse); wird in App gesetzt
/* Teamfarbe: leitet die Akzentfarben der Oberfläche von einer Farbe ab */
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const farbMix = (a, b, t) => rgbHex(a.map((v, i) => v * (1 - t) + b[i] * t));
const farbLum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
/* Lesbare Schriftfarbe (weiß oder dunkel) auf einer Fläche, nach Kontrast */
const textAuf = (hex) => {
  const c = hexRgb(hex);
  if (!c) return "#fff";
  const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.065 ? "#fff" : "#1C2B22";
};
const sichereTeamfarbe = (hex) => {
  let c = hexRgb(hex);
  if (!c) return CLUB_STD.farbe;
  for (let i = 0; i < 12 && farbLum(c) > 0.42; i++) c = hexRgb(farbMix(c, [0, 0, 0], 0.12));
  return rgbHex(c);
};
let letzteFarben = { basis: null, einzel: {} };
const istDunkel = () => {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
};
const TEAMFARBEN_VARS = ["--accent", "--accent-text", "--focus", "--header-grad", "--header-grad-btn", "--auswahl", "--auswahl-text", "--chip", "--chip-text", "--trikot", "--trikot-text", "--regler"];
/* Farben: Teamfarbe = Grundfarbe; Kopfzeile, Buttons & Akzent und Auswahl lassen sich einzeln überschreiben (leer = Teamfarbe).
   Zu helle Farben werden abgedunkelt, damit weiße Schrift lesbar bleibt. */
const berechneFarben = (basis, einzel, dunkel) => {
  const e = einzel || {};
  const sw = [0, 0, 0], ws = [255, 255, 255];
  const std = CLUB_STD.farbe.toLowerCase();
  const wahl = (h) => (hexRgb(h) ? sichereTeamfarbe(h) : basis);
  const kopf = wahl(e.kopf), akz = wahl(e.akzent);
  const ca = hexRgb(akz), ck = hexRgb(kopf);
  const akzent = farbMix(ca, sw, 0.12);
  return {
    kopfStd: kopf.toLowerCase() === std,
    akzentStd: akz.toLowerCase() === std,
    accent: akzent,
    accentText: dunkel ? farbMix(ca, ws, 0.5) : akzent,
    focus: akz,
    kopfGrad: `linear-gradient(135deg, ${kopf} 0%, ${farbMix(ck, sw, 0.28)} 100%)`,
    kopfBtn: `linear-gradient(135deg, ${farbMix(ck, ws, 0.06)}, ${farbMix(ck, sw, 0.25)})`,
    kopfMeta: farbMix(ck, sw, 0.12),
    // Auswahl: jede Farbe erlaubt (auch helles Grau), die Schrift passt sich an; null = aus dem Akzent abgedunkelt (siehe --auswahl in index.html)
    auswahl: hexRgb(e.auswahl) ? e.auswahl : null,
    auswahlText: hexRgb(e.auswahl) ? textAuf(e.auswahl) : "#fff",
    chip: hexRgb(e.chip) ? e.chip : null, // null = wie die Umschalter
    chipText: hexRgb(e.chip) ? textAuf(e.chip) : null,
    auswahlStandard: farbMix(ca, sw, 0.32),
    // Trikot: jede Farbe erlaubt (auch Weiß); die Nummer wird bei hellen Farben dunkel
    trikot: hexRgb(e.trikot) ? e.trikot : null,
    trikotText: hexRgb(e.trikot) ? textAuf(e.trikot) : "#fff",
    // Regler: jede Farbe erlaubt; null = wie Buttons & Akzent
    regler: hexRgb(e.regler) ? e.regler : null,
  };
};
const wendeTeamfarbeAn = () => {
  try {
    const root = document.documentElement.style;
    const basis = letzteFarben.basis;
    if (!basis) { TEAMFARBEN_VARS.forEach((v) => root.removeProperty(v)); return; }
    const f = berechneFarben(basis, letzteFarben.einzel, istDunkel());
    if (f.akzentStd) ["--accent", "--accent-text", "--focus"].forEach((v) => root.removeProperty(v));
    else {
      root.setProperty("--accent", f.accent);
      root.setProperty("--accent-text", f.accentText);
      root.setProperty("--focus", f.focus);
    }
    if (f.kopfStd) ["--header-grad", "--header-grad-btn"].forEach((v) => root.removeProperty(v));
    else {
      root.setProperty("--header-grad", f.kopfGrad);
      root.setProperty("--header-grad-btn", f.kopfBtn);
    }
    if (f.auswahl) { root.setProperty("--auswahl", f.auswahl); root.setProperty("--auswahl-text", f.auswahlText); }
    else ["--auswahl", "--auswahl-text"].forEach((v) => root.removeProperty(v));
    if (f.chip) { root.setProperty("--chip", f.chip); root.setProperty("--chip-text", f.chipText); }
    else ["--chip", "--chip-text"].forEach((v) => root.removeProperty(v));
    if (f.trikot) { root.setProperty("--trikot", f.trikot); root.setProperty("--trikot-text", f.trikotText); }
    else ["--trikot", "--trikot-text"].forEach((v) => root.removeProperty(v));
    if (f.regler) root.setProperty("--regler", f.regler);
    else root.removeProperty("--regler");
    const meta = document.querySelector('meta[name="theme-color"]');
    // In der Administration bleibt die Statusleiste dunkel (siehe index.html), sie folgt nicht der Teamfarbe
    if (meta && !f.kopfStd && !/^admin\./i.test(window.location.hostname) && !/[?&]admin=1\b/.test(window.location.search)) meta.setAttribute("content", f.kopfMeta);
  } catch (e) {}
};
try {
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", wendeTeamfarbeAn);
} catch (e) {}
const setzeClub = (name, logo, farbe, titel, einzel) => {
  const f = farbe ? sichereTeamfarbe(farbe) : CLUB_STD.farbe;
  CLUB = { name: (name && String(name).trim()) || CLUB_STD.name, logo: logo || CLUB_STD.logo, farbe: f, titel: (titel && String(titel).trim()) || CLUB_STD.titel };
  const e = { kopf: (einzel && einzel.kopf) || "", akzent: (einzel && einzel.akzent) || "", auswahl: (einzel && einzel.auswahl) || "", chip: (einzel && einzel.chip) || "", trikot: (einzel && einzel.trikot) || "", regler: (einzel && einzel.regler) || "" };
  if (letzteFarben.basis !== f || JSON.stringify(letzteFarben.einzel) !== JSON.stringify(e)) {
    letzteFarben = { basis: f, einzel: e };
    wendeTeamfarbeAn();
  }
};

(function () {
  var link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = LOGO_DATA_URI;
})();

/* ---------- Konstanten (Rechenlogik: js/logik.js) ---------- */
const TEILNAHME_LABEL = {
  anwesend: "Anwesend",
  anwesend_nicht_angemeldet: "Anwesend (nicht angemeldet)",
  verspaetet: "Verspätet",
  verspaetet_nicht_angemeldet: "Verspätet und nicht angemeldet",
  unentschuldigt: "Unentschuldigt gefehlt",
  entschuldigt: "Abgemeldet",
};
const MONATSNAMEN = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WOCHENTAGE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

const MATERIAL_GRUPPEN = [
  {
    id: "trainingsequipment",
    label: "Trainingsequipment",
    items: [
      ["baelle", "Bälle"],
      ["huetchen", "Hütchen"],
      ["floormarker", "Floormarker"],
      ["getraenkehalter", "Getränkehalter"],
      ["spruehflaschen", "Sprühflaschen"],
      ["verbandsmaterial", "Verbandsmaterial"],
    ],
  },
  {
    id: "trikots",
    label: "Trikots",
    items: [
      ["trikots", "Trikots"],
      ["hosen", "Hosen"],
      ["stutzen", "Stutzen"],
    ],
  },
];
const MATERIAL_TYPEN = MATERIAL_GRUPPEN.flatMap((g) => g.items);
const MATERIAL_LABEL = Object.fromEntries(MATERIAL_TYPEN);

const toLocalISODate = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};
const todayISO = () => toLocalISODate(new Date());
// IDs aus dem Zufallsgenerator des Browsers (crypto) statt Math.random: einige IDs stehen in öffentlich abrufbaren Bildpfaden. Format wie bisher (12 Zeichen).
const uid = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-4);
};
/* Ein Spieltag gilt erst als gespielt, wenn mindestens ein Ergebnis eingetragen ist (Notizen oder Aufstellung allein zählen nicht, ebenso wenig ein Spieltag in der Zukunft). */
let SPIELTAG_WERTUNG = "ergebnisse"; // ergebnisse | teilnehmer | datum (Einstellungen)
const spieltagGespielt = (s) => {
  if (s.date > todayISO()) return false;
  if (SPIELTAG_WERTUNG === "datum") return true;
  if (SPIELTAG_WERTUNG === "teilnehmer") return s.spiele.length > 0 || (s.teilnehmer || []).length > 0;
  return s.spiele.length > 0;
};
const TEILNAHME_STD = { anwesend: 0.5, abzugAnmeldung: 0.25, abzugVerspaetet: 0.25, unentschuldigt: -0.25, entschuldigt: 0 };
const KARTEN_STD = { gelb: 0.5, blau: 1, rot: 2 };
const zahlOder = (v, d) => { const n = Number(String(v ?? "").replace(",", ".")); return v === undefined || v === null || v === "" || !isFinite(n) ? d : n; };
let EINST = { backupTage: 7, papierkorbTage: 30 };
let STANDARDS = { training: { tage: [2, 4], von: "16:30", bis: "17:45", wochen: 8 }, spieltag: { zeit: "", ort: "", spielzeiten: [10, 12, 15, 20], spielzeit: 12 } };
/* Spielzeiten je Team (Minuten): Auswahl im Spiel und Standard für neue Spieltage. Ohne Eintrag 10 / 12 / 15 / 20 und 12. */
const SPIELZEITEN_STD = [10, 12, 15, 20];
function spielzeitenAusConfig(std) {
  const roh = std && Array.isArray(std.spielzeiten) ? std.spielzeiten : [];
  const liste = [...new Set(roh.map(Number).filter((n) => n >= 1 && n <= 90))].sort((a, b) => a - b);
  const auswahl = liste.length ? liste : SPIELZEITEN_STD;
  const vorgabe = Number(std && std.spielzeit);
  return { spielzeiten: auswahl, spielzeit: vorgabe >= 1 && vorgabe <= 90 ? vorgabe : auswahl.includes(12) ? 12 : auswahl[0] };
}
const setzeEinstellungen = (cfg) => {
  cfg = cfg || {};
  EINST = {
    backupTage: cfg.backup_tage === undefined ? 7 : Math.max(0, Math.min(365, Number(cfg.backup_tage) || 0)),
    papierkorbTage: cfg.papierkorb_tage === undefined || cfg.papierkorb_tage === null ? 30 : Math.max(0, Math.min(3650, Number(cfg.papierkorb_tage) || 0)),
  };
  const tr = cfg.training_std || {};
  STANDARDS = {
    training: {
      tage: Array.isArray(tr.tage) && tr.tage.length ? tr.tage.map(Number).filter((x) => x >= 0 && x <= 6) : [2, 4],
      von: tr.von || "16:30",
      bis: tr.bis || "17:45",
      wochen: Math.max(1, Math.min(52, Number(tr.wochen) || 8)),
    },
    spieltag: {
      zeit: (cfg.spieltag_std && cfg.spieltag_std.zeit) || "",
      ort: (cfg.spieltag_std && cfg.spieltag_std.ort) || "",
      ...spielzeitenAusConfig(cfg.spieltag_std),
    },
  };
  const st = Number(cfg.saison_start), en = Number(cfg.saison_ende);
  SAISON = st >= 1 && st <= 12 && en >= 1 && en <= 12 && en < st ? { start: st, ende: en } : { start: 9, ende: 7 };
  SPIELTAG_WERTUNG = ["ergebnisse", "teilnehmer", "datum"].includes(cfg.spieltag_wertung) ? cfg.spieltag_wertung : "ergebnisse";
  const b = cfg.bewertung || {};
  KARTEN.gelb = -Math.abs(zahlOder(b.gelb, KARTEN_STD.gelb));
  KARTEN.blau = -Math.abs(zahlOder(b.blau, KARTEN_STD.blau));
  KARTEN.rot = -Math.abs(zahlOder(b.rot, KARTEN_STD.rot));
  const A = zahlOder(b.anwesend, TEILNAHME_STD.anwesend);
  const nA = Math.abs(zahlOder(b.abzugAnmeldung, TEILNAHME_STD.abzugAnmeldung));
  const v = Math.abs(zahlOder(b.abzugVerspaetet, TEILNAHME_STD.abzugVerspaetet));
  TEILNAHME.anwesend = A;
  TEILNAHME.anwesend_nicht_angemeldet = A - nA;
  TEILNAHME.verspaetet = A - v;
  TEILNAHME.verspaetet_nicht_angemeldet = A - v - nA;
  TEILNAHME.unentschuldigt = zahlOder(b.unentschuldigt, TEILNAHME_STD.unentschuldigt);
  TEILNAHME.entschuldigt = zahlOder(b.entschuldigt, TEILNAHME_STD.entschuldigt);
};
function spieltagNummern(spieltage) {
  // Spieltage und Turniere werden getrennt durchnummeriert, jeweils chronologisch.
  const chronologisch = [...spieltage].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const zaehler = {};
  const map = new Map();
  chronologisch.forEach((s) => {
    const typ = s.typ || "spieltag";
    zaehler[typ] = (zaehler[typ] || 0) + 1;
    map.set(s.id, zaehler[typ]);
  });
  return map;
}
const spieltagLabel = (spieltag, nummer) => {
  const bezeichnung = spieltag.typ === "hallenturnier" ? "Hallenturnier" : spieltag.typ === "turnier" ? "Turnier" : spieltag.typ === "freundschaftsspiel" ? "Freundschaftsspiel" : "Spieltag";
  return nummer ? `${bezeichnung} ${nummer}` : bezeichnung;
};
let _confirmHandler = null;
function registerConfirmHandler(fn) {
  _confirmHandler = fn;
}
let _toastHandler = null;
function registerToastHandler(fn) { _toastHandler = fn; }
const meldung = (msg, type = "info") => { if (_toastHandler) _toastHandler(msg, type); else window.alert(msg); };
let _promptHandler = null;
function registerPromptHandler(fn) { _promptHandler = fn; }
const frageAnd = (titel, wert, onOk) => { if (_promptHandler) _promptHandler({ titel, wert, onOk }); else { const v = window.prompt(titel, wert); if (v !== null) onOk(v); } };
const confirmAnd = (message, fn) => {
  if (_confirmHandler) {
    _confirmHandler(message, fn);
  } else if (window.confirm(message)) {
    fn();
  }
};
function friendlyError(e) {
  const raw = (e && e.message) || "";
  // Supabase-/Storage-Fehler enthalten JSON mit einer lesbaren "message": diese anzeigen statt der Standardmeldung
  const jsonStart = raw.indexOf("{");
  if (jsonStart > 0) {
    try {
      const detail = JSON.parse(raw.slice(jsonStart));
      const msg = detail.message || detail.error_description || detail.error;
      if (msg) {
        const kontext = raw.slice(0, jsonStart).replace(/:\s*$/, "").trim();
        return `${kontext ? kontext + ": " : ""}${msg}`;
      }
    } catch (err) {
      // kein gültiges JSON: weiter mit der Standardlogik
    }
  }
  const trimmed = raw.trim();
  if (!raw || raw.length > 260 || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "Etwas ist schiefgelaufen. Bitte versuch es erneut.";
  }
  return raw;
}

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key) => {
  const [y, m] = key.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
};
const formatTerminLabel = (dateStr) => {
  const d = new Date(dateStr + "T00:00:00");
  return `${WOCHENTAGE[d.getDay()]}, ${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
};

/* Saison, die gerade läuft bzw. als Nächstes beginnt (in der Sommerpause), z. B. "2026/27" */
function aktuelleSaisonLabel() {
  const d = new Date();
  const k = seasonKeyOf(monthKey(d)) || `${d.getFullYear()}-${d.getFullYear() + 1}`;
  const [a, b] = k.split("-");
  return `${a}/${b.slice(2)}`;
}




/* ---------- Zugangscode-Gate ---------- */

function Gate({ onUnlock, hinweis = "" }) {
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [fehler, setFehler] = useState(hinweis);

  const pruefen = async () => {
    if (!code.trim()) return;
    setChecking(true);
    setFehler("");
    try {
      const info = await pruefeZugang(code.trim());
      if (!info.ok) {
        setFehler("Zugangscode ist falsch.");
      } else if (zugangFehler(info)) {
        setFehler(zugangFehler(info));
      } else {
        Sitzung.merkeCode(code.trim());
        Sitzung.info = info;
        onUnlock(code.trim());
      }
    } catch (e) {
      setFehler("Verbindung fehlgeschlagen. Internet prüfen und erneut versuchen.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={styles.loadingScreen}>
      <div style={styles.loginCard}>
        <img src={LOGO_DATA_URI} alt="SV Heimstetten" style={styles.loginLogo} />
        <div style={styles.loginTitle}>Nachspielzeit</div>
        <div style={styles.loginSubtitle}>{IS_ADMIN_HOST ? "Administration" : `SV Heimstetten · ${Sitzung.team.toUpperCase()}`}</div>
        <input
          style={styles.loginInput}
          placeholder="Zugangscode"
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pruefen();
          }}
          autoFocus
        />
        {fehler && <div style={styles.loginError}>{fehler}</div>}
        <button style={styles.loginBtn} onClick={pruefen} disabled={checking || !code.trim()}>
          {checking ? "Prüfe …" : "Anmelden"}
        </button>
      </div>
    </div>
  );
}

/* ---------- Funktionsschalter (Admin: admin.nachspielzeit.app) ---------- */

const FEATURES = [
  { key: "mannschaftsbild", label: "Mannschaftsbild", beschreibung: "Großes Mannschaftsbild oben auf der Home-Seite (inkl. Foto-Upload)" },
  { key: "entwicklung", label: "Monatsentwicklung", beschreibung: "Tab „Monatsentwicklung“ (Extrapunkt je Spieler und Monat)" },
  { key: "spieltage", label: "Spieltage", beschreibung: "Tab „Spieltage“ inkl. Ergebnissen, Torschützen und Fotos" },
  { key: "teilen", label: "Spieltag teilen", beschreibung: "Button „Teilen“ (WhatsApp-Bild) an den Spieltagen" },
  { key: "uebungen", label: "Übungsbibliothek", beschreibung: "Setup → Übungen sowie Übungen und Notizen im Trainingsplan" },
  { key: "material", label: "Material", beschreibung: "Setup → Material (Bestandsführung)" },
  { key: "eltern_seite", label: "Eltern-Seite („Unsere Saison“)", beschreibung: "Öffentliche Seite für die Eltern inkl. Link-Box unter Setup. Ausgeschaltet: Link zeigt nur „nicht verfügbar“, die Link-Box verschwindet." },
  { key: "eltern_bilanz", label: "Bereich Bilanz", beschreibung: "Tab „Bilanz“ auf der Eltern-Seite", unter: "eltern_seite" },
  { key: "eltern_bilanz_saison", label: "Saisonbilanz", beschreibung: "Spiele, Siege, Unentschieden, Niederlagen, Tore", unter: "eltern_bilanz", ebene: 2 },
  { key: "eltern_bilanz_torschuetzen", label: "Torschützenliste", beschreibung: "Torschützen der Saison", unter: "eltern_bilanz", ebene: 2 },
  { key: "eltern_bilanz_gegner", label: "Bilanz pro Gegner", beschreibung: "Tabelle mit Ergebnissen je Gegner", unter: "eltern_bilanz", ebene: 2 },
  { key: "eltern_spieltage", label: "Bereich Spieltage", beschreibung: "Tab „Spieltage“ mit den Spieltagskarten", unter: "eltern_seite" },
  { key: "eltern_karten", label: "Bereich Karten", beschreibung: "Tab „Karten“ mit den Sammelkarten", unter: "eltern_seite" },
  { key: "eltern_songs", label: "Bereich Songs", beschreibung: "Tab „Songs“ mit Player und Liedtext", unter: "eltern_seite" },
  { key: "eltern_briefkasten", label: "Bereich Briefkasten", beschreibung: "Tab „Briefkasten“: Eltern werfen anonym Lob, Kritik und Ideen ein (standardmäßig aus; dafür muss vorher einmalig das SQL in Supabase laufen)", unter: "eltern_seite" },
  { key: "taktik", label: "Taktik-Board", beschreibung: "Tab „Taktik“ (interaktives Taktikboard mit Spielern, Laufwegen und Animation)" },
  { key: "geburtstage", label: "Geburtstagsreminder", beschreibung: "Hinweis auf der Home-Seite, wenn ein Spieler bald Geburtstag hat (Vorlauf in den Team-Einstellungen)" },
];

/* Funktionen, die ohne ausdrücklichen Eintrag AUS sind (alle anderen gelten ohne Eintrag als an) */
const FEATURES_STANDARD_AUS = ["eltern_briefkasten"];
const featureAn = (f, key) => (FEATURES_STANDARD_AUS.includes(key) ? f[key] === true : f[key] !== false);

const FeatureCtx = React.createContext({});
// Ohne Eintrag in der Datenbank gilt eine Funktion als aktiv
const useFeature = (key) => featureAn(React.useContext(FeatureCtx), key);

const IS_ADMIN_HOST = /^admin\./i.test(window.location.hostname) || /[?&]admin=1\b/.test(window.location.search);

const BACKUP_TABELLEN = [
  "players", "basisqualitaet", "trainingstermine", "trainings", "entwicklungen", "gegner", "spieltage", "spiele",
  "torschuetzen", "spieltag_gegner", "spieltag_teilnehmer", "material_bestand", "team_settings", "uebungen",
  "training_uebungen", "app_features", "teams", "taktik_boards", "training_boards", "briefkasten",
];

/* ---------- Spieler-Import (BFV/DFBnet-CSV) ---------- */

function parseBfvCsv(text) {
  const zeilen = text.replace(/\r/g, "").split("\n").filter((z) => z.trim() !== "");
  if (zeilen.length < 2) return [];
  const kopf = zeilen[0].split(";").map((h) => h.trim().toLowerCase());
  const idx = (re) => kopf.findIndex((h) => re.test(h));
  const iNach = idx(/^name/);
  const iVor = idx(/^vorname/);
  const iGeb = idx(/^geb/);
  const iPass = idx(/^passnummer/);
  return zeilen.slice(1).map((z) => {
    const c = z.split(";");
    const get = (i) => (i >= 0 && c[i] != null ? c[i].trim() : "");
    const vor = get(iVor).replace(/\s*\((m|w|d|x)\)\s*$/i, "").trim();
    const gebRaw = get(iGeb);
    const mt = gebRaw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    return {
      vorname: vor,
      nachname: get(iNach),
      geburtsdatum: mt ? `${mt[3]}-${mt[2].padStart(2, "0")}-${mt[1].padStart(2, "0")}` : null,
      passnummer: get(iPass) || null,
    };
  }).filter((r) => r.vorname);
}

function SpielerImport() {
  const [zeilen, setZeilen] = useState(null);
  const [spieler, setSpieler] = useState([]);
  const [fehler, setFehler] = useState(null);
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState(null);
  const [auswahl, setAuswahl] = useState({});
  const [zuordnung, setZuordnung] = useState({});

  const ladeDatei = async (file) => {
    setFehler(null);
    setErgebnis(null);
    try {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      setZeilen(parseBfvCsv(text));
    } catch (e) {
      try {
        const buf = await file.arrayBuffer();
        setZeilen(parseBfvCsv(new TextDecoder("windows-1252").decode(buf)));
      } catch (e2) {
        setFehler("Datei konnte nicht gelesen werden.");
        return;
      }
    }
    try {
      const rows = await dbSelect("players");
      setSpieler(rows.filter((p) => !p.deleted_at));
    } catch (e) {
      setFehler(friendlyError(e));
    }
  };

  // Abgleich: Passnummer, sonst eindeutiger Vorname
  const vorschau = useMemo(() => {
    if (!zeilen) return [];
    return zeilen.map((z, i) => {
      let treffer = z.passnummer ? spieler.filter((p) => p.passnummer && p.passnummer === z.passnummer) : [];
      let art = treffer.length === 1 ? "pass" : null;
      if (!art) {
        const gleicheImport = zeilen.filter((o) => o.vorname.toLowerCase() === z.vorname.toLowerCase()).length;
        treffer = spieler.filter((p) => (p.name || "").trim().toLowerCase() === z.vorname.toLowerCase());
        if (treffer.length === 1 && gleicheImport === 1) art = "name";
        else if (treffer.length >= 1) art = "unklar";
        else art = "neu";
      }
      return { ...z, i, art, treffer };
    });
  }, [zeilen, spieler]);

  const zielFuer = (v) => {
    if (v.art === "pass" || v.art === "name") return v.treffer[0].id;
    if (v.art === "unklar") return zuordnung[v.i] || null;
    return null;
  };
  const aktiv = (v) => (auswahl[v.i] !== undefined ? auswahl[v.i] : v.art !== "unklar" || !!zuordnung[v.i]);

  const importiere = async () => {
    setLaeuft(true);
    setFehler(null);
    let neu = 0, aktualisiert = 0;
    try {
      for (const v of vorschau) {
        if (!aktiv(v)) continue;
        const daten = { nachname: v.nachname || null, geburtsdatum: v.geburtsdatum, passnummer: v.passnummer };
        const ziel = zielFuer(v);
        if (ziel) {
          await dbUpdate("players", ziel, daten);
          aktualisiert++;
        } else if (v.art === "neu") {
          await dbInsert("players", { id: uid(), name: v.vorname, active: true, ...daten });
          neu++;
        }
      }
      setErgebnis({ neu, aktualisiert });
      setZeilen(null);
    } catch (e) {
      setFehler(friendlyError(e));
    } finally {
      setLaeuft(false);
    }
  };

  const importierteIds = new Set(vorschau.map((v) => zielFuer(v)).filter(Boolean));
  const fehlend = spieler.filter((p) => !importierteIds.has(p.id));
  const SQL_SPIELER = `alter table players add column if not exists nachname text;
alter table players add column if not exists geburtsdatum date;
alter table players add column if not exists passnummer text;
notify pgrst, 'reload schema';`;
  const label = { neu: "Neu anlegen", pass: "Aktualisieren (Passnr.)", name: "Aktualisieren (Vorname)", unklar: "Unklar – bitte zuordnen" };

  return (
    <section>
      <div style={styles.card}>
        <KartenTitel>Spieler-Import</KartenTitel>
        <div style={styles.cardDesc}>
        CSV-Export aus dem DFBnet hochladen (Spalten: Name, Vorname, Geb., Passnummer). Übernommen werden Nachname, Geburtsdatum und Passnummer. Es wird nichts gelöscht.
        </div>
        <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => e.target.files[0] && ladeDatei(e.target.files[0])} />
      </div>
      {fehler && (
        <div style={{ ...styles.editBanner, marginTop: 12 }}>
          <div>{fehler}</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Falls die Spalten fehlen, einmal in Supabase (SQL Editor) ausführen:</div>
          <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: "6px 0 0", userSelect: "all" }}>{SQL_SPIELER}</pre>
        </div>
      )}
      {ergebnis && (
        <div style={{ ...styles.editBanner, marginTop: 12 }}>
          Fertig: {ergebnis.neu} neu angelegt, {ergebnis.aktualisiert} aktualisiert.
        </div>
      )}
      {zeilen && (
        <div style={{ marginTop: 14 }}>
          <div className="card-list" style={styles.cardList}>
            {vorschau.map((v) => (
              <div key={v.i} style={{ ...styles.card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input type="checkbox" checked={aktiv(v)} onChange={(e) => setAuswahl((a) => ({ ...a, [v.i]: e.target.checked }))} aria-label="Übernehmen" />
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{v.vorname} {v.nachname}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>
                    {v.geburtsdatum ? formatGeburtsdatum(v.geburtsdatum) : "kein Geburtsdatum"} · Pass {v.passnummer || "–"}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: v.art === "neu" ? "var(--success-text)" : v.art === "unklar" ? "var(--danger-text)" : "var(--text)" }}>{label[v.art]}</div>
                {v.art === "unklar" && (
                  <select style={styles.select} value={zuordnung[v.i] || ""} onChange={(e) => setZuordnung((z) => ({ ...z, [v.i]: e.target.value }))}>
                    <option value="">Spieler wählen …</option>
                    {(v.treffer.length > 0 ? v.treffer : spieler).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{p.nachname ? ` ${p.nachname}` : ""}</option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
          {fehlend.length > 0 && (
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 10 }}>
              In der App, aber nicht in der Datei (bleiben unverändert): {fehlend.map((p) => p.name).join(", ")}
            </div>
          )}
          <button style={{ ...styles.primaryBtn, marginTop: 14 }} onClick={importiere} disabled={laeuft}>
            {laeuft ? "Importiere …" : `Import starten (${vorschau.filter(aktiv).length})`}
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------- Admin: Teams & Team-Einstellungen ---------- */

const SQL_TEAMS = `create table if not exists teams (
  id text primary key,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  archived boolean not null default false,
  created_at timestamptz default now()
);
alter table teams enable row level security;
grant select, insert, update, delete on table teams to anon, authenticated, service_role;
-- Alte, offene Policy entfernen. Zugriff regelt erst das Zugangs-Skript (Admin → Zugänge): ohne dieses ist die Tabelle gesperrt.
drop policy if exists "access via code" on teams;
insert into teams (id, name) values ('u8', 'U8') on conflict (id) do nothing;

-- Daten den Teams zuordnen (bestehende Daten gehören zu "u8")
alter table players add column if not exists team_id text not null default 'u8';
alter table trainingstermine add column if not exists team_id text not null default 'u8';
alter table gegner add column if not exists team_id text not null default 'u8';
alter table spieltage add column if not exists team_id text not null default 'u8';
alter table uebungen add column if not exists team_id text not null default 'u8';
alter table material_bestand add column if not exists team_id text not null default 'u8';
alter table app_features add column if not exists team_id text not null default 'u8';
alter table app_features drop constraint if exists app_features_pkey;
alter table app_features add primary key (team_id, key);
notify pgrst, 'reload schema';`;

function SqlHinweis({ fehler }) {
  return (
    <div style={{ ...styles.editBanner, marginBottom: 12 }}>
      <div style={{ marginBottom: 6 }}>{fehler}</div>
      <div style={{ fontSize: 13 }}>Falls die Teams-Tabelle noch fehlt, einmal in Supabase (SQL Editor) ausführen:</div>
      <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: "6px 0 0", userSelect: "all" }}>{SQL_TEAMS}</pre>
    </div>
  );
}

const SQL_ZUGAENGE = `-- Nachspielzeit: Zugangscodes pro Team + Team-Zuordnung aller Daten
-- Vorher: unten bei DEIN-AKTUELLER-CODE deinen bisherigen Zugangscode eintragen (zweimal!).
-- Das Skript ist wiederholbar (kann mehrfach ausgeführt werden).

-- 1) Zugangscodes (team_id leer = Admin mit Zugriff auf alle Teams)
create table if not exists access_codes (
  code text primary key,
  team_id text,
  label text,
  active boolean not null default true,
  created_at timestamptz default now()
);
alter table access_codes enable row level security;
grant select, insert, update, delete on table access_codes to anon, authenticated, service_role;
insert into access_codes (code, team_id, label) values ('DEIN-AKTUELLER-CODE', null, 'Admin') on conflict (code) do nothing;

create or replace function nsz_header_code() returns text language sql stable as $$
  select nullif(current_setting('request.headers', true), '')::json ->> 'x-access-code'
$$;
create or replace function nsz_code_ok(t text default null) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from access_codes where code = nsz_header_code() and active and (team_id is null or t is null or team_id = t))
$$;
create or replace function nsz_is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from access_codes where code = nsz_header_code() and active and team_id is null)
$$;
create or replace function check_access(code text) returns json language sql stable security definer set search_path = public as $$
  select coalesce(
    (select json_build_object('ok', true, 'team_id', a.team_id) from access_codes a where a.code = check_access.code and a.active limit 1),
    json_build_object('ok', false))
$$;
grant execute on function check_access(text) to anon, authenticated;

-- Sicherung: nicht fortfahren, solange der Platzhalter-Code der einzige Admin-Code ist
do $$ begin
  if not exists (select 1 from access_codes where team_id is null and active and code <> 'DEIN-AKTUELLER-CODE') then
    raise exception 'Bitte zuerst DEIN-AKTUELLER-CODE durch deinen echten Zugangscode ersetzen.';
  end if;
end $$;

-- 2) Alle Datentabellen: team_id + Zugriff nur mit passendem Code
do $$
declare t text; p record;
begin
  foreach t in array array['players','basisqualitaet','trainingstermine','trainings','entwicklungen','gegner','spieltage','spiele','torschuetzen','spieltag_gegner','spieltag_teilnehmer','material_bestand','uebungen','training_uebungen','app_features'] loop
    execute format('alter table public.%I add column if not exists team_id text not null default %L', t, 'u8');
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "access via code" on public.%I for all to public using (nsz_code_ok(team_id)) with check (nsz_code_ok(team_id))', t);
  end loop;
end $$;

-- team_settings (alte Einzeltabelle fürs Mannschaftsfoto): für jeden gültigen Code lesbar
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'team_settings' loop
    execute format('drop policy %I on public.team_settings', p.policyname);
  end loop;
end $$;
create policy "access via code" on team_settings for all to public using (nsz_code_ok()) with check (nsz_code_ok());

-- 3) Schlüssel pro Team
alter table app_features drop constraint if exists app_features_pkey;
alter table app_features add primary key (team_id, key);
do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.material_bestand'::regclass and contype = 'u'
      and (select array_agg(attname::text order by attname) from pg_attribute where attrelid = conrelid and attnum = any(conkey)) = array['date','material']
  loop
    execute format('alter table public.material_bestand drop constraint %I', c.conname);
  end loop;
end $$;
alter table material_bestand drop constraint if exists material_bestand_team_date_material_key;
alter table material_bestand add constraint material_bestand_team_date_material_key unique (team_id, date, material);

-- 4) Teams und Codes: wer darf was
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' and tablename in ('teams', 'access_codes') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
create policy "teams lesen" on teams for select to public using (nsz_code_ok());
create policy "teams aendern" on teams for update to public using (nsz_code_ok(id)) with check (nsz_code_ok(id));
create policy "teams anlegen" on teams for insert to public with check (nsz_is_admin());
create policy "teams loeschen" on teams for delete to public using (nsz_is_admin());
create policy "nur admin" on access_codes for all to public using (nsz_is_admin()) with check (nsz_is_admin());

-- 5) Bilder-Bucket: Schreiben nur mit gültigem Code (Lesen bleibt öffentlich)
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%profilbilder%' loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;
create policy "profilbilder lesen" on storage.objects for select to public using (bucket_id = 'profilbilder');
create policy "profilbilder schreiben" on storage.objects for insert to public with check (bucket_id = 'profilbilder' and public.nsz_code_ok());
create policy "profilbilder aendern" on storage.objects for update to public using (bucket_id = 'profilbilder' and public.nsz_code_ok());
create policy "profilbilder loeschen" on storage.objects for delete to public using (bucket_id = 'profilbilder' and public.nsz_code_ok());


-- 6) Übungen: mehrere Teams je Übung (team_ids); 'alle' = für alle Teams lesbar (ändern nur Admin)
alter table uebungen add column if not exists team_ids text[] not null default '{u8}';
update uebungen set team_ids = array[team_id] where team_id is not null and team_id <> 'u8' and team_ids = '{u8}';
create or replace function nsz_code_ok_arr(t text[]) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from access_codes where code = nsz_header_code() and active and (team_id is null or team_id = any(t)))
$$;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'uebungen' loop
    execute format('drop policy %I on public.uebungen', p.policyname);
  end loop;
end $$;
create policy "uebungen lesen" on uebungen for select to public using (nsz_code_ok_arr(team_ids) or ('alle' = any(team_ids) and nsz_code_ok()));
create policy "uebungen anlegen" on uebungen for insert to public with check (nsz_code_ok_arr(team_ids));
create policy "uebungen aendern" on uebungen for update to public using (nsz_code_ok_arr(team_ids)) with check (nsz_code_ok_arr(team_ids));
create policy "uebungen loeschen" on uebungen for delete to public using (nsz_code_ok_arr(team_ids));

notify pgrst, 'reload schema';
`;

function neuerCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}


// Datei-Format: { "uebungen": [ { "titel": "...", "ablauf": "...", "keywords": ["..."] } ] } oder direkt eine Liste
function parseUebungenImport(text) {
  const roh = JSON.parse(text);
  const liste = Array.isArray(roh) ? roh : roh.uebungen;
  if (!Array.isArray(liste)) throw new Error("Keine Übungsliste gefunden.");
  return liste
    .map((u) => ({
      titel: String(u.titel || u.name || "").trim(),
      beschreibung: String(u.ablauf || u.beschreibung || "").trim(),
      keywords: (Array.isArray(u.keywords) ? u.keywords : String(u.keywords || "").split(/[,;]/)).map((k) => String(k).trim()).filter(Boolean),
      bild_url: u.bild_url || (String(u.bild || "").startsWith("http") ? u.bild : null),
      bild_data: u.bild_data || (String(u.bild || "").startsWith("data:") ? u.bild : null),
    }))
    .filter((u) => u.titel);
}

// Mehrfachauswahl: einzelne Teams oder "Alle Teams" (schließen sich gegenseitig aus)
function TeamMehrfachAuswahl({ teams, value, onChange }) {
  const alleAn = value.includes("alle");
  const umschalten = (id) => {
    if (id === "alle") return onChange(alleAn ? [teams[0] ? teams[0].id : "u8"] : ["alle"]);
    const basis = alleAn ? [] : value;
    const neu = basis.includes(id) ? basis.filter((x) => x !== id) : [...basis, id];
    if (neu.length > 0) onChange(neu);
  };
  const chip = (id, label) => {
    const an = id === "alle" ? alleAn : !alleAn && value.includes(id);
    return (
      <button key={id} type="button" role="checkbox" aria-checked={an} onClick={() => umschalten(id)} style={{ ...styles.chip, ...(an ? styles.chipActive : {}) }}>
        {label}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {chip("alle", "Alle Teams")}
      {teams.filter((t) => !t.archived).map((t) => chip(t.id, t.name))}
    </div>
  );
}

function UebungenAdmin({ teams }) {
  const [alle, setAlle] = useState(null);
  const [fehler, setFehler] = useState(null);
  const [ziel, setZiel] = useState(["alle"]);
  const [text, setText] = useState("");
  const [vorschau, setVorschau] = useState(null);
  const [meldung, setMeldung] = useState("");
  const [suche, setSuche] = useState("");
  const [kwFilter, setKwFilter] = useState([]);
  const [offenId, setOffenId] = useState(null);
  const [bearbeite, setBearbeite] = useState(null);
  const laden = async () => {
    try {
      const rows = await dbSelect("uebungen", { alle: true });
      setAlle(rows.filter((u) => !u.deleted_at).sort((a, b) => String(a.titel).localeCompare(String(b.titel), "de")));
      setFehler(null);
    } catch (e) {
      setAlle([]);
      setFehler(friendlyError(e));
    }
  };
  useEffect(() => {
    laden();
  }, []);
  const zuordnungName = (ids) => ids.map((id) => (id === "alle" ? "Alle Teams" : (teams.find((t) => t.id === id) || { name: id }).name)).join(", ");
  const lesen = (t) => {
    setText(t);
    setMeldung("");
    try {
      setVorschau(t.trim() ? parseUebungenImport(t) : null);
    } catch (e) {
      setVorschau(null);
      setMeldung("Datei nicht lesbar: " + e.message);
    }
  };
  const teamsVon = (u) => (Array.isArray(u.team_ids) ? u.team_ids : [u.team_id || "u8"]);
  const findeBekannte = (titel) =>
    (alle || []).find((u) => teamsVon(u).some((t) => ziel.includes(t)) && String(u.titel).trim().toLowerCase() === titel.toLowerCase());
  const bekannt = (titel) => !!findeBekannte(titel);
  const neue = (vorschau || []).filter((u) => !bekannt(u.titel));
  // vorhandene Übungen ohne Bild bekommen das Bild aus der Datei
  const ergaenzen = (vorschau || []).filter((u) => u.bild_data && findeBekannte(u.titel) && !findeBekannte(u.titel).bild_url);
  const bildHochladen = async (id, dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    return uploadUebungBild(id, new File([blob], "bild.jpg", { type: blob.type || "image/jpeg" }));
  };
  const importieren = async () => {
    try {
      const rows = [];
      for (const u of neue) {
        const id = uid();
        const bildUrl = u.bild_data ? await bildHochladen(id, u.bild_data) : u.bild_url;
        rows.push({ id, titel: u.titel, beschreibung: u.beschreibung || null, keywords: u.keywords, bild_url: bildUrl, team_ids: ziel });
      }
      if (rows.length) await dbInsert("uebungen", rows);
      for (const u of ergaenzen) {
        const b = findeBekannte(u.titel);
        await dbUpdate("uebungen", b.id, { bild_url: await bildHochladen(b.id, u.bild_data) });
      }
      setMeldung(`${rows.length} Übungen importiert${ergaenzen.length ? `, ${ergaenzen.length} Bild(er) ergänzt` : ""} (${zuordnungName(ziel)}).`);
      setText("");
      setVorschau(null);
      await laden();
    } catch (e) {
      setMeldung(friendlyError(e));
    }
  };
  const zuordnen = async (u, ids) => {
    try {
      await dbUpdate("uebungen", u.id, { team_ids: ids });
      await laden();
    } catch (e) {
      setMeldung(friendlyError(e));
    }
  };
  const speichernUebung = async (u, file) => {
    try {
      let bildUrl = bearbeite.bild_url || null;
      if (file) bildUrl = await uploadUebungBild(u.id, file);
      await dbUpdate("uebungen", u.id, { titel: u.titel, beschreibung: u.beschreibung || null, keywords: u.keywords, bild_url: bildUrl });
      setBearbeite(null);
      setMeldung("Übung gespeichert.");
      await laden();
    } catch (e) {
      setMeldung(friendlyError(e));
    }
  };
  const loescheUebung = (u) =>
    confirmAnd(`Übung „${u.titel}“ wirklich löschen?`, async () => {
      try {
        await dbUpdate("uebungen", u.id, { deleted_at: new Date().toISOString() });
        setBearbeite(null);
        await laden();
      } catch (e) {
        setMeldung(friendlyError(e));
      }
    });
  if (bearbeite) {
    return (
      <UebungForm
        key={bearbeite.id}
        start={{ id: bearbeite.id, titel: bearbeite.titel || "", beschreibung: bearbeite.beschreibung || "", keywords: Array.isArray(bearbeite.keywords) ? bearbeite.keywords : [], bildUrl: bearbeite.bild_url || null }}
        alleKeywords={alleKeywordsVon((alle || []).map((x) => ({ keywords: Array.isArray(x.keywords) ? x.keywords : [] })))}
        onSave={speichernUebung}
        onCancel={() => setBearbeite(null)}
        onRemove={() => loescheUebung(bearbeite)}
      />
    );
  }
  const normiert = (alle || []).map((u) => ({ ...u, keywords: Array.isArray(u.keywords) ? u.keywords : [], beschreibung: u.beschreibung || "" }));
  const gefiltert = filterUebungen(normiert, suche, kwFilter);
  return (
    <section>
      {fehler && <div style={{ ...styles.editBanner, marginBottom: 12 }}>{fehler}</div>}
      <div style={{ ...styles.card, display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        <KartenTitel style={{ marginBottom: 0 }}>Übungen importieren</KartenTitel>
        <div style={styles.cardDesc}>Übungen importieren und Teams zuordnen. Eine Übung gehört entweder einem Team oder allen Teams (dann ist sie in jeder Team-App sichtbar, ändern können sie nur Admins).</div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Zuordnung der importierten Übungen
          <div style={{ marginTop: 6 }}>
            <TeamMehrfachAuswahl teams={teams} value={ziel} onChange={setZiel} />
          </div>
        </div>
        <input
          type="file"
          accept=".json,application/json,text/plain"
          onChange={async (e) => {
            const f = e.target.files && e.target.files[0];
            if (f) lesen(await f.text());
          }}
        />
        <textarea
          style={{ ...styles.input, width: "100%", boxSizing: "border-box", minHeight: 90, fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13 }}
          placeholder="… oder den Inhalt der Datei hier einfügen"
          value={text}
          onChange={(e) => lesen(e.target.value)}
        />
        {vorschau && (
          <div style={{ fontSize: 13 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {neue.length} neue Übungen{vorschau.length - neue.length > 0 ? `, ${vorschau.length - neue.length} gibt es schon (werden übersprungen${ergaenzen.length ? `, ${ergaenzen.length} bekommen das Bild` : ""})` : ""}
            </div>
            {vorschau.map((u, i) => (
              <div key={i} style={{ padding: "2px 0", color: bekannt(u.titel) ? "var(--muted-2)" : "var(--text)" }}>
                {bekannt(u.titel) ? "– " : "+ "}
                {u.titel}
                {u.keywords.length > 0 ? ` · ${u.keywords.join(", ")}` : ""}
                {u.bild_data || u.bild_url ? " · mit Bild" : ""}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button style={{ ...styles.primaryBtn, opacity: neue.length || ergaenzen.length ? 1 : 0.5 }} disabled={!neue.length && !ergaenzen.length} onClick={importieren}>
            {neue.length ? `${neue.length} Übungen importieren` : ergaenzen.length ? `${ergaenzen.length} Bild(er) ergänzen` : "Importieren"}
          </button>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{meldung}</span>
        </div>
        <div style={{ fontSize: 13, color: "var(--muted-2)" }}>
          Bilder lassen sich später in der Team-App je Übung ergänzen (Alle-Teams-Übungen im Admin: Bild per Import-Feld „bild_url“).
        </div>
      </div>

      {alle !== null && <UebungFilterLeiste karte titel={`Alle Übungen (${alle.length})`} uebungen={normiert} suche={suche} setSuche={setSuche} filter={kwFilter} setFilter={setKwFilter} />}
      {alle === null ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Lade …</div>
      ) : (
        <div className="card-list" style={styles.cardList}>
          {gefiltert.map((u) => (
            <div key={u.id} style={{ ...styles.card, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setOffenId(offenId === u.id ? null : u.id)}
                aria-expanded={offenId === u.id}
                style={{ flex: 1, minWidth: 140, textAlign: "left", background: "transparent", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer" }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  {offenId === u.id ? "▾" : "▸"} {u.titel}
                </div>
                <div style={{ fontSize: 13, color: "var(--muted)" }}>{Array.isArray(u.keywords) ? u.keywords.join(", ") : ""}</div>
              </button>
              {offenId === u.id && (
                <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
                  {u.bild_url && <img src={u.bild_url} alt={u.titel} style={{ maxWidth: "100%", borderRadius: 12 }} />}
                  {u.beschreibung ? <FormatierterText text={u.beschreibung} /> : <div style={{ fontSize: 13, color: "var(--muted)" }}>Kein Ablauf hinterlegt.</div>}
                  <div>
                    <button style={styles.rowBtn} onClick={() => setBearbeite(u)}>
                      Bearbeiten
                    </button>
                  </div>
                </div>
              )}
              <div style={{ width: "100%" }}>
                <TeamMehrfachAuswahl teams={teams} value={teamsVon(u)} onChange={(ids) => zuordnen(u, ids)} />
              </div>
            </div>
          ))}
          {gefiltert.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)" }}>Keine Übungen.</div>}
        </div>
      )}
    </section>
  );
}

function ZugaengeVerwaltung({ teams }) {
  const [codes, setCodes] = useState(null);
  const [fehler, setFehler] = useState(null);
  const [offen, setOffen] = useState({});
  const [label, setLabel] = useState("");
  const [teamId, setTeamId] = useState(teams[0] ? teams[0].id : "");
  const [code, setCode] = useState(() => neuerCode());
  const [meldung, setMeldung] = useState("");
  const laden = async () => {
    try {
      setCodes((await dbSelect("access_codes", { alle: true })).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));
      setFehler(null);
    } catch (e) {
      setCodes([]);
      setFehler(friendlyError(e));
    }
  };
  useEffect(() => {
    laden();
  }, []);
  const teamName = (id) => (id ? (teams.find((t) => t.id === id) || { name: id }).name : "Alle Teams (Admin)");
  const anlegen = async () => {
    const c = code.trim();
    if (c.length < 6) return setMeldung("Der Code braucht mindestens 6 Zeichen.");
    if (codes.some((x) => x.code === c)) return setMeldung("Diesen Code gibt es schon.");
    try {
      await dbInsert("access_codes", { code: c, team_id: teamId === "*" ? null : teamId, label: label.trim() || null, active: true });
      setLabel("");
      setCode(neuerCode());
      setMeldung("Code angelegt. Jetzt an die Trainer des Teams weitergeben.");
      await laden();
    } catch (e) {
      setMeldung(friendlyError(e));
    }
  };
  const umschalten = async (c) => {
    if (c.code === Sitzung.code) return setMeldung("Der Code, mit dem du gerade angemeldet bist, kann nicht gesperrt werden.");
    try {
      await dbUpdate("access_codes", c.code, { active: !c.active }, "code");
      await laden();
    } catch (e) {
      setMeldung(friendlyError(e));
    }
  };
  const loeschen = async (c) => {
    if (c.code === Sitzung.code) return setMeldung("Der Code, mit dem du gerade angemeldet bist, kann nicht gelöscht werden.");
    confirmAnd(`Code${c.label ? ` „${c.label}“` : ""} endgültig löschen?`, async () => {
      try {
        await dbDelete("access_codes", c.code, "code");
        await laden();
      } catch (e) {
        setMeldung(friendlyError(e));
      }
    });
  };
  return (
    <section>
      <div style={{ ...styles.card, marginBottom: 14 }}>
        <KartenTitel>Zugänge</KartenTitel>
        <div style={{ ...styles.cardDesc, marginBottom: 0 }}>
        Jedes Team hat eigene Zugangscodes und sieht nur seine Daten. Ein Code ohne Team („Alle Teams“) ist ein Admin-Code und funktioniert auch in der Administration.
        </div>
      </div>
      {fehler && (
        <div style={{ ...styles.editBanner, marginBottom: 12 }}>
          <div style={{ marginBottom: 6 }}>{fehler}</div>
          <div style={{ fontSize: 13 }}>Falls die Zugangs-Tabelle noch fehlt: SQL unten einmalig in Supabase (SQL Editor) ausführen, vorher DEIN-AKTUELLER-CODE ersetzen.</div>
          <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: "6px 0 0", userSelect: "all" }}>{SQL_ZUGAENGE}</pre>
        </div>
      )}
      {!fehler && codes !== null && (
        <div style={{ ...styles.card, marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <KartenTitel>Neuen Code anlegen</KartenTitel>
          <input style={{ ...styles.input, width: "100%", boxSizing: "border-box" }} placeholder="Bezeichnung (z. B. Trainer U9)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <select style={{ ...styles.input, width: "100%", boxSizing: "border-box" }} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="*">Alle Teams (Admin)</option>
          </select>
          <input style={{ ...styles.input, width: "100%", boxSizing: "border-box" }} value={code} onChange={(e) => setCode(e.target.value)} />
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button style={styles.primaryBtn} onClick={anlegen}>Code anlegen</button>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>{meldung}</span>
          </div>
        </div>
      )}
      {codes === null ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Lade …</div>
      ) : (
        <div className="card-list" style={styles.cardList}>
          {codes.map((c) => (
            <div key={c.code} style={{ ...styles.card, opacity: c.active ? 1 : 0.6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>
                    {c.label || "(ohne Bezeichnung)"}
                    {c.active ? "" : " · gesperrt"}
                    {c.code === Sitzung.code ? " · dein aktueller Code" : ""}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{teamName(c.team_id)}</div>
                  <div style={{ fontSize: 13, marginTop: 4, fontWeight: 600, letterSpacing: "0.02em", userSelect: "all" }}>{offen[c.code] ? c.code : "••••••••"}</div>
                </div>
                <button style={styles.rowBtnOutline} onClick={() => setOffen((o) => ({ ...o, [c.code]: !o[c.code] }))}>
                  {offen[c.code] ? "Verbergen" : "Anzeigen"}
                </button>
                <button style={styles.rowBtnOutline} onClick={() => umschalten(c)}>
                  {c.active ? "Sperren" : "Entsperren"}
                </button>
                <button style={styles.rowBtnOutline} onClick={() => loeschen(c)}>
                  Löschen
                </button>
              </div>
            </div>
          ))}
          {codes.length === 0 && !fehler && <div style={{ fontSize: 13, color: "var(--muted)" }}>Noch keine Codes.</div>}
        </div>
      )}
    </section>
  );
}

const FARB_PALETTE = [["#C4271F", "Rot"], ["#1F5FBF", "Blau"], ["#1E7A46", "Grün"], ["#D9731A", "Orange"], ["#6A3FA6", "Lila"], ["#26323F", "Anthrazit"]];

/* Farbauswahl: Palette + eigene Farbe + Zurücksetzen. `wert` leer = nichts gewählt (z. B. "wie Teamfarbe"). */
function FarbWahl({ titel, hinweis, wert, onChange, leer, onLeer, palette = FARB_PALETTE }) {
  const an = (h) => !!wert && wert.toLowerCase() === h.toLowerCase();
  return (
    <div style={{ fontSize: 13, fontWeight: 700 }}>
      <span id={`fw-${titel}`}>{titel}</span>
      <div role="group" aria-labelledby={`fw-${titel}`} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
        {palette.map(([h, l]) => (
          <button key={h} title={l} aria-label={l} aria-pressed={an(h)} onClick={() => onChange(h)} style={{ width: 44, height: 44, borderRadius: 999, background: h, cursor: "pointer", padding: 0, border: an(h) ? "3px solid var(--text)" : "2px solid var(--border-strong)" }} />
        ))}
        <input type="color" value={wert || CLUB_STD.farbe} onChange={(e) => onChange(e.target.value)} aria-label={`${titel}: eigene Farbe`} style={{ width: 44, height: 44, padding: 0, border: "none", background: "none", cursor: "pointer" }} />
        {leer && <button style={styles.linkBtn} aria-pressed={!wert && leer !== "Zurücksetzen"} onClick={onLeer}>{leer}</button>}
      </div>
      {hinweis && <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>{hinweis}</div>}
    </div>
  );
}

/* Vorschau der Farben im Admin: Kopfzeile, Umschalter, Button, Link und Chips mit den gewählten Farben (noch nicht gespeichert) */
function FarbVorschau({ basis, kopf, akzent, auswahl, chip, trikot, regler }) {
  const b = sichereTeamfarbe(basis || CLUB_STD.farbe);
  const f = berechneFarben(b, { kopf, akzent, auswahl, chip, trikot, regler }, istDunkel());
  const aus = f.auswahl || f.auswahlStandard;
  const chipFarbe = f.chip || aus;
  const chipText = f.chip ? f.chipText : f.auswahl ? f.auswahlText : "#fff";
  const seg = { flex: 1, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontSize: 14, fontWeight: 600 };
  return (
    <div role="img" aria-label="Vorschau der gewählten Farben" style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--surface)" }}>
      <div style={{ background: f.kopfGrad, color: "#fff", padding: "12px 14px", fontSize: 14, fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Kopfzeile</span>
        <span style={{ background: f.kopfBtn, borderRadius: 999, padding: "4px 12px", fontSize: 12 }}>Team</span>
      </div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 4, padding: 4, border: "1px solid var(--divider)", borderRadius: 12 }}>
          <span style={{ ...seg, background: aus, color: f.auswahl ? f.auswahlText : "#fff" }}>Training</span>
          <span style={{ ...seg, color: "var(--muted)" }}>Saison</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ background: f.accent, color: "#fff", borderRadius: 12, padding: "0 18px", minHeight: 44, display: "inline-flex", alignItems: "center", fontSize: 14, fontWeight: 600 }}>Speichern</span>
          <span style={{ color: f.accentText, fontSize: 14, fontWeight: 600 }}>Link-Text</span>
          <span style={{ background: chipFarbe, color: chipText, border: `1px solid ${chipFarbe}`, borderRadius: 8, padding: "0 14px", minHeight: 44, display: "inline-flex", alignItems: "center", fontSize: 13 }}>Chip aktiv</span>
          <span style={{ border: "1px solid var(--border-strong)", color: "var(--muted)", borderRadius: 8, padding: "0 14px", minHeight: 44, display: "inline-flex", alignItems: "center", fontSize: 13 }}>Chip</span>
          <span aria-hidden="true" style={{ flexBasis: "100%", height: 44, display: "flex", alignItems: "center" }}>
            <span style={{ position: "relative", flex: 1, height: 6, borderRadius: 999, background: "var(--track)" }}>
              <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "55%", borderRadius: 999, background: f.regler || f.accent }} />
              <span style={{ position: "absolute", left: "55%", top: "50%", width: 20, height: 20, marginLeft: -10, marginTop: -10, borderRadius: 999, background: f.regler || f.accent, border: "2px solid var(--surface)" }} />
            </span>
          </span>
          <span style={{ position: "relative", display: "inline-flex", width: 36, height: 36 }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill={f.trikot || f.accent} stroke="var(--border-strong)" strokeWidth="0.6" strokeLinejoin="round"><path d="M16 3l-2.2 1.8a2.2 2.2 0 0 1-3.6 0L8 3 2 7.5 4.3 11H7v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-9h2.7L22 7.5 16 3z" /></svg>
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", paddingTop: 6, fontSize: 15, fontWeight: 700, color: f.trikot ? f.trikotText : "#fff", lineHeight: 1 }}>7</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function TeamEinstellungen({ team, teamRow, onSaved }) {
  const cfg = (teamRow && teamRow.config) || {};
  const [name, setName] = useState(teamRow ? teamRow.name : "");
  const [vorlauf, setVorlauf] = useState(String(cfg.geburtstage_vorlauf ?? 7));
  const [status, setStatus] = useState("");
  const [verein, setVerein] = useState(cfg.verein_name || "");
  const [logoUrl, setLogoUrl] = useState(cfg.verein_logo_url || "");
  const [logoBusy, setLogoBusy] = useState(false);
  const [farbe, setFarbe] = useState(cfg.verein_farbe || "");
  const [farbeKopf, setFarbeKopf] = useState(cfg.farbe_kopf || "");
  const [farbeAkzent, setFarbeAkzent] = useState(cfg.farbe_akzent || "");
  const [farbeAuswahl, setFarbeAuswahl] = useState(cfg.farbe_auswahl || "");
  const [farbeChip, setFarbeChip] = useState(cfg.farbe_chip || "");
  const [farbeTrikot, setFarbeTrikot] = useState(cfg.farbe_trikot || "");
  const [farbeRegler, setFarbeRegler] = useState(cfg.farbe_regler || "");
  const [titel, setTitel] = useState(cfg.eltern_titel || "");
  const [fotoUrl, setFotoUrl] = useState(cfg.team_photo_url || "");
  const [fotoBusy, setFotoBusy] = useState(false);
  const trs = cfg.training_std || {};
  const [trTage, setTrTage] = useState(Array.isArray(trs.tage) && trs.tage.length ? trs.tage.map(Number) : [2, 4]);
  const [trVon, setTrVon] = useState(trs.von || "16:30");
  const [trBis, setTrBis] = useState(trs.bis || "17:45");
  const [trWochen, setTrWochen] = useState(String(trs.wochen || 8));
  const [stZeit, setStZeit] = useState((cfg.spieltag_std && cfg.spieltag_std.zeit) || "");
  const [stOrt, setStOrt] = useState((cfg.spieltag_std && cfg.spieltag_std.ort) || "");
  const sz0 = spielzeitenAusConfig(cfg.spieltag_std);
  const [szListe, setSzListe] = useState(sz0.spielzeiten.join(", "));
  const [szStd, setSzStd] = useState(String(sz0.spielzeit));
  const [startTab, setStartTab] = useState(cfg.start_tab || "letzte");
  const [backupTage, setBackupTage] = useState(String(cfg.backup_tage === undefined ? 7 : cfg.backup_tage));
  const [papierTage, setPapierTage] = useState(String(cfg.papierkorb_tage === undefined || cfg.papierkorb_tage === null ? 30 : cfg.papierkorb_tage));
  const [codes, setCodes] = useState(null);
  useEffect(() => {
    dbSelect("access_codes", { alle: true }).then((r) => setCodes(r.filter((c) => c.team_id === team))).catch(() => setCodes([]));
  }, [team]);
  const [saisonStart, setSaisonStart] = useState(String(cfg.saison_start || 9));
  const [saisonEnde, setSaisonEnde] = useState(String(cfg.saison_ende || 7));
  const [wertung, setWertung] = useState(cfg.spieltag_wertung || "ergebnisse");
  const bw = cfg.bewertung || {};
  const bwFeld = (k, d) => String(bw[k] ?? d).replace(".", ",");
  const [bewertung, setBewertung] = useState({
    gelb: bwFeld("gelb", KARTEN_STD.gelb), blau: bwFeld("blau", KARTEN_STD.blau), rot: bwFeld("rot", KARTEN_STD.rot),
    anwesend: bwFeld("anwesend", TEILNAHME_STD.anwesend), abzugAnmeldung: bwFeld("abzugAnmeldung", TEILNAHME_STD.abzugAnmeldung),
    abzugVerspaetet: bwFeld("abzugVerspaetet", TEILNAHME_STD.abzugVerspaetet), unentschuldigt: bwFeld("unentschuldigt", TEILNAHME_STD.unentschuldigt), entschuldigt: bwFeld("entschuldigt", TEILNAHME_STD.entschuldigt),
  });
  const fotoWaehlen = async (file) => {
    if (!file) return;
    setFotoBusy(true);
    try {
      setFotoUrl(await uploadTeamFoto(file, team));
      setStatus("Mannschaftsbild hochgeladen – bitte speichern");
    } catch (e) {
      setStatus(friendlyError(e));
    } finally {
      setFotoBusy(false);
    }
  };
  const logoWaehlen = async (file) => {
    if (!file) return;
    setLogoBusy(true);
    try {
      setLogoUrl(await uploadVereinsLogo(team, file));
      setStatus("Wappen hochgeladen – bitte speichern");
    } catch (e) {
      setStatus(friendlyError(e));
    } finally {
      setLogoBusy(false);
    }
  };
  const speichern = async () => {
    setStatus("…");
    try {
      const v = Math.max(0, Math.min(60, parseInt(vorlauf, 10) || 0));
      const neuCfg = { ...cfg, geburtstage_vorlauf: v };
      if (verein.trim()) neuCfg.verein_name = verein.trim(); else delete neuCfg.verein_name;
      if (logoUrl) neuCfg.verein_logo_url = logoUrl; else delete neuCfg.verein_logo_url;
      if (farbe) neuCfg.verein_farbe = farbe; else delete neuCfg.verein_farbe;
      if (farbeKopf) neuCfg.farbe_kopf = farbeKopf; else delete neuCfg.farbe_kopf;
      if (farbeAkzent) neuCfg.farbe_akzent = farbeAkzent; else delete neuCfg.farbe_akzent;
      if (farbeAuswahl) neuCfg.farbe_auswahl = farbeAuswahl; else delete neuCfg.farbe_auswahl;
      if (farbeChip) neuCfg.farbe_chip = farbeChip; else delete neuCfg.farbe_chip;
      if (farbeTrikot) neuCfg.farbe_trikot = farbeTrikot; else delete neuCfg.farbe_trikot;
      if (farbeRegler) neuCfg.farbe_regler = farbeRegler; else delete neuCfg.farbe_regler;
      if (titel.trim()) neuCfg.eltern_titel = titel.trim(); else delete neuCfg.eltern_titel;
      if (fotoUrl) neuCfg.team_photo_url = fotoUrl;
      const sS = Number(saisonStart), sE = Number(saisonEnde);
      if (!(sE < sS)) { setStatus("Das Saisonende muss vor dem Saisonbeginn liegen (z. B. Beginn September, Ende Juli)."); return; }
      if (sS === 9 && sE === 7) { delete neuCfg.saison_start; delete neuCfg.saison_ende; } else { neuCfg.saison_start = sS; neuCfg.saison_ende = sE; }
      if (wertung === "ergebnisse") delete neuCfg.spieltag_wertung; else neuCfg.spieltag_wertung = wertung;
      const trNeu = { tage: [...trTage].sort(), von: trVon || "16:30", bis: trBis || "17:45", wochen: Math.max(1, Math.min(52, parseInt(trWochen, 10) || 8)) };
      if (JSON.stringify(trNeu) === JSON.stringify({ tage: [2, 4], von: "16:30", bis: "17:45", wochen: 8 }) || trNeu.tage.length === 0) delete neuCfg.training_std; else neuCfg.training_std = trNeu;
      const szNeu = spielzeitenAusConfig({ spielzeiten: szListe.split(/[^0-9]+/).filter(Boolean), spielzeit: szStd });
      const szIstStd = JSON.stringify(szNeu) === JSON.stringify(spielzeitenAusConfig(null));
      if (stZeit || stOrt.trim() || !szIstStd) neuCfg.spieltag_std = { zeit: stZeit, ort: stOrt.trim(), ...(szIstStd ? {} : { spielzeiten: szNeu.spielzeiten, spielzeit: szNeu.spielzeit }) }; else delete neuCfg.spieltag_std;
      setSzListe(szNeu.spielzeiten.join(", "));
      setSzStd(String(szNeu.spielzeit));
      if (startTab === "letzte") delete neuCfg.start_tab; else neuCfg.start_tab = startTab;
      const bt = Math.max(0, Math.min(365, parseInt(backupTage, 10) || 0));
      if (bt === 7) delete neuCfg.backup_tage; else neuCfg.backup_tage = bt;
      const pt = Math.max(0, Math.min(3650, parseInt(papierTage, 10) || 0));
      neuCfg.papierkorb_tage = pt; // 0 = bewusst aus (ohne Eintrag gilt der Standard 30)
      const bNeu = {};
      Object.keys(bewertung).forEach((k) => {
        const std = { ...KARTEN_STD, ...TEILNAHME_STD }[k];
        const n = zahlOder(bewertung[k], std);
        const nn = ["gelb", "blau", "rot", "abzugAnmeldung", "abzugVerspaetet"].includes(k) ? Math.abs(n) : n;
        if (nn !== std) bNeu[k] = nn;
      });
      if (Object.keys(bNeu).length) neuCfg.bewertung = bNeu; else delete neuCfg.bewertung;
      // Nur das ändern, was in diesem Formular geändert wurde – auf Basis der frischen Konfiguration (andere Stellen schreiben sie ebenfalls)
      const geaendert = [...new Set([...Object.keys(cfg), ...Object.keys(neuCfg)])].filter((k) => JSON.stringify(cfg[k]) !== JSON.stringify(neuCfg[k]));
      await dbConfigAendern(team, (frisch) => {
        geaendert.forEach((k) => { if (neuCfg[k] === undefined) delete frisch[k]; else frisch[k] = neuCfg[k]; });
        return frisch;
      });
      if (name.trim() !== (teamRow.name || "")) await dbUpdate("teams", team, { name: name.trim() || team });
      setVorlauf(String(v));
      setStatus("Gespeichert");
      onSaved && onSaved();
    } catch (e) {
      setStatus(friendlyError(e));
    }
  };
  if (!teamRow) {
    return <SqlHinweis fehler={`Für das Team „${team}“ gibt es noch keinen Eintrag in der Tabelle „teams“.`} />;
  }
  return (
    <section>
      <div style={{ ...styles.card, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <KartenTitel>Einstellungen · {teamRow.name}</KartenTitel>
          <div style={{ ...styles.cardDesc, marginBottom: 0 }}>
        Einstellungen gelten nur für dieses Team. Die Änderung gilt nach dem nächsten Laden der App.
          </div>
        </div>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Teamname
          <input style={{ ...styles.input, marginTop: 4, width: "100%", boxSizing: "border-box" }} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Vereinsname
          <input style={{ ...styles.input, marginTop: 4, width: "100%", boxSizing: "border-box" }} value={verein} placeholder={CLUB_STD.name} onChange={(e) => setVerein(e.target.value)} />
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>
            Erscheint in der Kopfzeile, auf der Eltern-Seite, den Karten und den Teilen-Bildern. Leer = „{CLUB_STD.name}“.
          </div>
        </label>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Wappen
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            <img src={logoUrl || CLUB_STD.logo} alt="Wappen" style={{ height: 56, maxWidth: 120, objectFit: "contain", background: "var(--surface-2)", borderRadius: 8, padding: 4 }} />
            <label style={{ ...styles.rowBtn, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit", fontSize: 14, fontWeight: 600, lineHeight: 1.2, whiteSpace: "nowrap", cursor: "pointer" }}>
              {logoBusy ? "Lädt …" : "Wappen hochladen"}
              <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { logoWaehlen(e.target.files && e.target.files[0]); e.target.value = ""; }} />
            </label>
            {logoUrl && <button style={styles.linkBtn} onClick={() => setLogoUrl("")}>Zurücksetzen</button>}
          </div>
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>
            Am besten PNG mit transparentem Hintergrund. Leer = Standard-Wappen.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <FarbWahl
            titel="Teamfarbe"
            hinweis="Grundfarbe: Kopfzeile, Schaltflächen und die Eltern-Seite. Zu helle Farben werden automatisch abgedunkelt. Die Sammelkarten behalten ihr Design."
            wert={farbe || CLUB_STD.farbe}
            onChange={(h) => setFarbe(h.toLowerCase() === CLUB_STD.farbe.toLowerCase() ? "" : h)}
            leer={farbe ? "Zurücksetzen" : null}
            onLeer={() => setFarbe("")}
          />
          <FarbWahl titel="Kopfzeile" hinweis="Nur der Header der Trainer-App. Leer = Teamfarbe." wert={farbeKopf} onChange={setFarbeKopf} leer="Wie Teamfarbe" onLeer={() => setFarbeKopf("")} />
          <FarbWahl titel="Buttons & Akzent" hinweis="Hauptknöpfe, Links, Fokus und Akzenttext. Leer = Teamfarbe." wert={farbeAkzent} onChange={setFarbeAkzent} leer="Wie Teamfarbe" onLeer={() => setFarbeAkzent("")} />
          <FarbWahl titel="Umschalter" hinweis="Aktiver Reiter bei Umschaltern wie „Training | Saison“. Auch helle Farben und Grautöne sind möglich, die Schrift passt sich an. Leer = dunklere Variante der Buttons-Farbe." wert={farbeAuswahl} onChange={setFarbeAuswahl} palette={[...FARB_PALETTE, ["#D9D4D3", "Hellgrau"], ["#6B6B6B", "Grau"]]} leer="Automatisch" onLeer={() => setFarbeAuswahl("")} />
          <FarbWahl titel="Filter-Chips" hinweis="Aktive Chips zum Filtern und Auswählen. Leer = wie die Umschalter." wert={farbeChip} onChange={setFarbeChip} palette={[...FARB_PALETTE, ["#D9D4D3", "Hellgrau"], ["#6B6B6B", "Grau"]]} leer="Wie Umschalter" onLeer={() => setFarbeChip("")} />
          <FarbWahl titel="Trikot" hinweis="Farbe des Trikot-Symbols neben den Spielern, zum Beispiel die echte Trikotfarbe. Auch helle Farben sind möglich. Leer = Buttons-Farbe." wert={farbeTrikot} onChange={setFarbeTrikot} palette={[...FARB_PALETTE, ["#FFFFFF", "Weiß"], ["#F2C21B", "Gelb"]]} leer="Wie Buttons" onLeer={() => setFarbeTrikot("")} />
          <FarbWahl titel="Regler" hinweis="Schieberegler, zum Beispiel bei der Bewertung. Leer = Buttons-Farbe." wert={farbeRegler} onChange={setFarbeRegler} leer="Wie Buttons" onLeer={() => setFarbeRegler("")} />
          <FarbVorschau basis={farbe} kopf={farbeKopf} akzent={farbeAkzent} auswahl={farbeAuswahl} chip={farbeChip} trikot={farbeTrikot} regler={farbeRegler} />
        </div>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Titel der Eltern-Seite
          <input style={{ ...styles.input, marginTop: 4, width: "100%", boxSizing: "border-box" }} value={titel} placeholder={CLUB_STD.titel} onChange={(e) => setTitel(e.target.value)} />
        </label>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Mannschaftsbild
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            {fotoUrl ? <img src={fotoUrl} alt="Mannschaftsbild" style={{ height: 64, borderRadius: 8, objectFit: "cover" }} /> : <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)" }}>Noch kein Bild</span>}
            <label style={{ ...styles.rowBtn, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit", fontSize: 14, fontWeight: 600, lineHeight: 1.2, whiteSpace: "nowrap", cursor: "pointer" }}>
              {fotoBusy ? "Lädt …" : fotoUrl ? "Bild ersetzen" : "Bild hochladen"}
              <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { fotoWaehlen(e.target.files && e.target.files[0]); e.target.value = ""; }} />
            </label>
          </div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Saison
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap", fontWeight: 400 }}>
            Beginn im
            <select style={{ ...styles.input, width: "auto" }} value={saisonStart} onChange={(e) => setSaisonStart(e.target.value)}>
              {MONATSNAMEN.map((n, i) => (i + 1 >= 6 ? <option key={n} value={i + 1}>{n}</option> : null))}
            </select>
            Ende im
            <select style={{ ...styles.input, width: "auto" }} value={saisonEnde} onChange={(e) => setSaisonEnde(e.target.value)}>
              {MONATSNAMEN.map((n, i) => (i + 1 <= 8 && i + 1 >= 4 ? <option key={n} value={i + 1}>{n}</option> : null))}
            </select>
          </div>
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>
            Ab dem Saisonbeginn starten Bilanz, Quoten und Karten bei null. Die Monate dazwischen gelten als Sommerpause ohne Wertung. Standard: September bis Juli.
          </div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Standard für neue Trainings
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const an = trTage.includes(d);
              return <button key={d} onClick={() => setTrTage(an ? trTage.filter((x) => x !== d) : [...trTage, d])} aria-pressed={!!(an)} style={{ ...styles.chip, ...(an ? styles.chipActive : {}), minHeight: 44, padding: "6px 12px" }}>{WOCHENTAGE[d]}</button>;
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap", fontWeight: 400 }}>
            von <input type="time" style={{ ...styles.input, width: "auto" }} value={trVon} onChange={(e) => setTrVon(e.target.value)} />
            bis <input type="time" style={{ ...styles.input, width: "auto" }} value={trBis} onChange={(e) => setTrBis(e.target.value)} />
            für <input type="number" min="1" max="52" style={{ ...styles.input, width: 70 }} value={trWochen} onChange={(e) => setTrWochen(e.target.value)} /> Wochen
          </div>
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>Vorbelegung beim Anlegen von Trainingsterminen im Trainingsplan.</div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Standard für neue Spieltage
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap", fontWeight: 400 }}>
            Uhrzeit <input type="time" style={{ ...styles.input, width: "auto" }} value={stZeit} onChange={(e) => setStZeit(e.target.value)} />
            Ort <input style={{ ...styles.input, flex: 1, minWidth: 160 }} value={stOrt} placeholder="z. B. Sportanlage Heimstetten" onChange={(e) => setStOrt(e.target.value)} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap", fontWeight: 400 }}>
            <label htmlFor="sz-liste">Spielzeiten (Min.)</label>
            <input id="sz-liste" style={{ ...styles.input, width: 150 }} value={szListe} placeholder="10, 12, 15, 20" onChange={(e) => setSzListe(e.target.value)} />
            <label htmlFor="sz-std">Standard</label>
            <input id="sz-std" type="number" min="1" max="90" style={{ ...styles.input, width: 70 }} value={szStd} onChange={(e) => setSzStd(e.target.value)} />
          </div>
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>Auswahl der Spielzeit im Spiel (mit Komma trennen) und Vorgabe für neue Spieltage. „Andere …“ bleibt immer möglich. Standard: 10, 12, 15, 20 und 12.</div>
        </div>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Backup-Erinnerung nach … Tagen
          <input type="number" min="0" max="365" style={{ ...styles.input, display: "block", marginTop: 6, width: 100 }} value={backupTage} onChange={(e) => setBackupTage(e.target.value)} />
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>
            Auf Home erscheint ein Hinweis, wenn das letzte Backup (im Admin unter „Backup“) so lange her ist. 0 = keine Erinnerung. Standard: 7.
            {cfg.letztes_backup ? ` Letztes Backup: ${new Date(cfg.letztes_backup).toLocaleString("de-DE")}.` : " Bisher wurde noch kein Backup vermerkt."}
          </div>
        </label>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Papierkorb: Hinweis nach … Tagen
          <input type="number" min="0" max="3650" style={{ ...styles.input, display: "block", marginTop: 6, width: 100 }} value={papierTage} onChange={(e) => setPapierTage(e.target.value)} />
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>
            Im Papierkorb wird markiert, was länger als diese Frist liegt, mit einem Knopf zum endgültigen Löschen. Es wird nie automatisch gelöscht. 0 = kein Hinweis. Standard: 30.
          </div>
        </label>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Zugangscodes dieses Teams
          <div style={{ marginTop: 6, fontWeight: 400, fontSize: 13 }}>
            {codes === null ? "Lade …" : codes.length === 0 ? "Keine Codes für dieses Team hinterlegt." : codes.map((c) => (
              <div key={c.code} style={{ display: "flex", gap: 10, padding: "3px 0", alignItems: "center" }}>
                <span style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "0.04em" }}>{"•••" + String(c.code).slice(-4)}</span>
                <span style={{ flex: 1 }}>{c.label || "ohne Bezeichnung"}</span>
                <span style={{ color: c.active === false ? "var(--danger-text)" : "var(--success-text)", fontWeight: 700 }}>{c.active === false ? "gesperrt" : "aktiv"}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>Anlegen, sperren und löschen im Bereich „Zugänge“ (Admin, Ansicht „Alle Teams“).</div>
        </div>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Startansicht der App
          <select style={{ ...styles.input, display: "block", marginTop: 6, width: "100%", boxSizing: "border-box" }} value={startTab} onChange={(e) => setStartTab(e.target.value)}>
            <option value="letzte">Zuletzt geöffneter Bereich (Standard)</option>
            <option value="dashboard">Home</option>
            <option value="training">Training bewerten</option>
            <option value="spieltage">Spieltage</option>
            <option value="taktik">Taktik</option>
          </select>
        </label>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Wann zählt ein Spieltag als gespielt?
          <select style={{ ...styles.input, display: "block", marginTop: 6, width: "100%", boxSizing: "border-box" }} value={wertung} onChange={(e) => setWertung(e.target.value)}>
            <option value="ergebnisse">Sobald ein Ergebnis eingetragen ist (Standard)</option>
            <option value="teilnehmer">Sobald Ergebnisse oder Teilnehmer eingetragen sind</option>
            <option value="datum">Sobald das Datum erreicht ist</option>
          </select>
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>Gilt für Spieltagsquote, Spieltage-Anzahl und die Karten. Zukünftige Spieltage zählen nie.</div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Bewertung im Training (Punkte)
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10, marginTop: 6 }}>
            {[["anwesend", "Anwesend"], ["abzugAnmeldung", "Abzug: nicht angemeldet"], ["abzugVerspaetet", "Abzug: verspätet"], ["unentschuldigt", "Unentschuldigt gefehlt"], ["entschuldigt", "Abgemeldet"], ["gelb", "Abzug: Gelbe Karte"], ["blau", "Abzug: Blaue Karte"], ["rot", "Abzug: Rote Karte"]].map(([k, l]) => (
              <label key={k} style={{ fontSize: 13, fontWeight: 600 }}>
                {l}
                <input inputMode="decimal" style={{ ...styles.input, marginTop: 3, width: "100%", boxSizing: "border-box" }} value={bewertung[k]} onChange={(e) => setBewertung({ ...bewertung, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>
            Abzüge als positive Zahl eingeben. Achtung: Eine Änderung wirkt auch rückwirkend auf alle bisherigen Trainings. Standard: Anwesend 0,5, Abzüge 0,25 · Karten 0,5 / 1 / 2.
            <button style={{ ...styles.linkBtn, marginLeft: 8 }} onClick={() => setBewertung({ gelb: "0,5", blau: "1", rot: "2", anwesend: "0,5", abzugAnmeldung: "0,25", abzugVerspaetet: "0,25", unentschuldigt: "-0,25", entschuldigt: "0" })}>Standard setzen</button>
          </div>
        </div>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Geburtstagsreminder: Vorlauf in Tagen
          <input
            type="number"
            min="0"
            max="60"
            style={{ ...styles.input, marginTop: 4, width: 100 }}
            value={vorlauf}
            onChange={(e) => setVorlauf(e.target.value)}
          />
          <div style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginTop: 4 }}>
            So viele Tage vorher erscheint der Hinweis auf Home (0 = nur am Geburtstag selbst). Ein-/ausschalten unter „Funktionen“.
          </div>
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button style={styles.primaryBtn} onClick={speichern}>Speichern</button>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{status}</span>
        </div>
      </div>
    </section>
  );
}

function TeamsVerwaltung({ teams, fehler, aktuellesTeam, onSelect, onChanged }) {
  const [name, setName] = useState("");
  const [kuerzel, setKuerzel] = useState("");
  const [meldung, setMeldung] = useState("");
  const anlegen = async () => {
    const id = kuerzel.trim().toLowerCase();
    if (!name.trim()) return setMeldung("Bitte einen Namen eingeben.");
    if (!/^[a-z0-9-]{2,20}$/.test(id)) return setMeldung("Kürzel: 2–20 Zeichen, nur a–z, 0–9 und Bindestrich.");
    if (["admin", "www", "app", "alle"].includes(id) || teams.some((t) => t.id === id)) return setMeldung("Dieses Kürzel ist nicht verfügbar.");
    try {
      await dbInsert("teams", { id, name: name.trim(), config: {} });
      setName("");
      setKuerzel("");
      setMeldung(`Team „${name.trim()}“ angelegt.`);
      await onChanged(id);
    } catch (e) {
      setMeldung(friendlyError(e));
    }
  };
  const archivieren = async (t) => {
    try {
      await dbUpdate("teams", t.id, { archived: !t.archived });
      await onChanged();
    } catch (e) {
      setMeldung(friendlyError(e));
    }
  };
  return (
    <section>
      <div style={{ ...styles.card, marginBottom: 14 }}>
        <KartenTitel>Teams</KartenTitel>
        <div style={{ ...styles.cardDesc, marginBottom: 0 }}>
        Jedes Team hat eigene Spieler, Trainings, Spieltage und Übungen sowie eigene Funktionen und Einstellungen. Die App eines Teams läuft unter <b>kürzel.nachspielzeit.app</b>.
        </div>
      </div>
      {fehler && <SqlHinweis fehler={fehler} />}
      {!fehler && (
        <div style={{ ...styles.card, marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <KartenTitel>Neues Team anlegen</KartenTitel>
          <input style={{ ...styles.input, width: "100%", boxSizing: "border-box" }} placeholder="Name (z. B. U9)" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            style={{ ...styles.input, width: "100%", boxSizing: "border-box" }}
            placeholder="Kürzel für die Adresse (z. B. u9)"
            value={kuerzel}
            onChange={(e) => setKuerzel(e.target.value)}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button style={styles.primaryBtn} onClick={anlegen}>Team anlegen</button>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>{meldung}</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--muted-2)" }}>
            Die Adresse kürzel.nachspielzeit.app muss zusätzlich in Cloudflare als Custom Domain beim Projekt eingetragen werden.
          </div>
        </div>
      )}
      <div className="card-list" style={styles.cardList}>
        {teams.map((t) => (
          <div key={t.id} style={{ ...styles.card, display: "flex", alignItems: "center", gap: 12, opacity: t.archived ? 0.6 : 1 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {t.name}
                {t.id === aktuellesTeam ? " · ausgewählt" : ""}
                {t.archived ? " · archiviert" : ""}
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{t.id}.nachspielzeit.app</div>
            </div>
            {t.id !== aktuellesTeam && (
              <button style={styles.rowBtnOutline} onClick={() => onSelect(t.id)}>Öffnen</button>
            )}
            {!fehler && t.id !== "u8" && (
              <button style={styles.rowBtnOutline} onClick={() => archivieren(t)}>{t.archived ? "Reaktivieren" : "Archivieren"}</button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const ADMIN_SCOPE = "__admin__";
const ADMIN_TABS_ALLGEMEIN = [["teams", "Teams"], ["zugaenge", "Zugänge"], ["uebungen", "Übungen"], ["backup", "Backup"], ["fehler", "Fehler"]];
const ADMIN_TABS_TEAM = [["funktionen", "Funktionen"], ["einstellungen", "Einstellungen"], ["import", "Spieler-Import"]];
const ADMIN_TABS = [...ADMIN_TABS_ALLGEMEIN, ...ADMIN_TABS_TEAM].map((t) => t[0]);

const SQL_FEHLERPROTOKOLL = `-- Nachspielzeit: anonymes Fehlerprotokoll (wiederholbar)
create table if not exists fehlerprotokoll (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  team_id text not null,
  kontext text not null check (char_length(kontext) <= 20),
  bereich text check (char_length(bereich) <= 40),
  meldung text not null check (char_length(meldung) <= 300),
  stack text check (char_length(stack) <= 600),
  stand text check (char_length(stand) <= 20),
  geraet text check (char_length(geraet) <= 40)
);
alter table fehlerprotokoll enable row level security;
grant select, insert, delete on table fehlerprotokoll to anon, authenticated, service_role;
drop policy if exists "fehler eintragen" on fehlerprotokoll;
drop policy if exists "fehler lesen" on fehlerprotokoll;
drop policy if exists "fehler loeschen" on fehlerprotokoll;
-- Eintragen: jeder gültige Code für sein Team. Lesen und Löschen: nur Admin-Codes.
create policy "fehler eintragen" on fehlerprotokoll for insert to public with check (nsz_code_ok(team_id));
create policy "fehler lesen" on fehlerprotokoll for select to public using (nsz_is_admin());
create policy "fehler loeschen" on fehlerprotokoll for delete to public using (nsz_is_admin());
notify pgrst, 'reload schema';`;

const FEHLER_ART = { anzeige: "Anzeige", aktion: "Speichern/Aktion", unbehandelt: "Unbehandelt" };

/* Administration → Fehler: gleiche Meldungen gruppiert mit Anzahl und letztem Zeitpunkt */
function FehlerAnsicht() {
  const [zeilen, setZeilen] = useState(null);
  const [fehler, setFehler] = useState("");
  const [status, setStatus] = useState("");
  const laden = async () => {
    setFehler("");
    try {
      const res = await nszFetch(`${REST}fehlerprotokoll?select=*&order=created_at.desc&limit=500`, { headers: dbHeaders() });
      if (!res.ok) throw new Error(`Laden des Fehlerprotokolls fehlgeschlagen: ${await res.text()}`);
      setZeilen(await res.json());
    } catch (e) {
      setFehler(friendlyError(e));
      setZeilen([]);
    }
  };
  useEffect(() => { laden(); }, []);
  const gruppen = useMemo(() => {
    const m = new Map();
    (zeilen || []).forEach((z) => {
      const k = [z.team_id, z.kontext, z.bereich, z.meldung].join("|");
      const g = m.get(k);
      if (!g) m.set(k, { ...z, anzahl: 1 });
      else g.anzahl += 1; // Zeilen kommen neueste zuerst: die erste ist der letzte Zeitpunkt
    });
    return Array.from(m.values());
  }, [zeilen]);
  const loesche = async (qs, text) => {
    try {
      await dbDeleteWhere("fehlerprotokoll", qs);
      setStatus(text);
      await laden();
    } catch (e) {
      setStatus(friendlyError(e));
    }
  };
  const wann = (iso) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <section>
      <div style={{ ...styles.card, marginBottom: 14 }}>
        <KartenTitel>Fehler</KartenTitel>
        <div style={{ ...styles.cardDesc, marginBottom: 0 }}>
          Anonym protokollierte Fehler aus den Apps (ohne Namen, Eingaben und Zugangscodes). Gleiche Meldungen sind zusammengefasst; pro Sitzung wird jede höchstens einmal gemeldet.
        </div>
      </div>
      {fehler && (
        <div style={{ ...styles.editBanner, marginBottom: 12, flexDirection: "column", alignItems: "stretch" }}>
          <div>{fehler}</div>
          <div style={{ fontSize: 13 }}>Falls die Tabelle noch fehlt, einmal in Supabase (SQL Editor) ausführen:</div>
          <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: "6px 0 0", userSelect: "all" }}>{SQL_FEHLERPROTOKOLL}</pre>
        </div>
      )}
      {!fehler && zeilen !== null && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button style={{ ...styles.rowBtn, width: "auto", height: 44, padding: "0 16px" }} onClick={laden}>Neu laden</button>
            <button
              style={{ ...styles.rowBtn, width: "auto", height: 44, padding: "0 16px" }}
              disabled={!zeilen.length}
              onClick={() => confirmAnd("Einträge älter als 30 Tage löschen?", () => loesche(`created_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}`, "Alte Einträge gelöscht"))}
            >
              Älter als 30 Tage löschen
            </button>
            <button
              style={{ ...styles.rowBtn, ...styles.dangerBtn, width: "auto", height: 44, padding: "0 16px" }}
              disabled={!zeilen.length}
              onClick={() => confirmAnd(`Alle ${zeilen.length} Einträge löschen?`, () => loesche("id=gt.0", "Alle Einträge gelöscht"))}
            >
              Alle löschen
            </button>
          </div>
          {status && <div role="status" style={{ ...styles.hint, marginTop: 0, marginBottom: 12 }}>{status}</div>}
          {gruppen.length === 0 ? (
            <div style={styles.empty}>
              <div style={{ fontWeight: 600, color: "var(--text)" }}>Keine Fehler protokolliert.</div>
              <div style={{ marginTop: 4, fontSize: 13 }}>Läuft.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {gruppen.map((g) => (
                <div key={[g.team_id, g.kontext, g.bereich, g.meldung].join("|")} style={styles.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>{g.meldung}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, fontSize: 13, color: "var(--muted)" }}>
                    <span>{FEHLER_ART[g.kontext] || g.kontext}</span>
                    <span>· Team {g.team_id}</span>
                    {g.bereich && <span>· {g.bereich}</span>}
                    <span>· {g.anzahl}×</span>
                    <span>· zuletzt {wann(g.created_at)}</span>
                    {g.geraet && <span>· {g.geraet}</span>}
                    {g.stand && <span>· Stand {g.stand}</span>}
                  </div>
                  {g.stack && (
                    <details style={{ marginTop: 8, fontSize: 13, color: "var(--muted)" }}>
                      <summary style={{ cursor: "pointer", minHeight: 24 }}>Details</summary>
                      <div style={{ marginTop: 4, overflowWrap: "anywhere", fontFamily: "monospace" }}>{g.stack}</div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const SQL_TORFOLGE = `-- Nachspielzeit: Torprotokoll pro Spiel (wiederholbar)
alter table public.spiele add column if not exists torfolge jsonb;
notify pgrst, 'reload schema';`;

const SQL_SPIELZEIT = `-- Nachspielzeit: Spielzeit pro Spieltag in Minuten (wiederholbar)
alter table public.spieltage add column if not exists spielzeit_min integer;
notify pgrst, 'reload schema';`;

/* Spielzeit pro Spieltag: Ersatzwert auf diesem Gerät, solange die Spalte spieltage.spielzeit_min fehlt */
function lokaleSpielzeit(spieltagId) {
  try { return Number(localStorage.getItem(`nsz-spielzeit-${spieltagId}`)) || 0; } catch { return 0; }
}

/* Spiel schreiben; das Torprotokoll (Spalte spiele.torfolge) ist optional. Fehlt die Spalte noch, wird das Spiel ohne Protokoll
   gespeichert und gemeldet, statt das Speichern scheitern zu lassen. */
async function schreibeSpiel(schreibe, zeile, torfolge, loeschen = false) {
  if (!torfolge && !loeschen) return schreibe(zeile);
  try {
    return await schreibe({ ...zeile, torfolge: torfolge || null });
  } catch (e) {
    if (!/torfolge/i.test(String((e && e.message) || e))) throw e;
    // verzögert, damit die Meldung nicht von "Spiel gespeichert" überschrieben wird
    setTimeout(() => meldung("Das Torprotokoll wurde nicht gespeichert: Es fehlt ein Datenbank-Update (Administration → Hinweis).", "error"), 2500);
    return schreibe(zeile);
  }
}

/* Hinweis nur für Admin: erscheint, solange eine optionale Spalte fehlt (spiele.torfolge, spieltage.spielzeit_min) */
function DatenbankHinweis() {
  const [fehlend, setFehlend] = useState([]);
  useEffect(() => {
    const pruefe = (pfad, sql, titel) =>
      nszFetch(REST + pfad, { headers: dbHeaders() })
        .then((r) => (r.ok ? null : { sql, titel }))
        .catch(() => null);
    Promise.all([
      pruefe("spiele?select=torfolge&limit=1", SQL_TORFOLGE, "Torprotokoll"),
      pruefe("spieltage?select=spielzeit_min&limit=1", SQL_SPIELZEIT, "Spielzeit pro Spieltag"),
    ]).then((l) => setFehlend(l.filter(Boolean)));
  }, []);
  if (fehlend.length === 0) return null;
  return (
    <div style={{ ...styles.editBanner, marginBottom: 12, flexDirection: "column", alignItems: "stretch" }}>
      <div style={{ fontWeight: 700 }}>Datenbank-Update: {fehlend.map((f) => f.titel).join(", ")}</div>
      <div style={{ fontSize: 13 }}>Dafür fehlt noch eine Spalte. Einmal in Supabase (SQL Editor) ausführen, danach die Seiten neu laden:</div>
      <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: "6px 0 0", userSelect: "all" }}>{fehlend.map((f) => f.sql).join("\n\n")}</pre>
    </div>
  );
}

function AdminApp() {
  const [tabWahl, setTabState] = useState(() => {
    const h = window.location.hash.replace("#", "");
    if (ADMIN_TABS.includes(h)) return h;
    try {
      const gespeichert = localStorage.getItem("nsz_admin_tab");
      if (ADMIN_TABS.includes(gespeichert)) return gespeichert;
    } catch {}
    return "teams";
  });
  const setTab = (t) => {
    setTabState(t);
    try {
      localStorage.setItem("nsz_admin_tab", t);
      window.history.replaceState(null, "", "#" + t);
    } catch {}
  };
  const [team, setTeamState] = useState(() => {
    let t = ADMIN_SCOPE;
    try {
      t = localStorage.getItem("nsz_admin_team") || ADMIN_SCOPE;
    } catch {}
    if (t !== ADMIN_SCOPE) Sitzung.team = t;
    return t;
  });
  const setTeam = (t) => {
    if (t !== ADMIN_SCOPE) Sitzung.team = t;
    try {
      localStorage.setItem("nsz_admin_team", t);
    } catch {}
    setFeatures(null);
    setTeamState(t);
  };
  const [teams, setTeams] = useState([{ id: "u8", name: "U8" }]);
  const [teamsFehler, setTeamsFehler] = useState(null);
  const ladeTeams = async (waehle) => {
    try {
      const rows = (await dbSelect("teams")).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (rows.length > 0) setTeams(rows);
      setTeamsFehler(null);
    } catch (e) {
      setTeamsFehler(friendlyError(e));
    }
  };
  useEffect(() => {
    ladeTeams();
  }, []);
  const teamRow = teams.find((t) => t.id === team && t.created_at !== undefined) || null;
  const teamName = (teams.find((t) => t.id === team) || { name: team }).name;
  const imAdminBereich = team === ADMIN_SCOPE;
  const tabListe = imAdminBereich ? ADMIN_TABS_ALLGEMEIN : ADMIN_TABS_TEAM;
  const tab = tabListe.some((t) => t[0] === tabWahl) ? tabWahl : tabListe[0][0];
  useEffect(() => { FEHLER_BEREICH = `admin/${tab}`; }, [tab]);
  const [features, setFeatures] = useState(null);
  const [featureFehler, setFeatureFehler] = useState(null);
  const [speichert, setSpeichert] = useState(null);
  const [backupLaeuft, setBackupLaeuft] = useState(false);
  const [backupInfo, setBackupInfo] = useState(null);
  const [letztesBackup, setLetztesBackup] = useState(() => {
    try {
      return localStorage.getItem("nsz_admin_last_backup") || "";
    } catch {
      return "";
    }
  });

  const ladeFeatures = async () => {
    try {
      const rows = await dbSelect("app_features");
      const m = {};
      rows.forEach((r) => (m[r.key] = r.enabled !== false));
      setFeatures(m);
      setFeatureFehler(null);
    } catch (e) {
      setFeatures({});
      setFeatureFehler(friendlyError(e));
    }
  };
  useEffect(() => {
    if (team !== ADMIN_SCOPE) ladeFeatures();
  }, [team]);

  const schalte = async (key, an) => {
    setSpeichert(key);
    try {
      await dbUpsert("app_features", { key, enabled: an, updated_at: new Date().toISOString() }, "key");
      setFeatures((f) => ({ ...f, [key]: an }));
      setFeatureFehler(null);
    } catch (e) {
      setFeatureFehler(friendlyError(e));
    } finally {
      setSpeichert(null);
    }
  };

  const backupErstellen = async () => {
    setBackupLaeuft(true);
    setBackupInfo(null);
    const daten = {};
    const infos = [];
    for (const t of BACKUP_TABELLEN) {
      try {
        const rows = await dbSelect(t, { alle: true });
        daten[t] = rows;
        infos.push({ tabelle: t, anzahl: rows.length });
      } catch (e) {
        infos.push({ tabelle: t, fehler: true });
      }
    }
    const jetzt = new Date();
    const payload = { app: "Nachspielzeit", erstellt: jetzt.toISOString(), host: window.location.hostname, tabellen: daten };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nachspielzeit-backup-${jetzt.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const stempel = jetzt.toLocaleString("de-DE");
    try {
      localStorage.setItem("nsz_admin_last_backup", stempel);
    } catch {}
    setLetztesBackup(stempel);
    try {
      for (const t of teams.filter((x) => x.created_at !== undefined)) {
        await dbConfigAendern(t.id, (c) => ({ ...c, letztes_backup: jetzt.toISOString() }));
      }
      ladeTeams();
    } catch (e) {}
    setBackupInfo(infos);
    setBackupLaeuft(false);
  };

  const SQL_FEATURES = `create table if not exists app_features (
  key text primary key,
  enabled boolean not null default true,
  updated_at timestamptz default now()
);
alter table app_features enable row level security;
grant select, insert, update, delete on table app_features to anon, authenticated, service_role;
drop policy if exists "access via code" on app_features;
create policy "access via code" on app_features for all to public using (true) with check (true);
notify pgrst, 'reload schema';`;

  return (
    <div style={styles.app}>
      <header className="app-header" style={{ ...styles.header, background: "var(--header-grad-admin)" }}>
        <div style={styles.headerTop}>
          <img src={LOGO_DATA_URI} alt="SV Heimstetten" style={styles.crestImg} />
          <div style={{ flex: 1 }}>
            <div style={styles.title}>Nachspielzeit Admin</div>
            <div style={{ ...styles.subtitle, display: "flex", alignItems: "center", gap: 6 }}>
              <span>Bereich</span>
              <select
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                aria-label="Team auswählen"
                style={{ font: "inherit", fontWeight: 700, background: "transparent", color: "inherit", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "1px 4px" }}
              >
                <option value={ADMIN_SCOPE} style={{ color: "#1a1a1a", background: "#fff" }}>Admin</option>
                {teams.filter((t) => !t.archived || t.id === team).map((t) => (
                  <option key={t.id} value={t.id} style={{ color: "#1a1a1a", background: "#fff" }}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          <a href={trainerUrl(imAdminBereich ? (teams.find((t) => !t.archived) || teams[0] || { id: "u8" }).id : team)} style={{ ...styles.logoutBtn, textDecoration: "none" }}>
            Zur Trainer-App
          </a>
          <button
            style={styles.logoutBtn}
            onClick={() => {
              Sitzung.vergiss();
              window.location.reload();
            }}
          >
            <LogoutIcon size={13} />
            Abmelden
          </button>
          </div>
        </div>
        <nav style={styles.nav}>
          {tabListe.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{ ...styles.navBtn, ...(tab === key ? styles.navBtnActive : {}) }}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main" style={styles.main}>
        <FehlerGrenze key={tab}>
        {tab === "backup" && (
          <section>
            <div style={styles.card}>
              <KartenTitel>Backup</KartenTitel>
              <div style={styles.cardDesc}>
                Lädt alle Daten der App (Spieler, Trainings, Spieltage, Übungen, Notizen, Einstellungen …) als eine JSON-Datei herunter. Bilder liegen im Supabase-Storage und sind nur als Link enthalten.
              </div>
              <div style={{ fontSize: 14, color: "var(--text)", margin: "-4px 0 12px", lineHeight: 1.45 }}>
                Die Datei enthält personenbezogene Daten von Kindern. Bitte sicher aufbewahren und nicht weitergeben.
              </div>
              <div style={{ fontSize: 14, color: "var(--muted)", margin: "-4px 0 12px" }}>
                Letztes Backup von diesem Gerät: {letztesBackup || "noch keines"}
              </div>
              <button style={styles.primaryBtn} onClick={backupErstellen} disabled={backupLaeuft}>
                {backupLaeuft ? "Backup läuft …" : "Backup jetzt herunterladen"}
              </button>
              {backupInfo && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Gesichert:</div>
                  {backupInfo.map((i) => (
                    <div key={i.tabelle} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0", color: i.fehler ? "var(--danger-text)" : "var(--text)" }}>
                      <span>{i.tabelle}</span>
                      <span>{i.fehler ? "nicht gefunden / Fehler" : `${i.anzahl} Einträge`}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ fontSize: 14, color: "var(--muted)", marginTop: 10 }}>Wiederherstellen aus einem Backup folgt in einem späteren Schritt.</div>
          </section>
        )}

        <DatenbankHinweis />
        {tab === "import" && <SpielerImport key={team} />}
        {/* Der Schlüssel wechselt, sobald die Team-Daten da sind: Das Formular übernimmt seine Startwerte nur beim Einbauen und wäre nach einem Reload sonst leer. */}
        {tab === "einstellungen" && <TeamEinstellungen key={`${team}:${teamRow ? "geladen" : "lade"}`} team={team} teamRow={teamRow} onSaved={() => ladeTeams()} />}
        {tab === "zugaenge" && <ZugaengeVerwaltung teams={teams} />}
        {tab === "uebungen" && <UebungenAdmin teams={teams} />}
        {tab === "fehler" && <FehlerAnsicht />}
        {tab === "teams" && <TeamsVerwaltung teams={teams} fehler={teamsFehler} aktuellesTeam={team} onSelect={setTeam} onChanged={ladeTeams} />}

        {tab === "funktionen" && (
          <section>
            <div style={{ ...styles.card, marginBottom: 14 }}>
              <KartenTitel>Funktionen · {teamName}</KartenTitel>
              <div style={{ ...styles.cardDesc, marginBottom: 0 }}>
              Deaktivierte Funktionen verschwinden in der App dieses Teams ({team}.nachspielzeit.app). Die Daten bleiben erhalten. Die Änderung gilt nach dem nächsten Laden der App.
              </div>
            </div>
            {featureFehler && (
              <div style={{ ...styles.editBanner, marginBottom: 12 }}>
                <div style={{ marginBottom: 6 }}>{featureFehler}</div>
                <div style={{ fontSize: 13 }}>Falls die Tabelle noch fehlt, einmal in Supabase (SQL Editor) ausführen:</div>
                <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: "6px 0 0", userSelect: "all" }}>{SQL_FEATURES}</pre>
                <div style={{ fontSize: 13, marginTop: 8 }}>Für die Team-Zuordnung zusätzlich das SQL aus dem Tab „Teams“ ausführen.</div>
              </div>
            )}
            {features === null ? (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>Lade …</div>
            ) : (
              (() => {
                const elternOben = (k) => { const x = FEATURES.find((q) => q.key === k); return !x || (featureAn(features, k) && (!x.unter || elternOben(x.unter))); };
                const zeile = (f, imBlock) => {
                  const an = featureAn(features, f.key);
                  const aktiv = !f.unter || elternOben(f.unter);
                  return (
                    <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: imBlock ? "10px 0" : 0, paddingLeft: imBlock && f.unter ? (f.ebene === 2 ? 44 : 22) : 0, borderTop: imBlock && f.unter ? "1px solid var(--divider)" : "none", opacity: aktiv ? 1 : 0.5 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: imBlock && f.ebene === 2 ? 600 : 700, fontSize: 14 }}>{f.label}</div>
                        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{f.beschreibung}</div>
                      </div>
                      <button
                        role="switch"
                        aria-checked={an}
                        aria-label={f.label}
                        disabled={speichert === f.key}
                        onClick={() => schalte(f.key, !an)}
                        style={{ width: 66, height: 44, boxSizing: "border-box", borderRadius: 999, border: "7px solid transparent", backgroundClip: "padding-box", background: an ? "var(--success-text)" : "var(--border-strong)", position: "relative", flexShrink: 0, cursor: "pointer" }}
                      >
                        <span style={{ position: "absolute", top: 3, left: an ? 25 : 3, width: 24, height: 24, borderRadius: 999, background: "#fff", transition: "left 120ms ease" }} />
                      </button>
                    </div>
                  );
                };
                const eltern = FEATURES.filter((f) => f.key === "eltern_seite" || f.unter);
                return (
                  <>
                    <div className="card-list" style={styles.cardList}>
                      {FEATURES.filter((f) => !eltern.includes(f)).map((f) => (
                        <div key={f.key} style={styles.card}>{zeile(f, false)}</div>
                      ))}
                    </div>
                    <div style={{ ...styles.card, marginBottom: 16 }}>
                      <KartenTitel>Eltern-Seite</KartenTitel>
                      {eltern.map((f) => zeile(f, true))}
                    </div>
                  </>
                );
              })()
            )}
          </section>
        )}
      </FehlerGrenze>
      </main>
    </div>
  );
}

/* Fehlergrenze: ein Fehler beim Zeichnen eines Bereichs legt nicht mehr die ganze App lahm.
   Mit key={tab} um den Inhalt gesetzt, wird sie beim Wechsel des Bereichs zurückgesetzt; Kopfzeile, Navigation und Eingaben anderer Bereiche bleiben erhalten. */
class FehlerGrenze extends React.Component {
  constructor(props) {
    super(props);
    this.state = { fehler: null };
  }
  static getDerivedStateFromError(fehler) {
    return { fehler };
  }
  componentDidCatch(fehler, info) {
    console.error("Renderfehler:", fehler, info && info.componentStack);
    meldeFehler("anzeige", fehler);
  }
  render() {
    if (!this.state.fehler) return this.props.children;
    return (
      <div role="alert" style={{ ...styles.card, margin: "24px auto", maxWidth: 420, textAlign: "center", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, fontWeight: 700, color: "var(--text)" }}>Da ist etwas schiefgelaufen.</div>
        <div style={{ fontSize: 14, color: "var(--text-2)" }}>Deine bereits gespeicherten Daten sind nicht betroffen.</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          <button style={styles.primaryBtn} onClick={() => window.location.reload()}>Neu laden</button>
          {this.props.onUebersicht && (
            <button style={styles.rowBtn} onClick={() => { this.setState({ fehler: null }); this.props.onUebersicht(); }}>Zu Home</button>
          )}
        </div>
      </div>
    );
  }
}

function OfflineScreen({ onRetry }) {
  return (
    <div style={styles.loadingScreen}>
      <div style={styles.loginCard} role="alert">
        <div style={styles.loginTitle}>Offline</div>
        <div style={{ fontSize: 14, color: "var(--text-2)", textAlign: "center" }}>Daten werden geladen, sobald das Netz da ist.</div>
        <button style={styles.primaryBtn} onClick={onRetry}>Erneut versuchen</button>
      </div>
    </div>
  );
}

function Root() {
  const [unlocked, setUnlocked] = useState(false);
  const [pruefung, setPruefung] = useState(!!Sitzung.code);
  const [hinweis, setHinweis] = useState("");
  const [offline, setOffline] = useState(false);
  const pruefeGespeichertenCode = () => {
    if (!Sitzung.code) return;
    setOffline(false);
    setPruefung(true);
    pruefeZugang(Sitzung.code)
      .then((info) => {
        const f = info.ok ? zugangFehler(info) : "";
        if (info.ok && !f) {
          Sitzung.info = info;
          setUnlocked(true);
        } else {
          Sitzung.vergiss();
          setHinweis(f || "Der Zugangscode ist nicht mehr gültig.");
        }
      })
      .catch(() => setOffline(true)) // Netz weg: Hinweis statt scheinbar geöffneter App; Datenzugriff schützt ohnehin die Datenbank
      .finally(() => setPruefung(false));
  };
  useEffect(() => {
    pruefeGespeichertenCode();
  }, []);
  // sobald das Netz zurück ist, automatisch erneut prüfen
  useEffect(() => {
    if (!offline) return undefined;
    window.addEventListener("online", pruefeGespeichertenCode);
    return () => window.removeEventListener("online", pruefeGespeichertenCode);
  }, [offline]);
  if (pruefung) return <div style={styles.loadingScreen}>Lade …</div>;
  if (offline) return <OfflineScreen onRetry={pruefeGespeichertenCode} />;
  if (!unlocked) {
    return (
      <Gate
        hinweis={hinweis}
        onUnlock={(code) => {
          Sitzung.code = code;
          setUnlocked(true);
        }}
      />
    );
  }
  return (
    <>
      <VersionsHinweis />
      <FehlerGrenze>{IS_ADMIN_HOST ? <AdminApp /> : <App />}</FehlerGrenze>
    </>
  );
}

/* ---------- App ---------- */

function App() {
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem("nsz_tab") || "dashboard";
    } catch {
      return "dashboard";
    }
  });
  const [ziel, setZiel] = useState(null); // Sprung von der Terminkachel: { typ: "training", date } | { typ: "spieltag", id }
  const [players, setPlayers] = useState([]);
  const [basis, setBasis] = useState({});
  const [trainings, setTrainings] = useState([]);
  const [entwicklungen, setEntwicklungen] = useState([]);
  const [gegner, setGegner] = useState([]);
  const [spieltage, setSpieltage] = useState([]);
  const [termine, setTermine] = useState([]);
  const [material, setMaterial] = useState([]);
  const [uebungen, setUebungen] = useState([]);
  const [trainingUebungen, setTrainingUebungen] = useState([]);
  const [taktikBoards, setTaktikBoards] = useState([]);
  const [taktikFehlt, setTaktikFehlt] = useState(false);
  const [trainingBoards, setTrainingBoards] = useState([]);
  const [trainingBoardsFehlt, setTrainingBoardsFehlt] = useState(false);
  const [teamSettings, setTeamSettings] = useState({});
  const [features, setFeatures] = useState({});
  const [teamInfo, setTeamInfo] = useState(null);
  const startTabErledigt = useRef(false);
  const [trashPlayers, setTrashPlayers] = useState([]);
  const [trashGegner, setTrashGegner] = useState([]);
  const [trashSpieltage, setTrashSpieltage] = useState([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState(() => {
    try {
      return localStorage.getItem("nsz_selected_player_id") || null;
    } catch {
      return null;
    }
  });
  const [settingsPlayerId, setSettingsPlayerId] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem("nsz_tab", tab);
    } catch {}
    FEHLER_BEREICH = tab; // für das Fehlerprotokoll
  }, [tab]);

  useEffect(() => {
    try {
      if (selectedPlayerId) localStorage.setItem("nsz_selected_player_id", selectedPlayerId);
      else localStorage.removeItem("nsz_selected_player_id");
    } catch {}
  }, [selectedPlayerId]);
  const openPlayerSettings = (id) => {
    setSelectedPlayerId(null);
    setSettingsPlayerId(id);
    setTab("verwaltung");
  };
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [promptState, setPromptState] = useState(null);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    registerConfirmHandler((message, onConfirm) => setConfirmState({ message, onConfirm }));
    registerPromptHandler((d) => setPromptState(d));
    return () => { registerConfirmHandler(null); registerPromptHandler(null); };
  }, []);

  const confirmCardRef = useRef(null);
  useEffect(() => {
    if (!confirmState) return;
    const previousFocus = document.activeElement;
    const card = confirmCardRef.current;
    const focusables = () => (card ? Array.from(card.querySelectorAll("button")) : []);
    if (focusables()[0]) focusables()[0].focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        setConfirmState(null);
      } else if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    };
  }, [confirmState]);

  const showToast = (msg, undo, type = "info") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message: msg, undo: undo || null, type });
    const duration = undo ? 6000 : type === "error" ? 5000 : 4000;
    toastTimerRef.current = setTimeout(() => setToast(null), duration);
  };  useEffect(() => {
    registerToastHandler((m, t) => showToast(m, null, t));
    return () => registerToastHandler(null);
  });

  /* Barrierefreiheit: Beschriftungen mit Feldern verknüpfen (Labels ohne for/Verschachtelung) */
  useEffect(() => {
    let n = 0, raf = 0;
    const CTRL = 'input:not([type=hidden]):not([type=file]):not([type=color]),select,textarea,[contenteditable="true"]';
    const run = () => {
      document.querySelectorAll("label").forEach((l) => {
        if (l.control || l.dataset.nzl) return;
        const t = l.nextElementSibling;
        if (!t) return;
        const c = t.matches(CTRL) ? t : t.children.length <= 4 ? t.querySelector(CTRL) : null;
        if (c) {
          if (c.matches("[contenteditable]")) {
            if (!l.id) l.id = "nzl-" + ++n;
            c.setAttribute("aria-labelledby", l.id);
          } else {
            if (!c.id) c.id = "nzf-" + ++n;
            l.htmlFor = c.id;
          }
          l.dataset.nzl = "1";
        } else if (t.querySelector("button")) {
          if (!l.id) l.id = "nzl-" + ++n;
          t.setAttribute("role", "group");
          t.setAttribute("aria-labelledby", l.id);
          l.dataset.nzl = "1";
        }
      });
    };
    const mo = new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run); });
    mo.observe(document.body, { childList: true, subtree: true });
    run();
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);


  const refreshAll = useCallback(async () => {
    try {
      const [playersRaw, basisRaw, termineRaw, trainingsRaw, entwRaw, gegnerRaw, spieltageRaw, spieleRaw, torRaw, sgRaw, stRaw, materialRaw, teamSettingsRaw, uebungenRaw, trainingUebungenRaw, featuresRaw, teamsRaw, taktikRaw, trainingBoardsRaw] =
        await Promise.all([
          dbSelect("players"),
          dbSelect("basisqualitaet"),
          dbSelect("trainingstermine"),
          dbSelect("trainings"),
          dbSelect("entwicklungen"),
          dbSelect("gegner"),
          dbSelect("spieltage"),
          dbSelect("spiele"),
          dbSelect("torschuetzen"),
          dbSelect("spieltag_gegner"),
          dbSelect("spieltag_teilnehmer"),
          dbSelect("material_bestand"),
          dbSelect("team_settings"),
          // Übungsbibliothek: falls die Tabellen noch nicht angelegt sind, bleibt die App trotzdem nutzbar
          dbSelect("uebungen").catch(() => []),
          dbSelect("training_uebungen").catch(() => []),
          dbSelect("app_features").catch(() => []),
          dbSelect("teams").catch(() => []),
          dbSelect("taktik_boards").then((r) => { setTaktikFehlt(false); return r; }).catch(() => { setTaktikFehlt(true); return []; }),
          dbSelect("training_boards").then((r) => { setTrainingBoardsFehlt(false); return r; }).catch(() => { setTrainingBoardsFehlt(true); return []; }),
        ]);
      setTaktikBoards(taktikRaw.filter((b) => !b.deleted_at));
      setTrainingBoards(trainingBoardsRaw.map((t) => ({ id: t.id, terminId: t.termin_id, boardId: t.board_id, position: Number(t.position) || 0 })));
      setPlayers(playersRaw.filter((p) => !p.deleted_at));
      setTrashPlayers(playersRaw.filter((p) => p.deleted_at));
      const basisMap = {};
      basisRaw.forEach((r) => (basisMap[r.player_id] = Number(r.wert)));
      setBasis(basisMap);
      setTermine(termineRaw);
      setTrainings(
        trainingsRaw.map((t) => ({
          id: t.id,
          date: t.date,
          playerId: t.player_id,
          vorkommnis: Number(t.vorkommnis),
          karte: t.karte,
          teilnahme: t.teilnahme,
          kommentar: t.kommentar || "",
        }))
      );
      setEntwicklungen(
        entwRaw.map((e) => ({ id: e.id, month: String(e.month).slice(0, 7), playerId: e.player_id, punkte: Number(e.punkte) }))
      );
      setGegner(gegnerRaw.filter((g) => !g.deleted_at));
      setTrashGegner(gegnerRaw.filter((g) => g.deleted_at));
      const spieltageFull = spieltageRaw.map((s) => ({
        id: s.id,
        date: s.date,
        notizen: s.notizen || "",
        fotoUrl: s.foto_url || null,
        zeit: s.zeit || null,
        typ: s.typ || "spieltag",
        spielzeitMin: Number(s.spielzeit_min) || lokaleSpielzeit(s.id) || null, // null = Standard des Teams
        ort: s.ort || "",
        deletedAt: s.deleted_at || null,
        zugeordneteGegner: sgRaw.filter((g) => g.spieltag_id === s.id).map((g) => g.opponent_id),
        teilnehmer: stRaw.filter((t) => t.spieltag_id === s.id).map((t) => t.player_id),
        spiele: spieleRaw
          .filter((sp) => sp.spieltag_id === s.id)
          .map((sp) => ({
            id: sp.id,
            opponentId: sp.opponent_id,
            ourGoals: sp.our_goals,
            theirGoals: sp.their_goals,
            torfolge: Array.isArray(sp.torfolge) ? sp.torfolge : null,
            scorers: torRaw
              .filter((t) => t.spiel_id === sp.id)
              .map((t) => ({ id: t.id, playerId: t.player_id, tore: t.tore })),
          })),
      }));
      setSpieltage(spieltageFull.filter((s) => !s.deletedAt));
      setTrashSpieltage(spieltageFull.filter((s) => s.deletedAt));
      setMaterial(
        materialRaw.map((m) => ({
          id: m.id,
          date: String(m.date).slice(0, 10),
          material: m.material,
          menge: Number(m.menge),
          gruppe: m.gruppe || null,
        }))
      );
      setTeamSettings(teamSettingsRaw[0] || {});
      setFeatures(Object.fromEntries(featuresRaw.map((r) => [r.key, r.enabled !== false])));
      const ti = teamsRaw.find((t) => t.id === Sitzung.team) || null;
      setTeamInfo(ti);
      const st = ti && ti.config && ti.config.start_tab;
      if (!startTabErledigt.current) {
        startTabErledigt.current = true;
        if (st && st !== "letzte") setTab(st);
      }
      setUebungen(
        uebungenRaw
          .filter((u) => !u.deleted_at)
          .map((u) => ({
            id: u.id,
            titel: u.titel || "",
            beschreibung: u.beschreibung || "",
            dauer: u.dauer != null ? Number(u.dauer) : null,
            kinder: u.kinder || "",
            keywords: Array.isArray(u.keywords) ? u.keywords : [],
            material: Array.isArray(u.material) ? u.material : [],
            bildUrl: u.bild_url || null,
            teamIds: Array.isArray(u.team_ids) ? u.team_ids : [Sitzung.team],
          }))
          .sort((a, b) => a.titel.localeCompare(b.titel, "de"))
      );
      setTrainingUebungen(
        trainingUebungenRaw.map((t) => ({
          id: t.id,
          terminId: t.termin_id,
          uebungId: t.uebung_id,
          position: Number(t.position) || 0,
        }))
      );
      setError("");
    } catch (e) {
      console.error(e);
      setError(e.message || "Unbekannter Fehler beim Laden der Daten.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const activePlayers = useMemo(() => players.filter((p) => p.active !== false), [players]);

  // Vor dem Überschreiben prüfen, ob jemand anderes die Daten inzwischen geändert hat (Vergleich der gespeicherten IDs).
  // Bei Abweichung: Rückfrage; die Eingaben bleiben stehen (Rückgabe false), bis bestätigt wird.
  const speichernMitKonflikt = async ({ kennung, bekannt, holeServer, speichern }) => {
    let abweichung = false;
    try {
      const server = await holeServer();
      abweichung = server.length !== bekannt.length || server.some((id) => !bekannt.includes(id));
    } catch (e) {
      console.error(e); // Prüfung gescheitert: nicht blockieren, normal speichern
    }
    if (!abweichung) return speichern();
    confirmAnd(`${kennung} wurde inzwischen von jemand anderem gespeichert. Trotzdem überschreiben?`, () => { speichern(); });
    return false;
  };

  const wrapAction = async (fn, successMsg, undo) => {
    setBusy(true);
    try {
      await fn();
      await refreshAll();
      if (successMsg) showToast(successMsg, undo);
      return true;
    } catch (e) {
      console.error(e);
      meldeFehler("aktion", e);
      showToast(friendlyError(e), null, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  /* Briefkasten (SVH-6): anonyme Nachrichten der Eltern. Wird nur geladen, wenn die Funktion eingeschaltet ist. */
  const briefkastenAn = featureAn(features, "eltern_briefkasten") && features.eltern_seite !== false;
  const [briefkasten, setBriefkasten] = useState(null); // null = noch nicht geladen
  const [briefkastenFehler, setBriefkastenFehler] = useState("");
  const ladeBriefkasten = useCallback(async () => {
    try {
      const rows = await dbSelect("briefkasten");
      setBriefkasten(rows.filter((r) => !r.deleted_at).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || y.id - x.id));
      setBriefkastenFehler("");
    } catch (e) {
      console.error(e);
      setBriefkasten([]);
      setBriefkastenFehler("Der Briefkasten konnte nicht geladen werden. Falls er neu ist, muss einmalig das SQL in Supabase ausgeführt werden.");
    }
  }, []);
  useEffect(() => {
    if (briefkastenAn) ladeBriefkasten();
  }, [briefkastenAn, ladeBriefkasten]);
  // Leichtgewichtig: nur der Briefkasten wird neu geladen, nicht die ganze App
  const briefkastenAktion = async (fn, msg, undo) => {
    try {
      await fn();
      await ladeBriefkasten();
      if (msg) showToast(msg, undo);
      return true;
    } catch (e) {
      console.error(e);
      meldeFehler("aktion", e);
      showToast(friendlyError(e), null, "error");
      return false;
    }
  };
  const briefkastenStatus = (id, status) => briefkastenAktion(() => dbUpdate("briefkasten", id, { status }));
  const briefkastenAlleGelesen = () =>
    briefkastenAktion(async () => {
      for (const r of (briefkasten || []).filter((x) => x.status === "neu")) await dbUpdate("briefkasten", r.id, { status: "gelesen" });
    }, "Alle als gelesen markiert");
  const briefkastenLoeschen = (id) =>
    confirmAnd("Diese Nachricht löschen?", () =>
      briefkastenAktion(
        () => dbUpdate("briefkasten", id, { deleted_at: new Date().toISOString() }),
        "Nachricht gelöscht",
        () => briefkastenAktion(() => dbUpdate("briefkasten", id, { deleted_at: null }), "Wiederhergestellt")
      )
    );
  const briefkastenNeu = briefkastenAn && briefkasten ? briefkasten.filter((r) => r.status === "neu").length : 0;

  /* Öffentlicher Karten-Link: Token liegt in teams.config.share_token; der Snapshot wird bei Änderungen automatisch neu veröffentlicht */
  setzeEinstellungen(teamInfo?.config);
  TEAM_NAME = (teamInfo && teamInfo.name) || Sitzung.team.toUpperCase();
  setzeClub(teamInfo?.config?.verein_name, teamInfo?.config?.verein_logo_url, teamInfo?.config?.verein_farbe, teamInfo?.config?.eltern_titel, { kopf: teamInfo?.config?.farbe_kopf, akzent: teamInfo?.config?.farbe_akzent, auswahl: teamInfo?.config?.farbe_auswahl, chip: teamInfo?.config?.farbe_chip, trikot: teamInfo?.config?.farbe_trikot, regler: teamInfo?.config?.farbe_regler });
  const kartenToken = (teamInfo && teamInfo.config && teamInfo.config.share_token) || null;
  const kartenAlt = (teamInfo && teamInfo.config && teamInfo.config.share_alt) || []; // ältere Links, die vorerst weiter funktionieren
  const kartenAltKey = kartenAlt.join(",");
  const elternAn = features.eltern_seite !== false;
  const pakete = useMemo(
    () => (kartenToken && !loading ? elternPakete(features, players, trainings, spieltage, gegner, teamInfo) : null),
    [kartenToken, loading, features, players, trainings, spieltage, gegner, teamInfo]
  );
  const kartenSnapshot = pakete ? pakete.snap : null;
  const kartenHash = kartenSnapshot ? JSON.stringify(kartenSnapshot) : null;
  const kartenPlus = pakete ? pakete.plus : null;
  const kartenPlusJson = kartenPlus ? JSON.stringify(kartenPlus) : null;
  useEffect(() => {
    if (!kartenHash || !kartenToken) return;
    let last = null;
    try { last = localStorage.getItem("nsz_karten_hash"); } catch {}
    const schluessel = kartenToken + kartenAltKey + kurzHash(kartenHash + (kartenPlusJson || ""));
    if (last === schluessel) return;
    const timer = setTimeout(() => {
      veroeffentlicheAlle([kartenToken, ...kartenAlt], JSON.parse(kartenHash), kartenPlusJson ? JSON.parse(kartenPlusJson) : null)
        .then(() => {
          try { localStorage.setItem("nsz_karten_hash", schluessel); } catch {}
        })
        .catch((e) => console.error(e));
    }, 3000);
    return () => clearTimeout(timer);
  }, [kartenHash, kartenPlusJson, kartenToken, kartenAltKey]); // eslint-disable-line
  const kartenLinkErzeugen = (name, code) =>
    wrapAction(async () => {
      const neu = neuerKartenToken(name, code);
      const { snap, plus: plusNeu } = elternPakete(features, players, trainings, spieltage, gegner, teamInfo);
      await veroeffentlicheKarten(neu, snap, plusNeu);
      // der bisherige Link bleibt vorerst aktiv (schon verschickt) und kann unten abgeschaltet werden
      const alt = kartenToken ? [kartenToken, ...kartenAlt] : kartenAlt;
      await veroeffentlicheAlle(alt, snap, plusNeu);
      await dbConfigAendern(Sitzung.team, (c) => ({ ...c, share_token: neu, share_alt: alt }));
    }, "Karten-Link erstellt");
  const kartenAltAbschalten = (tok) =>
    wrapAction(async () => {
      await loescheKarten(tok);
      await dbConfigAendern(Sitzung.team, (c) => ({ ...c, share_alt: kartenAlt.filter((x) => x !== tok) }));
    }, "Alter Link abgeschaltet");
  const kartenLinkSperren = () =>
    wrapAction(async () => {
      await dbConfigAendern(Sitzung.team, (c) => { delete c.share_token; delete c.share_alt; return c; });
      for (const t of [kartenToken, ...kartenAlt]) if (t) await loescheKarten(t);
    }, "Karten-Link gesperrt");
  const songsSpeichern = async (songs) => {
    await dbConfigAendern(Sitzung.team, (c) => ({ ...c, songs }));
  };
  const songHinzufuegen = (files) =>
    wrapAction(async () => {
      let liste = [...(teamInfo?.config?.songs || [])];
      for (const f of files) {
        const pfad = await ladeSongHoch(f);
        liste = [...liste, { titel: f.name.replace(/\.[^.]+$/, ""), pfad }];
        await songsSpeichern(liste);
      }
    }, "Song hochgeladen");
  const songAendern = (i, aktion, wert) => {
    if (aktion === "loeschen" && wert !== "ok") {
      const titel = (teamInfo?.config?.songs || [])[i]?.titel || "Song";
      confirmAnd(`„${titel}“ löschen?`, () => songAendern(i, "loeschen", "ok"));
      return;
    }
    if (aktion === "umbenennen" && !(wert && wert.titel)) {
      const aktuell = (teamInfo?.config?.songs || [])[i]?.titel || "";
      frageAnd("Titel", aktuell, (v) => songAendern(i, "umbenennen", { titel: v }));
      return;
    }
    return wrapAction(async () => {
      const liste = [...(teamInfo?.config?.songs || [])];
      if (aktion === "hoch" && i > 0) [liste[i - 1], liste[i]] = [liste[i], liste[i - 1]];
      else if (aktion === "runter" && i < liste.length - 1) [liste[i + 1], liste[i]] = [liste[i], liste[i + 1]];
      else if (aktion === "text") {
        liste[i] = { ...liste[i], text: (wert || "").trim() };
      } else if (aktion === "umbenennen") {
        const t = wert.titel;
        if (!t || !t.trim()) return;
        liste[i] = { ...liste[i], titel: t.trim() };
      } else if (aktion === "loeschen") {
        const [weg] = liste.splice(i, 1);
        await songsSpeichern(liste);
        await loescheSongDatei(weg.pfad);
        return;
      }
      await songsSpeichern(liste);
    }, "Songs angepasst");
  };
  const kartenVollUmschalten = () =>
    wrapAction(async () => {
      const voll = !teamInfo?.config?.share_voll;
      await dbConfigAendern(Sitzung.team, (c) => ({ ...c, share_voll: voll }));
    }, "Karten-Link angepasst");
  const kartenLinkAktualisieren = () =>
    wrapAction(async () => {
      const { snap, plus: plusNeu } = elternPakete(features, players, trainings, spieltage, gegner, teamInfo);
      await veroeffentlicheAlle([kartenToken, ...kartenAlt], snap, plusNeu);
    }, "Karten aktualisiert");

  const softDelete = (table, id, entityLabel) =>
    wrapAction(
      () => dbUpdate(table, id, { deleted_at: new Date().toISOString() }),
      `${entityLabel} gelöscht`,
      () => wrapAction(() => dbUpdate(table, id, { deleted_at: null }), "Wiederhergestellt")
    );

  const addSpieltag = (date, zeit, typ, ort) =>
    wrapAction(async () => {
      const newId = uid();
      await dbInsert("spieltage", {
        id: newId,
        date,
        zeit: zeit || null,
        typ: ["turnier", "hallenturnier", "freundschaftsspiel"].includes(typ) ? typ : "spieltag",
        ort: ort || null,
      });
      const letzterSpieltag = [...spieltage].sort((a, b) => b.date.localeCompare(a.date))[0];
      const activeIds = new Set(players.map((p) => p.id));
      const uebernommeneTeilnehmer = (letzterSpieltag?.teilnehmer || []).filter((id) => activeIds.has(id));
      if (uebernommeneTeilnehmer.length > 0) {
        await dbInsert(
          "spieltag_teilnehmer",
          uebernommeneTeilnehmer.map((playerId) => ({ spieltag_id: newId, player_id: playerId }))
        );
      }
    });

  const removeSpieltag = (id) => softDelete("spieltage", id, "Spieltag");

  const toggleGegnerZuordnung = (spieltagId, opponentId, istZugeordnet) =>
    wrapAction(async () => {
      if (istZugeordnet) {
        await dbDeleteWhere("spieltag_gegner", `spieltag_id=eq.${spieltagId}&opponent_id=eq.${opponentId}`);
      } else {
        await dbInsert("spieltag_gegner", { spieltag_id: spieltagId, opponent_id: opponentId });
      }
    });

  const saveUebung = (u, file) =>
    wrapAction(async () => {
      let bildUrl = u.bildUrl || null;
      if (file) bildUrl = await uploadUebungBild(u.id, file);
      await dbUpsert(
        "uebungen",
        {
          id: u.id,
          titel: u.titel,
          beschreibung: u.beschreibung || null,
          keywords: u.keywords,
          bild_url: bildUrl,
          ...(teamFilterAktiv("uebungen") ? { team_ids: u.teamIds || [Sitzung.team] } : {}),
          deleted_at: null,
        },
        "id"
      );
    }, "Übung gespeichert");

  const addTrainingUebung = (terminId, uebungId) =>
    wrapAction(async () => {
      const vorhandene = trainingUebungen.filter((t) => t.terminId === terminId);
      const position = vorhandene.reduce((m, t) => Math.max(m, t.position), 0) + 1;
      await dbInsert("training_uebungen", { id: uid(), termin_id: terminId, uebung_id: uebungId, position });
    });

  const moveTrainingUebung = (terminId, id, richtung) =>
    wrapAction(async () => {
      const liste = trainingUebungen.filter((t) => t.terminId === terminId).sort((a, b) => a.position - b.position);
      const i = liste.findIndex((t) => t.id === id);
      const j = i + richtung;
      if (i < 0 || j < 0 || j >= liste.length) return;
      await dbUpdate("training_uebungen", liste[i].id, { position: liste[j].position });
      await dbUpdate("training_uebungen", liste[j].id, { position: liste[i].position });
    });

  const addTrainingBoard = (terminId, boardId) =>
    wrapAction(async () => {
      const vorhandene = trainingBoards.filter((t) => t.terminId === terminId);
      const position = vorhandene.reduce((m, t) => Math.max(m, t.position), 0) + 1;
      await dbInsert("training_boards", { id: uid(), termin_id: terminId, board_id: boardId, position });
    }, (() => { const t = termine.find((x) => x.id === terminId); return t ? `Board zum Training am ${formatTerminLabel(t.date)} hinzugefügt` : "Board zum Training hinzugefügt"; })());
  const removeTrainingBoard = (id) => wrapAction(() => dbDelete("training_boards", id), "Board aus dem Training entfernt");
  const moveTrainingBoard = (terminId, id, richtung) =>
    wrapAction(async () => {
      const liste = trainingBoards.filter((t) => t.terminId === terminId).sort((a, b) => a.position - b.position);
      const i = liste.findIndex((t) => t.id === id);
      const j = i + richtung;
      if (i < 0 || j < 0 || j >= liste.length) return;
      await dbUpdate("training_boards", liste[i].id, { position: liste[j].position });
      await dbUpdate("training_boards", liste[j].id, { position: liste[i].position });
    });
  const trainingBoardCtx = { boards: taktikBoards, links: trainingBoards, termine, players, fehlt: trainingBoardsFehlt, add: addTrainingBoard, remove: removeTrainingBoard, move: moveTrainingBoard };

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingBall} />
        <span>Lade Daten aus der Datenbank …</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.loadingScreen}>
        <span style={{ color: "var(--danger-text)", fontWeight: 600 }}>Verbindung fehlgeschlagen</span>
        <span style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "0 24px" }}>{error}</span>
        <button style={styles.primaryBtn} onClick={refreshAll}>
          Erneut versuchen
        </button>
      </div>
    );
  }

  return (
    <FeatureCtx.Provider value={features}>
    <TrainingBoardCtx.Provider value={trainingBoardCtx}>
    <NavCtx.Provider value={setTab}>
    <div style={styles.app}>
      <Header tab={tab} setTab={(k) => { setZiel(null); setTab(k); }} />
      <main className="app-main" style={styles.main}>
        <FehlerGrenze key={tab} onUebersicht={() => setTab("dashboard")}>
        <h1 className="nz-sr">{{ dashboard: "Home", training: "Training bewerten", entwicklung: "Monatsentwicklung", spieltage: "Spieltage", taktik: "Taktik", verwaltung: "Setup" }[tab] || "Nachspielzeit"}</h1>
        {tab === "dashboard" && (
          <Dashboard
            players={players}
            basis={basis}
            trainings={trainings}
            entwicklungen={entwicklungen}
            spieltage={spieltage}
            gegner={gegner}
            teamSettings={teamSettings}
            teamInfo={teamInfo}
            termine={termine}
            onOpenTermin={(e) => {
              if (e.typ === "spieltag" || e.typ === "turnier" || e.typ === "hallenturnier" || e.typ === "freundschaftsspiel") {
                if (features.spieltage === false) return;
                setZiel({ typ: "spieltag", id: e.spieltagId });
                setTab("spieltage");
              } else {
                setZiel({ typ: "training", date: e.date });
                setTab("training");
              }
            }}
            onUploadTeamFoto={(file) =>
              wrapAction(async () => {
                const url = await uploadTeamFoto(file);
                if (teamInfo) await dbConfigAendern(Sitzung.team, (c) => ({ ...c, team_photo_url: url }));
                else await dbUpsert("team_settings", { id: 1, team_photo_url: url }, "id");
              }, "Mannschaftsfoto aktualisiert")
            }
            selectedPlayerId={selectedPlayerId}
            onSelectPlayer={setSelectedPlayerId}
            onOpenSettings={openPlayerSettings}
            briefkastenNeu={briefkastenNeu}
            onBriefkasten={() => { NZ_SETUP_START = "briefkasten"; setTab("verwaltung"); }}
          />
        )}
        {tab === "training" && (
          <TrainingBewertung
            zielDatum={ziel?.typ === "training" ? ziel.date : null}
            players={activePlayers}
            trainings={trainings}
            termine={termine}
            onSaveTerminNotiz={(id, text) => wrapAction(() => dbUpdate("trainingstermine", id, { bewertung_notizen: text }), "Notiz gespeichert")}
            onSave={(entries, date) =>
              speichernMitKonflikt({
                kennung: "Dieses Training",
                bekannt: trainings.filter((t) => t.date === date).map((t) => String(t.id)),
                holeServer: () => dbIdsWhere("trainings", `date=eq.${date}`),
                speichern: () =>
                  wrapAction(async () => {
                    await ersetzeGruppe(
                      "trainings",
                      `date=eq.${date}`,
                      entries.map((e) => ({
                        id: e.id,
                        date: e.date,
                        player_id: e.playerId,
                        vorkommnis: e.vorkommnis,
                        karte: e.karte,
                        teilnahme: e.teilnahme,
                        kommentar: e.kommentar || "",
                      }))
                    );
                  }, "Trainingsbewertung gespeichert"),
              })
            }
            onDelete={(date) =>
              wrapAction(async () => {
                await dbDeleteWhere("trainings", `date=eq.${date}`);
              }, "Trainingsbewertung gelöscht")
            }
          />
        )}
        {tab === "entwicklung" && features.entwicklung !== false && (
          <MonatsEntwicklung
            players={activePlayers}
            entwicklungen={entwicklungen}
            onSave={(entries, month) =>
              speichernMitKonflikt({
                kennung: "Dieser Monat",
                bekannt: entwicklungen.filter((e) => e.month === month).map((e) => String(e.id)),
                holeServer: () => dbIdsWhere("entwicklungen", `month=eq.${month}`),
                speichern: () =>
                  wrapAction(async () => {
                    await ersetzeGruppe(
                      "entwicklungen",
                      `month=eq.${month}`,
                      entries.map((e) => ({ id: e.id, month: e.month, player_id: e.playerId, punkte: e.punkte }))
                    );
                  }, "Monatsentwicklung gespeichert"),
              })
            }
          />
        )}
        {tab === "spieltage" && features.spieltage !== false && (
          <Spieltage
            zielSpieltagId={ziel?.typ === "spieltag" ? ziel.id : null}
            players={players}
            gegner={gegner}
            spieltage={spieltage}
            onRemoveSpieltag={removeSpieltag}
            onAddSpiel={(spieltagId, spiel) =>
              wrapAction(async () => {
                await schreibeSpiel((z) => dbInsert("spiele", z), {
                  id: spiel.id,
                  spieltag_id: spieltagId,
                  opponent_id: spiel.opponentId,
                  our_goals: spiel.ourGoals,
                  their_goals: spiel.theirGoals,
                }, spiel.torfolge);
                if (spiel.scorers.length > 0) {
                  await dbInsert(
                    "torschuetzen",
                    spiel.scorers.map((s) => ({ id: s.id, spiel_id: spiel.id, player_id: s.playerId, tore: s.tore }))
                  );
                }
              }, "Spiel gespeichert")
            }
            onUpdateSpiel={(spieltagId, spiel) =>
              wrapAction(async () => {
                await schreibeSpiel((z) => dbUpdate("spiele", spiel.id, z), {
                  opponent_id: spiel.opponentId,
                  our_goals: spiel.ourGoals,
                  their_goals: spiel.theirGoals,
                }, spiel.torfolge, spiel.hatteFolge);
                await dbDeleteWhere("torschuetzen", `spiel_id=eq.${spiel.id}`);
                if (spiel.scorers.length > 0) {
                  await dbInsert(
                    "torschuetzen",
                    spiel.scorers.map((s) => ({ id: s.id, spiel_id: spiel.id, player_id: s.playerId, tore: s.tore }))
                  );
                }
              }, "Spiel aktualisiert")
            }
            onRemoveSpiel={(spieltagId, spielId) => wrapAction(() => dbDelete("spiele", spielId))}
            onToggleTeilnehmer={(spieltagId, playerId, istDabei) =>
              wrapAction(async () => {
                if (istDabei) {
                  await dbDeleteWhere(
                    "spieltag_teilnehmer",
                    `spieltag_id=eq.${spieltagId}&player_id=eq.${playerId}`
                  );
                } else {
                  await dbInsert("spieltag_teilnehmer", { spieltag_id: spieltagId, player_id: playerId });
                }
              })
            }
            onUpdateNotizen={(spieltagId, notizen) => wrapAction(() => dbUpdate("spieltage", spieltagId, { notizen }))}
            onUpdateSpielzeit={(spieltagId, min) =>
              wrapAction(async () => {
                try {
                  await dbUpdate("spieltage", spieltagId, { spielzeit_min: min });
                } catch (e) {
                  if (!/spielzeit_min/i.test(String((e && e.message) || e))) throw e;
                  try { localStorage.setItem(`nsz-spielzeit-${spieltagId}`, String(min)); } catch {}
                  setTimeout(() => meldung("Spielzeit nur auf diesem Gerät gespeichert: Es fehlt ein Datenbank-Update (Administration → Hinweis).", "error"), 400);
                }
              })
            }
            onUploadFoto={(spieltagId, file) =>
              wrapAction(async () => {
                const url = await uploadSpieltagFoto(spieltagId, file);
                await dbUpdate("spieltage", spieltagId, { foto_url: url });
              }, "Spieltagfoto aktualisiert")
            }
            onOpenPlayer={(id) => {
              setSelectedPlayerId(id);
              setTab("dashboard");
            }}
          />
        )}
        {tab === "taktik" && features.taktik !== false && (
          <TaktikTab
            boards={taktikBoards}
            fehlt={taktikFehlt}
            players={players}
            onSave={async (b, neu) => {
              const jetzt = new Date().toISOString();
              if (neu) {
                const row = (await dbInsert("taktik_boards", { id: b.id, name: b.name, data: b.data, updated_at: jetzt }))[0] || { id: b.id, name: b.name, data: b.data, updated_at: jetzt };
                setTaktikBoards((l) => [...l, row]);
              } else {
                await dbUpdate("taktik_boards", b.id, { name: b.name, data: b.data, updated_at: jetzt });
                setTaktikBoards((l) => l.map((x) => (x.id === b.id ? { ...x, name: b.name, data: b.data, updated_at: jetzt } : x)));
              }
            }}
            onDelete={(id) =>
              wrapAction(async () => {
                await dbUpdate("taktik_boards", id, { deleted_at: new Date().toISOString() });
                setTaktikBoards((l) => l.filter((x) => x.id !== id));
              }, "Board gelöscht")
            }
            onDuplicate={(b) =>
              wrapAction(async () => {
                const jetzt = new Date().toISOString();
                const row = { id: uid(), name: `${b.name} (Kopie)`, data: b.data, updated_at: jetzt };
                const res = await dbInsert("taktik_boards", row);
                setTaktikBoards((l) => [...l, res[0] || row]);
              }, "Board dupliziert")
            }
          />
        )}

        {tab === "verwaltung" && (
          <Verwaltung
            briefkasten={{ an: briefkastenAn, liste: briefkasten, fehler: briefkastenFehler, neu: briefkastenNeu, onStatus: briefkastenStatus, onAlleGelesen: briefkastenAlleGelesen, onLoeschen: briefkastenLoeschen }}
            kartenBox={
              teamInfo && elternAn ? (
                <KartenLinkBox token={kartenToken} altTokens={kartenAlt} onAltOff={kartenAltAbschalten} onCreate={kartenLinkErzeugen} onRevoke={kartenLinkSperren} onRefresh={kartenLinkAktualisieren} voll={!!teamInfo?.config?.share_voll} onToggleVoll={kartenVollUmschalten} busy={busy} songs={teamInfo?.config?.songs || []} onSongAdd={songHinzufuegen} onSongChange={songAendern} />
              ) : null
            }
            players={players}
            basis={basis}
            termine={termine}
            gegner={gegner}
            onAdd={(name) => wrapAction(() => dbInsert("players", { id: uid(), name, active: true }))}
            onToggleActive={(id) => {
              const p = players.find((x) => x.id === id);
              return wrapAction(() => dbUpdate("players", id, { active: !(p?.active !== false) }));
            }}
            onRemove={(id) => softDelete("players", id, "Spieler")}
            onBasisChange={(playerId, wert) =>
              wrapAction(() => dbUpsert("basisqualitaet", { player_id: playerId, wert }, "player_id"))
            }
            onUploadPhoto={(playerId, file) =>
              wrapAction(async () => {
                const url = await uploadProfilbild(playerId, file);
                await dbUpdate("players", playerId, { photo_url: url });
              }, "Profilbild aktualisiert")
            }
            onRemovePhoto={(playerId) =>
              wrapAction(() => dbUpdate("players", playerId, { photo_url: null }), "Profilbild entfernt")
            }
            onTrikotnummerChange={(playerId, trikotnummer) =>
              wrapAction(() => dbUpdate("players", playerId, { trikotnummer }))
            }
            onUpdatePlayer={(playerId, patch) => wrapAction(() => dbUpdate("players", playerId, patch), "Gespeichert")}
            onGenerateTermine={(neueTermine) =>
              wrapAction(async () => {
                const bestehendeDaten = new Set(termine.map((t) => t.date));
                const zusaetzliche = neueTermine.filter((t) => !bestehendeDaten.has(t.date));
                if (zusaetzliche.length > 0) await dbInsert("trainingstermine", zusaetzliche);
              }, "Termine angelegt")
            }
            onToggleAbsage={(id) => {
              const t = termine.find((x) => x.id === id);
              const neuerStatus = t?.status === "abgesagt" ? "geplant" : "abgesagt";
              return wrapAction(() => dbUpdate("trainingstermine", id, { status: neuerStatus }));
            }}
            onRemoveTermin={(id) => wrapAction(() => dbDelete("trainingstermine", id))}
            onUpdateZeit={(id, startZeit, endZeit, datum) => {
              const t = termine.find((x) => x.id === id);
              const neuesDatum = datum && t && datum !== t.date ? datum : null;
              if (neuesDatum) {
                // Bewertungen hängen am Datum, nicht am Termin: Verschieben nur, wenn nichts daran hängt
                if (trainings.some((x) => x.date === t.date)) {
                  meldung("Für diesen Tag gibt es schon Bewertungen. Das Datum lässt sich deshalb nicht mehr ändern.", "error");
                  return Promise.resolve(false);
                }
                if (termine.some((x) => x.id !== id && x.date === neuesDatum)) {
                  meldung("An diesem Tag gibt es schon einen Termin.", "error");
                  return Promise.resolve(false);
                }
              }
              return wrapAction(() => dbUpdate("trainingstermine", id, { start_zeit: startZeit, end_zeit: endZeit, ...(neuesDatum ? { date: neuesDatum } : {}) }), neuesDatum ? "Termin verschoben" : "Uhrzeit aktualisiert");
            }}
            onAddGegner={(name) => wrapAction(() => dbInsert("gegner", { id: uid(), name }))}
            onRemoveGegner={(id) => softDelete("gegner", id, "Gegner")}
            spieltage={spieltage}
            onAddSpieltag={addSpieltag}
            onRemoveSpieltag={removeSpieltag}
            onToggleGegnerZuordnung={toggleGegnerZuordnung}
            uebungen={uebungen}
            trainingUebungen={trainingUebungen}
            onSaveUebung={saveUebung}
            onRemoveUebung={(id) => softDelete("uebungen", id, "Übung")}
            onAddTrainingUebung={addTrainingUebung}
            onRemoveTrainingUebung={(id) => wrapAction(() => dbDelete("training_uebungen", id))}
            onMoveTrainingUebung={moveTrainingUebung}
            onSaveTerminNotiz={(id, notizen) => wrapAction(() => dbUpdate("trainingstermine", id, { notizen }), "Notiz gespeichert")}
            trashPlayers={trashPlayers}
            trashGegner={trashGegner}
            trashSpieltage={trashSpieltage}
            onRestore={(table, id) => wrapAction(() => dbUpdate(table, id, { deleted_at: null }), "Wiederhergestellt")}
            onHardDelete={(table, id, label) => wrapAction(() => dbDelete(table, id), `${label} endgültig gelöscht`)}
            onOpenPlayer={(id) => {
              setSelectedPlayerId(id);
              setTab("dashboard");
            }}
            settingsPlayerId={settingsPlayerId}
            material={material}
            onSaveBestand={(materialKey, date, menge, gruppe) =>
              wrapAction(() =>
                dbUpsert("material_bestand", { date, material: materialKey, menge, gruppe }, "date,material")
              )
            }
            onDeleteMaterialEintrag={(id) => wrapAction(() => dbDelete("material_bestand", id))}
          />
        )}
      </FehlerGrenze>
      </main>
      {busy && <div style={styles.progressBar} />}
      <div className="nz-sr" role="status" aria-live="polite" aria-atomic="true">{toast && toast.type !== "error" ? toast.message : ""}</div>
      {toast && (
        <div className="nz-toast" role={toast.type === "error" ? "alert" : undefined} style={{ ...styles.toast, background: toast.type === "error" ? "var(--danger-solid)" : "var(--accent)" }}>
          <span>
            {toast.type === "error" ? "⚠ " : ""}
            {toast.message}
          </span>
          {toast.undo && (
            <button
              style={styles.toastUndoBtn}
              onClick={() => {
                toast.undo();
                setToast(null);
              }}
            >
              Rückgängig
            </button>
          )}
        </div>
      )}
      {promptState && <TkDialog dialog={promptState} onClose={() => setPromptState(null)} />}
      {confirmState && (
        <div style={styles.modalOverlay}>
          <div
            ref={confirmCardRef}
            role="alertdialog"
            aria-modal="true"
            aria-describedby="confirm-message"
            style={styles.modalCard}
            onClick={(e) => e.stopPropagation()}
          >
            <p id="confirm-message" style={styles.modalText}>{confirmState.message}</p>
            <div style={styles.modalActions}>
              <button style={styles.rowBtnOutline} onClick={() => setConfirmState(null)}>
                Abbrechen
              </button>
              <button
                style={{ ...styles.rowBtn, background: "#9B2226" }}
                onClick={() => {
                  confirmState.onConfirm();
                  setConfirmState(null);
                }}
              >
                Bestätigen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </NavCtx.Provider>
    </TrainingBoardCtx.Provider>
    </FeatureCtx.Provider>
  );
}

/* ---------- Taktik-Board: Felder, Magnete, Linien, Schritte (Animation) ---------- */

const TrainingBoardCtx = React.createContext(null);
const SQL_TRAINING_BOARDS = `-- Nachspielzeit: Taktik-Boards einem Training zuordnen (wiederholbar)
create table if not exists training_boards (
  id text primary key,
  team_id text not null default 'u8',
  termin_id text not null,
  board_id text not null,
  position int not null default 1,
  created_at timestamptz default now()
);
alter table training_boards enable row level security;
grant select, insert, update, delete on table training_boards to anon, authenticated, service_role;
drop policy if exists "access via code" on training_boards;
create policy "access via code" on training_boards for all to public using (nsz_code_ok(team_id)) with check (nsz_code_ok(team_id));
notify pgrst, 'reload schema';`;

function TrainingBoardSqlHinweis() {
  if (!Sitzung.info || Sitzung.info.team_id) {
    return <div style={{ fontSize: 13, color: "var(--muted)" }}>Diese Funktion ist noch nicht aktiviert. Bitte beim Admin nachfragen.</div>;
  }
  return (
    <div style={{ fontSize: 13, color: "var(--muted)" }}>
      <div style={{ marginBottom: 6 }}>Für die Zuordnung fehlt noch eine Tabelle. Bitte einmal in Supabase (SQL Editor) ausführen, danach die Seite neu laden:</div>
      <pre style={{ fontSize: 11.5, whiteSpace: "pre-wrap", margin: 0, userSelect: "all", color: "var(--text)" }}>{SQL_TRAINING_BOARDS}</pre>
    </div>
  );
}

/* Auswahl im Board-Editor: Board einem oder mehreren Trainings zuordnen (Tippen schaltet um) */
function TkTrainingWahl({ board, onClose }) {
  const karteRef = useDialogFokus(onClose);
  const tb = React.useContext(TrainingBoardCtx);
  const heute = todayISO();
  const termine = useMemo(() => {
    if (!tb) return [];
    const verlinkt = new Set(tb.links.filter((l) => l.boardId === board.id).map((l) => l.terminId));
    return tb.termine
      .filter((t) => t.status !== "abgesagt" && (t.date >= heute || verlinkt.has(t.id)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, 30);
  }, [tb, board.id, heute]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Zu Training hinzufügen" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(20,12,12,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div ref={karteRef} onClick={(e) => e.stopPropagation()} style={{ ...styles.card, width: "100%", maxWidth: 420, maxHeight: "80vh", padding: 16, display: "flex", flexDirection: "column", gap: 12, boxShadow: "var(--sh-3)" }}>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 17, fontWeight: 600 }}>Zu Training hinzufügen</div>
        {tb && tb.fehlt ? (
          <TrainingBoardSqlHinweis />
        ) : termine.length === 0 ? (
          <div style={{ fontSize: 13.5, color: "var(--muted)" }}>Keine anstehenden Trainings gefunden. Lege sie unter „Setup“ → „Trainingsplan“ an.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
            {termine.map((t) => {
              const link = tb.links.find((l) => l.terminId === t.id && l.boardId === board.id);
              return (
                <button key={t.id} type="button" aria-pressed={!!link} onClick={() => (link ? tb.remove(link.id) : tb.add(t.id, board.id))}
                  style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 48, padding: "0 12px", borderRadius: 12, textAlign: "left", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600,
                    border: `1.5px solid ${link ? TK_ROT : "var(--border)"}`, background: link ? "rgba(196,39,31,0.10)" : "var(--surface)", color: "var(--text)" }}>
                  <span style={{ flex: 1 }}>
                    {formatTerminLabel(t.date)}
                    {t.start_zeit ? <span style={{ fontWeight: 500, color: "var(--muted)" }}> · {String(t.start_zeit).slice(0, 5)}{t.end_zeit ? `–${String(t.end_zeit).slice(0, 5)}` : ""}</span> : null}
                  </span>
                  {link && <span style={{ color: TK_ROT, fontWeight: 700 }}>✓ dabei</span>}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <TkBtn label="Fertig" aktiv onClick={onClose} />
        </div>
      </div>
    </div>
  );
}

/* Nur-Ansehen-Fenster für ein Board (Training): Schritte wählen, abspielen – ohne Bearbeiten */
function TkAnsicht({ board, players, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1300, background: "var(--bg)", overflowY: "auto", padding: 10, boxSizing: "border-box" }}>
      <TaktikEditor board={board} players={players} onSave={() => {}} onClose={onClose} nurLesen />
    </div>
  );
}

const SQL_TAKTIK = `-- Nachspielzeit: Tabelle für die Taktik-Boards (wiederholbar)
create table if not exists taktik_boards (
  id text primary key,
  team_id text not null default 'u8',
  name text not null default 'Neues Board',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);
alter table taktik_boards enable row level security;
grant select, insert, update, delete on table taktik_boards to anon, authenticated, service_role;
drop policy if exists "access via code" on taktik_boards;
create policy "access via code" on taktik_boards for all to public using (nsz_code_ok(team_id)) with check (nsz_code_ok(team_id));
notify pgrst, 'reload schema';`;

/* Feldmaße in Metern (Länge x Breite). Halbes Feld: links Mittellinie, rechts Torlinie. Fußball5: 40 x 25 m mit 6-m-Torzone. */
const TK_FELDER = {
  f5: { label: "Fußball5", L: 40, W: 25, pad: 2.6 },
  ganz: { label: "Ganzes Feld", L: 105, W: 68, pad: 3.5 },
  halb: { label: "Halbes Feld", L: 52.5, W: 68, pad: 3.5 },
};
const TK_FARBEN = [
  ["#FFFFFF", "Weiß"],
  ["#FFD84D", "Gelb"],
  ["#FF6B5E", "Rot"],
  ["#7CC4FF", "Blau"],
  ["#1F2937", "Schwarz"],
];
const TK_ROT = "#C4271F";
const TK_BLAU = "#2B4C9B";
const TK_GOLD = "#F2A93B";
const TK_GGTW = "#7A3FA6";
const TK_SPIELERART = ["spieler", "torwart", "gegner", "gegnertw"];
const TK_VERBINDBAR = ["spieler", "torwart", "gegner", "gegnertw", "ball", "huetchen"];
const tkNeuesBoard = () => ({
  v: 1,
  feld: "f5",
  ausr: "quer",
  zonen: false,
  anzeige: "nummer",
  namen: true,
  hell: false,
  groesse: 1,
  schritte: [{ objekte: [], linien: [] }],
});
const tkKopie = (x) => JSON.parse(JSON.stringify(x));
const tkVorname = (n) => String(n || "").trim().split(/\s+/)[0] || "";

function tkGeo(data) {
  const F = TK_FELDER[data.feld] || TK_FELDER.f5;
  const hoch = data.ausr === "hoch";
  const { L, W, pad } = F;
  const vbW = (hoch ? W : L) + 2 * pad;
  const vbH = (hoch ? L : W) + 2 * pad;
  // kanonisch (Meter, Länge entlang x) <-> Bildschirm (viewBox-Einheiten)
  const toS = (x, y) => {
    const cx = x * L, cy = y * W;
    return hoch ? [pad + W - cy, pad + cx] : [pad + cx, pad + cy];
  };
  const toN = (sx, sy) => {
    let cx, cy;
    if (hoch) { cy = pad + W - sx; cx = sy - pad; } else { cx = sx - pad; cy = sy - pad; }
    return [cx / L, cy / W];
  };
  return { F, L, W, pad, hoch, vbW, vbH, toS, toN, hell: !!data.hell, R: W * 0.043 * (data.groesse || 1) };
}

const tkBlickWinkel = (o, g) => (g.hoch ? Math.atan2(Math.cos(o.blick), -Math.sin(o.blick)) : o.blick);
const tkFormRad = (o, g) => (((o.rot || 0) + (g.hoch ? 90 : 0)) * Math.PI) / 180;
function tkFormLokal(o, g, s) {
  const c = g.toS(o.x, o.y), th = -tkFormRad(o, g);
  const dx = s[0] - c[0], dy = s[1] - c[1];
  return [dx * Math.cos(th) - dy * Math.sin(th), dx * Math.sin(th) + dy * Math.cos(th)];
}
function tkFormInnen(o, g, s) {
  const [lx, ly] = tkFormLokal(o, g, s);
  if (o.form === "oval") return (lx / (o.w / 2)) ** 2 + (ly / (o.h / 2)) ** 2 <= 1;
  return Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.h / 2;
}
/* Griffe einer Form: vier Seiten (nur Breite bzw. Höhe, die Gegenseite bleibt stehen) und vier Ecken (beides) */
function tkFormGriffe(o, g) {
  const c = g.toS(o.x, o.y), th = tkFormRad(o, g);
  const p = (fx, fy) => {
    const lx = fx * o.w / 2, ly = fy * o.h / 2;
    return [c[0] + lx * Math.cos(th) - ly * Math.sin(th), c[1] + lx * Math.sin(th) + ly * Math.cos(th)];
  };
  const out = [];
  [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sy]) => out.push({ sx, sy, pos: p(sx, sy) }));
  return out;
}
/* Bildschirmpunkte einer Linie (Bögen als Kurve, ohne Wellen) */
function tkBasisPunkte(l, g, objMap) {
  if (l.art === "verbindung") {
    const a = objMap[l.von], b = objMap[l.zu];
    if (!a || !b) return [];
    return [g.toS(a.x, a.y), g.toS(b.x, b.y)];
  }
  let pts = (l.punkte || []).map(([x, y]) => g.toS(x, y));
  if (l.bogen && pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1], c = g.toS(l.bogen[0], l.bogen[1]);
    pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
  }
  return pts;
}
function tkBogenGriff(l, g) {
  const pts = (l.punkte || []).map(([x, y]) => g.toS(x, y));
  const a = pts[0], b = pts[pts.length - 1], c = g.toS(l.bogen[0], l.bogen[1]);
  return [0.25 * a[0] + 0.5 * c[0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * c[1] + 0.25 * b[1]];
}
function tkStandardBogen(a, b, g, vz = 1) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return g.toN(m[0] - vz * (b[1] - a[1]) * 0.25, m[1] + vz * (b[0] - a[0]) * 0.25);
}
function tkWelle(pts, amp, lam) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total < 0.01) return pts;
  const step = lam / 8, n = Math.max(2, Math.ceil(total / step));
  const out = [];
  let seg = 1;
  for (let k = 0; k <= n; k++) {
    const d = Math.min(total, (k * total) / n);
    while (seg < pts.length - 1 && cum[seg] < d) seg++;
    const a = pts[seg - 1], b = pts[seg];
    const sl = cum[seg] - cum[seg - 1] || 1;
    const t = (d - cum[seg - 1]) / sl;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    const tx = (b[0] - a[0]) / sl, ty = (b[1] - a[1]) / sl;
    const taper = Math.min(1, (total - d) / lam, d / (lam * 0.5));
    const off = amp * Math.sin((2 * Math.PI * d) / lam) * Math.max(0, taper);
    out.push([x - ty * off, y + tx * off]);
  }
  return out;
}

function TkFeld({ data, g }) {
  const { L, W, pad, hoch } = g;
  const sw = Math.max(0.25, W * 0.005);
  const hell = g.hell;
  const lc = hell ? "rgba(55,65,81,0.9)" : "rgba(255,255,255,0.93)";
  const zl = hell ? "rgba(55,65,81,0.55)" : "rgba(255,255,255,0.55)";
  const ln = { stroke: lc, strokeWidth: sw, fill: "none" };
  const tr = hoch ? `matrix(0 1 -1 0 ${pad + W} ${pad})` : `translate(${pad} ${pad})`;
  const fs = Math.max(1.5, W * 0.045);
  const txt = (key, x, y, s, extra) => (
    <text key={key} x={x} y={y} fontSize={fs} fontWeight="700" textAnchor="middle" dominantBaseline="central"
      fill={hell ? "rgba(55,65,81,0.95)" : "rgba(255,255,255,0.95)"} stroke={hell ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.25)"} strokeWidth={fs * 0.06} paintOrder="stroke"
      transform={hoch ? `rotate(-90 ${x} ${y})` : undefined} {...extra}>{s}</text>
  );
  const streifen = [];
  const n = data.feld === "f5" ? 8 : 10;
  for (let i = 0; i < n; i++) streifen.push(<rect key={i} x={(i * L) / n} y={0} width={L / n + 0.01} height={W} fill={hell ? (i % 2 ? "#F3F4F6" : "#FFFFFF") : i % 2 ? "#3C9246" : "#37893F"} />);
  const marks = [];
  if (data.feld === "ganz") {
    marks.push(<rect key="r" x={0} y={0} width={L} height={W} {...ln} />);
    marks.push(<line key="m" x1={L / 2} y1={0} x2={L / 2} y2={W} {...ln} />);
    marks.push(<circle key="mk" cx={L / 2} cy={W / 2} r={9.15} {...ln} />);
    marks.push(<circle key="mp" cx={L / 2} cy={W / 2} r={0.35} fill={lc} />);
    [0, 1].forEach((s) => {
      const f = (x) => (s ? L - x : x);
      const d = Math.sqrt(9.15 * 9.15 - 5.5 * 5.5);
      marks.push(<rect key={"sr" + s} x={s ? L - 16.5 : 0} y={W / 2 - 20.16} width={16.5} height={40.32} {...ln} />);
      marks.push(<rect key={"fr" + s} x={s ? L - 5.5 : 0} y={W / 2 - 9.16} width={5.5} height={18.32} {...ln} />);
      marks.push(<circle key={"ep" + s} cx={f(11)} cy={W / 2} r={0.3} fill={lc} />);
      marks.push(<path key={"bg" + s} d={`M ${f(16.5)} ${W / 2 - d} A 9.15 9.15 0 0 ${s ? 0 : 1} ${f(16.5)} ${W / 2 + d}`} {...ln} />);
      marks.push(<rect key={"tor" + s} x={s ? L : -2} y={W / 2 - 3.66} width={2} height={7.32} {...ln} />);
    });
  } else if (data.feld === "halb") {
    marks.push(<rect key="r" x={0} y={0} width={L} height={W} {...ln} />);
    const d = Math.sqrt(9.15 * 9.15 - 5.5 * 5.5);
    marks.push(<path key="mk" d={`M 0 ${W / 2 - 9.15} A 9.15 9.15 0 0 1 0 ${W / 2 + 9.15}`} {...ln} />);
    marks.push(<rect key="sr" x={L - 16.5} y={W / 2 - 20.16} width={16.5} height={40.32} {...ln} />);
    marks.push(<rect key="fr" x={L - 5.5} y={W / 2 - 9.16} width={5.5} height={18.32} {...ln} />);
    marks.push(<circle key="ep" cx={L - 11} cy={W / 2} r={0.3} fill={lc} />);
    marks.push(<path key="bg" d={`M ${L - 16.5} ${W / 2 - d} A 9.15 9.15 0 0 0 ${L - 16.5} ${W / 2 + d}`} {...ln} />);
    marks.push(<rect key="tor" x={L} y={W / 2 - 3.66} width={2} height={7.32} {...ln} />);
  } else {
    marks.push(<rect key="tz0" x={0} y={0} width={6} height={W} fill={hell ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.10)"} />);
    marks.push(<rect key="tz1" x={L - 6} y={0} width={6} height={W} fill={hell ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.10)"} />);
    marks.push(<rect key="r" x={0} y={0} width={L} height={W} {...ln} />);
    marks.push(<line key="m" x1={L / 2} y1={0} x2={L / 2} y2={W} {...ln} />);
    marks.push(<circle key="mp" cx={L / 2} cy={W / 2} r={0.3} fill={lc} />);
    marks.push(<line key="t0" x1={6} y1={0} x2={6} y2={W} {...ln} />);
    marks.push(<line key="t1" x1={L - 6} y1={0} x2={L - 6} y2={W} {...ln} />);
    marks.push(<rect key="tor0" x={-1.2} y={W / 2 - 1.5} width={1.2} height={3} {...ln} />);
    marks.push(<rect key="tor1" x={L} y={W / 2 - 1.5} width={1.2} height={3} {...ln} />);
  }
  // Zonen: Korridore (Flügel blau, Halbräume grau) und Längszonen
  const zon = [];
  if (data.zonen) {
    let ky, zx, bez, zbez, kz;
    if (data.feld === "f5") {
      ky = [0, 7, 18, 25];
      kz = ["flügel", "mitte", "flügel"];
      bez = ["A", "B", "C"];
      zx = [0, 6, 20, 34, 40];
      zbez = ["1", "2", "3", "4"];
    } else {
      ky = [0, 0.18, 0.35, 0.65, 0.82, 1].map((v) => v * W);
      kz = ["flügel", "halbraum", "mitte", "halbraum", "flügel"];
      bez = ["A", "B", "C", "D", "E"];
      const z0 = data.feld === "halb" ? 3 : 0;
      zx = Array.from({ length: (data.feld === "halb" ? 3 : 6) + 1 }, (_, i) => (i * 17.5));
      zbez = Array.from({ length: data.feld === "halb" ? 3 : 6 }, (_, i) => String(i + 1 + z0));
    }
    kz.forEach((t, i) => {
      if (t === "mitte") return;
      zon.push(<rect key={"k" + i} x={0} y={ky[i]} width={L} height={ky[i + 1] - ky[i]} fill={t === "flügel" ? `url(#tkHB-${data.feld})` : `url(#tkHG-${data.feld})`} />);
    });
    ky.slice(1, -1).forEach((y, i) => zon.push(<line key={"kl" + i} x1={0} y1={y} x2={L} y2={y} stroke={zl} strokeWidth={sw * 0.8} strokeDasharray={`${sw * 4} ${sw * 3}`} />));
    zx.slice(1, -1).forEach((x, i) => zon.push(<line key={"zl" + i} x1={x} y1={0} x2={x} y2={W} stroke={zl} strokeWidth={sw * 0.8} strokeDasharray={`${sw * 4} ${sw * 3}`} />));
    bez.forEach((b, i) => zon.push(txt("kb" + i, fs * 0.9, (ky[i] + ky[i + 1]) / 2, b, { opacity: 0.9 })));
    zbez.forEach((b, i) => zon.push(txt("zb" + i, (zx[i] + zx[i + 1]) / 2, fs * 0.9, b, { opacity: 0.9 })));
  }
  return (
    <g transform={tr}>
      {streifen}
      {zon}
      {marks}
    </g>
  );
}

const tkRadius = (o, g) => {
  const R = g.R;
  if (o.art === "ball") return R * 0.75;
  if (o.art === "stange") return R * 1.2;
  if (o.art === "reifen") return R * 1.15 * (o.sk || 1);
  if (o.art === "form") return Math.max(o.w, o.h) / 2;
  if (o.art === "huetchen") return R * 0.8;
  if (o.art === "tor") return (o.klein ? g.W * 0.05 : g.W * 0.108) * 0.55;
  if (o.art === "text") return Math.max(R * 1.2, (String(o.text || "").length * R * 0.9 * 0.6) / 2 + R * 0.5);
  return R * 1.12;
};

function TkObjekt({ o, g, anzeige, namen, players, sel, opacity = 1, pos }) {
  const R = g.R;
  const [x, y] = pos || g.toS(o.x, o.y);
  const p = o.spielerId ? players.find((q) => q.id === o.spielerId) : null;
  const gk = o.art === "torwart";
  const hell = g.hell;
  const tx = (c) => (hell && c === "#FFFFFF" ? "#111827" : c);
  let body = null;
  if (TK_SPIELERART.includes(o.art)) {
    const farbe = o.art === "gegner" ? TK_BLAU : o.art === "gegnertw" ? TK_GGTW : gk ? TK_GOLD : TK_ROT;
    const th = o.blick != null ? tkBlickWinkel(o, g) : null;
    const nr = p ? (p.trikotnummer != null ? p.trikotnummer : tkVorname(p.name).slice(0, 1)) : o.nr != null && o.nr !== "" ? o.nr : "";
    const foto = anzeige === "foto" && p && p.photo_url ? p.photo_url : null;
    const klar = "tkc" + String(o.id).replace(/[^a-z0-9]/gi, "");
    body = (
      <>
        {th != null && (
          <g transform={`rotate(${(th * 180) / Math.PI})`}>
            <path d={`M ${R * 0.9} ${-R * 0.65} L ${R * 1.8} 0 L ${R * 0.9} ${R * 0.65} Z`} fill={farbe} stroke="#fff" strokeWidth={R * 0.1} strokeLinejoin="round" />
          </g>
        )}
        <circle r={R} fill={farbe} stroke="#fff" strokeWidth={R * 0.12} />
        {foto ? (
          <>
            <clipPath id={klar}><circle r={R * 0.9} /></clipPath>
            <image href={foto} x={-R} y={-R} width={R * 2} height={R * 2} clipPath={`url(#${klar})`} preserveAspectRatio="xMidYMid slice" />
            {nr !== "" && (
              <g transform={`translate(${-R * 0.72} ${R * 0.72})`}>
                <circle r={R * 0.42} fill={farbe} stroke="#fff" strokeWidth={R * 0.08} />
                <text fontSize={R * 0.62} fontWeight="800" fill="#fff" textAnchor="middle" dominantBaseline="central">{nr}</text>
              </g>
            )}
          </>
        ) : (
          nr !== "" && <text fontSize={R * (String(nr).length > 1 ? 0.95 : 1.15)} fontWeight="800" fill={gk ? "#3B2A05" : "#fff"} textAnchor="middle" dominantBaseline="central">{nr}</text>
        )}
        {namen && p && <text y={R * 1.9} fontSize={R * 0.78} fontWeight="700" fill={hell ? "#111" : "#fff"} stroke={hell ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.55)"} strokeWidth={R * 0.2} paintOrder="stroke" textAnchor="middle">{tkVorname(p.name)}</text>}
        {namen && !p && o.name && <text y={R * 1.9} fontSize={R * 0.78} fontWeight="700" fill={hell ? "#111" : "#fff"} stroke={hell ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.55)"} strokeWidth={R * 0.2} paintOrder="stroke" textAnchor="middle">{o.name}</text>}
      </>
    );
  } else if (o.art === "ball") {
    body = (
      <>
        <circle r={R * 0.55} fill="#fff" stroke="#111" strokeWidth={R * 0.09} />
        <polygon points={`0,${-R * 0.26} ${R * 0.25},${-R * 0.08} ${R * 0.15},${R * 0.21} ${-R * 0.15},${R * 0.21} ${-R * 0.25},${-R * 0.08}`} fill="#111" />
      </>
    );
  } else if (o.art === "huetchen") {
    body = <path d={`M 0 ${-R * 0.7} L ${R * 0.6} ${R * 0.55} L ${-R * 0.6} ${R * 0.55} Z`} fill={o.farbe || "#F28C28"} stroke="#fff" strokeWidth={R * 0.09} strokeLinejoin="round" />;
  } else if (o.art === "tor") {
    const w = o.klein ? g.W * 0.05 : g.W * 0.108;
    const h = w * 0.38;
    const netz = [];
    for (let i = 1; i < 6; i++) netz.push(<line key={i} x1={-w / 2 + (w * i) / 6} y1={-h / 2} x2={-w / 2 + (w * i) / 6} y2={h / 2} stroke={hell ? "rgba(55,65,81,0.5)" : "rgba(255,255,255,0.55)"} strokeWidth={w * 0.012} />);
    body = (
      <g transform={`rotate(${o.rot || 0})`}>
        <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={hell ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.22)"} stroke={hell ? "#374151" : "#fff"} strokeWidth={w * 0.045} rx={w * 0.01} />
        {netz}
      </g>
    );
  } else if (o.art === "stange") {
    const rot = (o.rot || 0) + (g.hoch ? 90 : 0);
    const seg = [];
    for (let i = 0; i < 4; i++) seg.push(<rect key={i} x={-R * 1.15 + i * R * 0.575} y={-R * 0.15} width={R * 0.575} height={R * 0.3} fill={i % 2 ? "#fff" : "#E5322B"} />);
    body = (
      <g transform={`rotate(${rot})`}>
        {seg}
        <rect x={-R * 1.15} y={-R * 0.15} width={R * 2.3} height={R * 0.3} fill="none" stroke="#222" strokeWidth={R * 0.06} />
      </g>
    );
  } else if (o.art === "reifen") {
    body = <circle r={R * 0.9 * (o.sk || 1)} fill="rgba(255,255,255,0.05)" stroke={tx(o.farbe || "#F28C28")} strokeWidth={R * 0.26} />;
  } else if (o.art === "form") {
    const rot = (o.rot || 0) + (g.hoch ? 90 : 0);
    const f = tx(o.farbe || "#FFFFFF");
    const op = o.op != null ? o.op : 0.3;
    body = (
      <g transform={`rotate(${rot})`}>
        {o.form === "oval" ? (
          <ellipse rx={o.w / 2} ry={o.h / 2} fill={f} fillOpacity={op} stroke={f} strokeWidth={R * 0.12} />
        ) : (
          <rect x={-o.w / 2} y={-o.h / 2} width={o.w} height={o.h} fill={f} fillOpacity={op} stroke={f} strokeWidth={R * 0.12} />
        )}
        {sel && <rect data-skip="1" x={-o.w / 2} y={-o.h / 2} width={o.w} height={o.h} fill="none" stroke="#FFD84D" strokeWidth={R * 0.12} strokeDasharray={`${R * 0.35} ${R * 0.25}`} />}
        {sel && [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([sx, sy]) => <circle key={`${sx}${sy}`} data-skip="1" cx={sx * o.w / 2} cy={sy * o.h / 2} r={R * 0.4} fill="#fff" stroke="#222" strokeWidth={R * 0.08} />)}
        {sel && [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sy]) => <circle key={`${sx}${sy}`} data-skip="1" cx={sx * o.w / 2} cy={sy * o.h / 2} r={R * 0.5} fill="#FFD84D" stroke="#222" strokeWidth={R * 0.08} />)}
      </g>
    );
  } else if (o.art === "text") {
    const fs = R * 0.95;
    const w = Math.max(fs * 1.4, String(o.text || "").length * fs * 0.6 + fs);
    body = (
      <>
        <rect x={-w / 2} y={-fs * 0.8} width={w} height={fs * 1.6} rx={fs * 0.35} fill="rgba(20,20,20,0.72)" stroke="rgba(255,255,255,0.8)" strokeWidth={fs * 0.06} />
        <text fontSize={fs} fontWeight="700" fill="#fff" textAnchor="middle" dominantBaseline="central">{o.text || "Text"}</text>
      </>
    );
  }
  const rr = tkRadius(o, g);
  return (
    <g transform={`translate(${x} ${y})`} opacity={opacity}>
      {sel && o.art !== "form" && <circle data-skip="1" r={rr * 1.25} fill="none" stroke="#FFD84D" strokeWidth={R * 0.14} strokeDasharray={`${R * 0.35} ${R * 0.25}`} />}
      {body}
      {sel && o.blick != null && TK_SPIELERART.includes(o.art) && (
        <circle data-skip="1" cx={Math.cos(tkBlickWinkel(o, g)) * R * 2.5} cy={Math.sin(tkBlickWinkel(o, g)) * R * 2.5} r={R * 0.45} fill="#FFD84D" stroke="#222" strokeWidth={R * 0.08} />
      )}
    </g>
  );
}

function TkLinie({ l, g, objMap, sel, opacity = 1 }) {
  const lw = Math.max(0.45, g.W * 0.011);
  const pts = tkBasisPunkte(l, g, objMap);
  if (pts.length < 2) return null;
  const farbe = l.farbe === "#FFFFFF" && g.hell ? "#111827" : l.farbe || "#FFFFFF";
  const verb = l.art === "verbindung";
  const breite = verb ? lw * 1.7 : lw;
  const mitSpitze = !verb && l.art !== "linie";
  let head = null;
  let linePts = pts;
  if (mitSpitze) {
    const e = pts[pts.length - 1];
    const hl = lw * 4.2;
    let q = pts[0];
    for (let i = pts.length - 2; i >= 0; i--) {
      q = pts[i];
      if (Math.hypot(e[0] - q[0], e[1] - q[1]) >= hl * 0.8) break;
    }
    const dx = e[0] - q[0], dy = e[1] - q[1];
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const bx = e[0] - ux * hl, by = e[1] - uy * hl;
    head = `${e[0]},${e[1]} ${bx - uy * hl * 0.5},${by + ux * hl * 0.5} ${bx + uy * hl * 0.5},${by - ux * hl * 0.5}`;
    linePts = [...pts.slice(0, -1), [e[0] - ux * hl * 0.6, e[1] - uy * hl * 0.6]];
  }
  if (l.art === "welle") linePts = tkWelle(linePts, lw * 1.5, lw * 7);
  const dstr = linePts.map((p) => p.join(",")).join(" ");
  const griff = sel && l.bogen && !verb ? tkBogenGriff(l, g) : null;
  return (
    <g opacity={opacity}>
      {sel && <polyline data-skip="1" points={dstr} fill="none" stroke="#FFD84D" strokeWidth={breite + lw * 1.6} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />}
      <polyline points={dstr} fill="none" stroke={farbe} strokeWidth={breite} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={l.art === "lauf" ? `${lw * 2.4} ${lw * 1.9}` : undefined} opacity={verb ? 0.8 : 1} />
      {head && <polygon points={head} fill={farbe} />}
      {griff && <circle data-skip="1" cx={griff[0]} cy={griff[1]} r={lw * 2.6} fill="#FFD84D" stroke="#222" strokeWidth={lw * 0.4} />}
    </g>
  );
}

function TkDefs({ data, g }) {
  const h = Math.max(1, g.W * 0.03);
  return (
    <defs>
      <pattern id={`tkHB-${data.feld}`} patternUnits="userSpaceOnUse" width={h} height={h} patternTransform="rotate(45)">
        <rect width={h} height={h} fill="rgba(70,140,255,0.22)" />
        <line x1="0" y1="0" x2="0" y2={h} stroke={g.hell ? "rgba(60,120,220,0.6)" : "rgba(130,185,255,0.8)"} strokeWidth={h * 0.22} />
      </pattern>
      <pattern id={`tkHG-${data.feld}`} patternUnits="userSpaceOnUse" width={h} height={h} patternTransform="rotate(45)">
        <rect width={h} height={h} fill={g.hell ? "rgba(120,120,120,0.12)" : "rgba(220,220,220,0.14)"} />
        <line x1="0" y1="0" x2="0" y2={h} stroke={g.hell ? "rgba(100,100,100,0.5)" : "rgba(230,230,230,0.7)"} strokeWidth={h * 0.22} />
      </pattern>
    </defs>
  );
}

const tkEase = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const tkLerp = (a, b, t) => a + (b - a) * t;
function tkAbstandSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function tkNormalisiere(d) {
  const n = { ...tkNeuesBoard(), ...(d || {}) };
  if (!Array.isArray(n.schritte) || n.schritte.length === 0) n.schritte = [{ objekte: [], linien: [] }];
  return n;
}

/* Interpolierte Ansicht zwischen Schritt A und B (t = 0..1) */
function tkZwischen(A, B, t) {
  const k = tkEase(t);
  const mapB = {};
  B.objekte.forEach((o) => (mapB[o.id] = o));
  const mapA = {};
  A.objekte.forEach((o) => (mapA[o.id] = o));
  const objekte = [];
  A.objekte.forEach((o) => {
    const b = mapB[o.id];
    objekte.push(
      b
        ? {
            ...o,
            x: tkLerp(o.x, b.x, k),
            y: tkLerp(o.y, b.y, k),
            rot: o.rot != null && b.rot != null ? tkLerp(o.rot, b.rot, k) : b.rot != null ? b.rot : o.rot,
            ...(o.w != null && b.w != null ? { w: tkLerp(o.w, b.w, k), h: tkLerp(o.h, b.h, k) } : {}),
            ...(o.blick != null && b.blick != null ? { blick: o.blick + ((((b.blick - o.blick + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * k } : {}),
          }
        : { ...o, _op: 1 - k }
    );
  });
  B.objekte.forEach((o) => { if (!mapA[o.id]) objekte.push({ ...o, _op: k }); });
  return objekte;
}

function TkBrett({ data, g, players, objekte, linien, linienOp = 1, selId, draft, svgRef, handlers, nurAnzeige }) {
  const objMap = {};
  objekte.forEach((o) => (objMap[o.id] = o));
  let draftEl = null;
  if (draft) {
    const lw = Math.max(0.45, g.W * 0.011);
    if (draft.art === "verbindung") {
      const a = objMap[draft.von];
      if (a) {
        const p1 = g.toS(a.x, a.y), p2 = g.toS(draft.ende[0], draft.ende[1]);
        draftEl = <line x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]} stroke={draft.farbe} strokeWidth={lw * 1.7} strokeLinecap="round" opacity={0.6} />;
      }
    } else {
      draftEl = <TkLinie l={{ art: draft.art, farbe: draft.farbe, punkte: draft.punkte, bogen: draft.bogen }} g={g} objMap={objMap} />;
    }
  }
  return (
    <svg ref={svgRef} viewBox={`0 0 ${g.vbW} ${g.vbH}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", borderRadius: nurAnzeige ? 8 : 12 }}
      {...(handlers || {})}>
      <TkDefs data={data} g={g} />
      <rect x={0} y={0} width={g.vbW} height={g.vbH} fill={g.hell ? "#FFFFFF" : "#2F7A39"} />
      <TkFeld data={data} g={g} />
      {objekte.filter((o) => o.art === "form").map((o) => (
        <TkObjekt key={o.id} o={o} g={g} anzeige={data.anzeige} namen={data.namen} players={players} sel={selId === o.id} opacity={o._op != null ? o._op : 1} />
      ))}
      {linien.map((l) => <TkLinie key={l.id} l={l} g={g} objMap={objMap} sel={selId === l.id} opacity={linienOp} />)}
      {draftEl}
      {objekte.filter((o) => o.art !== "form").map((o) => (
        <TkObjekt key={o.id} o={o} g={g} anzeige={data.anzeige} namen={data.namen} players={players} sel={selId === o.id} opacity={o._op != null ? o._op : 1} />
      ))}
    </svg>
  );
}

/* ---------- Taktik-Board: Icons und Bedienelemente ---------- */
const TK_ICONS = {
  zurueck: <path d="M15 18l-6-6 6-6" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>,
  bild: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></>,
  voll: <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />,
  vollAus: <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />,
  f5: <><rect x="3" y="7" width="18" height="10" rx="1" /><path d="M3 10.5h2.5v3H3M21 10.5h-2.5v3H21" /></>,
  ganz: <><rect x="2" y="5" width="20" height="14" rx="1" /><path d="M12 5v14" /><circle cx="12" cy="12" r="2.5" /></>,
  halb: <><rect x="2" y="5" width="20" height="14" rx="1" /><path d="M2 9h4v6H2" /><path d="M22 9.5a3 3 0 0 0 0 5" /></>,
  quer: <rect x="2" y="6" width="20" height="12" rx="2" />,
  hoch: <rect x="6" y="2" width="12" height="20" rx="2" />,
  zonen: <path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18" />,
  nummern: <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />,
  foto: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  text: <path d="M4 7V4h16v3M9 20h6M12 4v16" />,
  hell: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  groesseS: <circle cx="12" cy="12" r="3" />,
  groesseM: <circle cx="12" cy="12" r="5.5" />,
  groesseL: <circle cx="12" cy="12" r="9" />,
  bewegen: <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" />,
  pass: <><path d="M3 12h15" /><path d="M14 7l6 5-6 5z" fill="currentColor" /></>,
  lauf: <><path d="M3 12h4M10 12h4" /><path d="M14 7l6 5-6 5z" fill="currentColor" /></>,
  welle: <><path d="M2 12c1.5-4 3.5-4 5 0s3.5 4 5 0" /><path d="M14 7l6 5-6 5z" fill="currentColor" /></>,
  linie: <path d="M4 20L20 4" />,
  frei: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  verbinden: <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />,
  radieren: <path d="M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9" />,
  bogen: <path d="M4 19C4 9 10 5 20 5" />,
  tauschen: <path d="M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />,
  drehen: <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />,
  blick: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  deckkraft: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  torwart: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  loeschen: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  play: <path d="M6 4l14 8-14 8z" fill="currentColor" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />,
  weiter: <><path d="M5 4l10 8-10 8z" fill="currentColor" /><path d="M19 5v14" /></>,
  wiederholen: <path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />,
  warten: <path d="M6 2h12M6 22h12M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4" />,
  kopieren: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  nummer: <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />,
  name: <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />,
  mehr: <path d="M4 6h16M4 12h16M4 18h16" />,
  kalender: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4" /></>,
  schliessen: <path d="M6 6l12 12M18 6L6 18" />,
  handydrehen: <><rect x="8" y="2.5" width="8" height="14" rx="1.5" /><path d="M4 14a8 8 0 0 0 6.5 7.8M10.5 22l-2.8-.5M10.5 22l.3-2.8M20 10a8 8 0 0 0-3-3" /></>,
};
function TkIcon({ n, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
      {TK_ICONS[n]}
    </svg>
  );
}

/* Icon-Button: quadratisch (nur Icon) oder mit Beschriftung. Titel = Tooltip + Screenreader-Name. */
function TkBtn({ icon, titel, label, aktiv, onClick, disabled, gefahr, size = 44, style, children }) {
  const an = !!aktiv;
  return (
    <button
      type="button"
      title={titel || label}
      aria-label={titel || label}
      aria-pressed={aktiv === undefined ? undefined : an}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flex: "none",
        minWidth: size, height: size, padding: label ? "0 12px" : 0, boxSizing: "border-box",
        border: `1.5px solid ${an ? TK_ROT : "var(--border)"}`, borderRadius: 12,
        background: an ? TK_ROT : "var(--surface)", color: an ? "#fff" : gefahr ? "var(--danger-text)" : "var(--text)",
        fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: disabled ? "default" : "pointer", whiteSpace: "nowrap",
        opacity: disabled ? 0.4 : 1, ...style,
      }}
    >
      {icon && <TkIcon n={icon} size={size < 40 ? 18 : 22} />}
      {label}
      {children}
    </button>
  );
}

/* Magnet als Kachel: Mini-Vorschau + kurze Beschriftung */
function TkMagnetKachel({ titel, onClick, children }) {
  return (
    <button type="button" title={titel} aria-label={titel} onClick={onClick}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, width: 68, height: 58, padding: 0, border: "1.5px solid var(--border)", borderRadius: 12, background: "var(--surface)", color: "var(--text)", fontFamily: "inherit", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
      <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titel}</span>
    </button>
  );
}
const tkFigur = (farbe) => <><circle cx="12" cy="12" r="8.5" fill={farbe} stroke="#fff" strokeWidth="1.5" /><circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--border-strong)" strokeWidth="0.8" /></>;
const TK_MAGNET_ICON = {
  spieler: tkFigur(TK_ROT),
  torwart: tkFigur(TK_GOLD),
  gegner: tkFigur(TK_BLAU),
  gegnertw: tkFigur(TK_GGTW),
  ball: <><circle cx="12" cy="12" r="8" fill="#fff" stroke="#222" strokeWidth="1.4" /><path d="M12 8l3.5 2.5-1.3 4h-4.4l-1.3-4z" fill="#222" /></>,
  huetchen: (f) => <path d="M12 4L5 19h14z" fill={f} stroke="#222" strokeWidth="0.8" strokeLinejoin="round" />,
  stange: <><rect x="1" y="10.5" width="5.5" height="3" fill="#E5322B" /><rect x="6.5" y="10.5" width="5.5" height="3" fill="#fff" /><rect x="12" y="10.5" width="5.5" height="3" fill="#E5322B" /><rect x="17.5" y="10.5" width="5.5" height="3" fill="#fff" /><rect x="1" y="10.5" width="22" height="3" fill="none" stroke="#222" strokeWidth="0.7" /></>,
  reifen: <circle cx="12" cy="12" r="7.5" fill="none" stroke="#F28C28" strokeWidth="3.2" />,
  rechteck: <rect x="3" y="6" width="18" height="12" rx="1.5" fill="rgba(124,196,255,0.45)" stroke="#4DA3FF" strokeWidth="1.5" />,
  oval: <ellipse cx="12" cy="12" rx="9" ry="6" fill="rgba(124,196,255,0.45)" stroke="#4DA3FF" strokeWidth="1.5" />,
  tor: <><path d="M3 19V6h18v13" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M7 6v13M12 6v13M17 6v13M3 10h18M3 14h18" stroke="currentColor" strokeWidth="0.7" opacity="0.6" /></>,
  minitor: <><path d="M6 17V9h12v8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M10 9v8M14 9v8M6 13h12" stroke="currentColor" strokeWidth="0.7" opacity="0.6" /></>,
  text: <path d="M5 7V5h14v2M9 19h6M12 5v14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
};

/* Eingabefenster (statt Browser-Popup) */
/* Dialog-Verhalten für Tastatur und Screenreader: Fokus in den Dialog, Tab bleibt im Dialog, Escape schließt, Fokus kehrt zum Auslöser zurück.
   Das zurückgegebene ref gehört an die Dialog-Karte. */
function useDialogFokus(onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Auslöser beim ersten Rendern merken: ein autoFocus im Dialog greift schon vor dem Effekt
  const vorherRef = useRef(null);
  if (vorherRef.current === null) vorherRef.current = document.activeElement;
  useEffect(() => {
    const vorher = vorherRef.current;
    const karte = ref.current;
    const fokussierbar = () =>
      karte ? Array.from(karte.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")) : [];
    if (karte && !karte.contains(document.activeElement) && fokussierbar()[0]) fokussierbar()[0].focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab") {
        const items = fokussierbar();
        if (!items.length) return;
        const erstes = items[0];
        const letztes = items[items.length - 1];
        if (e.shiftKey && document.activeElement === erstes) { e.preventDefault(); letztes.focus(); }
        else if (!e.shiftKey && document.activeElement === letztes) { e.preventDefault(); erstes.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (vorher && vorher.focus && document.contains(vorher)) vorher.focus();
    };
  }, []);
  return ref;
}

function TkDialog({ dialog, onClose }) {
  const [wert, setWert] = useState(dialog.wert || "");
  const ok = () => { dialog.onOk(wert); onClose(); };
  const karteRef = useDialogFokus(onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label={dialog.titel} onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(20,12,12,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div ref={karteRef} onClick={(e) => e.stopPropagation()} style={{ ...styles.card, width: "100%", maxWidth: 360, padding: 16, display: "flex", flexDirection: "column", gap: 12, boxShadow: "var(--sh-3)" }}>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 17, fontWeight: 600 }}>{dialog.titel}</div>
        <input autoFocus value={wert} placeholder={dialog.platzhalter || ""} inputMode={dialog.zahl ? "numeric" : undefined}
          onChange={(e) => setWert(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") ok(); }}
          style={{ ...styles.input, width: "100%", boxSizing: "border-box", fontSize: 16 }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <TkBtn label="Abbrechen" onClick={onClose} />
          <TkBtn label="OK" aktiv onClick={ok} />
        </div>
      </div>
    </div>
  );
}

function TaktikEditor({ board, players, onSave, onClose, nurLesen = false }) {
  const [name, setName] = useState(board.name || "Neues Board");
  const [data, setData] = useState(() => tkNormalisiere(tkKopie(board.data)));
  const [schritt, setSchritt] = useState(0);
  const [tool, setTool] = useState("bewegen");
  const [farbe, setFarbe] = useState("#FFFFFF");
  const [sel, setSel] = useState(null); // { typ: "o" | "l", id }
  const [draft, setDraft] = useState(null);
  const [anim, setAnim] = useState(null); // { i, t }
  const [voll, setVoll] = useState(false);
  const [status, setStatus] = useState("");
  const [dirty, setDirty] = useState(0);
  const [fenster, setFenster] = useState(() => ({ b: window.innerWidth, h: window.innerHeight }));
  const [exportiert, setExportiert] = useState(false);
  const [bogenAn, setBogenAn] = useState(false);
  const [bogenSeite, setBogenSeite] = useState(1);
  const [schleife, setSchleife] = useState(false);
  const [tempo, setTempo] = useState(1);
  const schleifeRef = useRef(false);
  const tempoRef = useRef(1);
  const weiterRef = useRef(false);
  schleifeRef.current = schleife;
  tempoRef.current = tempo;
  const [fTeam, setFTeam] = useState("wir");
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  const past = useRef([]);
  const future = useRef([]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const schrittRef = useRef(0);
  const nameRef = useRef(name);
  nameRef.current = name;
  const letzterStand = useRef(null);

  const g = useMemo(() => tkGeo(data), [data.feld, data.ausr, data.hell, data.groesse]);
  const sIdx = Math.min(schritt, data.schritte.length - 1);
  schrittRef.current = sIdx;
  const st = data.schritte[sIdx];
  const aktivePlayers = useMemo(
    () => players.filter((p) => p.active !== false).slice().sort((a, b) => (a.trikotnummer ?? 999) - (b.trikotnummer ?? 999) || (a.name || "").localeCompare(b.name || "", "de")),
    [players]
  );

  useEffect(() => {
    const h = () => setFenster({ b: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  useEffect(() => {
    const h = () => { if (!document.fullscreenElement) setVoll((v) => (v && document.fullscreenElement === null && letzterStand.current === "fs" ? false : v)); };
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Automatisches Speichern (kurz nach der letzten Änderung)
  useEffect(() => {
    if (dirty === 0) return;
    setStatus("Ungespeichert …");
    const t = setTimeout(() => speichernJetzt(), 1200);
    return () => clearTimeout(t);
  }, [dirty]);
  const speichernJetzt = async () => {
    try {
      setStatus("Speichert …");
      await onSave({ id: board.id, name: nameRef.current.trim() || "Board", data: dataRef.current });
      setStatus("Gespeichert ✓");
    } catch (e) {
      setStatus("Fehler beim Speichern");
    }
  };
  const schliessen = async () => {
    cancelAnimationFrame(rafRef.current);
    if (dirty > 0) await speichernJetzt();
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    onClose();
  };

  const commit = (neu, ohneHistorie) => {
    if (!ohneHistorie) {
      past.current.push(JSON.stringify(dataRef.current));
      if (past.current.length > 80) past.current.shift();
      future.current = [];
    }
    dataRef.current = neu;
    setData(neu);
    setDirty((n) => n + 1);
  };
  const aendern = (fn) => {
    const d = tkKopie(dataRef.current);
    fn(d, d.schritte[schrittRef.current], schrittRef.current);
    commit(d);
  };
  const rueckgaengig = () => {
    if (!past.current.length) return;
    future.current.push(JSON.stringify(dataRef.current));
    const d = JSON.parse(past.current.pop());
    dataRef.current = d;
    setData(d);
    setSchritt((s) => Math.min(s, d.schritte.length - 1));
    setSel(null);
    setDirty((n) => n + 1);
  };
  const wiederholen = () => {
    if (!future.current.length) return;
    past.current.push(JSON.stringify(dataRef.current));
    const d = JSON.parse(future.current.pop());
    dataRef.current = d;
    setData(d);
    setSchritt((s) => Math.min(s, d.schritte.length - 1));
    setSel(null);
    setDirty((n) => n + 1);
  };

  const punkt = (e) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [p.x, p.y];
  };
  const klemme = (v) => Math.max(-0.04, Math.min(1.04, v));
  const treffer = (s) => {
    const rev = [...st.objekte].reverse();
    return (
      rev.find((o) => {
        if (o.art === "form") return false;
        const [ox, oy] = g.toS(o.x, o.y);
        return Math.hypot(ox - s[0], oy - s[1]) <= tkRadius(o, g);
      }) || rev.find((o) => o.art === "form" && tkFormInnen(o, g, s))
    );
  };
  const linienTreffer = (s) => {
    const map = {};
    st.objekte.forEach((o) => (map[o.id] = o));
    const tol = Math.max(1.4, g.W * 0.03);
    return [...st.linien].reverse().find((l) => {
      const pts = tkBasisPunkte(l, g, map);
      for (let i = 0; i < pts.length - 1; i++) if (tkAbstandSegment(s, pts[i], pts[i + 1]) <= tol) return true;
      return false;
    });
  };

  const onDown = (e) => {
    if (anim) { if (anim.wait) weiterRef.current = true; return; }
    if (dragRef.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const s = punkt(e);
    const [nx, ny] = g.toN(s[0], s[1]);
    const hit = treffer(s);
    const svg = svgRef.current;
    if (tool === "bewegen" && sel) {
      const so = sel.typ === "o" ? st.objekte.find((o) => o.id === sel.id) : null;
      const sl = sel.typ === "l" ? st.linien.find((l) => l.id === sel.id) : null;
      let griff = null, art = null, ra = g.R * 0.9, formAchse = null;
      if (so && so.blick != null && TK_SPIELERART.includes(so.art)) {
        const c = g.toS(so.x, so.y), th = tkBlickWinkel(so, g);
        griff = [c[0] + Math.cos(th) * g.R * 2.5, c[1] + Math.sin(th) * g.R * 2.5]; art = "blick";
      } else if (so && so.art === "form") {
        const gf = tkFormGriffe(so, g).map((q) => ({ ...q, d: Math.hypot(q.pos[0] - s[0], q.pos[1] - s[1]) })).sort((a, b) => a.d - b.d)[0];
        griff = gf.pos; art = "form"; formAchse = { sx: gf.sx, sy: gf.sy, x: so.x, y: so.y, w: so.w, h: so.h };
      } else if (sl && sl.bogen) {
        griff = tkBogenGriff(sl, g); art = "bogen"; ra = Math.max(g.W * 0.03, 1.2);
      }
      if (griff && Math.hypot(griff[0] - s[0], griff[1] - s[1]) <= ra) {
        dragRef.current = { kind: art, id: sel.id, pid: e.pointerId, moved: false, achse: formAchse, start: JSON.stringify(dataRef.current) };
        svg.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (tool === "radieren") {
      dragRef.current = { kind: "erase", pid: e.pointerId, moved: false, start: JSON.stringify(dataRef.current) };
      svg.setPointerCapture(e.pointerId);
      radiereBei(s);
      return;
    }
    if (tool === "bewegen") {
      if (hit) {
        setSel({ typ: "o", id: hit.id });
        dragRef.current = { kind: "obj", id: hit.id, pid: e.pointerId, dx: hit.x - nx, dy: hit.y - ny, moved: false, start: JSON.stringify(dataRef.current) };
        svg.setPointerCapture(e.pointerId);
      } else {
        const l = linienTreffer(s);
        setSel(l ? { typ: "l", id: l.id } : null);
      }
    } else if (tool === "verbinden") {
      if (hit && TK_VERBINDBAR.includes(hit.art)) {
        dragRef.current = { kind: "verb", von: hit.id, pid: e.pointerId };
        setDraft({ art: "verbindung", von: hit.id, ende: [hit.x, hit.y], farbe });
        svg.setPointerCapture(e.pointerId);
      }
    } else {
      dragRef.current = { kind: "draw", pid: e.pointerId, bogen: bogenAn && tool !== "frei", seite: bogenSeite };
      setDraft({ art: tool, punkte: [[nx, ny]], farbe });
      svg.setPointerCapture(e.pointerId);
    }
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d || d.pid !== e.pointerId) return;
    const s = punkt(e);
    const [nx, ny] = g.toN(s[0], s[1]);
    if (d.kind === "obj") {
      d.moved = true;
      const neu = tkKopie(dataRef.current);
      const o = neu.schritte[schrittRef.current].objekte.find((q) => q.id === d.id);
      if (o) { o.x = klemme(nx + d.dx); o.y = klemme(ny + d.dy); }
      dataRef.current = neu;
      setData(neu);
    } else if (d.kind === "erase") {
      radiereBei(s);
    } else if (d.kind === "blick" || d.kind === "form" || d.kind === "bogen") {
      d.moved = true;
      const neu = tkKopie(dataRef.current);
      const stp = neu.schritte[schrittRef.current];
      if (d.kind === "bogen") {
        const l = stp.linien.find((q) => q.id === d.id);
        if (l) {
          const pts = (l.punkte || []).map(([x, y]) => g.toS(x, y));
          const a = pts[0], b = pts[pts.length - 1];
          l.bogen = g.toN(2 * s[0] - 0.5 * (a[0] + b[0]), 2 * s[1] - 0.5 * (a[1] + b[1]));
        }
      } else {
        const o = stp.objekte.find((q) => q.id === d.id);
        if (o && d.kind === "blick") {
          const c = g.toS(o.x, o.y), vx = s[0] - c[0], vy = s[1] - c[1];
          o.blick = g.hoch ? Math.atan2(-vx, vy) : Math.atan2(vy, vx);
        } else if (o) {
          // Lokale Position des Zeigers relativ zur Form vor dem Ziehen; die Gegenseite bleibt stehen
          const a0 = d.achse;
          const c0 = g.toS(a0.x, a0.y), th = tkFormRad(o, g);
          const dx = s[0] - c0[0], dy = s[1] - c0[1];
          const px = dx * Math.cos(-th) - dy * Math.sin(-th), py = dx * Math.sin(-th) + dy * Math.cos(-th);
          const achse = (sg, p, laenge) => {
            if (sg === 0) return [laenge, 0];
            const fest = (-sg * laenge) / 2;
            const neu = Math.max(2, Math.min(200, sg * (p - fest)));
            return [neu, fest + (sg * neu) / 2];
          };
          const [nw, cxl] = achse(a0.sx, px, a0.w);
          const [nh, cyl] = achse(a0.sy, py, a0.h);
          const cs = [c0[0] + cxl * Math.cos(th) - cyl * Math.sin(th), c0[1] + cxl * Math.sin(th) + cyl * Math.cos(th)];
          const [nx2, ny2] = g.toN(cs[0], cs[1]);
          o.w = nw; o.h = nh; o.x = nx2; o.y = ny2;
        }
      }
      dataRef.current = neu;
      setData(neu);
    } else if (d.kind === "verb") {
      setDraft((dr) => (dr ? { ...dr, ende: [nx, ny] } : dr));
    } else if (d.kind === "draw") {
      setDraft((dr) => {
        if (!dr) return dr;
        if (dr.art === "frei") {
          const l = dr.punkte[dr.punkte.length - 1];
          const [ax, ay] = g.toS(l[0], l[1]);
          if (Math.hypot(ax - s[0], ay - s[1]) < Math.max(0.5, g.W * 0.012)) return dr;
          return { ...dr, punkte: [...dr.punkte, [nx, ny]] };
        }
        const a = g.toS(dr.punkte[0][0], dr.punkte[0][1]);
        return { ...dr, punkte: [dr.punkte[0], [nx, ny]], bogen: d.bogen ? tkStandardBogen(a, s, g, d.seite) : undefined };
      });
    }
  };
  const onUp = (e) => {
    const d = dragRef.current;
    if (!d || d.pid !== e.pointerId) return;
    dragRef.current = null;
    try { svgRef.current.releasePointerCapture(e.pointerId); } catch (er) {}
    if (d.kind === "obj" || d.kind === "blick" || d.kind === "form" || d.kind === "bogen" || d.kind === "erase") {
      if (d.moved) {
        past.current.push(d.start);
        if (past.current.length > 80) past.current.shift();
        future.current = [];
        setDirty((n) => n + 1);
      }
    } else if (d.kind === "verb") {
      const s = punkt(e);
      const ziel = treffer(s);
      setDraft(null);
      if (ziel && ziel.id !== d.von && TK_VERBINDBAR.includes(ziel.art)) {
        aendern((nd, step) => {
          const idx = step.linien.findIndex((l) => l.art === "verbindung" && ((l.von === d.von && l.zu === ziel.id) || (l.von === ziel.id && l.zu === d.von)));
          if (idx >= 0) step.linien.splice(idx, 1);
          else step.linien.push({ id: uid(), art: "verbindung", von: d.von, zu: ziel.id, farbe });
        });
      }
    } else if (d.kind === "draw") {
      const dr = draft;
      setDraft(null);
      if (dr && dr.punkte.length >= 2) {
        const a = g.toS(dr.punkte[0][0], dr.punkte[0][1]);
        const b = g.toS(dr.punkte[dr.punkte.length - 1][0], dr.punkte[dr.punkte.length - 1][1]);
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= Math.max(2, g.W * 0.05)) {
          const id = uid();
          aendern((nd, step) => step.linien.push({ id, art: dr.art, farbe: dr.farbe, punkte: dr.punkte, ...(dr.bogen ? { bogen: dr.bogen } : {}) }));
          setSel({ typ: "l", id });
        }
      }
    }
  };
  const onCancel = () => { dragRef.current = null; setDraft(null); };

  const radiereBei = (s) => {
    const d = dragRef.current;
    const hit = treffer(s);
    let lhit = null;
    if (!hit) lhit = linienTreffer(s);
    if (!hit && !lhit) return;
    const nd = tkKopie(dataRef.current);
    const idx = schrittRef.current;
    if (hit) {
      for (let k = idx; k < nd.schritte.length; k++) {
        nd.schritte[k].objekte = nd.schritte[k].objekte.filter((o) => o.id !== hit.id);
        nd.schritte[k].linien = nd.schritte[k].linien.filter((l) => l.von !== hit.id && l.zu !== hit.id);
      }
    } else nd.schritte[idx].linien = nd.schritte[idx].linien.filter((l) => l.id !== lhit.id);
    if (d) d.moved = true;
    dataRef.current = nd;
    setData(nd);
    setSel(null);
  };
  const formationAnwenden = (rows, team) => {
    const wir = team === "wir";
    const arten = wir ? ["spieler", "torwart"] : ["gegner", "gegnertw"];
    const halb = dataRef.current.feld === "halb";
    const f5 = dataRef.current.feld === "f5";
    const slots = [];
    if (!halb) slots.push({ x: f5 ? 0.07 : 0.04, y: 0.5, gk: true });
    const x0 = halb ? 0.12 : f5 ? 0.24 : 0.17, x1 = halb ? 0.62 : f5 ? 0.44 : 0.43;
    rows.forEach((n, ri) => {
      const x = rows.length === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * ri) / (rows.length - 1);
      const stp = n > 1 ? Math.min(0.3, 0.64 / (n - 1)) : 0;
      for (let i = 0; i < n; i++) slots.push({ x, y: 0.5 + (i - (n - 1) / 2) * stp, gk: false });
    });
    aendern((nd, step, idx) => {
      const vorhanden = step.objekte.filter((o) => arten.includes(o.art));
      const benutzt = new Set();
      const imFeldIds = new Set(step.objekte.map((o) => o.spielerId).filter(Boolean));
      const kader = wir ? aktivePlayers.filter((q) => !imFeldIds.has(q.id)) : [];
      let nr = Math.max(0, ...vorhanden.map((o) => Number(o.nr) || 0));
      slots.forEach((sl) => {
        const px = wir ? sl.x : 1 - sl.x;
        const ok = (q) => !benutzt.has(q.id) && (q.art === arten[1]) === sl.gk;
        const o = vorhanden.find(ok);
        if (o) { benutzt.add(o.id); o.x = px; o.y = sl.y; return; }
        const neu = { id: uid(), x: px, y: sl.y };
        if (sl.gk) { neu.art = arten[1]; neu.nr = 1; }
        else if (wir && kader.length) { neu.art = "spieler"; neu.spielerId = kader.shift().id; }
        else { neu.art = arten[0]; neu.nr = ++nr; }
        for (let k = idx; k < nd.schritte.length; k++) nd.schritte[k].objekte.push(k === idx ? neu : { ...neu });
      });
    });
    setSel(null);
  };
  const hinzu = (o) => {
    const id = uid();
    aendern((nd, step, idx) => {
      const x = 0.5 + (Math.random() - 0.5) * 0.18, y = 0.5 + (Math.random() - 0.5) * 0.3;
      for (let k = idx; k < nd.schritte.length; k++) nd.schritte[k].objekte.push({ ...o, id, x: ["tor", "form"].includes(o.art) ? 0.5 : x, y: ["tor", "form"].includes(o.art) ? 0.5 : y });
    });
    setSel({ typ: "o", id });
    setTool("bewegen");
  };
  const naechsteNr = (art) => {
    const nr = st.objekte.filter((o) => o.art === art && !o.spielerId).map((o) => Number(o.nr) || 0);
    return Math.max(0, ...nr) + 1;
  };
  const loeschen = () => {
    if (!sel) return;
    aendern((nd, step, idx) => {
      if (sel.typ === "o") {
        for (let k = idx; k < nd.schritte.length; k++) {
          nd.schritte[k].objekte = nd.schritte[k].objekte.filter((o) => o.id !== sel.id);
          nd.schritte[k].linien = nd.schritte[k].linien.filter((l) => l.von !== sel.id && l.zu !== sel.id);
        }
      } else step.linien = step.linien.filter((l) => l.id !== sel.id);
    });
    setSel(null);
  };
  const objAendern = (fn) => {
    if (!sel || sel.typ !== "o") return;
    aendern((nd, step, idx) => {
      for (let k = idx; k < nd.schritte.length; k++) {
        const o = nd.schritte[k].objekte.find((q) => q.id === sel.id);
        if (o) fn(o);
      }
    });
  };
  const waehleFarbe = (f) => {
    setFarbe(f);
    if (sel && sel.typ === "l") aendern((nd, step) => { const l = step.linien.find((q) => q.id === sel.id); if (l) l.farbe = f; });
    else if (sel && sel.typ === "o") {
      const so = st.objekte.find((q) => q.id === sel.id);
      if (so && ["form", "reifen"].includes(so.art)) objAendern((o) => (o.farbe = f));
    }
  };
  const selObj = sel && sel.typ === "o" ? st.objekte.find((o) => o.id === sel.id) : null;
  const selLinie = sel && sel.typ === "l" ? st.linien.find((l) => l.id === sel.id) : null;

  const neuerSchritt = () =>
    aendern((nd, step, idx) => {
      const kopie = { objekte: tkKopie(step.objekte), linien: tkKopie(step.linien.filter((l) => l.art === "verbindung")) };
      ["pause", "dauer", "warten"].forEach((k) => { if (step[k] != null) kopie[k] = step[k]; });
      nd.schritte.splice(idx + 1, 0, kopie);
    }) || setSchritt(sIdx + 1);
  const schrittLoeschen = () => {
    if (data.schritte.length < 2) return;
    confirmAnd(`Schritt ${sIdx + 1} löschen?`, () => {
      aendern((nd, step, idx) => nd.schritte.splice(idx, 1));
      setSchritt(Math.max(0, sIdx - 1));
      setSel(null);
    });
  };

  const stoppen = () => { cancelAnimationFrame(rafRef.current); setAnim(null); };
  const abspielen = () => {
    if (dataRef.current.schritte.length < 2) return;
    setSel(null);
    setDraft(null);
    let i = sIdx >= dataRef.current.schritte.length - 1 ? 0 : sIdx;
    let phase = "hold";
    let t0 = performance.now();
    weiterRef.current = false;
    setSchritt(i);
    const loop = (now) => {
      const sch = dataRef.current.schritte;
      const n = sch.length;
      if (i > n - 1) i = n - 1;
      const stp = sch[i];
      const el = (now - t0) * tempoRef.current;
      if (phase === "hold") {
        const wait = !!stp.warten && i < n - 1;
        setAnim((p) => (p && p.hold && p.i === i && p.wait === wait ? p : { i, hold: true, wait }));
        if (wait ? weiterRef.current : el >= (stp.pause != null ? stp.pause : 0.6) * 1000) {
          weiterRef.current = false;
          if (i >= n - 1) {
            if (schleifeRef.current) { i = 0; t0 = now; setSchritt(0); }
            else { setAnim(null); setSchritt(n - 1); return; }
          } else { phase = "move"; t0 = now; }
        }
      } else {
        const dur = (stp.dauer != null ? stp.dauer : 1.7) * 1000;
        if (el < dur) setAnim({ i, t: el / dur });
        else { i++; phase = "hold"; t0 = now; setSchritt(i); }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  let objekte = st.objekte, linien = st.linien, linienOp = 1, anzSchritt = sIdx;
  if (anim) {
    const A = data.schritte[anim.i];
    if (anim.hold) {
      objekte = A.objekte;
      linien = A.linien;
      anzSchritt = anim.i;
    } else {
      const B = data.schritte[anim.i + 1];
      objekte = tkZwischen(A, B, anim.t);
      linien = A.linien;
      linienOp = 1 - Math.max(0, (anim.t - 0.6) / 0.4);
      anzSchritt = anim.t > 0.5 ? anim.i + 1 : anim.i;
    }
  }

  const toggleVoll = async () => {
    const neu = !voll;
    setVoll(neu);
    letzterStand.current = neu ? "fs" : null;
    try {
      if (neu && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else if (!neu && document.fullscreenElement) await document.exitFullscreen();
    } catch (e) {}
  };

  const exportPng = async () => {
    try {
      const svg = svgRef.current;
      const clone = svg.cloneNode(true);
      clone.querySelectorAll("[data-skip]").forEach((n) => n.remove());
      const bilder = Array.from(clone.querySelectorAll("image"));
      for (const im of bilder) {
        const url = im.getAttribute("href");
        try {
          const blob = await (await fetch(url)).blob();
          const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
          im.setAttribute("href", dataUrl);
        } catch (e) { im.remove(); }
      }
      const B = 1800;
      const H = Math.round((B * g.vbH) / g.vbW);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", B);
      clone.setAttribute("height", H);
      const xml = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml); });
      const c = document.createElement("canvas");
      c.width = B; c.height = H;
      c.getContext("2d").drawImage(img, 0, 0, B, H);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const dateiname = `${(name || "taktik").replace(/[^a-z0-9äöüß ]+/gi, "").trim() || "taktik"}.png`;
      const file = new File([blob], dateiname, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
      } else {
        const u = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = u; a.download = dateiname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 4000);
      }
      setExportiert(true);
      setTimeout(() => setExportiert(false), 2000);
    } catch (e) {
      if (!(e && e.name === "AbortError")) meldung("Das Bild konnte nicht erstellt werden.", "error");
    }
  };

  const chip = (an, extra) => ({ border: `1.5px solid ${an ? TK_ROT : "var(--border)"}`, background: an ? TK_ROT : "var(--surface)", color: an ? "#fff" : "var(--text)", borderRadius: 999, padding: "9px 14px", minHeight: 40, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", ...extra });
  const grp = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" };
  const trenner = <span aria-hidden="true" style={{ width: 1, alignSelf: "stretch", background: "var(--divider)", margin: "0 4px" }} />;
  const kachel = { ...styles.card, padding: 10 };
  const setz = (patch) => aendern((nd) => Object.assign(nd, patch));
  const imFeld = (pid) => st.objekte.some((o) => o.spielerId === pid);
  const [dialog, setDialog] = useState(null);
  const [gedreht, setGedreht] = useState(false);
  const [sheetOffen, setSheetOffen] = useState(false);
  const [trainingWahl, setTrainingWahl] = useState(false);
  const tb = React.useContext(TrainingBoardCtx);
  const anzTrainings = tb ? tb.links.filter((l) => l.boardId === board.id).length : 0;
  const [seitenTab, setSeitenTab] = useState("magnete");
  const hatAusw = !!(selObj || selLinie);
  useEffect(() => { if (hatAusw) setSeitenTab("auswahl"); else setSeitenTab((t) => (t === "auswahl" ? "magnete" : t)); }, [hatAusw]);
  const frage = (titel, wert, onOk, extra) => setDialog({ titel, wert, onOk, ...extra });

  // Ansicht: bei „gedreht“ (Notlösung ohne Sperre des Handys) sind Breite und Höhe vertauscht
  const eff = gedreht ? { b: fenster.h, h: fenster.b } : fenster;
  const effBreit = eff.b >= eff.h;
  const mobil = eff.b < 900;

  const querformat = async () => {
    const vorher = window.innerHeight > window.innerWidth;
    try {
      if (window.screen && screen.orientation && screen.orientation.lock) {
        await Promise.race([screen.orientation.lock(vorher ? "landscape" : "portrait"), new Promise((_, nein) => setTimeout(nein, 600))]);
        // Hat sich die Ansicht wirklich gedreht? Sonst (z. B. Emulator, iPhone) per Software drehen
        await new Promise((r) => setTimeout(r, 450));
        if ((window.innerHeight > window.innerWidth) !== vorher) { setGedreht(false); return; }
      }
    } catch (e) {}
    setGedreht((v) => !v);
  };
  useEffect(() => {
    if (voll) return;
    setGedreht(false);
    setSheetOffen(false);
    try { if (window.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  }, [voll]);

  const werkzeuge = [["bewegen", "Bewegen"], ["pass", "Pass"], ["lauf", "Laufweg"], ["welle", "Dribbling"], ["linie", "Linie"], ["frei", "Frei zeichnen"], ["verbinden", "Verbinden"], ["radieren", "Radierer"]];
  const formGroesse = { w: Math.round(g.W * 0.36), h: Math.round(g.W * 0.22), rot: 0, op: 0.3, farbe: farbe };
  const magnete = [
    ["Spieler", "spieler", () => hinzu({ art: "spieler", nr: naechsteNr("spieler") })],
    ["Torwart", "torwart", () => hinzu({ art: "torwart", nr: 1 })],
    ["Gegner", "gegner", () => hinzu({ art: "gegner", nr: naechsteNr("gegner") })],
    ["Gegner-TW", "gegnertw", () => hinzu({ art: "gegnertw", nr: 1 })],
    ["Ball", "ball", () => hinzu({ art: "ball" })],
    ["Hütchen gelb", ["huetchen", "#FFD84D"], () => hinzu({ art: "huetchen", farbe: "#FFD84D" })],
    ["Hütchen orange", ["huetchen", "#F28C28"], () => hinzu({ art: "huetchen", farbe: "#F28C28" })],
    ["Hütchen blau", ["huetchen", "#4DA3FF"], () => hinzu({ art: "huetchen", farbe: "#4DA3FF" })],
    ["Stange", "stange", () => hinzu({ art: "stange" })],
    ["Reifen", "reifen", () => hinzu({ art: "reifen", farbe: "#F28C28" })],
    ["Rechteck", "rechteck", () => hinzu({ art: "form", form: "rechteck", ...formGroesse })],
    ["Oval", "oval", () => hinzu({ art: "form", form: "oval", ...formGroesse })],
    ["Tor", "tor", () => hinzu({ art: "tor" })],
    ["Minitor", "minitor", () => hinzu({ art: "tor", klein: true })],
    ["Text", "text", () => frage("Text", "", (t) => { if (t && t.trim()) hinzu({ art: "text", text: t.trim() }); })],
  ];
  const linienWerkzeug = ["pass", "lauf", "welle", "linie"].includes(tool);

  /* ---- Einzelne Bedienelemente (in allen Layouts wiederverwendet) ---- */
  const bZurueck = <TkBtn icon="zurueck" titel="Zurück zu den Boards" onClick={schliessen} />;
  const bName = (
    <input value={name} onChange={(e) => { setName(e.target.value); setDirty((n) => n + 1); }} aria-label="Name des Boards"
      style={{ ...styles.input, flex: 1, minWidth: 0, height: 44, boxSizing: "border-box", fontSize: 15, fontWeight: 700, padding: "0 12px" }} />
  );
  const bUndo = <TkBtn key="undo" icon="undo" titel="Rückgängig" onClick={rueckgaengig} disabled={!past.current.length} />;
  const bRedo = <TkBtn key="redo" icon="redo" titel="Wiederholen" onClick={wiederholen} disabled={!future.current.length} />;
  const bTraining = nurLesen ? null : <TkBtn key="training" icon="kalender" titel={anzTrainings > 0 ? `Zu Training hinzufügen (in ${anzTrainings} Training${anzTrainings > 1 ? "s" : ""})` : "Zu Training hinzufügen"} aktiv={anzTrainings > 0 ? true : undefined} label={anzTrainings > 0 ? `Training (${anzTrainings})` : "Training"} onClick={() => setTrainingWahl(true)} />;
  const bBild = <TkBtn key="bild" icon="bild" titel={exportiert ? "Bild gespeichert" : "Als Bild speichern"} aktiv={exportiert ? true : undefined} onClick={exportPng} />;
  const bVoll = <TkBtn key="voll" icon={voll ? "vollAus" : "voll"} titel={voll ? "Vollbild beenden" : "Vollbild"} aktiv={voll} onClick={toggleVoll} />;
  const bPlay = anim ? (
    <React.Fragment key="play">
      <TkBtn icon="stop" titel="Stopp" aktiv onClick={stoppen} />
      {anim.wait && <TkBtn icon="weiter" titel="Weiter" onClick={() => (weiterRef.current = true)} style={{ borderColor: TK_ROT }} />}
    </React.Fragment>
  ) : (
    <TkBtn key="play" icon="play" titel="Abspielen" onClick={abspielen} disabled={data.schritte.length < 2} />
  );
  const bSchritte = [
    ...data.schritte.map((_, i) => (
      <TkBtn key={"s" + i} label={String(i + 1)} titel={`Schritt ${i + 1}`} aktiv={anzSchritt === i} onClick={() => { if (!anim) { setSchritt(i); setSel(null); } }} />
    )),
    <TkBtn key="s+" icon="plus" titel="Schritt hinzufügen" onClick={neuerSchritt} disabled={!!anim} />,
  ];
  const bWerkzeuge = werkzeuge.map(([k, l]) => (
    <TkBtn key={k} icon={k} titel={l} aktiv={tool === k} onClick={() => { setTool(k); if (k !== "bewegen") setSel(null); }} />
  ));
  const bBogen = linienWerkzeug ? [
    <TkBtn key="bg" icon="bogen" titel="Gebogen zeichnen" aktiv={bogenAn} onClick={() => setBogenAn(!bogenAn)} />,
    bogenAn && <TkBtn key="bgs" icon="tauschen" titel="Bogen-Seite tauschen" onClick={() => setBogenSeite(-bogenSeite)} />,
  ] : null;
  const bFarben = TK_FARBEN.map(([f, l]) => (
    <button key={f} type="button" aria-label={l} title={l} aria-pressed={farbe === f} onClick={() => waehleFarbe(f)}
      style={{ width: 36, height: 36, borderRadius: 999, background: f, cursor: "pointer", flex: "none", border: farbe === f ? `3px solid ${TK_ROT}` : "2px solid var(--border-strong)", padding: 0 }} />
  ));

  /* ---- Kacheln ---- */
  const inhaltFeld = (
    <>
      <div style={grp}>
        {Object.entries(TK_FELDER).map(([k, f]) => (
          <TkBtn key={k} icon={k} titel={f.label} aktiv={data.feld === k} onClick={() => setz({ feld: k })} />
        ))}
        {trenner}
        <TkBtn icon="quer" titel="Quer" aktiv={data.ausr === "quer"} onClick={() => setz({ ausr: "quer" })} />
        <TkBtn icon="hoch" titel="Hoch" aktiv={data.ausr === "hoch"} onClick={() => setz({ ausr: "hoch" })} />
        {trenner}
        <TkBtn icon="zonen" titel="Zonen" aktiv={!!data.zonen} onClick={() => setz({ zonen: !data.zonen })} />
        <TkBtn icon="hell" titel="Helles Feld" aktiv={!!data.hell} onClick={() => setz({ hell: !data.hell })} />
        {trenner}
        <TkBtn icon="nummern" titel="Nummern anzeigen" aktiv={data.anzeige === "nummer"} onClick={() => setz({ anzeige: "nummer" })} />
        <TkBtn icon="foto" titel="Fotos anzeigen" aktiv={data.anzeige === "foto"} onClick={() => setz({ anzeige: "foto" })} />
        <TkBtn icon="text" titel="Namen anzeigen" aktiv={!!data.namen} onClick={() => setz({ namen: !data.namen })} />
        {trenner}
        {[[0.8, "groesseS", "Spieler klein"], [1, "groesseM", "Spieler mittel"], [1.3, "groesseL", "Spieler groß"]].map(([v, ic, t]) => (
          <TkBtn key={ic} icon={ic} titel={t} aktiv={(data.groesse || 1) === v} onClick={() => setz({ groesse: v })} />
        ))}
      </div>
    </>
  );
  const cFeld = (
    <div style={kachel}>
      <KartenTitel zuStart={mobil}>Feld und Anzeige</KartenTitel>
      {inhaltFeld}
    </div>
  );

  const inhaltZeichnen = (
    <>
      <div style={grp}>
        {bWerkzeuge}
        {linienWerkzeug && trenner}
        {bBogen}
        {trenner}
        {bFarben}
      </div>
    </>
  );
  const cZeichnen = (
    <div style={kachel}>
      <KartenTitel>Zeichnen</KartenTitel>
      {inhaltZeichnen}
    </div>
  );

  const inhaltAusw = selObj || selLinie ? (
    <>
      <div style={grp}>
        {selObj && ["spieler", "gegner", "torwart", "gegnertw"].includes(selObj.art) && !selObj.spielerId && (
          <>
            <TkBtn icon="nummer" titel="Nummer ändern" onClick={() => frage("Nummer", selObj.nr != null ? String(selObj.nr) : "", (v) => objAendern((o) => (o.nr = v.trim())), { zahl: true })} />
            <TkBtn icon="name" titel="Name ändern" onClick={() => frage("Name (optional)", selObj.name || "", (v) => objAendern((o) => (o.name = v.trim())))} />
          </>
        )}
        {selObj && ["spieler", "torwart"].includes(selObj.art) && (
          <TkBtn icon="torwart" titel={selObj.art === "torwart" ? "Zum Feldspieler machen" : "Zum Torwart machen"} aktiv={selObj.art === "torwart"} onClick={() => objAendern((o) => (o.art = o.art === "torwart" ? "spieler" : "torwart"))} />
        )}
        {selObj && ["gegner", "gegnertw"].includes(selObj.art) && (
          <TkBtn icon="torwart" titel={selObj.art === "gegnertw" ? "Zum Feldspieler machen" : "Zum Torwart machen"} aktiv={selObj.art === "gegnertw"} onClick={() => objAendern((o) => (o.art = o.art === "gegnertw" ? "gegner" : "gegnertw"))} />
        )}
        {selObj && TK_SPIELERART.includes(selObj.art) && (
          <TkBtn icon="blick" titel="Blickrichtung" aktiv={selObj.blick != null} onClick={() => objAendern((o) => { if (o.blick != null) delete o.blick; else o.blick = 0; })} />
        )}
        {selObj && selObj.art === "tor" && <TkBtn icon="drehen" titel="Drehen" onClick={() => objAendern((o) => (o.rot = ((o.rot || 0) + 90) % 180))} />}
        {selObj && selObj.art === "stange" && <TkBtn icon="drehen" titel="Drehen" onClick={() => objAendern((o) => (o.rot = ((o.rot || 0) + 45) % 180))} />}
        {selObj && selObj.art === "form" && (
          <>
            <TkBtn icon="drehen" titel="Drehen" onClick={() => objAendern((o) => (o.rot = ((o.rot || 0) + 15) % 180))} />
            <TkBtn icon="deckkraft" titel={`Deckkraft ${Math.round((selObj.op != null ? selObj.op : 0.3) * 100)} % (tippen zum Ändern)`} label={`${Math.round((selObj.op != null ? selObj.op : 0.3) * 100)} %`}
              onClick={() => objAendern((o) => { const w = [0, 0.15, 0.3, 0.5, 0.75]; const i = w.findIndex((x) => Math.abs(x - (o.op != null ? o.op : 0.3)) < 0.01); o.op = w[(i + 1) % w.length]; })} />
          </>
        )}
        {selLinie && selLinie.art !== "verbindung" && selLinie.art !== "frei" && (
          <TkBtn icon="bogen" titel="Gebogen" aktiv={!!selLinie.bogen} onClick={() => aendern((nd, step) => {
            const l = step.linien.find((q) => q.id === selLinie.id);
            if (!l) return;
            if (l.bogen) delete l.bogen;
            else l.bogen = tkStandardBogen(g.toS(l.punkte[0][0], l.punkte[0][1]), g.toS(l.punkte[l.punkte.length - 1][0], l.punkte[l.punkte.length - 1][1]), g);
          })} />
        )}
        {selLinie && selLinie.bogen && (
          <TkBtn icon="tauschen" titel="Bogen umdrehen" onClick={() => aendern((nd, step) => {
            const l = step.linien.find((q) => q.id === selLinie.id);
            if (!l) return;
            const a = l.punkte[0], b = l.punkte[l.punkte.length - 1];
            l.bogen = [a[0] + b[0] - l.bogen[0], a[1] + b[1] - l.bogen[1]];
          })} />
        )}
        {selObj && selObj.art === "text" && <TkBtn icon="text" titel="Text ändern" onClick={() => frage("Text", selObj.text || "", (v) => { if (v && v.trim()) objAendern((o) => (o.text = v.trim())); })} />}
        {selObj && selObj.art === "reifen" && (
          <>
            <TkBtn label="−" titel="Reifen kleiner" disabled={(selObj.sk || 1) <= 0.5} onClick={() => objAendern((o) => (o.sk = Math.max(0.5, Math.round(((o.sk || 1) - 0.25) * 100) / 100)))} />
            <TkBtn label="+" titel="Reifen größer" disabled={(selObj.sk || 1) >= 3} onClick={() => objAendern((o) => (o.sk = Math.min(3, Math.round(((o.sk || 1) + 0.25) * 100) / 100)))} />
          </>
        )}
        <TkBtn icon="loeschen" titel="Löschen" gefahr onClick={loeschen} />
      </div>
      {selObj && selObj.art === "form" && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>Form ändern: gelbe Ecken = Breite und Höhe, weiße Punkte an den Seiten = nur diese Seite verschieben. Farbe: unter „Zeichnen“.</div>}
      {selObj && selObj.art === "reifen" && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>Größe: − / +. Farbe: unter „Zeichnen“.</div>}
      {selLinie && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>Farbe: unter „Zeichnen“.</div>}
    </>
  ) : null;
  const cAusw = inhaltAusw ? (
    <div style={kachel}>
      <KartenTitel>Ausgewählt</KartenTitel>
      {inhaltAusw}
    </div>
  ) : null;

  const inhaltMagnete = (
    <>
      <div style={grp}>
        {magnete.map(([l, ic, fn]) => (
          <TkMagnetKachel key={l} titel={l} onClick={fn}>
            {Array.isArray(ic) ? TK_MAGNET_ICON[ic[0]](ic[1]) : TK_MAGNET_ICON[ic]}
          </TkMagnetKachel>
        ))}
      </div>
    </>
  );
  const cMagnete = (
    <div style={kachel}>
      <KartenTitel>Magnete</KartenTitel>
      {inhaltMagnete}
    </div>
  );

  const inhaltFormation = (
    <>
      <div style={{ ...grp, marginBottom: 8 }}>
        <TkBtn label="Wir" size={36} aktiv={fTeam === "wir"} onClick={() => setFTeam("wir")} />
        <TkBtn label="Gegner" size={36} aktiv={fTeam === "gegner"} onClick={() => setFTeam("gegner")} />
      </div>
      <div style={grp}>
        {(data.feld === "f5"
          ? [["2-2", [2, 2]], ["1-2-1", [1, 2, 1]], ["1-3", [1, 3]], ["3-1", [3, 1]]]
          : [["2-3-1", [2, 3, 1]], ["3-2-1", [3, 2, 1]], ["2-2-2", [2, 2, 2]], ["4-4-2", [4, 4, 2]], ["4-3-3", [4, 3, 3]], ["3-5-2", [3, 5, 2]]]
        ).map(([l, rows]) => (
          <TkBtn key={l} label={l} size={38} onClick={() => formationAnwenden(rows, fTeam)} />
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>Stellt vorhandene Spieler auf, fehlende kommen aus dem Kader dazu.</div>
    </>
  );
  const cFormation = (
    <div style={kachel}>
      <KartenTitel zuStart={mobil}>Formation</KartenTitel>
      {inhaltFormation}
    </div>
  );

  const inhaltMannschaft = aktivePlayers.length > 0 ? (
    <>
      <div style={grp}>
        {aktivePlayers.map((p) => {
          const da = imFeld(p.id);
          return (
            <TkBtn key={p.id} size={38} disabled={da} onClick={() => hinzu({ art: "spieler", spielerId: p.id })}
              label={`${p.trikotnummer != null ? p.trikotnummer + " " : ""}${tkVorname(p.name)}`} />
          );
        })}
      </div>
    </>
  ) : null;
  const cMannschaft = inhaltMannschaft ? (
    <div style={kachel}>
      <KartenTitel zuStart={mobil}>Mannschaft</KartenTitel>
      {inhaltMannschaft}
    </div>
  ) : null;

  const inhaltSchritte = (
    <>
      <div style={grp}>
        {bSchritte}
        {data.schritte.length > 1 && <TkBtn icon="loeschen" titel="Schritt löschen" gefahr onClick={schrittLoeschen} disabled={!!anim} />}
        {trenner}
        {bPlay}
        {data.schritte.length > 1 && (
          <>
            <TkBtn icon="wiederholen" titel="Wiederholen" aktiv={schleife} onClick={() => setSchleife(!schleife)} />
            {[0.5, 1, 2].map((v) => (
              <TkBtn key={v} label={`${String(v).replace(".", ",")}×`} titel={`Tempo ${String(v).replace(".", ",")}×`} aktiv={tempo === v} onClick={() => setTempo(v)} />
            ))}
          </>
        )}
      </div>
      {data.schritte.length < 2 && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>Mit „+“ den nächsten Moment anlegen und die Magnete neu stellen, dann abspielen.</div>}
      {data.schritte.length > 1 && (
        <div style={{ ...grp, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--divider)" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Schritt {sIdx + 1}:</span>
          {(() => {
            const fmt = (v) => v.toFixed(1).replace(".", ",") + " s";
            const stufe = (feld, std, min, max, label) => {
              const v = st[feld] != null ? st[feld] : std;
              const set = (nv) => aendern((nd, step) => { step[feld] = Math.round(Math.max(min, Math.min(max, nv)) * 10) / 10; });
              return (
                <span key={feld} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 13 }}>{label}</span>
                  <TkBtn label="−" size={38} titel={label + " kürzer"} onClick={() => set(v - 0.5)} />
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 48, textAlign: "center" }}>{fmt(v)}</span>
                  <TkBtn label="+" size={38} titel={label + " länger"} onClick={() => set(v + 0.5)} />
                </span>
              );
            };
            const letzter = sIdx >= data.schritte.length - 1;
            return (
              <>
                {!st.warten && stufe("pause", 0.6, 0, 60, "Pause")}
                <TkBtn icon="warten" titel={letzter ? "Beim letzten Schritt nicht nötig" : "Warten auf Tipp"} aktiv={!!st.warten} disabled={letzter} onClick={() => aendern((nd, step) => { step.warten = !step.warten; })} />
                {!letzter && stufe("dauer", 1.7, 0.5, 20, "Bewegung")}
              </>
            );
          })()}
        </div>
      )}
    </>
  );
  const cSchritte = (
    <div style={kachel}>
      <KartenTitel>Schritte und Animation</KartenTitel>
      {inhaltSchritte}
    </div>
  );

  const dialogEl = (
    <>
      {dialog ? <TkDialog dialog={dialog} onClose={() => setDialog(null)} /> : null}
      {trainingWahl ? <TkTrainingWahl board={board} onClose={() => setTrainingWahl(false)} /> : null}
    </>
  );
  const statusEl = status ? <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: -2 }}>{status}</div> : null;
  const brettEl = (stil) => (
    <div style={stil}>
      <TkBrett data={data} g={g} players={players} objekte={objekte} linien={linien} linienOp={linienOp} selId={sel ? sel.id : null}
        draft={draft} svgRef={svgRef}
        handlers={nurLesen ? undefined : { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onCancel }} />
    </div>
  );
  const kopfEl = (
    <div style={{ ...grp, flexWrap: "nowrap" }}>
      {bZurueck}
      {bName}
      {bUndo}
      {bRedo}
      {bTraining}
      {bBild}
      {bVoll}
    </div>
  );

  /* ---- Nur ansehen (Training): Brett, Schritte, Abspielen ---- */
  if (nurLesen) {
    const verhL = g.vbW / g.vbH;
    const rootL = voll
      ? { position: "fixed", inset: 0, zIndex: 1400, background: "var(--bg)", display: "flex", flexDirection: "column", padding: "8px 10px 24px", gap: 8, overflow: "auto" }
      : { display: "flex", flexDirection: "column", gap: 8, paddingBottom: 16 };
    return (
      <div style={rootL}>
        <div style={{ ...grp, flexWrap: "nowrap" }}>
          {bZurueck}
          <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
          <TkBtn icon={voll ? "vollAus" : "voll"} titel={voll ? "Vollbild beenden" : "Vollbild"} label={voll ? "Beenden" : "Vollbild"} aktiv={voll} onClick={toggleVoll} style={{ padding: "0 14px" }} />
        </div>
        {brettEl({ width: `min(100%, calc(${voll ? "(100vh - 190px)" : "68vh"} * ${verhL}))`, aspectRatio: `${g.vbW} / ${g.vbH}`, margin: "0 auto", flex: "none" })}
        <div style={{ ...kachel, padding: 8 }}>
          <div style={grp}>
            {data.schritte.map((_, i) => (
              <TkBtn key={i} label={String(i + 1)} titel={`Schritt ${i + 1}`} aktiv={anzSchritt === i} onClick={() => { if (!anim) setSchritt(i); }} />
            ))}
            {data.schritte.length > 1 && (
              <>
                {trenner}
                {bPlay}
                <TkBtn icon="wiederholen" titel="Wiederholen" aktiv={schleife} onClick={() => setSchleife(!schleife)} />
                {[0.5, 1, 2].map((v) => (
                  <TkBtn key={v} label={`${String(v).replace(".", ",")}×`} titel={`Tempo ${String(v).replace(".", ",")}×`} aktiv={tempo === v} onClick={() => setTempo(v)} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ---- Vollbild am Handy: Brett füllt den Bildschirm, Werkzeuge in Leisten und einem Fenster von unten/rechts ---- */
  if (voll && mobil) {
    const rootV = {
      position: "fixed", zIndex: 1000, background: "var(--bg)", display: "flex", gap: 6, boxSizing: "border-box",
      flexDirection: effBreit ? "row" : "column",
      padding: "max(6px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left))",
      overflow: "hidden",
      ...(gedreht
        ? { top: 0, left: 0, width: window.innerHeight, height: window.innerWidth, transformOrigin: "0 0", transform: `translateX(${window.innerWidth}px) rotate(90deg)` }
        : { inset: 0 }),
    };
    const leiste = { display: "flex", gap: 6, alignItems: "center", flex: "none", overflowX: "auto", overflowY: "hidden" };
    const umbruch = <span aria-hidden="true" style={{ flexBasis: "100%", height: 0 }} />;
    const bMehr = <TkBtn key="mehr" icon="mehr" titel="Magnete und weitere Einstellungen" aktiv={sheetOffen} onClick={() => setSheetOffen((v) => !v)} />;
    const bDrehen = <TkBtn key="dreh" icon="handydrehen" titel="Ansicht drehen" onClick={querformat} />;
    const steuer = [bVoll, bDrehen, bUndo, bRedo, bPlay, ...bSchritte, bMehr];
    const werkzeugeLeiste = [...bWerkzeuge, ...(bBogen || []), ...bFarben];
    return (
      <div style={rootV}>
        {dialogEl}
        {effBreit ? (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignContent: "flex-start", width: 100, flex: "none", overflowY: "auto" }}>
              {steuer}
              {umbruch}
              {werkzeugeLeiste}
            </div>
            {brettEl({ flex: 1, minWidth: 0, minHeight: 0 })}
          </>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 8 }}>
            <div className="nz-leiste" style={leiste}>{steuer}</div>
            {brettEl({ width: "100%", aspectRatio: `${g.vbW} / ${g.vbH}`, maxHeight: eff.h - 150, flex: "none" })}
            <div className="nz-leiste" style={leiste}>{werkzeugeLeiste}</div>
          </div>
        )}
        {sheetOffen && (
          <div style={{
            position: "absolute", zIndex: 1100, background: "var(--bg)", overflowY: "auto", padding: 10, boxSizing: "border-box",
            display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 -6px 24px rgba(0,0,0,0.25)",
            ...(effBreit
              ? { top: 0, bottom: 0, right: 0, width: "min(420px, 55%)" }
              : { left: 0, right: 0, bottom: 0, maxHeight: "62%", borderTopLeftRadius: 16, borderTopRightRadius: 16 }),
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 17, fontWeight: 600 }}>Werkzeuge</span>
              <TkBtn icon="schliessen" titel="Schließen" size={40} onClick={() => setSheetOffen(false)} />
            </div>
            {cAusw}
            {cMagnete}
            {cSchritte}
            {cFeld}
            {cFormation}
            {cMannschaft}
          </div>
        )}
      </div>
    );
  }

  /* ---- Handy (nicht Vollbild): Brett zuerst, danach die Kacheln untereinander ---- */
  if (mobil) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 24 }}>
        {dialogEl}
        <div style={{ ...grp, flexWrap: "nowrap" }}>{bZurueck}{bName}</div>
        <div style={{ ...grp, flexWrap: "nowrap" }}>
          {bUndo}
          {bRedo}
          <span style={{ flex: 1 }} />
          {bTraining}
          {bBild}
          {bVoll}
        </div>
        {statusEl}
        {brettEl({ width: `min(100%, calc(55vh * ${g.vbW / g.vbH}))`, aspectRatio: `${g.vbW} / ${g.vbH}`, margin: "0 auto", flex: "none" })}
        {cZeichnen}
        {cAusw}
        {cSchritte}
        {cMagnete}
        {cFeld}
        {cFormation}
        {cMannschaft}
      </div>
    );
  }

  /* ---- Tablet/Desktop: schmale Werkzeugzeile, Brett mit Zeitleiste, Seitenleiste mit Reitern ---- */
  const root = voll
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "var(--bg)", display: "flex", flexDirection: "column", padding: "8px 10px 24px", gap: 8, overflow: "auto" }
    : { display: "flex", flexDirection: "column", gap: 8, minHeight: 560, paddingBottom: 16 };
  const verh = g.vbW / g.vbH;
  const brettHoehe = voll ? "(100vh - 330px)" : "72vh";
  const tabKnopf = (k, l) => (
    <button key={k} type="button" onClick={() => setSeitenTab(k)} aria-pressed={seitenTab === k}
      aria-pressed={!!(seitenTab === k)} style={{ ...styles.segBtn, ...(seitenTab === k ? styles.segBtnActive : {}) }}>{l}</button>
  );
  const seitenInhalt = seitenTab === "auswahl" && inhaltAusw ? inhaltAusw
    : seitenTab === "aufstellung" ? (
      <>
        <div>
          <KartenTitel block>Formation</KartenTitel>
          {inhaltFormation}
        </div>
        {inhaltMannschaft && (
          <div style={{ marginTop: 8 }}>
            <KartenTitel block>Mannschaft</KartenTitel>
            {inhaltMannschaft}
          </div>
        )}
      </>
    ) : inhaltMagnete;
  return (
    <div style={root}>
      {dialogEl}
      {kopfEl}
      {statusEl}
      <div style={{ ...kachel, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        {inhaltZeichnen}
        {inhaltFeld}
      </div>
      <div style={{ display: "flex", flexDirection: "row", gap: 10, flex: "none", minHeight: 0, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {brettEl({ width: `min(100%, calc(${brettHoehe} * ${verh}))`, aspectRatio: `${g.vbW} / ${g.vbH}`, margin: "0 auto", flex: "none" })}
          <div style={{ ...kachel, padding: 8 }}>{inhaltSchritte}</div>
        </div>
        <div style={{ ...kachel, width: 290, flex: "none", maxHeight: "min(80vh, 820px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...styles.segNav, marginBottom: 0 }}>
            {inhaltAusw && tabKnopf("auswahl", "Auswahl")}
            {tabKnopf("magnete", "Magnete")}
            {tabKnopf("aufstellung", "Aufstellung")}
          </div>
          {seitenInhalt}
        </div>
      </div>
    </div>
  );
}

function TaktikTab({ boards, fehlt, players, onSave, onDelete, onDuplicate }) {
  const [offenId, setOffenId] = useState(null);
  const aktiv = boards.find((b) => b.id === offenId);
  if (fehlt) {
    return (
      <div style={styles.card}>
        <KartenTitel>Taktik-Board einrichten</KartenTitel>
        <div style={{ fontSize: 13.5, marginBottom: 8 }}>Für die Boards fehlt noch eine Tabelle. Bitte einmal in Supabase (SQL Editor) ausführen, danach die Seite neu laden:</div>
        <pre style={{ fontSize: 11.5, whiteSpace: "pre-wrap", margin: 0, userSelect: "all" }}>{SQL_TAKTIK}</pre>
      </div>
    );
  }
  if (aktiv) return <TaktikEditor key={aktiv.id} board={aktiv} players={players} onSave={onSave} onClose={() => setOffenId(null)} />;
  const neu = async () => {
    const b = { id: uid(), name: "Neues Board", data: tkNeuesBoard() };
    await onSave(b, true);
    setOffenId(b.id);
  };
  const liste = boards.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return (
    <div style={styles.card}>
      <KartenTitel aktion={<TkBtn icon="plus" label="Neues Board" size={44} onClick={neu} />}>Taktik-Boards</KartenTitel>
      {liste.length === 0 && <EmptyState text="Noch kein Board angelegt. Mit „Neues Board“ geht es los." />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
        {liste.map((b) => {
          const d = tkNormalisiere(b.data);
          const g = tkGeo(d);
          const s0 = d.schritte[0];
          return (
            <div key={b.id} style={{ ...styles.card, padding: 10 }}>
              <button onClick={() => setOffenId(b.id)} aria-label={`Board „${b.name}“ öffnen`} style={{ display: "block", width: "100%", border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "inherit" }}>
                <div style={{ height: 150 }}>
                  <TkBrett data={d} g={g} players={players} objekte={s0.objekte} linien={s0.linien} nurAnzeige />
                </div>
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <button onClick={() => setOffenId(b.id)} style={{ flex: 1, minWidth: 0, minHeight: 44, border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "inherit" }}>
                  <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    {(TK_FELDER[d.feld] || TK_FELDER.f5).label} · {d.ausr === "hoch" ? "hoch" : "quer"} · {d.schritte.length} {d.schritte.length === 1 ? "Schritt" : "Schritte"}
                  </div>
                </button>
                <TkBtn icon="kopieren" titel="Duplizieren" size={44} onClick={() => onDuplicate(b)} />
                <TkBtn icon="loeschen" titel="Löschen" size={44} gefahr onClick={() => confirmAnd(`Board „${b.name}“ löschen?`, () => onDelete(b.id))} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


/* ---------- Wechsel zwischen Teams, Administration und Trainer-App (nur Admin-Codes) ---------- */

/* Links bleiben auf demselben Host, weil der Zugangscode im localStorage pro Host liegt (kein erneutes Anmelden).
   Nur von admin.nachspielzeit.app geht es auf den Trainer-Host (u8.…), dort ist eine neue Anmeldung nötig. */
const trainerUrl = (teamId) => {
  const q = "?team=" + encodeURIComponent(teamId);
  return /^admin\./i.test(window.location.hostname) ? "https://" + window.location.hostname.replace(/^admin\./i, "u8.") + "/" + q : "/" + q;
};

function TeamWechsler() {
  const istAdmin = !!Sitzung.info && !Sitzung.info.team_id;
  const [offen, setOffen] = useState(false);
  const [pos, setPos] = useState(null); // Menü liegt fest im Fenster, weil die Kopfzeile abschneidet (overflow: hidden)
  const [teams, setTeams] = useState(null);
  const knopfRef = useRef(null);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!istAdmin) return;
    let weg = false;
    dbSelect("teams")
      .then((rows) => !weg && setTeams(rows.filter((t) => !t.archived || t.id === Sitzung.team).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))))
      .catch(() => !weg && setTeams([]));
    return () => { weg = true; };
  }, [istAdmin]);
  useEffect(() => {
    if (!offen) return;
    const taste = (e) => { if (e.key === "Escape") { setOffen(false); knopfRef.current && knopfRef.current.focus(); } };
    const daneben = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOffen(false); };
    const zu = () => setOffen(false);
    document.addEventListener("keydown", taste);
    document.addEventListener("mousedown", daneben);
    window.addEventListener("scroll", zu, true);
    window.addEventListener("resize", zu);
    return () => { document.removeEventListener("keydown", taste); document.removeEventListener("mousedown", daneben); window.removeEventListener("scroll", zu, true); window.removeEventListener("resize", zu); };
  }, [offen]);
  const umschalten = () => {
    if (!offen && knopfRef.current) {
      const r = knopfRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    }
    setOffen((o) => !o);
  };
  if (!istAdmin) return null;
  const liste = teams && teams.length > 0 ? teams : [{ id: Sitzung.team, name: Sitzung.team.toUpperCase() }];
  const aktuell = liste.find((t) => t.id === Sitzung.team) || { name: Sitzung.team.toUpperCase() };
  const eintrag = { display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 12px", borderRadius: 8, color: "var(--text)", textDecoration: "none", fontSize: 14, fontWeight: 500 };
  return (
    <div ref={boxRef} className="nz-wechsler" style={{ position: "relative", flexShrink: 0 }}>
      <button ref={knopfRef} type="button" style={styles.logoutBtn} aria-expanded={offen} aria-controls="nsz-wechsler" onClick={umschalten}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 7h13" /><path d="m16 3 4 4-4 4" /><path d="M17 17H4" /><path d="m8 13-4 4 4 4" /></svg>
        <span className="nz-sr">Team wechseln, aktuell </span><span title={aktuell.name} style={{ maxWidth: 56, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{aktuell.name}</span>
      </button>
      {offen && pos && (
        <div id="nsz-wechsler" style={{ position: "fixed", right: pos.right, top: pos.top, zIndex: 40, minWidth: 210, background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--sh-3)", padding: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", padding: "8px 12px 4px" }}>Team wechseln</div>
          {liste.map((t) => {
            const istJetzt = t.id === Sitzung.team;
            return (
              <a key={t.id} href={"/?team=" + encodeURIComponent(t.id)} aria-current={istJetzt ? "true" : undefined} style={{ ...eintrag, fontWeight: istJetzt ? 700 : 500 }}>
                <span style={{ width: 16, color: "var(--accent-text)" }} aria-hidden="true">{istJetzt ? "✓" : ""}</span>
                {t.name}
              </a>
            );
          })}
          <div style={{ borderTop: "1px solid var(--border)", margin: "6px 0" }} />
          <a href="/?admin=1" style={eintrag}>
            <span style={{ width: 16 }} aria-hidden="true" />
            Administration
          </a>
        </div>
      )}
    </div>
  );
}

/* ---------- Header ---------- */

function Header({ tab, setTab }) {
  const fEntwicklung = useFeature("entwicklung");
  const fSpieltage = useFeature("spieltage");
  const fTaktik = useFeature("taktik");
  const items = [
    ["dashboard", "Home"],
    ["training", "Training bewerten"],
    fEntwicklung && ["entwicklung", "Monatsentwicklung"],
    fSpieltage && ["spieltage", "Spieltage"],
    fTaktik && ["taktik", "Taktik"],
    ["verwaltung", "Setup"],
  ].filter(Boolean);
  const NAV_KURZ = { dashboard: "Home", training: "Bewerten", entwicklung: "Verlauf", spieltage: "Spieltage", taktik: "Taktik", verwaltung: "Setup" };
  const NAV_ICON = {
    dashboard: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></>,
    training: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="m9.5 13 2 2 3.5-4" /></>,
    entwicklung: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
    spieltage: <><path d="M8 4h8v5a4 4 0 0 1-8 0z" /><path d="M8 6H4v1a4 4 0 0 0 4 4" /><path d="M16 6h4v1a4 4 0 0 1-4 4" /><path d="M12 13v4" /><path d="M8 20h8" /></>,
    taktik: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></>,
    verwaltung: <><path d="M4 7h10" /><path d="M18 7h2" /><circle cx="16" cy="7" r="2" /><path d="M4 17h2" /><path d="M10 17h10" /><circle cx="8" cy="17" r="2" /></>,
  };
  const navRef = useRef(null);
  const [scrollFade, setScrollFade] = useState({ left: false, right: false });

  const updateFade = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setScrollFade({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < maxScroll - 2,
    });
  }, []);

  useEffect(() => {
    updateFade();
    const el = navRef.current;
    if (!el) return;
    const onResize = () => updateFade();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateFade]);

  const maskStops = scrollFade.left && scrollFade.right
    ? "linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)"
    : scrollFade.left
    ? "linear-gradient(to right, transparent 0%, black 8%, black 100%)"
    : scrollFade.right
    ? "linear-gradient(to right, black 92%, transparent 100%)"
    : "none";

  return (
    <header className="app-header" style={styles.header}>
      <div className="nz-kopf-oben" style={styles.headerTop}>
        <img src={CLUB.logo} alt={CLUB.name} style={styles.crestImg} />
        <div style={{ flex: 1 }}>
          <div style={styles.title}>Nachspielzeit</div>
          <div style={styles.subtitle}>{CLUB.name} · Saison {aktuelleSaisonLabel()}</div>
        </div>
        <TeamWechsler />
        <button
          className="nz-abmelden"
          aria-label="Abmelden"
          style={styles.logoutBtn}
          onClick={() => {
            Sitzung.vergiss();
            window.location.reload();
          }}
        >
          <LogoutIcon size={13} />
          <span className="nz-abmelden-text">Abmelden</span>
        </button>
      </div>
      <nav
        ref={navRef}
        className="nav-top"
        style={{ ...styles.nav, WebkitMaskImage: maskStops, maskImage: maskStops }}
        onScroll={updateFade}
      >
        {items.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{ ...styles.navBtn, ...(tab === key ? styles.navBtnActive : {}) }}
          >
            {label}
          </button>
        ))}
      </nav>
      <nav className="nav-bottom" aria-label="Hauptnavigation" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
        {items.map(([key, label]) => (
          <button key={key} onClick={() => { setTab(key); window.scrollTo(0, 0); }} aria-current={tab === key ? "page" : undefined}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{NAV_ICON[key]}</svg>
            <span>{NAV_KURZ[key] || label}</span>
          </button>
        ))}
      </nav>
    </header>
  );
}

function BackupHinweis({ config }) {
  const tage = EINST.backupTage;
  const letztes = config && config.letztes_backup ? new Date(config.letztes_backup) : null;
  const heute = todayISO();
  const key = `nsz_backup_hint_${heute}`;
  const [weg, setWeg] = useState(() => { try { return localStorage.getItem(key) === "1"; } catch { return false; } });
  if (!tage || weg) return null;
  // Nur Admin-Codes (ohne Team) können Backups machen – andere Trainer sehen den Hinweis nicht
  if (!Sitzung.info || Sitzung.info.team_id) return null;
  const alter = letztes ? Math.floor((Date.now() - letztes.getTime()) / 86400000) : null;
  if (alter !== null && alter < tage) return null;
  return (
    <div style={styles.seasonHint}>
      <span>
        {alter === null ? "Es gibt noch kein Backup." : `Das letzte Backup ist ${alter} ${alter === 1 ? "Tag" : "Tage"} alt.`} Bitte unter admin.nachspielzeit.app → Backup eine Sicherung erstellen.
      </span>
      <button style={styles.linkBtn} onClick={() => { try { localStorage.setItem(key, "1"); } catch {} setWeg(true); }}>Heute nicht mehr</button>
    </div>
  );
}

function SaisonwechselHinweis({ seasons }) {
  const heute = new Date();
  const monatNr = heute.getMonth() + 1;
  const jahr = heute.getFullYear();
  const inPause = monatNr > SAISON.ende && monatNr < SAISON.start;
  const zeigenGrundsaetzlich = inPause || monatNr === SAISON.start;
  const neueSaison = inPause ? `${jahr}-${jahr + 1}` : seasonKeyOf(monthKey(heute));
  const storageKey = `nsz_season_hint_${neueSaison}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  const hatSchonDaten = neueSaison && seasons.includes(neueSaison);
  if (!zeigenGrundsaetzlich || !neueSaison || hatSchonDaten || dismissed) return null;

  return (
    <div style={styles.seasonHint}>
      <span>
        Die Saison {neueSaison.replace("-", "/")} {inPause ? "beginnt bald" : "hat begonnen"}. Frühere
        Saisons bleiben über die Saison-Auswahl weiterhin gespeichert und abrufbar.
      </span>
      <button
        style={styles.linkBtn}
        onClick={() => {
          try {
            localStorage.setItem(storageKey, "1");
          } catch {}
          setDismissed(true);
        }}
      >
        Verstanden
      </button>
    </div>
  );
}

/* ---------- Dashboard ---------- */

function loadImageCrossOrigin(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Foto konnte nicht geladen werden."));
    img.src = url;
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncateCanvasText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

// Sammelkarte (Trading Card) eines Spielers als PNG, 750x1130
/* ---------- Öffentlicher Karten-Link (alle Sammelkarten, ohne Login) ----------
   Die App veröffentlicht einen Snapshot (nur Vorname, Trikot, Foto, Kennzahlen – kein Nachname/Geburtsdatum) als JSON im Storage
   unter karten/<geheimer Token>.json. Die Seite ?karten=<Token> liest nur diese Datei. Token neu erzeugen/löschen = alter Link tot. */
const KARTEN_OBJ = `${SUPABASE_URL}/storage/v1/object`;
/* Link-Name (frei wählbar, z. B. "Saison 26") + 5 zufällige Zeichen → "saison-26-k7m2x". Ohne Namen: rein zufälliger Token. */
function zufallsCode() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join("");
}
function neuerKartenToken(name = "", code = "") {
  const slug = (name || "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
  if (!slug) {
    const a = new Uint8Array(20);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 28);
  }
  const c = (code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  return `${slug}-${c.length >= 5 ? c : zufallsCode()}`;
}
function kartenLinkUrl(token) {
  return `${window.location.origin}/${token}`;
}
function songUrl(pfad) {
  return `${KARTEN_OBJ}/public/${PHOTO_BUCKET}/${pfad}`;
}
async function ladeSongHoch(file) {
  const endung = (file.name.match(/\.([a-z0-9]{2,4})$/i) || [, "mp3"])[1].toLowerCase();
  const pfad = teamPfad(`songs/${uid()}.${endung}`);
  const res = await fetch(`${KARTEN_OBJ}/${PHOTO_BUCKET}/${pfad}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "x-access-code": Sitzung.code,
      "x-upsert": "true",
      "cache-control": "max-age=31536000",
      "Content-Type": file.type || "audio/mpeg",
    },
    body: file,
  });
  if (!res.ok) throw new Error(`Song konnte nicht hochgeladen werden: ${await res.text()}`);
  return pfad;
}
async function loescheSongDatei(pfad) {
  try {
    await fetch(`${KARTEN_OBJ}/${PHOTO_BUCKET}/${pfad}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "x-access-code": Sitzung.code },
    });
  } catch (e) {}
}
function kartenLinkUrlVorschau(token) {
  return `${window.location.origin}/${token}?seite=vorschau`;
}
/* Einzel-Song-Link: stabile ID = Dateiname im Speicher (ohne Endung), bleibt bei Umbenennen/Umsortieren gleich */
function songId(url) {
  return String(url || "").split("/").pop().replace(/\.[a-z0-9]{2,4}$/i, "");
}
function songLinkUrl(token, song) {
  return `${window.location.origin}/${token}?song=${encodeURIComponent(songId(song.url))}`;
}
function berechneKartenSnapshot(players, trainings, spieltage, teamName, voll = false) {
  const heute = todayISO();
  const saison = seasonKeyOf(heute.slice(0, 7));
  const vergangene = spieltage.filter((s) => spieltagGespielt(s) && seasonKeyOf(s.date.slice(0, 7)) === saison && s.date <= heute);
  const spieler = players
    .filter((p) => p.active !== false)
    .sort((a, b) => (a.trikotnummer ?? 999) - (b.trikotnummer ?? 999) || (a.name || "").localeCompare(b.name || "", "de"))
    .map((p) => {
      const saisonTr = trainings.filter((t) => t.playerId === p.id && seasonKeyOf(t.date.slice(0, 7)) === saison);
      const anwesend = saisonTr.filter((t) =>
        ["anwesend", "anwesend_nicht_angemeldet", "verspaetet", "verspaetet_nicht_angemeldet"].includes(t.teilnahme)
      ).length;
      const dabei = vergangene.filter((s) => s.teilnehmer.includes(p.id)).length;
      const tore = spieltage
        .flatMap((s) => s.spiele)
        .flatMap((sp) => sp.scorers)
        .filter((sc) => sc.playerId === p.id)
        .reduce((sum, sc) => sum + Number(sc.tore || 0), 0);
      return {
        id: p.id,
        name: p.name,
        trikot: p.trikotnummer ?? null,
        foto: p.photo_url || null,
        spitzname: p.spitzname || null,
        alter: p.geburtsdatum ? alterVonGeburtsdatum(String(p.geburtsdatum).slice(0, 10)) : null,
        ...(voll ? { nachname: p.nachname || "", geburtsdatum: p.geburtsdatum ? String(p.geburtsdatum).slice(0, 10) : null } : {}),
        monat: monatsBewertungProzent(trainings.filter((t) => t.playerId === p.id), heute.slice(0, 7)),
        karten: kartenZaehlen(saisonTr),
        tore,
        spieltage: spieltage.filter((s) => spieltagGespielt(s) && s.teilnehmer.includes(p.id)).length,
        training: saisonTr.length > 0 ? Math.round((anwesend / saisonTr.length) * 100) : null,
        spieltagQuote: vergangene.length > 0 ? Math.round((dabei / vergangene.length) * 100) : null,
      };
    });
  return { version: 1, team: teamName, saison: saison ? saison.replace("-", "/") : "", spieler };
}
function sammelkartenWerte({ tore, spieltage, training, spieltagQuote, monat, karten }) {
  return [
    { value: tore, label: "TORE" },
    { value: `${spieltage}`, label: "SPIELTAGE" },
    { value: training != null ? training + "%" : "–", label: "ANW. TRAININGS", kurz: "ANWESENHEIT TRAININGS", icon: "schuh", prozent: training },
    { value: spieltagQuote != null ? spieltagQuote + "%" : "–", label: "ANW. SPIELTAGE", kurz: "ANWESENHEIT SPIELTAGE", icon: "pokal", prozent: spieltagQuote },
    { value: monat != null ? monat + "%" : "–", label: "TRAININGSFORM (MONAT)", kurz: "TRAININGSFORM (MONAT)", daumen: monat ?? null },
    { label: "KARTEN (TRAINING)", kurz: "KARTEN (TRAINING)", karten: karten || { gelb: 0, blau: 0, rot: 0 } },
  ];
}
function kartenStats(sp) {
  return sammelkartenWerte({ tore: sp.tore, spieltage: sp.spieltage, training: sp.training, spieltagQuote: sp.spieltagQuote, monat: sp.monat, karten: sp.karten });
}
async function kartenPutJson(pfad, obj) {
  const res = await fetch(`${KARTEN_OBJ}/${PHOTO_BUCKET}/${pfad}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "x-access-code": Sitzung.code,
      "x-upsert": "true",
      "cache-control": "max-age=60",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...obj, stand: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Karten-Link konnte nicht aktualisiert werden: ${await res.text()}`);
}
async function veroeffentlicheKarten(token, snapshot, plus) {
  await kartenPutJson(`karten/${token}.json`, snapshot);
  if (plus) await kartenPutJson(`karten/${token}-plus.json`, plus);
}
async function veroeffentlicheAlle(tokens, snapshot, plus) {
  for (const t of tokens) await veroeffentlicheKarten(t, snapshot, plus);
}
/* Pakete für den öffentlichen Link, abhängig von den Schaltern unter Verwaltung → Funktionen */
function elternPakete(f, players, trainings, spieltage, gegner, teamInfo) {
  const an = (k) => featureAn(f, k);
  const name = teamInfo?.name || "U8";
  if (!an("eltern_seite")) return { snap: { version: 1, inaktiv: true, team: name, saison: "", spieler: null }, plus: { version: 1, inaktiv: true } };
  const snap = berechneKartenSnapshot(players, trainings, spieltage, name, !!teamInfo?.config?.share_voll);
  snap.verein = { name: teamInfo?.config?.verein_name || null, logo: teamInfo?.config?.verein_logo_url || null, farbe: teamInfo?.config?.verein_farbe || null, titel: teamInfo?.config?.eltern_titel || null };
  if (!an("eltern_karten")) snap.spieler = [];
  const plus = berechneKartenPlus(spieltage, gegner, players, name, teamInfo?.config?.songs, teamInfo?.config?.team_photo_url, {
    bilanz: an("eltern_bilanz"),
    saison: an("eltern_bilanz_saison"),
    torschuetzen: an("eltern_bilanz_torschuetzen"),
    gegner: an("eltern_bilanz_gegner"),
    spieltage: an("eltern_spieltage"),
    songs: an("eltern_songs"),
    briefkasten: an("eltern_briefkasten"),
    karten: an("eltern_karten"),
  });
  return { snap, plus };
}
async function loescheKarten(token) {
  for (const pfad of [`karten/${token}.json`, `karten/${token}-plus.json`]) {
    try {
      await fetch(`${KARTEN_OBJ}/${PHOTO_BUCKET}/${pfad}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "x-access-code": Sitzung.code },
      });
    } catch (e) {}
  }
}
function kurzHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h);
}
/* Erweiterter Snapshot: Spieltagskarten, Saisonbilanz, Bilanz pro Gegner */
function berechneKartenPlus(spieltage, gegner, players, teamName, songs, cover, opt = {}) {
  const o = { bilanz: true, saison: true, torschuetzen: true, gegner: true, spieltage: true, songs: true, ...opt };
  const heute = todayISO();
  const saison = seasonKeyOf(heute.slice(0, 7));
  const nr = spieltagNummern(spieltage);
  const sName = (id) => players.find((p) => p.id === id)?.name || "Unbekannt";
  const gName = (id) => gegner.find((g) => g.id === id)?.name || "Unbekannt";
  const gespielt = spieltage
    .filter((s) => s.spiele.length > 0 && s.date <= heute)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const tage = gespielt.map((s) => ({
    id: s.id,
    date: s.date,
    zeit: s.zeit || null,
    ort: s.ort || "",
    typ: s.typ || "spieltag",
    fotoUrl: s.fotoUrl || null,
    nummer: nr.get(s.id),
    spiele: s.spiele.map((sp) => ({
      gegner: gName(sp.opponentId),
      ourGoals: sp.ourGoals,
      theirGoals: sp.theirGoals,
      scorers: sp.scorers.map((sc) => ({ name: sName(sc.playerId), tore: Number(sc.tore) || 0 })),
    })),
  }));
  const saisonSpiele = spieltage.filter((s) => seasonKeyOf(s.date.slice(0, 7)) === saison).flatMap((s) => s.spiele);
  const bil = { spiele: saisonSpiele.length, siege: 0, unentschieden: 0, niederlagen: 0, toreFuer: 0, toreGegen: 0 };
  const tore = {};
  saisonSpiele.forEach((sp) => {
    bil.toreFuer += sp.ourGoals;
    bil.toreGegen += sp.theirGoals;
    if (sp.ourGoals > sp.theirGoals) bil.siege++;
    else if (sp.ourGoals < sp.theirGoals) bil.niederlagen++;
    else bil.unentschieden++;
    sp.scorers.forEach((sc) => {
      tore[sc.playerId] = (tore[sc.playerId] || 0) + Number(sc.tore || 0);
    });
  });
  const torschuetzen = Object.entries(tore)
    .map(([id, t]) => ({ name: sName(id), tore: t }))
    .sort((a, b) => b.tore - a.tore);
  // Bilanz je Gegner: gilt für die aktuelle Saison, dazu eine Gesamtbilanz über alle Saisons
  const bilanzJeGegner = (tage) => {
    const gmap = {};
    tage.flatMap((s) => s.spiele).forEach((sp) => {
      if (!sp.opponentId) return;
      const b = (gmap[sp.opponentId] = gmap[sp.opponentId] || { name: gName(sp.opponentId), spiele: 0, siege: 0, unentschieden: 0, niederlagen: 0, toreFuer: 0, toreGegen: 0 });
      b.spiele++;
      b.toreFuer += sp.ourGoals;
      b.toreGegen += sp.theirGoals;
      if (sp.ourGoals > sp.theirGoals) b.siege++;
      else if (sp.ourGoals < sp.theirGoals) b.niederlagen++;
      else b.unentschieden++;
    });
    return Object.values(gmap).sort((a, b) => b.spiele - a.spiele || a.name.localeCompare(b.name, "de"));
  };
  const gegnerBilanz = bilanzJeGegner(spieltage.filter((s) => seasonKeyOf(s.date.slice(0, 7)) === saison));
  const gegnerBilanzGesamt = bilanzJeGegner(spieltage);
  const mitBilanz = o.bilanz;
  return {
    version: 1,
    team: teamName,
    saison: saison ? saison.replace("-", "/") : "",
    bereiche: { bilanz: mitBilanz, spieltage: o.spieltage, karten: o.karten !== false, songs: o.songs, briefkasten: o.briefkasten === true },
    spieltage: o.spieltage ? tage : [],
    saisonBilanz: mitBilanz && o.saison ? bil : null,
    torschuetzen: mitBilanz && o.torschuetzen ? torschuetzen : [],
    gegnerBilanz: mitBilanz && o.gegner ? gegnerBilanz : [],
    gegnerBilanzGesamt: mitBilanz && o.gegner ? gegnerBilanzGesamt : [],
    songs: o.songs ? (songs || []).map((x) => ({ titel: x.titel, url: songUrl(x.pfad), text: x.text || "" })) : [],
    cover: cover || null,
  };
}
async function ladeKartenSnapshot(token, suffix = "") {
  const res = await fetch(`${KARTEN_OBJ}/public/${PHOTO_BUCKET}/karten/${encodeURIComponent(token)}${suffix}.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

/* Eine Sammelkarte als Bild (dieselbe Grafik wie der Download), wird erst beim Sichtbarwerden gerendert */
function KartenBild({ sp, saison, team, onFehler }) {
  const boxRef = useRef(null);
  const [url, setUrl] = useState(null);
  const [blob, setBlob] = useState(null);
  const [sichtbar, setSichtbar] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return setSichtbar(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSichtbar(true), io.disconnect()), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!sichtbar) return;
    let alt = null;
    let weg = false;
    generateSammelkarte(
      { name: sp.name, spitzname: sp.spitzname || null, nachname: sp.nachname || "", geburtsdatum: sp.geburtsdatum || null, alter: sp.alter ?? null, trikotnummer: sp.trikot, photo_url: sp.foto },
      kartenStats(sp),
      saison,
      team
    )
      .then((b) => {
        if (weg) return;
        alt = URL.createObjectURL(b);
        setBlob(b);
        setUrl(alt);
      })
      .catch((e) => onFehler((e && e.message) || "Sammelkarte konnte nicht erstellt werden."));
    return () => {
      weg = true;
      if (alt) URL.revokeObjectURL(alt);
    };
  }, [sichtbar, JSON.stringify(sp), saison, team]); // eslint-disable-line
  const speichern = () => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = `sammelkarte-${(sp.name || "spieler").toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-")}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  };
  return (
    <div ref={boxRef} style={{ width: "100%", maxWidth: 340, margin: "0 auto" }}>
      <div style={{ aspectRatio: "750 / 1130", borderRadius: 24, background: url ? "transparent" : "var(--surface-2)" }}>
        {url && <img src={url} alt={`Sammelkarte ${sp.name}`} style={{ width: "100%", height: "100%", display: "block", filter: "drop-shadow(0 10px 18px rgba(142,20,22,0.28))" }} />}
      </div>
      <div style={{ textAlign: "center", marginTop: 8 }}>
        <button style={styles.linkBtn} onClick={speichern} disabled={!blob}>Karte speichern</button>
      </div>
    </div>
  );
}

/* Erweiterte Seite: Saisonbilanz, Bilanz pro Gegner, Spieltagskarten, Sammelkarten */
function tagZuShare(tag) {
  const gegnerListe = tag.spiele.map((sp, i) => ({ id: "g" + i, name: sp.gegner }));
  const namen = [];
  const spieler = (n) => {
    let i = namen.indexOf(n);
    if (i < 0) i = namen.push(n) - 1;
    return "p" + i;
  };
  const st = {
    date: tag.date, zeit: tag.zeit, ort: tag.ort, typ: tag.typ, fotoUrl: tag.fotoUrl,
    spiele: tag.spiele.map((sp, i) => ({
      opponentId: "g" + i, ourGoals: sp.ourGoals, theirGoals: sp.theirGoals,
      scorers: sp.scorers.map((sc) => ({ playerId: spieler(sc.name), tore: sc.tore })),
    })),
  };
  return { st, gegnerListe, pl: namen.map((n, i) => ({ id: "p" + i, name: n })) };
}
function SpieltagKartenBild({ tag, team, onFehler, minH }) {
  const boxRef = useRef(null);
  const [url, setUrl] = useState(null);
  const [blob, setBlob] = useState(null);
  const [sichtbar, setSichtbar] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return setSichtbar(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSichtbar(true), io.disconnect()), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!sichtbar) return;
    let alt = null;
    let weg = false;
    const { st, gegnerListe, pl } = tagZuShare(tag);
    generateSpieltagShareImage(st, tag.nummer, gegnerListe, pl, { minH, teamName: team })
      .then((b) => {
        if (weg) return;
        alt = URL.createObjectURL(b);
        setBlob(b);
        setUrl(alt);
      })
      .catch((e) => onFehler((e && e.message) || "Spieltagskarte konnte nicht erstellt werden."));
    return () => {
      weg = true;
      if (alt) URL.revokeObjectURL(alt);
    };
  }, [sichtbar, JSON.stringify(tag), minH]); // eslint-disable-line
  const speichern = () => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = `${spieltagLabel(tag, tag.nummer).toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-")}-${tag.date}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  };
  return (
    <div ref={boxRef} style={{ width: "100%" }}>
      <div style={{ aspectRatio: minH ? `1080 / ${minH}` : undefined, minHeight: minH ? undefined : 200, borderRadius: 16, background: url ? "transparent" : "var(--surface-2)" }}>
        {url && <img src={url} alt={spieltagLabel(tag, tag.nummer)} style={{ width: "100%", height: "100%", display: "block", borderRadius: 16, boxShadow: "0 6px 16px rgba(0,0,0,0.12)" }} />}
      </div>
      <div style={{ textAlign: "center", marginTop: 8 }}>
        <button style={styles.linkBtn} onClick={speichern} disabled={!blob}>Karte speichern</button>
      </div>
    </div>
  );
}

const fmtZeit = (t) => {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const sek = Math.floor(t % 60);
  return `${m}:${String(sek).padStart(2, "0")}`;
};
function Equalizer({ aktiv, farbe = "#fff", hoehe = 18 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: hoehe }} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="eq-balken" style={{ width: 3, height: "100%", background: farbe, borderRadius: 2, transformOrigin: "bottom", animation: aktiv ? `eqTanz ${0.7 + i * 0.13}s ease-in-out ${i * 0.1}s infinite alternate` : "none", transform: aktiv ? undefined : "scaleY(0.25)" }} />
      ))}
    </span>
  );
}
const PLAYER_ICON = {
  play: <path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor" stroke="none" /><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor" stroke="none" /></>,
  prev: <><path d="M18 5.8v12.4a.8.8 0 0 1-1.25.66L8.6 12.66a.8.8 0 0 1 0-1.32l8.15-6.2A.8.8 0 0 1 18 5.8z" fill="currentColor" stroke="none" /><path d="M6 5v14" /></>,
  next: <><path d="M6 5.8v12.4a.8.8 0 0 0 1.25.66l8.15-6.2a.8.8 0 0 0 0-1.32L7.25 5.14A.8.8 0 0 0 6 5.8z" fill="currentColor" stroke="none" /><path d="M18 5v14" /></>,
  shuffle: <><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" /></>,
  repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
  repeat1: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /><path d="M11 10h1v4" /></>,
  list: <><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>,
  text: <><path d="M4 6h16" /><path d="M4 11h16" /><path d="M4 16h10" /></>,
  share: <><circle cx="18" cy="5" r="2.6" /><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="19" r="2.6" /><path d="m8.3 10.8 7.4-4.4" /><path d="m8.3 13.2 7.4 4.4" /></>,
  download: <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></>,
};
function PIcon({ name, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }} aria-hidden="true">
      {PLAYER_ICON[name]}
    </svg>
  );
}
/* Text mit Zeitstempeln im LRC-Format ([mm:ss.xx] Zeile) → [{t, text}]; ohne Zeitstempel: null */
function parseLrc(text) {
  if (!text) return null;
  const zeilen = [];
  text.split(/\r?\n/).forEach((roh) => {
    const m = roh.match(/^\s*\[(\d+):(\d+(?:[.,]\d+)?)\]\s*(.*)$/);
    if (m) zeilen.push({ t: Math.max(0, Number(m[1]) * 60 + Number(m[2].replace(",", "."))), text: m[3] });
  });
  return zeilen.length >= 2 ? zeilen.sort((a, b) => a.t - b.t) : null;
}
function SongPlayer({ songs, cover, team, token, textStart = false }) {
  const ROT = CLUB.farbe;
  const [aktiv, setAktiv] = useState(0);
  const [laeuft, setLaeuft] = useState(false);
  const [zeit, setZeit] = useState(0);
  const [dauer, setDauer] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [wiederholen, setWiederholen] = useState("aus"); // aus | alle | eins
  const [offen, setOffen] = useState(false);
  const [textOffen, setTextOffen] = useState(!!textStart);
  const [kopiert, setKopiert] = useState(false);
  const [dauern, setDauern] = useState({});
  const [breit, setBreit] = useState(() => typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 900px)").matches : false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 900px)");
    const h = (e) => setBreit(e.matches);
    mq.addEventListener ? mq.addEventListener("change", h) : mq.addListener(h);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", h) : mq.removeListener(h); };
  }, []);
  const ref = useRef(null);
  const start = useRef(false);
  const ersterLauf = useRef(true);
  const song = songs[aktiv] || songs[0];
  const lrc = useMemo(() => parseLrc(song.text), [song.text]);
  const lrcBox = useRef(null);
  let aktZeile = -1;
  if (lrc) for (let i = 0; i < lrc.length; i++) { if (zeit + 0.15 >= lrc[i].t) aktZeile = i; else break; }

  useEffect(() => {
    if (start.current && ref.current) ref.current.play().catch(() => setLaeuft(false));
    setZeit(0);
    setDauer(0);
    if (!ersterLauf.current) setTextOffen(false); // beim ersten Aufbau bleibt der Text offen, falls textStart gesetzt ist
    ersterLauf.current = false;
  }, [aktiv]);
  useEffect(() => {
    if (lrc && (breit || !offen)) setTextOffen(true);
  }, [aktiv]); // eslint-disable-line
  useEffect(() => {
    const box = lrcBox.current;
    if (!box || aktZeile < 0) return;
    const el = box.children[aktZeile];
    if (el) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, [aktZeile, textOffen]);

  // Dauer der Songs in der Playlist (nur Metadaten laden)
  useEffect(() => {
    if (!offen) return;
    const els = [];
    songs.forEach((x) => {
      if (dauern[x.url]) return;
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => setDauern((d) => ({ ...d, [x.url]: a.duration }));
      a.src = x.url;
      els.push(a);
    });
    return () => els.forEach((a) => { a.onloadedmetadata = null; a.src = ""; });
  }, [offen, songs]); // eslint-disable-line

  const zufall = () => {
    if (songs.length < 2) return aktiv;
    let n = aktiv;
    while (n === aktiv) n = Math.floor(Math.random() * songs.length);
    return n;
  };
  const weiter = (d) => {
    start.current = true;
    if (shuffle && d > 0) setAktiv(zufall());
    else setAktiv((a) => (a + d + songs.length) % songs.length);
  };
  const zurueck = () => {
    if (ref.current && ref.current.currentTime > 3) {
      ref.current.currentTime = 0;
    } else weiter(-1);
  };
  const umschalten = () => {
    start.current = true;
    const a = ref.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };
  const wahl = (i) => {
    start.current = true;
    if (i === aktiv) umschalten();
    else setAktiv(i);
  };
  const ende = () => {
    const a = ref.current;
    if (wiederholen === "eins" && a) {
      a.currentTime = 0;
      a.play().catch(() => {});
    } else if (shuffle) {
      weiter(1);
    } else if (aktiv < songs.length - 1 || wiederholen === "alle") {
      weiter(1);
    } else {
      setLaeuft(false);
    }
  };

  // Sperrbildschirm / Kopfhörer-Tasten
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.titel,
        artist: `${CLUB.name} ${team || "U8"}`,
        album: "Mannschaftssongs",
        artwork: cover ? [{ src: cover }] : [],
      });
    } catch (e) {}
  }, [aktiv, song.titel, cover, team]);
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => ref.current && ref.current.play());
      navigator.mediaSession.setActionHandler("pause", () => ref.current && ref.current.pause());
      navigator.mediaSession.setActionHandler("previoustrack", zurueck);
      navigator.mediaSession.setActionHandler("nexttrack", () => weiter(1));
      navigator.mediaSession.setActionHandler("seekto", (d) => { if (ref.current && d.seekTime != null) ref.current.currentTime = d.seekTime; });
    } catch (e) {}
  }); // eslint-disable-line

  // Teilen: auf dem Handy das Teilen-Menü (WhatsApp), sonst Link in die Zwischenablage
  const teilen = async (x) => {
    if (!token) return;
    const url = songLinkUrl(token, x);
    // Der Titel steht in der Nachricht selbst, weil die Link-Vorschau (WhatsApp) nur den allgemeinen Seitentitel kennt
    const nachricht = `🎵 ${x.titel} – Mannschaftssong ${CLUB.name} ${team || "U8"}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: x.titel, text: nachricht, url });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(`${nachricht}\n${url}`);
      setKopiert("ok");
      setTimeout(() => setKopiert(false), 2500);
    } catch (e) {
      setKopiert(url); // Kopieren nicht erlaubt: Link sichtbar anzeigen, damit man ihn markieren kann
    }
  };

  const speichern = async (x) => {
    try {
      const res = await fetch(x.url);
      const blob = await res.blob();
      const u = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = u;
      el.download = `${x.titel.replace(/[^a-z0-9äöüß ]+/gi, "").trim() || "song"}.mp3`;
      document.body.appendChild(el);
      el.click();
      el.remove();
      setTimeout(() => URL.revokeObjectURL(u), 3000);
    } catch (e) {
      window.open(x.url, "_blank");
    }
  };

  const iconBtn = { background: "none", border: "none", cursor: "pointer", padding: 10, fontFamily: "inherit", lineHeight: 0, color: "inherit", borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center" };
  const pille = (an) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", minHeight: 44, borderRadius: 999, fontFamily: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer", border: `1.5px solid ${an ? ROT : "var(--border)"}`, background: an ? ROT : "transparent", color: an ? "#fff" : "inherit" });
  const toggleFarbe = (an) => ({ ...iconBtn, color: an ? ROT : "var(--muted)" });

  return (
    <div>
      <style>{`@keyframes eqTanz { from { transform: scaleY(0.2); } to { transform: scaleY(1); } }`}</style>
      <audio
        ref={ref}
        src={song.url}
        preload="metadata"
        onPlay={() => setLaeuft(true)}
        onPause={() => setLaeuft(false)}
        onTimeUpdate={(e) => setZeit(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDauer(e.currentTarget.duration)}
        onEnded={ende}
      />
      <div style={{ display: "flex", gap: breit ? 24 : 14, alignItems: "center" }}>
      <div style={{ position: "relative", width: breit ? 230 : 104, flex: "none", aspectRatio: "1 / 1", borderRadius: breit ? 18 : 14, overflow: "hidden", background: cover ? "#222" : "linear-gradient(135deg,#C4271F,#8E1416)" }}>
        {cover ? (
          <img src={cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        ) : (
          <img src={CLUB.logo} alt="" style={{ position: "absolute", inset: "20%", width: "60%", height: "60%", objectFit: "contain" }} />
        )}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "40%", background: "linear-gradient(to top, rgba(20,13,13,0.75), rgba(20,13,13,0))" }} />
        <div style={{ position: "absolute", left: breit ? 12 : 7, bottom: breit ? 10 : 6 }}>
          <Equalizer aktiv={laeuft} hoehe={breit ? 20 : 12} />
        </div>
      </div>
        <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ textAlign: "left" }}>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: breit ? 24 : 18, fontWeight: 800, lineHeight: 1.2 }}>{song.titel}</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{CLUB.name} {team || "U8"} · Mannschaftssong</div>
      </div>

        {breit && (
          <>
      <div style={{ marginTop: 14 }}>
        <input
          type="range"
          min={0}
          max={dauer || 0}
          step={0.1}
          value={Math.min(zeit, dauer || 0)}
          onChange={(e) => { if (ref.current) ref.current.currentTime = Number(e.target.value); setZeit(Number(e.target.value)); }}
          aria-label="Fortschritt"
          style={{ width: "100%", accentColor: ROT, cursor: "pointer" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
          <span>{fmtZeit(zeit)}</span>
          <span>{fmtZeit(dauer)}</span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: breit ? "flex-start" : "center", gap: 6, marginTop: 4 }}>
        <button style={toggleFarbe(shuffle)} onClick={() => setShuffle((v) => !v)} aria-pressed={shuffle} title="Zufall" disabled={songs.length < 2}><PIcon name="shuffle" size={20} /></button>
        <button style={iconBtn} onClick={zurueck} aria-label="Zurück" title="Zurück"><PIcon name="prev" size={24} /></button>
        <button onClick={umschalten} aria-label={laeuft ? "Pause" : "Abspielen"} style={{ width: 64, height: 64, borderRadius: 999, border: "none", background: ROT, color: "#fff", cursor: "pointer", boxShadow: "var(--sh-glow-sm)", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
          <PIcon name={laeuft ? "pause" : "play"} size={30} />
        </button>
        <button style={iconBtn} onClick={() => weiter(1)} aria-label="Weiter" title="Weiter" disabled={songs.length < 2}><PIcon name="next" size={24} /></button>
        <button style={toggleFarbe(wiederholen !== "aus")} onClick={() => setWiederholen((w) => (w === "aus" ? "alle" : w === "alle" ? "eins" : "aus"))} title={wiederholen === "aus" ? "Wiederholen aus" : wiederholen === "alle" ? "Alle wiederholen" : "Song wiederholen"} aria-label="Wiederholen">
          <PIcon name={wiederholen === "eins" ? "repeat1" : "repeat"} size={20} />
        </button>
      </div>

      <div style={{ display: "flex", justifyContent: breit ? "flex-start" : "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {songs.length > 1 && (
          <button onClick={() => { if (!offen && !breit) setTextOffen(false); setOffen((o) => !o); }} aria-expanded={offen} style={pille(offen)}><PIcon name="list" size={16} /> Playlist · {songs.length}</button>
        )}
        {song.text ? <button onClick={() => { if (!textOffen && !breit) setOffen(false); setTextOffen((o) => !o); }} aria-expanded={textOffen} style={pille(textOffen)}><PIcon name="text" size={16} /> Text</button> : null}
        <button onClick={() => speichern(song)} style={pille(false)}><PIcon name="download" size={16} /> Speichern</button>
        {token && <button onClick={() => teilen(song)} style={pille(false)}><PIcon name="share" size={16} /> {kopiert === "ok" ? "Link kopiert" : "Teilen"}</button>}
        {kopiert && kopiert !== "ok" && <input readOnly value={kopiert} onFocus={(e) => e.target.select()} aria-label="Link zum Kopieren" style={{ ...styles.input, width: "100%", marginTop: 0 }} />}
      </div>
          </>
        )}
        </div>
      </div>
      {!breit && (
        <>
      <div style={{ marginTop: 14 }}>
        <input
          type="range"
          min={0}
          max={dauer || 0}
          step={0.1}
          value={Math.min(zeit, dauer || 0)}
          onChange={(e) => { if (ref.current) ref.current.currentTime = Number(e.target.value); setZeit(Number(e.target.value)); }}
          aria-label="Fortschritt"
          style={{ width: "100%", accentColor: ROT, cursor: "pointer" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
          <span>{fmtZeit(zeit)}</span>
          <span>{fmtZeit(dauer)}</span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: breit ? "flex-start" : "center", gap: 6, marginTop: 4 }}>
        <button style={toggleFarbe(shuffle)} onClick={() => setShuffle((v) => !v)} aria-pressed={shuffle} title="Zufall" disabled={songs.length < 2}><PIcon name="shuffle" size={20} /></button>
        <button style={iconBtn} onClick={zurueck} aria-label="Zurück" title="Zurück"><PIcon name="prev" size={24} /></button>
        <button onClick={umschalten} aria-label={laeuft ? "Pause" : "Abspielen"} style={{ width: 64, height: 64, borderRadius: 999, border: "none", background: ROT, color: "#fff", cursor: "pointer", boxShadow: "var(--sh-glow-sm)", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
          <PIcon name={laeuft ? "pause" : "play"} size={30} />
        </button>
        <button style={iconBtn} onClick={() => weiter(1)} aria-label="Weiter" title="Weiter" disabled={songs.length < 2}><PIcon name="next" size={24} /></button>
        <button style={toggleFarbe(wiederholen !== "aus")} onClick={() => setWiederholen((w) => (w === "aus" ? "alle" : w === "alle" ? "eins" : "aus"))} title={wiederholen === "aus" ? "Wiederholen aus" : wiederholen === "alle" ? "Alle wiederholen" : "Song wiederholen"} aria-label="Wiederholen">
          <PIcon name={wiederholen === "eins" ? "repeat1" : "repeat"} size={20} />
        </button>
      </div>

      <div style={{ display: "flex", justifyContent: breit ? "flex-start" : "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {songs.length > 1 && (
          <button onClick={() => { if (!offen && !breit) setTextOffen(false); setOffen((o) => !o); }} aria-expanded={offen} style={pille(offen)}><PIcon name="list" size={16} /> Playlist · {songs.length}</button>
        )}
        {song.text ? <button onClick={() => { if (!textOffen && !breit) setOffen(false); setTextOffen((o) => !o); }} aria-expanded={textOffen} style={pille(textOffen)}><PIcon name="text" size={16} /> Text</button> : null}
        <button onClick={() => speichern(song)} style={pille(false)}><PIcon name="download" size={16} /> Speichern</button>
        {token && <button onClick={() => teilen(song)} style={pille(false)}><PIcon name="share" size={16} /> {kopiert === "ok" ? "Link kopiert" : "Teilen"}</button>}
        {kopiert && kopiert !== "ok" && <input readOnly value={kopiert} onFocus={(e) => e.target.select()} aria-label="Link zum Kopieren" style={{ ...styles.input, width: "100%", marginTop: 0 }} />}
      </div>
        </>
      )}
      {((songs.length > 1 && offen) || (song.text && textOffen)) && (
        <div style={{ display: "grid", gridTemplateColumns: breit && songs.length > 1 && offen && song.text && textOffen ? "1fr 1fr" : "1fr", gap: 14, alignItems: "start", marginTop: 12 }}>
      {songs.length > 1 && offen && (
        <div style={{ maxHeight: 340, overflowY: "auto", paddingRight: 2 }}>
          {songs.map((x, i) => (
            <button key={x.url} onClick={() => wahl(i)} style={{ display: "flex", width: "100%", gap: 12, alignItems: "center", textAlign: "left", border: "none", borderRadius: 12, padding: "10px 12px", marginBottom: 4, fontSize: 16, fontFamily: "inherit", cursor: "pointer", background: i === aktiv ? "var(--track)" : "transparent", color: i === aktiv ? "var(--accent-text)" : "inherit", fontWeight: i === aktiv ? 700 : 500 }}>
              <span style={{ width: 22, display: "inline-flex", justifyContent: "center" }}>
                {i === aktiv ? <Equalizer aktiv={laeuft} farbe={ROT} hoehe={14} /> : <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>}
              </span>
              <span style={{ flex: 1 }}>{x.titel}</span>
              <span style={{ fontSize: 13, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{dauern[x.url] ? fmtZeit(dauern[x.url]) : ""}</span>
            </button>
          ))}
        </div>
      )}

      {song.text && textOffen && !lrc && (
        <div style={{ padding: "12px 14px", background: "var(--surface-2)", borderRadius: 12, fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{song.text}</div>
      )}
      {song.text && textOffen && lrc && (
        <div ref={lrcBox} style={{ position: "relative", padding: "40px 14px", height: 340, overflowY: "auto", background: "var(--surface-2)", borderRadius: 12, textAlign: "center", scrollbarWidth: "none" }}>
          {lrc.map((z, i) => (
            <div
              key={i}
              onClick={() => { if (ref.current) { start.current = true; ref.current.currentTime = z.t; ref.current.play().catch(() => {}); } }}
              style={{ padding: "5px 0", cursor: "pointer", fontSize: i === aktZeile ? 19 : 16, lineHeight: 1.4, fontWeight: i === aktZeile ? 800 : 500, color: i === aktZeile ? ROT : "var(--muted)", opacity: i === aktZeile ? 1 : 0.75, transition: "all 0.25s ease", minHeight: z.text ? undefined : 14 }}
            >
              {z.text || "\u00A0"}
            </div>
          ))}
        </div>
      )}

        </div>
      )}
    </div>
  );
}

/* Bilanz pro Gegner auf der Elternseite: Saison (Standard) oder Gesamt über alle Saisons */
function GegnerBilanzSeite({ saison, gesamt, saisonLabel }) {
  const [umfang, setUmfang] = useState("saison");
  // „Gesamt“ nur anbieten, wenn es sich von der Saison unterscheidet (also mehr als eine Saison vorliegt)
  const mehrere = !!gesamt && JSON.stringify(gesamt) !== JSON.stringify(saison);
  const liste = umfang === "gesamt" && mehrere ? gesamt : saison;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={styles.subheading}>Bilanz pro Gegner</div>
      {mehrere && (
        <div role="group" aria-label="Zeitraum" style={{ ...styles.segNav, marginTop: 6, marginBottom: 8 }}>
          {[["saison", saisonLabel ? `Saison ${saisonLabel}` : "Saison"], ["gesamt", "Gesamt"]].map(([k, t]) => (
            <button key={k} aria-pressed={umfang === k} onClick={() => setUmfang(k)} style={{ ...styles.segBtn, ...(umfang === k ? styles.segBtnActive : {}) }}>{t}</button>
          ))}
        </div>
      )}
      {liste.length === 0 ? (
        <div style={styles.hint}>Noch keine Spiele in dieser Saison.</div>
      ) : (
        <div className="nz-tabelle" style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Gegner</th>
                {["Spiele", "S", "U", "N", "Tore", "Diff."].map((h) => <th key={h} style={{ ...styles.th, textAlign: "right" }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {liste.map((g) => {
                const d = g.toreFuer - g.toreGegen;
                return (
                  <tr key={g.name}>
                    <td style={styles.tdName}>{g.name}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{g.spiele}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{g.siege}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{g.unentschieden}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{g.niederlagen}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{g.toreFuer}:{g.toreGegen}</td>
                    <td style={{ ...styles.td, textAlign: "right", fontWeight: 700, color: d > 0 ? "var(--success-text)" : d < 0 ? "var(--loss-text)" : "var(--text-2)" }}>{d > 0 ? "+" : ""}{d}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- Briefkasten (Eltern-Seite): anonymes Feedback an die Trainer ----------
   Geschrieben wird nur über die RPC-Funktion briefkasten_senden (prüft Token, Schalter, Länge, Honeypot, Limit). */
const BRIEFKASTEN_MAX = 1000;
const BRIEFKASTEN_KATEGORIEN = [["lob", "Lob"], ["kritik", "Kritik"], ["idee", "Idee"], ["sonstiges", "Sonstiges"]];
const BRIEFKASTEN_MELDUNG = {
  ungueltig: "Dieser Link ist nicht mehr gültig.",
  aus: "Der Briefkasten ist gerade geschlossen.",
  laenge: "Bitte schreibe zwischen 1 und 1000 Zeichen.",
  zu_viele: "Gerade sind sehr viele Nachrichten eingegangen. Bitte versuche es in einer Stunde noch einmal.",
};
function BriefkastenFormular({ token }) {
  const [kategorie, setKategorie] = useState("sonstiges");
  const [text, setText] = useState("");
  const [falle, setFalle] = useState(""); // Honeypot: Menschen sehen das Feld nicht
  const [stand, setStand] = useState("bereit"); // bereit | sendet | ok
  const [fehler, setFehler] = useState("");
  const rest = BRIEFKASTEN_MAX - text.length;
  const senden = async () => {
    if (stand === "sendet" || !text.trim()) return;
    setStand("sendet");
    setFehler("");
    try {
      const res = await fetch(REST + "rpc/briefkasten_senden", {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ p_token: token, p_nachricht: text, p_kategorie: kategorie, p_website: falle }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const code = await res.json();
      if (code !== "ok") {
        setFehler(BRIEFKASTEN_MELDUNG[code] || "Das hat leider nicht geklappt. Bitte versuche es später noch einmal.");
        setStand("bereit");
        return;
      }
      setText("");
      setStand("ok");
    } catch (e) {
      setFehler("Das hat leider nicht geklappt. Prüfe kurz deine Verbindung und versuche es noch einmal. Dein Text bleibt erhalten.");
      setStand("bereit");
    }
  };
  if (stand === "ok") {
    return (
      <div role="status" style={{ textAlign: "center", padding: "12px 0" }}>
        <h3 style={{ ...styles.h3Plain, marginTop: 0 }}>Danke, deine Nachricht ist angekommen.</h3>
        <p style={{ fontSize: 14, color: "var(--text-2)", margin: "0 0 16px" }}>Die Trainer lesen sie. Antworten können wir nicht, weil du anonym bleibst.</p>
        <button style={styles.rowBtn} onClick={() => { setStand("bereit"); setKategorie("sonstiges"); }}>Noch eine schreiben</button>
      </div>
    );
  }
  return (
    <div>
      <h3 style={{ ...styles.h3Plain, marginTop: 0 }}>Briefkasten</h3>
      <p style={{ fontSize: 14, color: "var(--text-2)", margin: "0 0 14px" }}>
        Lob, Kritik oder eine Idee für die Trainer? Einfach einwerfen. Die App speichert weder Namen noch Kontaktdaten und zeigt den Trainern nur das Datum. Eine Antwort ist deshalb nicht möglich. Für ein persönliches Gespräch sprich uns gern direkt an.
      </p>
      <div role="group" aria-label="Kategorie" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {BRIEFKASTEN_KATEGORIEN.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={kategorie === k} onClick={() => setKategorie(k)} style={{ ...styles.chip, ...(kategorie === k ? styles.chipActive : null) }}>{l}</button>
        ))}
      </div>
      <label htmlFor="briefkasten-text" style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Deine Nachricht</label>
      <textarea
        id="briefkasten-text"
        value={text}
        maxLength={BRIEFKASTEN_MAX}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        style={{ ...styles.input, width: "100%", boxSizing: "border-box", minHeight: 140, fontSize: 16, resize: "vertical" }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 13, color: rest < 50 ? "var(--danger-text)" : "var(--muted)", fontVariantNumeric: "tabular-nums", marginTop: 4 }}>
        {text.length} / {BRIEFKASTEN_MAX}
      </div>
      {/* Honeypot: für Menschen und Screenreader unsichtbar, Bots füllen es aus */}
      <div aria-hidden="true" style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}>
        <label>Website<input type="text" tabIndex={-1} autoComplete="off" value={falle} onChange={(e) => setFalle(e.target.value)} /></label>
      </div>
      {fehler && <div role="alert" style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 10 }}>{fehler}</div>}
      <button style={{ ...styles.primaryBtn, width: "100%", marginTop: 14, opacity: !text.trim() || stand === "sendet" ? 0.6 : 1 }} disabled={!text.trim() || stand === "sendet"} onClick={senden}>
        {stand === "sendet" ? "Sende …" : "Einwerfen"}
      </button>
    </div>
  );
}

function KartenSeitePlus({ token }) {
  const [karten, setKarten] = useState(undefined);
  const [plus, setPlus] = useState(undefined);
  const [fehler, setFehler] = useState(null);
  const [maxH, setMaxH] = useState(null);
  const [tab, setTab] = useState(null);
  const [besucht, setBesucht] = useState({});
  useEffect(() => {
    // Beide Dateien laden unabhängig: erst rechnen, wenn karten UND plus da sind (sonst Absturz = weiße Seite)
    if (!karten || !plus || !plus.spieltage || plus.spieltage.length === 0) return;
    let weg = false;
    Promise.all(plus.spieltage.map((t) => { const { st, gegnerListe, pl } = tagZuShare(t); return generateSpieltagShareImage(st, t.nummer, gegnerListe, pl, { nurHoehe: true, teamName: karten.team }); }))
      .then((hs) => !weg && setMaxH(Math.max(...hs)))
      .catch(() => {});
    return () => { weg = true; };
  }, [plus, karten]);
  useEffect(() => {
    const m = document.createElement("meta");
    m.name = "robots";
    m.content = "noindex,nofollow";
    document.head.appendChild(m);
    ladeKartenSnapshot(token).then(setKarten).catch(() => setKarten(null));
    ladeKartenSnapshot(token, "-plus").then(setPlus).catch(() => setPlus(null));
    return () => m.remove();
  }, [token]);
  if (karten === undefined || plus === undefined) return <div style={styles.loadingScreen}>Lade …</div>;
  if (karten && (karten.inaktiv || (plus && plus.inaktiv))) {
    return <div style={styles.loadingScreen}>Diese Seite ist derzeit nicht verfügbar.</div>;
  }
  if (!karten || !Array.isArray(karten.spieler)) {
    return <div style={styles.loadingScreen}>Dieser Link ist nicht (mehr) gültig.</div>;
  }
  setzeClub(karten.verein && karten.verein.name, karten.verein && karten.verein.logo, karten.verein && karten.verein.farbe, karten.verein && karten.verein.titel);
  const stand = karten.stand ? new Date(karten.stand).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
  const b = plus && plus.saisonBilanz;
  const be = (plus && plus.bereiche) || { bilanz: true, spieltage: true, karten: true, songs: true };
  // Einzel-Song-Link (?song=<ID>): nur dieser Song mit Player und Text, keine übrigen Bereiche der Elternseite
  const einzelId = new URLSearchParams(window.location.search).get("song");
  const einzelSong = einzelId && plus && be.songs && plus.songs ? plus.songs.find((x) => songId(x.url) === einzelId) : null;
  if (einzelSong) {
    return (
      <div style={styles.app}>
      <header className="app-header" style={{ ...styles.header, paddingBottom: 16 }}>
        <div style={{ ...styles.headerTop, maxWidth: 1100, margin: "0 auto" }}>
          <img src={CLUB.logo} alt={CLUB.name} style={styles.crestImg} />
          <div style={{ flex: 1 }}>
            <div style={styles.title}>{CLUB.titel}</div>
            <div style={styles.subtitle}>
              <div>{CLUB.name} {karten.team || "U8"}</div>
              <div>Saison {karten.saison}{stand ? ` · Stand ${stand}` : ""}</div>
            </div>
          </div>
        </div>
      </header>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "0 16px 32px" }}>
          <section style={{ ...styles.card, marginTop: 16 }}>
            <SongPlayer songs={[einzelSong]} cover={plus.cover} team={karten.team} token={token} textStart />
          </section>
        </main>
      </div>
    );
  }
  const bilanzHat = !!plus && !!(b || (plus.torschuetzen && plus.torschuetzen.length > 0) || ((plus.gegnerBilanz && plus.gegnerBilanz.length > 0) || (plus.gegnerBilanzGesamt && plus.gegnerBilanzGesamt.length > 0)));
  const th = { textAlign: "right", padding: "6px 8px", fontSize: 13, color: "var(--muted)", fontWeight: 600 };
  const td = { textAlign: "right", padding: "8px 8px", fontVariantNumeric: "tabular-nums", fontSize: 14 };
  const kopf = (t) => <h3 style={{ ...styles.h3Plain, marginTop: 28 }}>{t}</h3>;
  const tabs = [];
  if (be.bilanz && bilanzHat) tabs.push({ k: "bilanz", label: "Bilanz" });
  if (plus && be.spieltage && plus.spieltage && plus.spieltage.length > 0) tabs.push({ k: "spieltage", label: "Spieltage", n: plus.spieltage.length });
  if (be.karten && karten.spieler.length > 0) tabs.push({ k: "karten", label: "Karten", n: karten.spieler.length });
  if (plus && be.songs && plus.songs && plus.songs.length > 0) tabs.push({ k: "songs", label: "Songs", n: plus.songs.length });
  if (plus && be.briefkasten) tabs.push({ k: "briefkasten", label: "Briefkasten" });
  const aktTab = tab && tabs.some((t) => t.k === tab) ? tab : tabs.length ? tabs[0].k : null;
  const waehle = (k) => { setTab(k); setBesucht((v) => (v[k] ? v : { ...v, [k]: true })); try { window.scrollTo({ top: 0 }); } catch (e) {} };
  // Bereiche bleiben nach dem ersten Öffnen eingebunden (die Musik läuft beim Wechseln weiter)
  const panel = (k, inhalt) => (besucht[k] || aktTab === k ? <div style={{ display: aktTab === k ? "block" : "none" }}>{inhalt}</div> : null);
  return (
    <div style={styles.app}>
      <header className="app-header" style={{ ...styles.header, paddingBottom: 16 }}>
        <div style={{ ...styles.headerTop, maxWidth: 1100, margin: "0 auto" }}>
          <img src={CLUB.logo} alt={CLUB.name} style={styles.crestImg} />
          <div style={{ flex: 1 }}>
            <div style={styles.title}>{CLUB.titel}</div>
            <div style={styles.subtitle}>
              <div>{CLUB.name} {karten.team || "U8"}</div>
              <div>Saison {karten.saison}{stand ? ` · Stand ${stand}` : ""}</div>
            </div>
          </div>
        </div>
      </header>
      {tabs.length > 1 && (
        <nav aria-label="Bereiche" style={{ position: "sticky", top: 0, zIndex: 20, background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "8px 16px", display: "flex", gap: 8, overflowX: "auto", scrollbarWidth: "none" }}>
            {tabs.map((t) => {
              const an = t.k === aktTab;
              return (
                <button key={t.k} onClick={() => waehle(t.k)} aria-current={an ? "page" : undefined}
                  style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 999, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer", border: `1.5px solid ${an ? CLUB.farbe : "var(--border)"}`, background: an ? CLUB.farbe : "var(--surface)", color: an ? "#fff" : "inherit" }}>
                  {t.label}
                  {t.n != null ? <span style={{ fontSize: 13, fontWeight: 600, opacity: an ? 0.9 : 0.6 }}>{t.n}</span> : null}
                </button>
              );
            })}
          </div>
        </nav>
      )}
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "8px 16px 40px" }}>
        {fehler && <div style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 10 }}>{fehler}</div>}
        {!plus && <div style={{ ...styles.card, marginTop: 18 }}>Die erweiterten Daten sind noch nicht veröffentlicht. In der App unter Setup → Spieler „Jetzt aktualisieren“ tippen.</div>}
        {plus && !plus.inaktiv && tabs.length === 0 && <div style={{ ...styles.card, marginTop: 18 }}>Hier gibt es im Moment nichts zu sehen.</div>}
        {plus && (
          <>
            {be.bilanz && bilanzHat && panel("bilanz", (
            <section style={{ ...styles.card, marginTop: 16 }}>
              {b && (<>
              <h3 style={{ ...styles.h3Plain, marginTop: 0 }}>Saisonbilanz {plus.saison}</h3>
              <div style={styles.statsRow}>
                {[["Spiele", b.spiele], ["Siege", b.siege], ["Unentschieden", b.unentschieden], ["Niederlagen", b.niederlagen], ["Tore", `${b.toreFuer}:${b.toreGegen}`]].map(([l, v]) => (
                  <div key={l} style={styles.statBox}>
                    <div style={styles.statValue}>{v}</div>
                    <div style={styles.statLabel}>{l}</div>
                  </div>
                ))}
              </div>
              </>)}
              {plus.torschuetzen.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div style={styles.subheading}>Torschützenliste</div>
                  <div className="nz-tabelle" style={styles.tableWrap}>
                    <table style={styles.table}>
                      <tbody>
                        {plus.torschuetzen.map((t, i) => (
                          <tr key={t.name + i}>
                            <td style={styles.tdName}><span style={styles.rank}>{i + 1}</span>{t.name}</td>
                            <td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>{t.tore}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {(plus.gegnerBilanz.length > 0 || (plus.gegnerBilanzGesamt || []).length > 0) && (
                <GegnerBilanzSeite saison={plus.gegnerBilanz} gesamt={plus.gegnerBilanzGesamt} saisonLabel={karten.saison} />
              )}
            </section>
            ))}
            {be.spieltage && plus.spieltage.length > 0 && panel("spieltage", (
              <section style={{ ...styles.card, marginTop: 16 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20, alignItems: "start" }}>
                  {plus.spieltage.map((t) => (
                    <SpieltagKartenBild key={t.id} tag={t} team={karten.team} onFehler={setFehler} minH={maxH} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
        {be.karten && panel("karten", (
        <section style={{ ...styles.card, marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 20, alignItems: "start" }}>
            {karten.spieler.map((sp) => (
              <KartenBild key={sp.id} sp={sp} saison={karten.saison} team={karten.team || "U8"} onFehler={setFehler} />
            ))}
          </div>
        </section>
        ))}
        {plus && be.songs && plus.songs && plus.songs.length > 0 && panel("songs", (
          <section style={{ ...styles.card, marginTop: 16 }}>
            <SongPlayer songs={plus.songs} cover={plus.cover} team={karten.team} token={token} />
          </section>
        ))}
        {plus && be.briefkasten && panel("briefkasten", (
          <section style={{ ...styles.card, marginTop: 16, position: "relative", maxWidth: 560 }}>
            <BriefkastenFormular token={token} />
          </section>
        ))}
      </main>
    </div>
  );
}

/* ---------- Vorschau (Staging): Hier werden Änderungen an der Eltern-Seite zuerst gezeigt. Die freigegebene Version ist KartenSeitePlus. ---------- */
function KartenSeiteVorschau({ token }) {
  const [karten, setKarten] = useState(undefined);
  const [plus, setPlus] = useState(undefined);
  const [fehler, setFehler] = useState(null);
  const [maxH, setMaxH] = useState(null);
  const [tab, setTab] = useState(null);
  const [besucht, setBesucht] = useState({});
  useEffect(() => {
    // Beide Dateien laden unabhängig: erst rechnen, wenn karten UND plus da sind (sonst Absturz = weiße Seite)
    if (!karten || !plus || !plus.spieltage || plus.spieltage.length === 0) return;
    let weg = false;
    Promise.all(plus.spieltage.map((t) => { const { st, gegnerListe, pl } = tagZuShare(t); return generateSpieltagShareImage(st, t.nummer, gegnerListe, pl, { nurHoehe: true, teamName: karten.team }); }))
      .then((hs) => !weg && setMaxH(Math.max(...hs)))
      .catch(() => {});
    return () => { weg = true; };
  }, [plus, karten]);
  useEffect(() => {
    const m = document.createElement("meta");
    m.name = "robots";
    m.content = "noindex,nofollow";
    document.head.appendChild(m);
    ladeKartenSnapshot(token).then(setKarten).catch(() => setKarten(null));
    ladeKartenSnapshot(token, "-plus").then(setPlus).catch(() => setPlus(null));
    return () => m.remove();
  }, [token]);
  if (karten === undefined || plus === undefined) return <div style={styles.loadingScreen}>Lade …</div>;
  if (karten && (karten.inaktiv || (plus && plus.inaktiv))) {
    return <div style={styles.loadingScreen}>Diese Seite ist derzeit nicht verfügbar.</div>;
  }
  if (!karten || !Array.isArray(karten.spieler)) {
    return <div style={styles.loadingScreen}>Dieser Link ist nicht (mehr) gültig.</div>;
  }
  setzeClub(karten.verein && karten.verein.name, karten.verein && karten.verein.logo, karten.verein && karten.verein.farbe, karten.verein && karten.verein.titel);
  const stand = karten.stand ? new Date(karten.stand).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
  const b = plus && plus.saisonBilanz;
  const be = (plus && plus.bereiche) || { bilanz: true, spieltage: true, karten: true, songs: true };
  const bilanzHat = !!plus && !!(b || (plus.torschuetzen && plus.torschuetzen.length > 0) || ((plus.gegnerBilanz && plus.gegnerBilanz.length > 0) || (plus.gegnerBilanzGesamt && plus.gegnerBilanzGesamt.length > 0)));
  const th = { textAlign: "right", padding: "6px 8px", fontSize: 13, color: "var(--muted)", fontWeight: 600 };
  const td = { textAlign: "right", padding: "8px 8px", fontVariantNumeric: "tabular-nums", fontSize: 14 };
  const kopf = (t) => <h3 style={{ ...styles.h3Plain, marginTop: 28 }}>{t}</h3>;
  const tabs = [];
  if (be.bilanz && bilanzHat) tabs.push({ k: "bilanz", label: "Bilanz" });
  if (plus && be.spieltage && plus.spieltage && plus.spieltage.length > 0) tabs.push({ k: "spieltage", label: "Spieltage", n: plus.spieltage.length });
  if (be.karten && karten.spieler.length > 0) tabs.push({ k: "karten", label: "Karten", n: karten.spieler.length });
  if (plus && be.songs && plus.songs && plus.songs.length > 0) tabs.push({ k: "songs", label: "Songs", n: plus.songs.length });
  if (plus && be.briefkasten) tabs.push({ k: "briefkasten", label: "Briefkasten" });
  const aktTab = tab && tabs.some((t) => t.k === tab) ? tab : tabs.length ? tabs[0].k : null;
  const waehle = (k) => { setTab(k); setBesucht((v) => (v[k] ? v : { ...v, [k]: true })); try { window.scrollTo({ top: 0 }); } catch (e) {} };
  // Bereiche bleiben nach dem ersten Öffnen eingebunden (die Musik läuft beim Wechseln weiter)
  const panel = (k, inhalt) => (besucht[k] || aktTab === k ? <div style={{ display: aktTab === k ? "block" : "none" }}>{inhalt}</div> : null);
  return (
    <div style={styles.app}>
      <div style={{ background: "var(--warn-bg)", color: "var(--warn-text)", textAlign: "center", fontSize: 13, fontWeight: 600, padding: "6px 12px" }}>Vorschau – so könnte die nächste Version der Eltern-Seite aussehen. Eltern sehen diese Seite nicht.</div>
      <header className="app-header" style={{ ...styles.header, paddingBottom: 16 }}>
        <div style={{ ...styles.headerTop, maxWidth: 1100, margin: "0 auto" }}>
          <img src={CLUB.logo} alt={CLUB.name} style={styles.crestImg} />
          <div style={{ flex: 1 }}>
            <div style={styles.title}>{CLUB.titel}</div>
            <div style={styles.subtitle}>
              <div>{CLUB.name} {karten.team || "U8"}</div>
              <div>Saison {karten.saison}{stand ? ` · Stand ${stand}` : ""}</div>
            </div>
          </div>
        </div>
      </header>
      {tabs.length > 1 && (
        <nav aria-label="Bereiche" style={{ position: "sticky", top: 0, zIndex: 20, background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "8px 16px", display: "flex", gap: 8, overflowX: "auto", scrollbarWidth: "none" }}>
            {tabs.map((t) => {
              const an = t.k === aktTab;
              return (
                <button key={t.k} onClick={() => waehle(t.k)} aria-current={an ? "page" : undefined}
                  style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 999, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer", border: `1.5px solid ${an ? CLUB.farbe : "var(--border)"}`, background: an ? CLUB.farbe : "var(--surface)", color: an ? "#fff" : "inherit" }}>
                  {t.label}
                  {t.n != null ? <span style={{ fontSize: 13, fontWeight: 600, opacity: an ? 0.9 : 0.6 }}>{t.n}</span> : null}
                </button>
              );
            })}
          </div>
        </nav>
      )}
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "8px 16px 40px" }}>
        {fehler && <div style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 10 }}>{fehler}</div>}
        {!plus && <div style={{ ...styles.card, marginTop: 18 }}>Die erweiterten Daten sind noch nicht veröffentlicht. In der App unter Setup → Spieler „Jetzt aktualisieren“ tippen.</div>}
        {plus && !plus.inaktiv && tabs.length === 0 && <div style={{ ...styles.card, marginTop: 18 }}>Hier gibt es im Moment nichts zu sehen.</div>}
        {plus && (
          <>
            {be.bilanz && bilanzHat && panel("bilanz", (
            <section style={{ ...styles.card, marginTop: 16 }}>
              {b && (<>
              <h3 style={{ ...styles.h3Plain, marginTop: 0 }}>Saisonbilanz {plus.saison}</h3>
              <div style={styles.statsRow}>
                {[["Spiele", b.spiele], ["Siege", b.siege], ["Unentschieden", b.unentschieden], ["Niederlagen", b.niederlagen], ["Tore", `${b.toreFuer}:${b.toreGegen}`]].map(([l, v]) => (
                  <div key={l} style={styles.statBox}>
                    <div style={styles.statValue}>{v}</div>
                    <div style={styles.statLabel}>{l}</div>
                  </div>
                ))}
              </div>
              </>)}
              {plus.torschuetzen.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div style={styles.subheading}>Torschützenliste</div>
                  <div className="nz-tabelle" style={styles.tableWrap}>
                    <table style={styles.table}>
                      <tbody>
                        {plus.torschuetzen.map((t, i) => (
                          <tr key={t.name + i}>
                            <td style={styles.tdName}><span style={styles.rank}>{i + 1}</span>{t.name}</td>
                            <td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>{t.tore}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {(plus.gegnerBilanz.length > 0 || (plus.gegnerBilanzGesamt || []).length > 0) && (
                <GegnerBilanzSeite saison={plus.gegnerBilanz} gesamt={plus.gegnerBilanzGesamt} saisonLabel={karten.saison} />
              )}
            </section>
            ))}
            {be.spieltage && plus.spieltage.length > 0 && panel("spieltage", (
              <section style={{ ...styles.card, marginTop: 16 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20, alignItems: "start" }}>
                  {plus.spieltage.map((t) => (
                    <SpieltagKartenBild key={t.id} tag={t} team={karten.team} onFehler={setFehler} minH={maxH} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
        {be.karten && panel("karten", (
        <section style={{ ...styles.card, marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 20, alignItems: "start" }}>
            {karten.spieler.map((sp) => (
              <KartenBild key={sp.id} sp={sp} saison={karten.saison} team={karten.team || "U8"} onFehler={setFehler} />
            ))}
          </div>
        </section>
        ))}
        {plus && be.songs && plus.songs && plus.songs.length > 0 && panel("songs", (
          <section style={{ ...styles.card, marginTop: 16 }}>
            <SongPlayer songs={plus.songs} cover={plus.cover} team={karten.team} token={token} />
          </section>
        ))}
        {plus && be.briefkasten && panel("briefkasten", (
          <section style={{ ...styles.card, marginTop: 16, position: "relative", maxWidth: 560 }}>
            <BriefkastenFormular token={token} />
          </section>
        ))}
      </main>
    </div>
  );
}

/* Hilfsfunktionen für Tap-Sync (Liedtext → Zeilen, LRC-Zeitstempel) */
const lrcZeit = (t) => { const c = Math.round(Math.max(0, t) * 100); return `[${String(Math.floor(c / 6000)).padStart(2, "0")}:${((c % 6000) / 100).toFixed(2).padStart(5, "0")}]`; };
function reinerLiedtext(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((z) => z.replace(/^\s*\[\d+:\d+(?:[.,]\d+)?\]\s*/, "").trim())
    .filter((z) => z && !/^\[[^\]]*\]$/.test(z));
}
/* Tap-Sync: Song läuft, bei jeder Zeile tippen → exakte Zeitstempel ohne Spracherkennung */
function TapSync({ titel, url, text, onFertig, onAbbruch }) {
  const zeilen = useMemo(() => reinerLiedtext(text), [text]);
  const audioRef = useRef(null);
  const [idx, setIdx] = useState(0);
  const [zeiten, setZeiten] = useState([]);
  const [laeuft, setLaeuft] = useState(false);
  const [tempo, setTempo] = useState(1);
  const stand = useRef({ idx: 0, zeiten: [] });
  stand.current = { idx, zeiten };
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = tempo; }, [tempo]);
  const tap = () => {
    const a = audioRef.current;
    const { idx: k, zeiten: z } = stand.current;
    if (!a || a.paused || k >= zeilen.length) return;
    const t = Math.max(0, a.currentTime - 0.2 * tempo); // Reaktionszeit ausgleichen
    const neu = [...z.slice(0, k), t];
    setZeiten(neu);
    setIdx(k + 1);
    if (k + 1 >= zeilen.length) {
      a.pause();
      onFertig(zeilen.map((zl, q) => lrcZeit(neu[q]) + zl).join("\n"));
    }
  };
  const speichern = () => {
    const { zeiten: z } = stand.current;
    if (z.length === 0) return;
    const a = audioRef.current;
    const ende = a && isFinite(a.duration) ? a.duration : z[z.length - 1] + 3 * (zeilen.length - z.length);
    const start = z[z.length - 1];
    const rest = zeilen.length - z.length;
    const voll = zeilen.map((zl, q) => lrcZeit(q < z.length ? z[q] : start + ((Math.max(ende - 1, start + 1) - start) * (q - z.length + 1)) / (rest + 1)) + zl);
    if (a) a.pause();
    onFertig(voll.join("\n"));
  };
  const zurueck = () => {
    const { idx: k, zeiten: z } = stand.current;
    if (k <= 0) return;
    const a = audioRef.current;
    if (a) a.currentTime = Math.max(0, (z[k - 1] || 0) - 2);
    setZeiten(z.slice(0, k - 1));
    setIdx(k - 1);
  };
  const startStop = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  useEffect(() => {
    const h = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.code === "Space" || e.key === "Enter") { e.preventDefault(); tap(); }
    };
    const hUp = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.code === "Space") e.preventDefault(); // verhindert, dass ein fokussierter Button per Leertaste ausgelöst wird
    };
    window.addEventListener("keydown", h);
    window.addEventListener("keyup", hUp);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("keyup", hUp); };
  }, [zeilen]);
  const zeile = (k, stil) => (k >= 0 && k < zeilen.length ? <div style={stil}>{zeilen[k]}</div> : <div style={stil}>&nbsp;</div>);
  return (
    <div style={{ margin: "8px 0", padding: 12, border: "1px solid var(--border)", borderRadius: 12 }}>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>
        Tap-Sync „{titel}“: Song starten und bei jeder Zeile genau dann auf den großen Button tippen (oder Leertaste), wenn sie anfängt. Kopfhörer empfohlen. Zeile {Math.min(idx + 1, zeilen.length)} von {zeilen.length}.
      </div>
      <audio ref={audioRef} src={url} preload="auto" onPlay={() => setLaeuft(true)} onPause={() => setLaeuft(false)} onEnded={() => setLaeuft(false)} />
      <div style={{ textAlign: "center", minHeight: 110 }}>
        {idx > 0 ? (
          <div style={{ fontSize: 16, fontWeight: 700, color: CLUB.farbe }}>♪ {zeilen[idx - 1]} <span style={{ fontWeight: 500, fontSize: 13, color: "var(--muted)" }}>(getippt)</span></div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>&nbsp;</div>
        )}
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Als Nächstes tippen, sobald diese Zeile anfängt</div>
        {zeile(idx, { fontSize: 20, fontWeight: 700, margin: "2px 0 6px" })}
        {zeile(idx + 1, { fontSize: 14, color: "var(--muted)" })}
        {zeile(idx + 2, { fontSize: 13, color: "var(--muted)", opacity: 0.6 })}
      </div>
      <button onPointerDown={(e) => { e.preventDefault(); tap(); }} style={{ width: "100%", padding: "22px 0", fontSize: 20, fontWeight: 700, borderRadius: 12, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", touchAction: "manipulation", userSelect: "none" }}>
        {laeuft ? "TAP – Zeile beginnt jetzt" : idx > 0 ? "Pausiert – unten „Start / Weiter“" : "Erst Song starten ▶ (Button unten)"}
      </button>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button style={styles.linkBtn} onClick={(e) => { e.currentTarget.blur(); startStop(); }}>{laeuft ? "Pause" : "Start / Weiter"}</button>
        <button style={styles.linkBtn} onClick={zurueck} disabled={idx === 0}>↶ Eine Zeile zurück</button>
        <button style={{ ...styles.linkBtn, fontWeight: 700 }} onClick={speichern} disabled={idx === 0}>Fertig &amp; speichern ({idx}/{zeilen.length})</button>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>
          Tempo{" "}
          <select value={tempo} onChange={(e) => setTempo(parseFloat(e.target.value))} style={{ fontSize: 13 }}>
            <option value={1}>normal</option>
            <option value={0.85}>85 %</option>
            <option value={0.7}>70 %</option>
          </select>
        </span>
        <button style={styles.linkBtn} onClick={onAbbruch}>Abbrechen</button>
      </div>
    </div>
  );
}

/* Verwaltung → Spieler: Link für die Eltern erzeugen, kopieren, aktualisieren, sperren */
function KartenLinkBox({ token, altTokens = [], onAltOff, onCreate, onRevoke, onRefresh, voll, onToggleVoll, busy, songs = [], onSongAdd, onSongChange }) {
  const [kopiert, setKopiert] = useState(false);
  const url = token ? kartenLinkUrl(token) : "";
  const urlVorschau = token ? kartenLinkUrlVorschau(token) : "";
  const [kopiertV, setKopiertV] = useState(false);
  const [linkName, setLinkName] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [textEdit, setTextEdit] = useState(null);
  const [sync, setSync] = useState(null);
  const [tapI, setTapI] = useState(null);
  const kopierText = async (text, setFlag) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlag(true);
      setTimeout(() => setFlag(false), 2000);
    } catch (e) {
      frageAnd("Link kopieren", text, () => {});
    }
  };
  const codeSauber = linkCode.toLowerCase().replace(/[^a-z0-9]/g, "");
  const namenSetzen = () => {
    if (codeSauber && codeSauber.length < 5) { meldung("Der Code braucht mindestens 5 Zeichen (Buchstaben und Ziffern) oder bleibt leer für einen Zufallscode.", "error"); return; }
    const los = () => { onCreate(linkName, codeSauber); setLinkName(""); setLinkCode(""); };
    const mitAlt = () => (token ? confirmAnd("Neuer Link: Der bisherige Link bleibt vorerst weiter aktiv und kann unten abgeschaltet werden. Fortfahren?", los) : los());
    if (codeSauber && /^[0-9]+$/.test(codeSauber)) confirmAnd("Ein Code nur aus Ziffern ist leichter zu erraten. Trotzdem verwenden?", mitAlt);
    else mitAlt();
  };
  const namensFelder = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="Link-Name, z. B. Saison 26" style={{ ...styles.textarea, marginTop: 0, fontSize: 13, flex: 2, minWidth: 160 }} />
      <input value={linkCode} onChange={(e) => setLinkCode(e.target.value)} placeholder="Code (leer = zufällig)" maxLength={12} style={{ ...styles.textarea, marginTop: 0, fontSize: 13, flex: 1, minWidth: 120 }} />
      <button style={styles.linkBtn} onClick={() => setLinkCode(zufallsCode())} disabled={busy}>Würfeln</button>
      <button style={token ? styles.linkBtn : styles.rowBtn} onClick={namenSetzen} disabled={busy || !linkName.trim()}>{token ? "Link ändern" : "Link erzeugen"}</button>
    </div>
  );
  return (
    <section>
    <div style={{ ...styles.card, marginBottom: 12 }}>
      <KartenTitel>Link für Eltern</KartenTitel>
      <div style={{ fontSize: 14, lineHeight: 1.45, color: "var(--text)", marginBottom: 12 }}>
        Eine Seite mit Saisonbilanz, Spieltagskarten, Sammelkarten und Mannschaftssongs. Wer den Link hat, sieht sie ohne Anmeldung; die Werte aktualisieren sich automatisch, sobald in der App etwas geändert wurde.
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={voll} onChange={onToggleVoll} disabled={busy} />
        Nachname und Geburtsdatum auf den Karten anzeigen (sonst nur Vorname und Alter)
      </label>
      {token ? (
        <>
          <input readOnly value={url} onFocus={(e) => e.target.select()} style={{ ...styles.textarea, marginTop: 0, fontSize: 13 }} />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
            <button style={styles.linkBtn} onClick={() => kopierText(url, setKopiert)}>{kopiert ? "Kopiert ✓" : "Link kopieren"}</button>
            <button style={styles.linkBtn} onClick={onRefresh} disabled={busy}>Jetzt aktualisieren</button>
            <button style={styles.linkBtn} onClick={() => window.open(url, "_blank")}>Öffnen</button>
            <button style={{ ...styles.linkBtn, ...styles.dangerBtn }} onClick={onRevoke} disabled={busy}>Alle Links sperren</button>
          </div>
          <div style={{ marginTop: 12 }}>{namensFelder}</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>Der Link besteht aus Name und Code (mind. 5 Zeichen, Buchstaben/Ziffern), damit er nicht zu erraten ist.</div>
          {altTokens.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <div style={{ color: "var(--muted)", marginBottom: 4 }}>Frühere Links (funktionieren weiter, zeigen dieselbe Seite):</div>
              {altTokens.map((t) => (
                <div key={t} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "2px 0" }}>
                  <span style={{ wordBreak: "break-all" }}>{kartenLinkUrl(t)}</span>
                  <button style={{ ...styles.linkBtn, ...styles.dangerBtn }} onClick={() => confirmAnd("Diesen alten Link abschalten? Eltern, die ihn gespeichert haben, sehen dann nichts mehr.", () => onAltOff(t))} disabled={busy}>Abschalten</button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        namensFelder
      )}
    </div>
    {token && (
      <>
    <div style={{ ...styles.card, marginBottom: 12 }}>
          <div>
            <KartenTitel>Vorschau-Link (zum Testen)</KartenTitel>
            <div style={{ fontSize: 14, lineHeight: 1.45, color: "var(--text)", marginBottom: 10 }}>
              Hier siehst du Änderungen an der Eltern-Seite, bevor sie freigegeben werden. Gleiche Daten wie der Eltern-Link, nur eine andere Darstellung. Eltern sehen sie nicht.
            </div>
            <input readOnly value={urlVorschau} onFocus={(e) => e.target.select()} style={{ ...styles.textarea, marginTop: 0, fontSize: 13 }} />
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
              <button style={styles.linkBtn} onClick={() => kopierText(urlVorschau, setKopiertV)}>{kopiertV ? "Kopiert ✓" : "Link kopieren"}</button>
              <button style={styles.linkBtn} onClick={() => window.open(urlVorschau, "_blank")}>Öffnen</button>
            </div>
          </div>
    </div>
    <div style={{ ...styles.card, marginBottom: 12 }}>
          <div>
            <KartenTitel>Mannschaftssongs (Player auf der Eltern-Seite)</KartenTitel>
            {songs.map((x, i) => (
              <div key={x.pfad} style={{ fontSize: 14, padding: "8px 0", borderTop: i ? "1px solid var(--divider)" : "none" }}>
                <div style={{ marginBottom: 4 }}>{i + 1}. {x.titel}</div>
                <div style={{ display: "flex", gap: "4px 10px", alignItems: "center", flexWrap: "wrap" }}>
                <button style={{ ...styles.linkBtn, padding: "4px 2px" }} disabled={busy || i === 0} onClick={() => onSongChange(i, "hoch")}>↑</button>
                <button style={{ ...styles.linkBtn, padding: "4px 2px", marginLeft: -8 }} disabled={busy || i === songs.length - 1} onClick={() => onSongChange(i, "runter")}>↓</button>
                <button style={styles.linkBtn} disabled={busy} onClick={() => onSongChange(i, "umbenennen")}>Umbenennen</button>
                <button style={styles.linkBtn} disabled={busy} onClick={() => { setTextEdit(textEdit && textEdit.i === i ? null : { i, val: x.text || "" }); }}>{x.text ? "Text ✓" : "Text"}</button>
                <button style={styles.linkBtn} disabled={busy} onClick={() => { if (!(x.text || "").trim()) { setSync({ i, msg: "Bitte zuerst über „Text“ den Liedtext eintragen und speichern.", fehler: true }); return; } setTextEdit(null); setTapI(i); }}>Tap-Sync</button>
                <button style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center" }} disabled={busy} aria-label="Löschen" title="Löschen" onClick={() => onSongChange(i, "loeschen")}><TrashIcon size={15} /></button>
                </div>
              </div>
            ))}
            {sync && (
              <div style={{ fontSize: 13, margin: "6px 0", color: sync.fehler ? "var(--danger-text)" : "var(--muted)" }}>
                {songs[sync.i] ? `„${songs[sync.i].titel}“: ` : ""}{sync.msg}
                {(!sync.fertig && !sync.fehler) ? null : (
                  <button style={{ ...styles.linkBtn, marginLeft: 8 }} onClick={() => setSync(null)}>OK</button>
                )}
              </div>
            )}
            <div style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0" }}>
              Liedtext zuerst über „Text“ eintragen, am besten am Laptop. Tap-Sync dauert so lange wie der Song.
            </div>
            {tapI != null && songs[tapI] && (
              <TapSync key={songs[tapI].pfad} titel={songs[tapI].titel} url={songUrl(songs[tapI].pfad)} text={songs[tapI].text}
                onAbbruch={() => setTapI(null)}
                onFertig={async (lrc) => { const k = tapI; setTapI(null); await onSongChange(k, "text", lrc); setTextEdit({ i: k, val: lrc }); setSync({ i: k, msg: "Tap-Sync fertig und gespeichert. Im Textfeld unten kannst du die Zeiten bei Bedarf prüfen.", fertig: true }); }} />
            )}
            {textEdit && songs[textEdit.i] && (
              <div style={{ margin: "6px 0 8px" }}>
                <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Text zu „{songs[textEdit.i].titel}“ – normal oder mit Zeitstempeln [mm:ss.xx] pro Zeile (dann läuft der Text im Player mit)</div>
                <textarea value={textEdit.val} onChange={(e) => setTextEdit({ ...textEdit, val: e.target.value })} rows={6} style={{ ...styles.textarea, marginTop: 0, width: "100%" }} />
                <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                  <button style={styles.linkBtn} disabled={busy} onClick={() => { onSongChange(textEdit.i, "text", textEdit.val); setTextEdit(null); }}>Speichern</button>
                  <button style={styles.linkBtn} onClick={() => setTextEdit(null)}>Abbrechen</button>
                </div>
              </div>
            )}
            <label style={{ ...styles.linkBtn, display: "inline-block", marginTop: 6, cursor: "pointer" }}>
              + Song hochladen (MP3)
              <input type="file" accept="audio/*,.mp3,.m4a,.wav" multiple style={{ display: "none" }} disabled={busy}
                onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ""; if (f.length) onSongAdd(f); }} />
            </label>
          </div>
    </div>
      </>
    )}
    </section>
  );
}

/* Kleine Linien-Icons für die Kennzahlen (24x24): Fußballschuh = Training, Pokal = Spieltag */
const STAT_ICONS = {
  schuh: { fill: "M3 6h6l1.5 3.5 6.5 1.5c2.5.6 4 1.8 4 3.5V16H3z", lines: ["M6 16v3", "M10.5 16v3", "M15 16v3", "M19 16v2.5", "M11.5 12l1.5-1.5", "M14.5 12.8l1.5-1.5"] },
  ball: { fill: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", lines: ["M12 8.5l3.2 2.3-1.2 3.7h-4l-1.2-3.7z", "M12 8.5V3.3", "M15.2 10.8l5-1.6", "M14 14.5l3 4.1", "M10 14.5l-3 4.1", "M8.8 10.8l-5-1.6"] },
  daumenHoch: { fill: "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z", lines: ["M7 10v12"] },
  daumenMitte: { fill: "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z", lines: ["M7 10v12"], rot: -90 },
  daumenRunter: { fill: "M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z", lines: ["M17 14V2"] },
  pokal: { fill: "M7 3h10v5.5a5 5 0 0 1-10 0z", lines: ["M7 5H4v2a3 3 0 0 0 3 3", "M17 5h3v2a3 3 0 0 1-3 3", "M12 13.5V18", "M10 18h4", "M8.5 21h7"] },
};
function StatIcon({ name, size = 15, color = "var(--gold)", aktiv = true }) {
  const d = STAT_ICONS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={aktiv ? color : "rgba(255,255,255,0.28)"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flexShrink: 0 }} aria-hidden="true">
      <path d={d.fill} fill={aktiv ? color : "none"} fillOpacity="0.25" />
      {d.lines.map((l, i) => <path key={i} d={l} />)}
    </svg>
  );
}
function zeichneStatIcon(ctx, name, x, y, size, aktiv = true, farbe = "#F7C65C") {
  const d = STAT_ICONS[name];
  if (!d) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  if (d.rot) {
    ctx.translate(12, 12);
    ctx.rotate((d.rot * Math.PI) / 180);
    ctx.translate(-12, -12);
  }
  ctx.strokeStyle = aktiv ? farbe : "rgba(255,255,255,0.28)";
  ctx.fillStyle = farbe + "40";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const f = new Path2D(d.fill);
  if (aktiv) ctx.fill(f);
  ctx.stroke(f);
  d.lines.forEach((l) => ctx.stroke(new Path2D(l)));
  ctx.restore();
}

async function generateSammelkarte(player, stats, saisonLabel, teamName) {
  try {
    await Promise.all([
      document.fonts.load("800 64px 'Space Grotesk'"),
      document.fonts.load("700 40px 'Space Grotesk'"),
      document.fonts.load("700 26px 'Inter'"),
    ]);
  } catch (e) {}

  const W = 750;
  const H = 1130;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "alphabetic";

  const goldGrad = ctx.createLinearGradient(0, 0, W, H);
  goldGrad.addColorStop(0, "#F7C65C");
  goldGrad.addColorStop(0.5, "#F2A93B");
  goldGrad.addColorStop(1, "#E08C1E");

  // Rahmen + Hintergrund
  roundRectPath(ctx, 0, 0, W, H, 44);
  ctx.fillStyle = goldGrad;
  ctx.fill();
  roundRectPath(ctx, 14, 14, W - 28, H - 28, 34);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#A3181C");
  bg.addColorStop(1, "#4E0A0C");
  ctx.fillStyle = bg;
  ctx.fill();

  // Foto-Fenster
  const px = 48, py = 48, pw = W - 96, ph = 536;
  ctx.save();
  roundRectPath(ctx, px, py, pw, ph, 26);
  ctx.clip();
  let fotoOk = false;
  if (player.photo_url) {
    try {
      let img;
      const hdUrl = String(player.photo_url).replace(/\/players\/([^/?]+)\.jpg/, "/players/$1-hd.jpg");
      try {
        img = hdUrl !== player.photo_url ? await loadImageCrossOrigin(hdUrl) : null;
      } catch (e) {
        img = null;
      }
      if (!img) img = await loadImageCrossOrigin(player.photo_url);
      ctx.imageSmoothingQuality = "high";
      const scale = Math.max(pw / img.naturalWidth, ph / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh);
      fotoOk = true;
    } catch (e) {}
  }
  if (!fotoOk) {
    const g = ctx.createLinearGradient(px, py, px + pw, py + ph);
    g.addColorStop(0, CLUB.farbe);
    g.addColorStop(1, farbMix(hexRgb(CLUB.farbe), [0, 0, 0], 0.28));
    ctx.fillStyle = g;
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "center";
    ctx.font = "800 260px 'Space Grotesk', sans-serif";
    ctx.fillText((player.name || "?").slice(0, 1).toUpperCase(), px + pw / 2, py + ph / 2 + 90);
  }
  // Verlauf unten im Foto
  const vl = ctx.createLinearGradient(0, py + ph - 200, 0, py + ph);
  vl.addColorStop(0, "rgba(20,8,8,0)");
  vl.addColorStop(1, "rgba(20,8,8,0.55)");
  ctx.fillStyle = vl;
  ctx.fillRect(px, py + ph - 200, pw, 200);
  ctx.restore();
  roundRectPath(ctx, px, py, pw, ph, 26);
  ctx.lineWidth = 6;
  ctx.strokeStyle = goldGrad;
  ctx.stroke();

  // Trikotnummer (Badge oben links im Foto)
  if (player.trikotnummer != null) {
    const bx = px + 22, by = py + 22, bw = 118, bh = 118;
    roundRectPath(ctx, bx, by, bw, bh, 24);
    ctx.fillStyle = "rgba(78,10,12,0.82)";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = goldGrad;
    ctx.stroke();
    ctx.fillStyle = "#F2A93B";
    ctx.textAlign = "center";
    ctx.font = "800 68px 'Space Grotesk', sans-serif";
    ctx.fillText(String(player.trikotnummer), bx + bw / 2, by + 78);
    ctx.font = "700 17px 'Inter', sans-serif";
    ctx.fillText("TRIKOT", bx + bw / 2, by + 104);
  }

  // Vereinslogo oben rechts im Foto
  try {
    const logo = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.crossOrigin = "anonymous";
      im.src = CLUB.logo;
    });
    const lh = 104;
    const lw = Math.round(lh * (logo.naturalWidth / logo.naturalHeight));
    ctx.drawImage(logo, px + pw - lw - 24, py + 22, lw, lh);
  } catch (e) {}

  // Namensband
  // Spitzname / Spruch als Schleife über der Foto-Unterkante
  if (player.spitzname && String(player.spitzname).trim()) {
    const txt = `„${String(player.spitzname).trim()}“`;
    ctx.font = "italic 700 28px 'Inter', sans-serif";
    const tw = Math.min(ctx.measureText(txt).width, pw - 120);
    const bw2 = tw + 56;
    const bh2 = 46;
    const bx2 = (W - bw2) / 2;
    const by2 = py + ph - bh2 / 2;
    roundRectPath(ctx, bx2, by2, bw2, bh2, 23);
    ctx.fillStyle = "#4E0A0C";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#F2A93B";
    ctx.stroke();
    ctx.fillStyle = "#F7C65C";
    ctx.textAlign = "center";
    ctx.fillText(truncateCanvasText(ctx, txt, pw - 120), W / 2, by2 + 32);
  }

  const ny = py + ph + 26;
  const nh = 132;
  roundRectPath(ctx, px, ny, pw, nh, 22);
  ctx.fillStyle = goldGrad;
  ctx.fill();
  ctx.fillStyle = "#3A2304";
  ctx.textAlign = "center";
  const vor = (player.name || "").toUpperCase();
  const nach = (player.nachname || "").toUpperCase();
  ctx.font = "800 54px 'Space Grotesk', sans-serif";
  ctx.fillText(truncateCanvasText(ctx, vor, pw - 40), W / 2, ny + (nach ? 62 : 82));
  if (nach) {
    ctx.font = "700 40px 'Space Grotesk', sans-serif";
    ctx.fillText(truncateCanvasText(ctx, nach, pw - 40), W / 2, ny + 110);
  }

  // Untertitel: Geburtsdatum / Alter
  let untertitel = player.alter != null ? `${player.alter} Jahre` : CLUB.name.toUpperCase() + " " + teamName;
  if (player.geburtsdatum) {
    const alter = alterVonGeburtsdatum(String(player.geburtsdatum).slice(0, 10));
    untertitel = `Geboren ${formatGeburtsdatum(player.geburtsdatum)}` + (alter != null ? ` · ${alter} Jahre` : "");
  }
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "600 25px 'Inter', sans-serif";
  ctx.fillText(untertitel, W / 2, ny + nh + 40);

  // Werte (2 x 2)
  const sy = ny + nh + 70;
  const cols = 2;
  const cellW = pw / cols;
  const cellH = 78;
  stats.slice(0, 6).forEach((st, i) => {
    const cx = px + (i % cols) * cellW;
    const cy = sy + Math.floor(i / cols) * cellH;
    roundRectPath(ctx, cx + 6, cy, cellW - 12, cellH - 10, 16);
    ctx.fillStyle = "rgba(255,255,255,0.09)";
    ctx.fill();
    if (st.karten) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "700 15px 'Inter', sans-serif";
      ctx.fillText(st.kurz || st.label, cx + cellW / 2, cy + 21);
      const farben = [["gelb", "#F2C21B"], ["blau", "#2F6FDB"], ["rot", "#D32F2F"]];
      const grp = 78;
      const gx0 = cx + (cellW - grp * 3) / 2;
      farben.forEach(([k, f], j) => {
        const gx = gx0 + j * grp;
        roundRectPath(ctx, gx + 6, cy + 29, 17, 24, 3);
        ctx.fillStyle = f;
        ctx.fill();
        ctx.fillStyle = "#F2A93B";
        ctx.textAlign = "left";
        ctx.font = "800 28px 'Space Grotesk', sans-serif";
        ctx.fillText(String(st.karten[k] || 0), gx + 32, cy + 52);
      });
      return;
    }
    if (st.daumen !== undefined) {
      // Trainingsform (Monat) als Daumen: ab 85 % hoch, 50-84 % Mitte, darunter runter
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "700 15px 'Inter', sans-serif";
      ctx.fillText(st.kurz || st.label, cx + cellW / 2, cy + 21);
      if (st.daumen == null) {
        ctx.fillStyle = "#F2A93B";
        ctx.font = "800 28px 'Space Grotesk', sans-serif";
        ctx.fillText("–", cx + cellW / 2, cy + 52);
      } else {
        const [ic, fb] = st.daumen >= 85 ? ["daumenHoch", "#7BD88F"] : st.daumen >= 50 ? ["daumenMitte", "#F7C65C"] : ["daumenRunter", "#FF8A8A"];
        zeichneStatIcon(ctx, ic, cx + cellW / 2 - 17, cy + 25, 34, true, fb);
      }
      return;
    }
    if (st.icon && st.prozent != null) {
      // Anteil als 5 Icons (je 20 %)
      const voll = Math.max(0, Math.min(5, Math.round(st.prozent / 20)));
      const isz = 28;
      const gap = 12;
      const gesamt = 5 * isz + 4 * gap;
      const x0 = cx + (cellW - gesamt) / 2;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "700 15px 'Inter', sans-serif";
      ctx.fillText(st.kurz || st.label, cx + cellW / 2, cy + 21);
      for (let k = 0; k < 5; k++) zeichneStatIcon(ctx, st.icon, x0 + k * (isz + gap), cy + 27, isz, k < voll);
      return;
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "#F2A93B";
    ctx.font = "800 38px 'Space Grotesk', sans-serif";
    ctx.fillText(String(st.value), cx + 26, cy + 46);
    const vw = ctx.measureText(String(st.value)).width;
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "700 19px 'Inter', sans-serif";
    ctx.fillText(st.label, cx + 26 + vw + 12, cy + 45);
  });

  // Fußzeile
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "700 20px 'Inter', sans-serif";
  ctx.fillText(`${CLUB.name.toUpperCase()} ${teamName}${saisonLabel ? " · SAISON " + saisonLabel : ""}`, W / 2, H - 38);

  // Glanzeffekt
  ctx.save();
  roundRectPath(ctx, 14, 14, W - 28, H - 28, 34);
  ctx.clip();
  const shine = ctx.createLinearGradient(0, 0, W, H * 0.7);
  shine.addColorStop(0, "rgba(255,255,255,0.14)");
  shine.addColorStop(0.35, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Sammelkarte konnte nicht erstellt werden."))), "image/png")
  );
}

// Erzeugt das WhatsApp-Teilen-Bild eines Spieltags (nur Mannschaftsfoto + Ergebnisse),
// Hochformat 1080px breit, Höhe passt sich der Anzahl der Spiele an.
async function generateSpieltagShareImage(spieltag, nummer, gegnerListe, players, opts) {
  try {
    await Promise.all([
      document.fonts.load("800 46px 'Space Grotesk'"),
      document.fonts.load("700 26px 'Inter'"),
      document.fonts.load("600 22px 'Inter'"),
    ]);
  } catch (e) {
    // Fallback-Fonts sind ok, falls das Laden fehlschlägt
  }

  const W = 1080;
  // Gleiches Seitenverhältnis wie beim Zuschneiden des Spieltag-Fotos (TeamHero, height=300 bei 390 Breite),
  // damit das Foto hier nicht nochmal anders (und schlechter) zugeschnitten wird.
  const photoH = Math.round((W * 300) / 390);
  const padding = 44;
  const gap = 20;
  const tileW = (W - padding * 2 - gap) / 2;
  const tileH = 150;
  const gridY = photoH + 110;
  const anzahlSpiele = spieltag.spiele.length;
  const rows = anzahlSpiele > 0 ? Math.ceil(anzahlSpiele / 2) : 0;

  // Torschützen je Spiel als umgebrochene Zeilen (Messung über temporäres Canvas)
  const messCtx = document.createElement("canvas").getContext("2d");
  messCtx.font = "600 22px 'Inter', sans-serif";
  const scorerMaxW = tileW - 48;
  const spielerNameFn = (id) => (players || []).find((p) => p.id === id)?.name || "Unbekannt";
  const scorerLines = spieltag.spiele.map((sp) => {
    const teile = (sp.scorers || []).map((sc) => (sc.tore > 1 ? `${spielerNameFn(sc.playerId)} (${sc.tore})` : spielerNameFn(sc.playerId)));
    if (teile.length === 0) return [];
    const woerter = teile.join(", ").split(" ");
    const lines = [];
    let cur = "";
    woerter.forEach((w) => {
      const test = cur ? cur + " " + w : w;
      if (cur && messCtx.measureText(test).width > scorerMaxW) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    });
    if (cur) lines.push(cur);
    return lines;
  });
  const scorerLineH = 30;
  const tileHeightOf = (i) => (scorerLines[i].length > 0 ? tileH + 4 + scorerLines[i].length * scorerLineH : tileH);
  const rowHeights = [];
  for (let r = 0; r < rows; r++) {
    rowHeights.push(Math.max(tileHeightOf(r * 2), r * 2 + 1 < anzahlSpiele ? tileHeightOf(r * 2 + 1) : 0));
  }
  const rowYs = [];
  let accY = gridY;
  rowHeights.forEach((h) => {
    rowYs.push(accY);
    accY += h + gap;
  });
  const inhaltsEnde = anzahlSpiele > 0 ? accY - gap : photoH + 170;
  const H = Math.max(1300, Math.round(inhaltsEnde + 44), (opts && opts.minH) || 0);
  if (opts && opts.nurHoehe) return H;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#F7F4F3";
  ctx.fillRect(0, 0, W, H);

  if (spieltag.fotoUrl) {
    try {
      const img = await loadImageCrossOrigin(spieltag.fotoUrl);
      const scale = Math.max(W / img.naturalWidth, photoH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (W - dw) / 2;
      const dy = (photoH - dh) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, photoH);
      ctx.clip();
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.restore();
    } catch (e) {
      throw new Error("Mannschaftsfoto konnte nicht geladen werden (CORS). Bitte Foto neu hochladen oder Supabase-Storage-CORS prüfen.");
    }
  } else {
    const grad = ctx.createLinearGradient(0, 0, W, photoH);
    grad.addColorStop(0, CLUB.farbe);
    grad.addColorStop(1, farbMix(hexRgb(CLUB.farbe), [0, 0, 0], 0.28));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, photoH);
  }

  const verlauf = ctx.createLinearGradient(0, photoH - 250, 0, photoH);
  verlauf.addColorStop(0, "rgba(28,20,20,0)");
  verlauf.addColorStop(1, "rgba(20,13,13,0.82)");
  ctx.fillStyle = verlauf;
  ctx.fillRect(0, photoH - 250, W, 250);

  // Vereinslogo (Data-URI, daher kein CORS-Problem) + Teamname
  const logoH = 120;
  const logoX = padding;
  const logoY = 32;
  let logoW = Math.round(logoH * 198 / 240);
  try {
    const logoImg = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.crossOrigin = "anonymous";
      im.src = CLUB.logo;
    });
    logoW = Math.round(logoH * (logoImg.naturalWidth / logoImg.naturalHeight));
    ctx.drawImage(logoImg, logoX, logoY, logoW, logoH);
  } catch (e) {
    // Ohne Logo weiter, nur den Teamnamen anzeigen
  }
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "800 56px 'Space Grotesk', sans-serif";
  ctx.fillText((opts && opts.teamName) || TEAM_NAME, logoX + logoW + 20, logoY + logoH / 2 + 2);

  const bezeichnung = spieltagLabel(spieltag, nummer);
  const datumFormatiert = new Date(spieltag.date + "T00:00:00").toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const zeile = `${bezeichnung} · ${datumFormatiert}${spieltag.zeit ? ` · ${spieltag.zeit} Uhr` : ""}${spieltag.ort ? ` · ${spieltag.ort}` : ""}`;
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.textBaseline = "alphabetic";
  ctx.font = "700 24px 'Inter', sans-serif";
  ctx.fillText(zeile.toUpperCase(), padding, photoH - 40);

  ctx.fillStyle = "#1C2B22";
  ctx.font = "800 46px 'Space Grotesk', sans-serif";
  ctx.fillText("Unsere Ergebnisse", padding, photoH + 80);

  const gegnerName = (id) => (gegnerListe || []).find((g) => g.id === id)?.name || "Unbekannt";

  if (anzahlSpiele > 0) {
    spieltag.spiele.forEach((sp, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = padding + col * (tileW + gap);
      const y = rowYs[row];
      const tileHi = rowHeights[row];
      let bg, farbe;
      if (sp.ourGoals > sp.theirGoals) {
        bg = "#E8F3E8";
        farbe = "#2E7D32";
      } else if (sp.ourGoals < sp.theirGoals) {
        bg = "#FBEAEA";
        farbe = "#C62828";
      } else {
        bg = "#F2EFE9";
        farbe = "#76595A";
      }
      roundRectPath(ctx, x, y, tileW, tileHi, 18);
      ctx.fillStyle = bg;
      ctx.fill();

      ctx.fillStyle = "#1C2B22";
      ctx.font = "700 26px 'Inter', sans-serif";
      ctx.fillText(truncateCanvasText(ctx, gegnerName(sp.opponentId), tileW - 32), x + 24, y + 48);

      ctx.fillStyle = farbe;
      ctx.font = "800 52px 'Space Grotesk', sans-serif";
      ctx.fillText(`${sp.ourGoals} : ${sp.theirGoals}`, x + 24, y + 112);

      if (scorerLines[i].length > 0) {
        ctx.fillStyle = "#5A4A4A";
        ctx.font = "600 22px 'Inter', sans-serif";
        scorerLines[i].forEach((line, li) => {
          ctx.fillText(line, x + 24, y + 150 + li * scorerLineH);
        });
      }
    });
  } else {
    ctx.fillStyle = "#B08A8A";
    ctx.font = "600 24px 'Inter', sans-serif";
    ctx.fillText("Noch keine Ergebnisse erfasst", padding, photoH + 140);
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Bild konnte nicht erstellt werden."))), "image/png")
  );
}

function ImageCropModal({ file, aspect, onCancel, onConfirm }) {
  const karteRef = useDialogFokus(onCancel);
  const [frameSize, setFrameSize] = useState({ w: 320, h: 320 / aspect });
  const [imgEl, setImgEl] = useState(null);
  const [baseScale, setBaseScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const dragRef = useRef(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setImgEl(img);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const update = () => {
      const w = Math.min(360, window.innerWidth - 80);
      setFrameSize({ w, h: w / aspect });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [aspect]);

  const clamp = (p, z, size) => {
    if (!imgEl) return p;
    const scale = baseScale * z;
    const dw = imgEl.naturalWidth * scale;
    const dh = imgEl.naturalHeight * scale;
    const minX = size.w - dw;
    const minY = size.h - dh;
    return { x: Math.min(0, Math.max(minX, p.x)), y: Math.min(0, Math.max(minY, p.y)) };
  };

  useEffect(() => {
    if (!imgEl) return;
    const scale = Math.max(frameSize.w / imgEl.naturalWidth, frameSize.h / imgEl.naturalHeight);
    setBaseScale(scale);
    setZoom(1);
    const dw = imgEl.naturalWidth * scale;
    const dh = imgEl.naturalHeight * scale;
    setPos({ x: (frameSize.w - dw) / 2, y: (frameSize.h - dh) / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgEl, frameSize.w, frameSize.h]);

  const onPointerDown = (e) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPos(clamp({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }, zoom, frameSize));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onZoomChange = (z) => {
    setZoom(z);
    setPos((p) => clamp(p, z, frameSize));
  };

  const handleConfirm = async () => {
    if (!imgEl) return;
    setSaving(true);
    try {
      const scale = baseScale * zoom;
      const srcX = -pos.x / scale;
      const srcY = -pos.y / scale;
      const srcW = frameSize.w / scale;
      const srcH = frameSize.h / scale;
      const outW = 1200;
      const outH = Math.round(outW / aspect);
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Bild konnte nicht verarbeitet werden."))), "image/jpeg", 0.88)
      );
      await onConfirm(blob);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.modalOverlay} onClick={onCancel}>
      <div ref={karteRef} role="dialog" aria-modal="true" aria-label="Bildausschnitt wählen" style={{ ...styles.modalCard, maxWidth: frameSize.w + 40 }} onClick={(e) => e.stopPropagation()}>
        <p style={{ ...styles.modalText, marginBottom: 10 }}>
          Bildausschnitt wählen — ziehen zum Verschieben, Regler zum Zoomen.
        </p>
        <div
          style={{
            position: "relative",
            width: frameSize.w,
            height: frameSize.h,
            overflow: "hidden",
            borderRadius: 12,
            background: "#111",
            touchAction: "none",
            cursor: "grab",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {imgEl ? (
            <img
              src={imgEl.src}
              draggable={false}
              alt=""
              style={{
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: imgEl.naturalWidth * baseScale * zoom,
                height: imgEl.naturalHeight * baseScale * zoom,
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#fff", fontSize: 13 }}>
              Lädt …
            </div>
          )}
        </div>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => onZoomChange(Number(e.target.value))}
          style={{ ...styles.range, marginTop: 14, width: "100%" }}
          disabled={!imgEl}
        />
        <div style={styles.modalActions}>
          <button style={styles.rowBtnOutline} onClick={onCancel} disabled={saving}>
            Abbrechen
          </button>
          <button style={styles.rowBtn} onClick={handleConfirm} disabled={!imgEl || saving}>
            {saving ? "Speichert …" : "Übernehmen"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TeamHero({ photoUrl, teamName, seasonLabel, subtitle, onUploadFoto, height = 360, marginBottom = 20, titleSize = 22, titleAbove = false }) {
  const fileInputRef = useRef(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [cropAspect, setCropAspect] = useState(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const bannerAspect = 390 / height;

  return (
    <>
    <div className={titleAbove ? "team-hero" : undefined} style={titleAbove ? { marginBottom } : undefined}>
    {titleAbove && (
      <div className="hero-kopf" style={{ fontSize: 13, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: "16px", marginBottom: 8 }}>
        Mannschaft
      </div>
    )}
    <div style={titleAbove ? { padding: 3, borderRadius: 21, background: "linear-gradient(135deg, var(--gold), var(--gold-2))" } : undefined}>
    <div
      className={titleAbove ? undefined : "team-hero"}
      onClick={() => photoUrl && setLightboxOpen(true)}
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: bannerAspect,
        borderRadius: 18,
        overflow: "hidden",
        marginBottom: titleAbove ? 0 : marginBottom,
        background: photoUrl ? `#000` : "var(--header-grad)",
        cursor: photoUrl ? "zoom-in" : "default",
      }}
    >
      {photoUrl && (
        <img
          src={photoUrl}
          alt={teamName}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {!photoUrl && (
        <svg width="100%" height="100%" viewBox="0 0 390 360" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, opacity: 0.18 }}>
          <circle cx="80" cy="150" r="46" fill="#fff" />
          <circle cx="150" cy="130" r="52" fill="#fff" />
          <circle cx="225" cy="150" r="46" fill="#fff" />
          <circle cx="295" cy="135" r="50" fill="#fff" />
          <circle cx="355" cy="155" r="40" fill="#fff" />
        </svg>
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: photoUrl && !titleAbove
            ? "linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,0.45) 100%)"
            : "transparent",
        }}
      />
      <div style={{ position: "absolute", left: 20, bottom: 14, right: 20, display: titleAbove ? "none" : "block" }}>
        <div
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: titleSize,
            fontWeight: 700,
            color: "#fff",
            textShadow: "0 1px 4px rgba(0,0,0,0.35)",
          }}
        >
          {teamName}
        </div>
        {(seasonLabel || subtitle) && (
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", marginTop: 2, textShadow: "0 1px 4px rgba(0,0,0,0.35)" }}>
            {subtitle ? subtitle : `Saison ${seasonLabel}`}
          </div>
        )}
      </div>
      {onUploadFoto && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const file = e.target.files && e.target.files[0];
              if (file) {
                setCropAspect(bannerAspect);
                setPendingFile(file);
              }
              e.target.value = "";
            }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current && fileInputRef.current.click();
            }}
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              minHeight: 44,
              borderRadius: 999,
              border: "none",
              background: "rgba(0,0,0,0.4)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <CameraIcon size={13} /> {photoUrl ? "Foto ändern" : "Foto hinzufügen"}
          </button>
        </>
      )}
    </div>
    </div>
    </div>
    {pendingFile && (
      <ImageCropModal
        file={pendingFile}
        aspect={cropAspect || bannerAspect}
        onCancel={() => setPendingFile(null)}
        onConfirm={async (blob) => {
          await onUploadFoto(blob);
          setPendingFile(null);
        }}
      />
    )}
    {lightboxOpen && photoUrl && (
      <div
        style={{ ...styles.modalOverlay, background: "rgba(10,6,6,0.9)", zIndex: 150, padding: 16 }}
        onClick={() => setLightboxOpen(false)}
      >
        <img
          src={photoUrl}
          alt={teamName}
          style={{ maxWidth: "100%", maxHeight: "92vh", objectFit: "contain", borderRadius: 12 }}
        />
        <button
          onClick={() => setLightboxOpen(false)}
          aria-label="Schließen"
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            width: 44,
            height: 44,
            borderRadius: 999,
            border: "none",
            background: "rgba(255,255,255,0.15)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    )}
    </>
  );
}

/* Alltags-Einstieg: offene Bewertung und nächster Termin mit Direkt-Button */
/* Kennzahlen-Kopf der Übersicht: vier große Zahlen auf einen Blick */
const ANWESEND_ARTEN = ["anwesend", "anwesend_nicht_angemeldet", "verspaetet", "verspaetet_nicht_angemeldet"];
function KennzahlenKopf({ month, trainings, termine }) {
  const heute = todayISO();
  const eintraege = (trainings || []).filter((t) => t.date.startsWith(month || "x"));
  const dabei = eintraege.filter((t) => ANWESEND_ARTEN.includes(t.teilnahme)).length;
  const quote = eintraege.length > 0 ? Math.round((dabei / eintraege.length) * 100) : null;
  const bewertetDaten = new Set((trainings || []).map((t) => t.date));
  const faellig = (termine || []).filter((t) => t.status !== "abgesagt" && t.date.startsWith(month || "x") && t.date <= heute);
  const bewertet = faellig.filter((t) => bewertetDaten.has(t.date)).length;
  const offen = faellig.length - bewertet;
  const karten = [
    { k: "a", label: "Anwesenheit", icon: "spieler", wert: quote === null ? "–" : `${quote} %`, sub: month ? `Schnitt ${monthLabel(month)}` : "" },
    { k: "b", label: "Trainings bewertet", icon: "termin", wert: faellig.length ? `${bewertet} / ${faellig.length}` : "–", sub: faellig.length ? (offen > 0 ? `${offen} noch offen` : "Alle bewertet") : "Noch keine Trainings", ton: offen > 0 ? "var(--danger-text)" : null },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, margin: "12px 0 4px" }}>
      {karten.map((c) => (
        <div key={c.k} style={{ background: "var(--surface-2)", borderRadius: 12, padding: 12, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{EMPTY_ICONS[c.icon]}</svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
          </div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 28, fontWeight: 700, lineHeight: 1.2, marginTop: 4, color: "var(--text)" }}>{c.wert}</div>
          <div style={{ fontSize: 13, color: c.ton || "var(--muted)", fontWeight: c.ton ? 600 : 400 }}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

function HeuteKarte({ termine, spieltage, trainings, onOpen }) {
  const heute = todayISO();
  const offen = useMemo(() => {
    const bewertet = new Set((trainings || []).map((t) => t.date));
    const grenze = new Date(); grenze.setDate(grenze.getDate() - 14);
    const g = grenze.toISOString().slice(0, 10);
    return (termine || [])
      .filter((t) => t.status !== "abgesagt" && t.date <= heute && t.date >= g && !bewertet.has(t.date))
      .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  }, [termine, trainings, heute]);
  const naechster = useMemo(() => {
    const liste = [
      ...(termine || []).filter((t) => t.status !== "abgesagt" && t.date >= heute).map((t) => ({ kind: "training", date: t.date, zeit: t.start_zeit, typ: "training" })),
      ...(spieltage || []).filter((s) => s.date >= heute).map((s) => ({ kind: "spieltag", date: s.date, zeit: s.zeit, spieltagId: s.id, typ: s.typ || "spieltag" })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    // ein heutiges, schon bewertetes Training ist kein „nächster“ Termin mehr
    const bewertet = new Set((trainings || []).map((t) => t.date));
    return liste.find((e) => !(e.kind === "training" && e.date === heute && bewertet.has(e.date))) || null;
  }, [termine, spieltage, trainings, heute]);
  if (!offen && !naechster) return null;
  const btn = { ...styles.primaryBtn, width: "auto", flexShrink: 0, padding: "0 16px", height: 44, whiteSpace: "nowrap" };
  const zeile = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 0" };
  return (
    <div style={{ ...styles.card, marginBottom: 14 }}>
      <KartenTitel>Als Nächstes</KartenTitel>
      {offen && (
        <div style={zeile}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Training noch nicht bewertet</div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>{formatTerminLabel(offen.date)}</div>
          </div>
          <button type="button" style={btn} onClick={() => onOpen({ typ: "training", date: offen.date })}>Bewerten</button>
        </div>
      )}
      {naechster && (
        <div style={zeile}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              {naechster.date === heute ? "Heute" : formatTerminLabel(naechster.date)} · {naechster.kind === "spieltag" ? (naechster.typ === "turnier" ? "Turnier" : naechster.typ === "hallenturnier" ? "Hallenturnier" : naechster.typ === "freundschaftsspiel" ? "Freundschaftsspiel" : "Spieltag") : naechster.typ === "hallentraining" ? "Hallentraining" : "Training"}
            </div>
            {naechster.zeit ? <div style={{ fontSize: 13, color: "var(--muted)" }}>{String(naechster.zeit).slice(0, 5)} Uhr</div> : null}
          </div>
          <button type="button" style={{ ...btn, background: "var(--surface)", color: "var(--accent-text)", border: "1.5px solid var(--border-strong)", boxShadow: "none" }}
            onClick={() => onOpen(naechster.kind === "spieltag" ? { typ: naechster.typ, spieltagId: naechster.spieltagId, date: naechster.date } : { typ: "training", date: naechster.date })}>
            Öffnen
          </button>
        </div>
      )}
    </div>
  );
}

function TermineLeiste({ termine, spieltage, onOpen }) {
  const heute = todayISO();

  const kommende = useMemo(() => {
    const trainingsEintraege = (termine || [])
      .filter((t) => t.status !== "abgesagt" && t.date >= heute)
      .map((t) => ({
        id: `t-${t.id}`,
        date: t.date,
        typ: t.typ === "hallentraining" ? "hallentraining" : "training",
        startZeit: t.start_zeit || null,
        endZeit: t.end_zeit || null,
      }));
    const spieltagEintraege = (spieltage || [])
      .filter((s) => s.date >= heute)
      .map((s) => ({ id: `s-${s.id}`, spieltagId: s.id, date: s.date, typ: ["turnier", "hallenturnier", "freundschaftsspiel"].includes(s.typ) ? s.typ : "spieltag", zeit: s.zeit || null }));
    return [...trainingsEintraege, ...spieltagEintraege].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  }, [termine, spieltage, heute]);

  const TYP_INFO = {
    training: {
      label: "Training",
      color: "var(--accent-text)",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l4 18H8z" />
          <ellipse cx="12" cy="19.5" rx="6" ry="1.5" />
        </svg>
      ),
    },
    hallentraining: {
      label: "Hallentr.",
      color: "var(--gold-2)",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 11l9-6 9 6" />
          <path d="M5 10v9h14v-9" />
          <path d="M9 19v-5h6v5" />
        </svg>
      ),
    },
    spieltag: {
      label: "Spieltag",
      color: "var(--success-text)",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M8 4h8v4a4 4 0 0 1-8 0V4z" />
          <path d="M8 5H5a3 3 0 0 0 3 4" />
          <path d="M16 5h3a3 3 0 0 1-3 4" />
          <path d="M12 12v4" />
          <path d="M9 20h6" />
          <path d="M10 16h4l1 4H9z" />
        </svg>
      ),
    },
    freundschaftsspiel: {
      label: "Freundsch.",
      color: "var(--success-text)",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 9l3 2-1.2 3.5h-3.6L9 11z" />
          <path d="M12 4v5M15 11l4.5-1.5M13.8 14.5l2.7 3.5M10.2 14.5L7.5 18M9 11L4.5 9.5" />
        </svg>
      ),
    },
    turnier: {
      label: "Turnier",
      color: "var(--gold-2)",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M8 4h8v4a4 4 0 0 1-8 0V4z" />
          <path d="M8 5H5a3 3 0 0 0 3 4" />
          <path d="M16 5h3a3 3 0 0 1-3 4" />
          <path d="M12 12v4" />
          <path d="M9 20h6" />
          <path d="M10 16h4l1 4H9z" />
          <path d="M6 20h12" strokeLinecap="round" />
        </svg>
      ),
    },
    hallenturnier: {
      label: "Hallenturnier",
      color: "var(--gold-2)",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2 9l10-6 10 6" />
          <path d="M9 10h6v3a3 3 0 0 1-6 0v-3z" />
          <path d="M9 11H7a2 2 0 0 0 2 2.5" />
          <path d="M15 11h2a2 2 0 0 1-2 2.5" />
          <path d="M12 16v2" />
          <path d="M9 21h6" />
          <path d="M10 18h4l.7 3H9.3z" />
        </svg>
      ),
    },
  };

  const kurzDatum = (dateStr) => {
    const d = new Date(dateStr + "T00:00:00");
    const tag = WOCHENTAGE[d.getDay()].toUpperCase();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${tag} · ${dd}.${mm}.`;
  };

  return (
    <div style={{ ...styles.card, marginBottom: 14 }}>
      <KartenTitel>Nächste Termine</KartenTitel>
      {kommende.length === 0 ? (
        <EmptyState text="Keine anstehenden Termine." />
      ) : (
        <div className="termine-grid" style={{ display: "flex", gap: 8 }}>
          {kommende.map((eintrag, idx) => {
            const info = TYP_INFO[eintrag.typ];
            return (
              <div
                key={eintrag.id}
                className={idx >= 3 ? "termin-extra" : undefined}
                role={onOpen ? "button" : undefined}
                tabIndex={onOpen ? 0 : undefined}
                onClick={onOpen ? () => onOpen(eintrag) : undefined}
                onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(eintrag); } } : undefined}
                title={onOpen ? (eintrag.typ === "spieltag" || eintrag.typ === "turnier" || eintrag.typ === "hallenturnier" || eintrag.typ === "freundschaftsspiel" ? "Spieltag öffnen" : "Training bewerten") : undefined}
                style={{
                  cursor: onOpen ? "pointer" : "default",
                  flex: 1,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderLeft: `3px solid ${info.color}`,
                  borderRadius: 12,
                  padding: "10px 8px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--muted)" }}>{kurzDatum(eintrag.date)}</div>
                <div style={{ margin: "9px auto", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", color: info.color }}>
                  {info.icon}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{info.label}</div>
                {eintrag.startZeit && eintrag.endZeit && (
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>
                    {eintrag.startZeit}–{eintrag.endZeit}
                  </div>
                )}
                {eintrag.zeit && (
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{eintrag.zeit} Uhr</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GeburtstagsKarte({ players, vorlauf }) {
  const heute = new Date();
  heute.setHours(0, 0, 0, 0);
  const eintraege = players
    .filter((p) => p.active !== false && p.geburtsdatum)
    .map((p) => {
      const [y, m, d] = String(p.geburtsdatum).slice(0, 10).split("-").map(Number);
      let datum = new Date(heute.getFullYear(), m - 1, d);
      if (datum < heute) datum = new Date(heute.getFullYear() + 1, m - 1, d);
      return { id: p.id, name: p.name, tage: Math.round((datum - heute) / 86400000), alter: datum.getFullYear() - y, datum };
    })
    .filter((e) => e.tage <= vorlauf)
    .sort((a, b) => a.tage - b.tage);
  if (eintraege.length === 0) return null;
  const wann = (e) =>
    e.tage === 0
      ? "heute"
      : `${e.tage === 1 ? "morgen" : `in ${e.tage} Tagen`} (${e.datum.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })})`;
  return (
    <div style={{ ...styles.card, marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ fontSize: 26, lineHeight: 1 }} aria-hidden="true">🎂</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{eintraege.some((e) => e.tage === 0) ? "Heute ist Geburtstag!" : "Bald Geburtstag"}</div>
        {eintraege.map((e) => (
          <div key={e.id} style={{ fontSize: 14, padding: "1px 0", fontWeight: e.tage === 0 ? 700 : 400 }}>
            {e.name} wird {e.alter} · {wann(e)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Briefkasten, Trainer-Ansicht (Setup → Briefkasten): anonyme Nachrichten der Eltern */
const BRIEFKASTEN_LABEL = { lob: "Lob", kritik: "Kritik", idee: "Idee", sonstiges: "Sonstiges" };
const BRIEFKASTEN_STATUS = { neu: "Neu", gelesen: "Gelesen", erledigt: "Erledigt" };
function BriefkastenListe({ daten }) {
  const { liste, fehler, neu, onStatus, onAlleGelesen, onLoeschen } = daten;
  const datum = (iso) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const knopf = { ...styles.rowBtnOutline, height: 44 }; // Touch-Ziel mindestens 44 px
  return (
    <section style={styles.card}>
      <KartenTitel>Briefkasten</KartenTitel>
      <p style={styles.cardDesc}>Anonyme Nachrichten der Eltern. Du siehst nur das Datum, keine Namen. Antworten ist nicht möglich.</p>
      {fehler && <div role="alert" style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 12 }}>{fehler}</div>}
      {liste === null ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Lade …</div>
      ) : liste.length === 0 ? (
        !fehler && <EmptyState text="Noch keine Nachrichten. Sobald Eltern etwas einwerfen, erscheint es hier." />
      ) : (
        <>
          {neu > 0 && (
            <button type="button" style={{ ...knopf, marginBottom: 12 }} onClick={onAlleGelesen}>Alle als gelesen markieren ({neu})</button>
          )}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {liste.map((r) => (
              <li key={r.id} style={{ border: "1px solid var(--border)", borderLeft: r.status === "neu" ? "4px solid var(--accent)" : "1px solid var(--border)", borderRadius: 12, background: "var(--surface)", padding: 12 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 13, color: "var(--muted)", marginBottom: 6 }}>
                  <strong style={{ color: "var(--text)" }}>{BRIEFKASTEN_LABEL[r.kategorie] || "Sonstiges"}</strong>
                  <span>·</span>
                  <span>{datum(r.created_at)}</span>
                  <span>·</span>
                  <span style={{ fontWeight: r.status === "neu" ? 700 : 400, color: r.status === "neu" ? "var(--accent-text)" : undefined }}>{BRIEFKASTEN_STATUS[r.status] || r.status}</span>
                </div>
                <div style={{ fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text)" }}>{r.nachricht}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {r.status === "neu" && <button type="button" style={knopf} onClick={() => onStatus(r.id, "gelesen")}>Gelesen</button>}
                  <button type="button" aria-pressed={r.status === "erledigt"} style={{ ...knopf, ...(r.status === "erledigt" ? styles.chipActive : null) }} onClick={() => onStatus(r.id, r.status === "erledigt" ? "gelesen" : "erledigt")}>
                    {r.status === "erledigt" ? "Erledigt ✓" : "Erledigt"}
                  </button>
                  <button type="button" style={{ ...styles.dangerBtn, minHeight: 44, border: "none", cursor: "pointer", fontSize: 14 }} onClick={() => onLoeschen(r.id)}>Löschen</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
/* Hinweis auf Home, solange ungelesene Briefkasten-Nachrichten da sind */
function BriefkastenHinweis({ neu, onOpen }) {
  if (!neu) return null;
  return (
    <div style={{ ...styles.card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 180, fontSize: 14 }}>
        <strong>{neu === 1 ? "1 neue Nachricht" : `${neu} neue Nachrichten`}</strong> im Briefkasten
      </div>
      <button type="button" style={styles.rowBtn} onClick={onOpen}>Lesen</button>
    </div>
  );
}

function Dashboard({
  players,
  basis,
  trainings,
  entwicklungen,
  spieltage,
  gegner,
  teamSettings,
  teamInfo,
  termine,
  onOpenTermin,
  onUploadTeamFoto,
  selectedPlayerId,
  onSelectPlayer,
  onOpenSettings,
  briefkastenNeu = 0,
  onBriefkasten,
}) {
  const months = useMemo(() => {
    const set = new Set(trainings.map((t) => t.date.slice(0, 7)));
    set.add(monthKey(new Date()));
    return Array.from(set).sort();
  }, [trainings]);
  const seasons = useMemo(() => {
    const set = new Set(months.map((m) => seasonKeyOf(m)).filter(Boolean));
    return Array.from(set).sort();
  }, [months]);
  const [season, setSeason] = useState(() => seasonKeyOf(months[months.length - 1]) || seasons[seasons.length - 1]);
  const [month, setMonth] = useState(months[months.length - 1]);
  const [sortKey, setSortKey] = useState("gesamtMonat");
  const [sortDir, setSortDir] = useState("desc");
  const [uebersichtTab, setUebersichtTab] = useState("training");
  const fMannschaftsbild = useFeature("mannschaftsbild");
  const fGeburtstage = useFeature("geburtstage");

  useEffect(() => {
    if (seasons.length > 0 && !seasons.includes(season)) setSeason(seasons[seasons.length - 1]);
  }, [seasons]); // eslint-disable-line

  const monateDerSaison = useMemo(() => months.filter((m) => seasonKeyOf(m) === season), [months, season]);

  useEffect(() => {
    if (monateDerSaison.length > 0 && !monateDerSaison.includes(month)) {
      setMonth(monateDerSaison[monateDerSaison.length - 1]);
    }
  }, [season, monateDerSaison]); // eslint-disable-line

  const rows = players.map((p) => {
    const monatsPunkte = trainings
      .filter((t) => t.playerId === p.id && t.date.slice(0, 7) === month)
      .reduce((sum, t) => sum + trainingPunkte(t), 0);
    const saisonPunkte = trainings
      .filter((t) => t.playerId === p.id && seasonKeyOf(t.date.slice(0, 7)) === seasonKeyOf(month))
      .reduce((sum, t) => sum + trainingPunkte(t), 0);
    const basisAktuell = aktuelleBasis(p.id, basis, entwicklungen, month);
    return {
      id: p.id,
      name: p.name,
      photoUrl: p.photo_url || null,
      active: p.active !== false,
      monatsPunkte,
      saisonPunkte,
      basisAktuell,
      gesamtMonat: monatsPunkte + basisAktuell,
      gesamtSaison: saisonPunkte + basisAktuell,
    };
  });
  rows.sort((a, b) => {
    let cmp;
    if (sortKey === "name") cmp = a.name.localeCompare(b.name, "de");
    else cmp = a[sortKey] - b[sortKey];
    return sortDir === "asc" ? cmp : -cmp;
  });

  const spalten = [
    ["name", "Spieler"],
    ["basisAktuell", "Basis-Qualität"],
    ["monatsPunkte", "Trainingspunkte (Monat)"],
    ["gesamtMonat", "Gesamt (Monat)"],
    ["saisonPunkte", "Trainingspunkte (Saison)"],
    ["gesamtSaison", "Gesamt (Saison)"],
  ];
  const sortiereNach = (key) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  if (selectedPlayerId) {
    const player = players.find((p) => p.id === selectedPlayerId);
    // Reihenfolge wie im Spieler-Slider (Trikotnummer), nur aktive Spieler
    const reihe = rows
      .filter((r) => r.active || r.id === selectedPlayerId)
      .map((r) => players.find((p) => p.id === r.id))
      .filter(Boolean)
      .sort((a, b) => (a.trikotnummer ?? 999) - (b.trikotnummer ?? 999) || (a.name || "").localeCompare(b.name || "", "de"));
    const idx = reihe.findIndex((p) => p.id === selectedPlayerId);
    const gehe = (p) => {
      onSelectPlayer(p.id);
      window.scrollTo({ top: 0 });
    };
    return (
      <SpielerDetail
        key={selectedPlayerId}
        vorheriger={reihe.length > 1 && idx >= 0 ? reihe[(idx - 1 + reihe.length) % reihe.length] : null}
        naechster={reihe.length > 1 && idx >= 0 ? reihe[(idx + 1) % reihe.length] : null}
        onNavigate={gehe}
        player={player}
        trainings={trainings}
        entwicklungen={entwicklungen}
        basis={basis}
        spieltage={spieltage}
        month={month}
        onClose={() => onSelectPlayer(null)}
        onOpenSettings={onOpenSettings}
        teamName={teamInfo?.name || TEAM_NAME}
      />
    );
  }

  return (
    <section>
      <div style={{ ...styles.card, marginBottom: 14 }}>
      <KartenTitel>{season ? `Saison ${season.replace("-", "/")}` : "Saison"}</KartenTitel>
      <div className={fMannschaftsbild ? "dash-top" : undefined}>
        <div className="dash-left" style={{ minWidth: 0 }}>
          {fMannschaftsbild && (
          <TeamHero
            photoUrl={teamInfo?.config?.team_photo_url || (Sitzung.team === "u8" ? teamSettings?.team_photo_url : null) || null}
            teamName={`${CLUB.name} ${teamInfo?.name || TEAM_NAME}`}
            seasonLabel={season ? season.replace("-", "/") : ""}
            onUploadFoto={onUploadTeamFoto}
            titleAbove
          />
        )}
        </div>
        <SpielerSlider rows={rows} players={players} onSelect={onSelectPlayer} />
      </div>
      </div>
      <div className="dash-side">
        <BriefkastenHinweis neu={briefkastenNeu} onOpen={onBriefkasten} />
        <HeuteKarte termine={termine} spieltage={spieltage} trainings={trainings} onOpen={onOpenTermin} />
        <TermineLeiste termine={termine} spieltage={spieltage} onOpen={onOpenTermin} />
        {fGeburtstage && <GeburtstagsKarte players={players} vorlauf={Number(teamInfo?.config?.geburtstage_vorlauf ?? 7)} />}
        <SaisonwechselHinweis seasons={seasons} />
        <BackupHinweis config={teamInfo?.config} />
      </div>

      <div style={{ ...styles.card, marginTop: 20, marginBottom: 18 }}>
        <KartenTitel>Übersicht</KartenTitel>
        <div style={{ ...styles.segNav, marginBottom: 12 }}>
          <button
            onClick={() => setUebersichtTab("training")}
            aria-pressed={!!(uebersichtTab === "training")} style={{ ...styles.segBtn, ...(uebersichtTab === "training" ? styles.segBtnActive : {}) }}
          >
            Training
          </button>
          <button
            onClick={() => setUebersichtTab("saison")}
            aria-pressed={!!(uebersichtTab === "saison")} style={{ ...styles.segBtn, ...(uebersichtTab === "saison" ? styles.segBtnActive : {}) }}
          >
            Saison
          </button>
        </div>
        {(seasons.length > 1 || uebersichtTab === "training") && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {seasons.length > 1 && (
            <div style={styles.selectGroup}>
              <label htmlFor={"sel-saison"} style={styles.selectGroupLabel}>Saison</label>
              <select id={"sel-saison"} style={styles.select} value={season || ""} onChange={(e) => setSeason(e.target.value)}>
                {seasons.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("-", "/")}
                  </option>
                ))}
              </select>
            </div>
          )}
          {uebersichtTab === "training" && (
            <div style={styles.selectGroup}>
              <label htmlFor={"sel-monat"} style={styles.selectGroupLabel}>Monat</label>
              <select id={"sel-monat"} style={styles.select} value={month} onChange={(e) => setMonth(e.target.value)}>
                {monateDerSaison.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        )}

      {uebersichtTab === "training" && <KennzahlenKopf month={month} trainings={trainings} termine={termine} />}

      {uebersichtTab === "training" && (
        <>
          <div style={{ marginTop: 8 }}>
          <KartenTitel block>Punktestand</KartenTitel>
          {rows.length === 0 && <EmptyState nach="verwaltung" text="Noch keine Spieler angelegt." />}

          {rows.length > 0 && (
            <div className="nz-tabelle" style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {spalten.map(([key, label]) => (
                      <th key={key} style={{ ...styles.th, cursor: "pointer", userSelect: "none" }} onClick={() => sortiereNach(key)}>
                        {label}
                        <span style={{ marginLeft: 4, opacity: sortKey === key ? 1 : 0.35 }}>
                          {sortKey === key ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} style={!r.active ? { opacity: 0.5 } : undefined}>
                      <td style={styles.tdName}>
                        <span style={styles.rank}>{i + 1}</span>
                        <Avatar name={r.name} size={36} photoUrl={r.photoUrl} />
                        <button style={styles.playerNameBtn} onClick={() => onSelectPlayer(r.id)}>
                          {r.name}
                        </button>
                      </td>
                      <td style={styles.td}>{r.basisAktuell.toFixed(2)}</td>
                      <td style={styles.td}>{r.monatsPunkte.toFixed(2)}</td>
                      <td style={{ ...styles.td, fontWeight: 700, color: "var(--accent-text)" }}>{r.gesamtMonat.toFixed(2)}</td>
                      <td style={styles.td}>{r.saisonPunkte.toFixed(2)}</td>
                      <td style={{ ...styles.td, fontWeight: 700, color: "var(--accent-text)" }}>{r.gesamtSaison.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>

          <AnwesenheitsStatistik trainings={trainings} players={players} month={month} onOpenPlayer={onSelectPlayer} />
          <EntwicklungsVerlauf players={players} basis={basis} entwicklungen={entwicklungen} months={months} month={month} onOpenPlayer={onSelectPlayer} />
          <TrainerNotizen trainings={trainings} players={players} month={month} onOpenPlayer={onSelectPlayer} />
        </>
      )}

      {uebersichtTab === "saison" && (
        <>
          <SaisonBilanz spieltage={spieltage} players={players} month={month} onOpenPlayer={onSelectPlayer} />
          <GegnerBilanzTabelle spieltage={spieltage} gegner={gegner} month={month} />
          <SpieltagAnwesenheit spieltage={spieltage} players={players} month={month} onOpenPlayer={onSelectPlayer} />
          <SpieltagNotizenUebersicht spieltage={spieltage} month={month} />
        </>
      )}
      </div>
    </section>
  );
}

const KARTEN_FARBE = { gelb: "#F2C21B", blau: "#2F6FDB", rot: "#D32F2F" };
const KARTEN_LABEL = { gelb: "Gelbe Karte", blau: "Blaue Karte", rot: "Rote Karte" };
function KartenIcon({ karte }) {
  return <span style={{ display: "inline-block", width: 10, height: 14, borderRadius: 2, background: KARTEN_FARBE[karte] || "#999", flexShrink: 0 }} />;
}
function KartenZaehler({ eintraege }) {
  const z = { gelb: 0, blau: 0, rot: 0 };
  eintraege.forEach((t) => { if (z[t.karte] !== undefined) z[t.karte]++; });
  const aktiv = ["gelb", "blau", "rot"].filter((k) => z[k] > 0);
  if (aktiv.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--muted)" }}>
      {aktiv.map((k) => (
        <span key={k} title={KARTEN_LABEL[k]} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <KartenIcon karte={k} /> {z[k]}
        </span>
      ))}
    </span>
  );
}
function hatNotiz(t) {
  return (t.kommentar && t.kommentar.trim() !== "") || (t.karte && t.karte !== "keine");
}

function SpielerLink({ id, name, players, onOpen }) {
  const p = (players || []).find((x) => x.id === id);
  return (
    <>
      <Avatar name={name} size={36} photoUrl={p?.photo_url || null} />
      <button style={styles.playerNameBtn} onClick={() => onOpen(id)}>{name}</button>
    </>
  );
}

function AnwesenheitsStatistik({ trainings, players, month, onOpenPlayer }) {
  const saison = seasonKeyOf(month);
  const rows = players
    .map((p) => {
      const eigene = trainings.filter((t) => t.playerId === p.id && seasonKeyOf(t.date.slice(0, 7)) === saison);
      const gesamt = eigene.length;
      const anwesend = eigene.filter((t) => t.teilnahme === "anwesend").length;
      const beides = eigene.filter((t) => t.teilnahme === "verspaetet_nicht_angemeldet").length;
      const nichtAngemeldet = eigene.filter((t) => t.teilnahme === "anwesend_nicht_angemeldet").length + beides;
      const verspaetet = eigene.filter((t) => t.teilnahme === "verspaetet").length + beides;
      const unentschuldigt = eigene.filter((t) => t.teilnahme === "unentschuldigt").length;
      const abgemeldet = eigene.filter((t) => t.teilnahme === "entschuldigt").length;
      // Anwesend = pünktlich, nicht angemeldet, verspätet oder beides (Beides steckt in nichtAngemeldet und verspaetet, daher einmal abziehen)
      const dabei = anwesend + nichtAngemeldet + verspaetet - beides;
      const quote = gesamt > 0 ? (dabei / gesamt) * 100 : null;
      return { id: p.id, name: p.name, gesamt, anwesend, nichtAngemeldet, verspaetet, unentschuldigt, abgemeldet, quote };
    })
    .filter((r) => r.gesamt > 0)
    .sort((a, b) => (b.quote ?? 0) - (a.quote ?? 0));

  return (
    <div style={{ marginTop: 8 }}>
      <KartenTitel block>Anwesenheit {saison ? saison.replace("-", "/") : ""}</KartenTitel>
      {rows.length === 0 && <EmptyState text="Noch keine Trainingsbewertungen in dieser Saison erfasst." />}
      {rows.length > 0 && (
        <div className="nz-tabelle" style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Spieler</th>
                <th style={styles.th}>Anwesend</th>
                <th style={styles.th}>Anwesend (n.a.)</th>
                <th style={styles.th}>Verspätet</th>
                <th style={styles.th}>Unentschuldigt</th>
                <th style={styles.th}>Abgemeldet</th>
                <th style={styles.th}>Quote</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={styles.tdName}><SpielerLink id={r.id} name={r.name} players={players} onOpen={onOpenPlayer} /></td>
                  <td style={styles.td}>{r.anwesend}</td>
                  <td style={styles.td}>{r.nichtAngemeldet}</td>
                  <td style={styles.td}>{r.verspaetet}</td>
                  <td style={styles.td}>{r.unentschuldigt}</td>
                  <td style={styles.td}>{r.abgemeldet}</td>
                  <td style={{ ...styles.td, fontWeight: 700, color: "var(--accent-text)" }}>{r.quote.toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TrainerNotizen({ trainings, players, month, onOpenPlayer }) {
  const saison = seasonKeyOf(month);
  const [offen, setOffen] = useState({});
  const notizen = trainings
    .filter((t) => hatNotiz(t) && seasonKeyOf(t.date.slice(0, 7)) === saison)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (notizen.length === 0) return null;

  // Gruppiert pro Spieler, Spieler mit der neuesten Notiz zuerst
  const gruppen = [];
  notizen.forEach((n) => {
    let g = gruppen.find((x) => x.id === n.playerId);
    if (!g) {
      const p = players.find((pl) => pl.id === n.playerId);
      g = { id: n.playerId, name: p?.name || "Unbekannt", photoUrl: p?.photo_url || null, notizen: [] };
      gruppen.push(g);
    }
    g.notizen.push(n);
  });
  const vorschau = (t) => t.replace(/!\[[^\]]*\]\([^)]*\)/g, "[Bild]").replace(/[*_#>`-]/g, "").replace(/\s+/g, " ").trim();

  return (
    <div style={{ marginTop: 8 }}>
      <KartenTitel block>Trainer-Notizen {saison ? saison.replace("-", "/") : ""}</KartenTitel>
      <div className="card-list" style={styles.cardList}>
        {gruppen.map((g) => {
          const isOpen = !!offen[g.id];
          return (
            <div key={g.id} style={styles.card}>
              <button
                onClick={() => setOffen((o) => ({ ...o, [g.id]: !o[g.id] }))}
                aria-expanded={isOpen}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 44, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }}
              >
                <Avatar name={g.name} size={36} photoUrl={g.photoUrl} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={styles.cardName}>{g.name}</span>
                    <span style={styles.mutedTag}>{g.notizen.length} {g.notizen.length === 1 ? "Notiz" : "Notizen"}</span>
                    <KartenZaehler eintraege={g.notizen} />
                  </div>
                  {!isOpen && (
                    <div style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {formatTerminLabel(g.notizen[0].date)}: {g.notizen[0].karte !== "keine" ? `${KARTEN_LABEL[g.notizen[0].karte] || "Karte"}${g.notizen[0].kommentar && g.notizen[0].kommentar.trim() ? " · " : ""}` : ""}{vorschau(g.notizen[0].kommentar || "")}
                    </div>
                  )}
                </div>
                <span style={{ color: "var(--muted)", fontSize: 14, transform: isOpen ? "rotate(180deg)" : "none" }}>▾</span>
              </button>
              {isOpen && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                  <button style={{ ...styles.linkBtn, alignSelf: "flex-start", padding: 0 }} onClick={() => onOpenPlayer(g.id)}>
                    Spielerprofil öffnen →
                  </button>
                  {g.notizen.map((n) => (
                    <div key={n.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                      <div style={{ ...styles.mutedTag, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
                        {formatTerminLabel(n.date)}
                        {n.karte && n.karte !== "keine" && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text)", fontWeight: 600 }}>
                            <KartenIcon karte={n.karte} /> {KARTEN_LABEL[n.karte]}
                          </span>
                        )}
                      </div>
                      {n.kommentar && n.kommentar.trim() !== "" && <FormatierterText text={n.kommentar} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SpieltagAnwesenheit({ spieltage, players, month, onOpenPlayer }) {
  const saison = seasonKeyOf(month);
  // Nur Spieltage, die schon stattgefunden haben (heute oder früher)
  const heuteISO = todayISO();
  const spieltageDerSaison = spieltage.filter(
    (s) => spieltagGespielt(s) && seasonKeyOf(s.date.slice(0, 7)) === saison && s.date <= heuteISO
  );
  const gesamt = spieltageDerSaison.length;

  const rows = players
    .map((p) => {
      const dabei = spieltageDerSaison.filter((s) => s.teilnehmer.includes(p.id)).length;
      const quote = gesamt > 0 ? (dabei / gesamt) * 100 : null;
      return { id: p.id, name: p.name, dabei, gesamt, quote };
    })
    .sort((a, b) => (b.quote ?? 0) - (a.quote ?? 0));

  return (
    <div style={{ marginTop: 8 }}>
      <KartenTitel block>Anwesenheit Spieltage {saison ? saison.replace("-", "/") : ""}</KartenTitel>
      {gesamt === 0 ? (
        <EmptyState text="Noch keine Spieltage in dieser Saison erfasst." />
      ) : (
        <div className="nz-tabelle" style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Spieler</th>
                <th style={styles.th}>Teilnahmen</th>
                <th style={styles.th}>Quote</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={styles.tdName}><SpielerLink id={r.id} name={r.name} players={players} onOpen={onOpenPlayer} /></td>
                  <td style={styles.td}>
                    {r.dabei} / {r.gesamt}
                  </td>
                  <td style={{ ...styles.td, fontWeight: 700, color: "var(--accent-text)" }}>
                    {r.quote != null ? r.quote.toFixed(0) + "%" : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SpieltagNotizenUebersicht({ spieltage, month }) {
  const saison = seasonKeyOf(month);
  const notizen = spieltage
    .filter((s) => s.notizen && s.notizen.trim() !== "" && seasonKeyOf(s.date.slice(0, 7)) === saison)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (notizen.length === 0) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <KartenTitel block>Notizen Spieltage {saison ? saison.replace("-", "/") : ""}</KartenTitel>
      <div className="card-list" style={styles.cardList}>
        {notizen.map((s) => (
          <div key={s.id} style={styles.card}>
            <div style={styles.cardHead}>
              <span style={styles.cardName}>{formatTerminLabel(s.date)}</span>
            </div>
            <FormatierterText text={s.notizen} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* Spieler als horizontal wischbare Karten (Übersicht) */
function SpielerSlider({ rows, players, onSelect }) {
  const liste = rows
    .filter((r) => r.active)
    .map((r) => ({ ...r, p: players.find((p) => p.id === r.id) }))
    .filter((r) => r.p)
    .sort((a, b) => (a.p.trikotnummer ?? 999) - (b.p.trikotnummer ?? 999) || a.name.localeCompare(b.name, "de"));
  if (liste.length === 0) return null;
  return (
    <div className="spieler-wrap" style={{ marginBottom: 12, marginTop: 8 }}>
      <div className="spieler-label" style={{ fontSize: 13, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
        Spieler
      </div>
      <div className="spieler-slider">
        {liste.map((r) => (
          <button key={r.id} className="spieler-karte" onClick={() => onSelect(r.id)} aria-label={`${r.name} öffnen`}>
            <PlayerCard player={r.p} stats={[]} />
          </button>
        ))}
      </div>
    </div>
  );
}

function PlayerCard({ player, stats, teamName = TEAM_NAME }) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 340,
        margin: "18px auto 0 auto",
        borderRadius: 24,
        padding: 3,
        background: `linear-gradient(135deg, var(--gold), var(--gold-2))`,
      }}
    >
      <div
        style={{
          position: "relative",
          borderRadius: 21,
          background: "linear-gradient(160deg, #96161A 0%, #560B0D 100%)",
          padding: "18px 18px 20px 18px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -50,
            left: -70,
            width: 280,
            height: 280,
            background: "linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0) 60%)",
            transform: "rotate(20deg)",
          }}
        />

        <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ textAlign: "center", lineHeight: 1 }}>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 38, fontWeight: 700, color: "var(--gold)" }}>
              {player.trikotnummer ?? "–"}
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)", letterSpacing: "0.08em", marginTop: 4 }}>
              TRIKOT
            </div>
          </div>
        </div>

        <div className="pc-avatar" style={{ position: "relative", display: "flex", justifyContent: "center", marginTop: -8 }}>
          <Avatar name={player.name} size={150} photoUrl={player.photo_url} ring="gold" />
        </div>

        <div style={{ position: "relative", textAlign: "center", marginTop: 12 }}>
          <div
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 23,
              fontWeight: 700,
              letterSpacing: "0.03em",
              color: "#fff",
              textTransform: "uppercase",
            }}
          >
            <div>{player.name}</div>
            <div style={{ minHeight: "1.2em" }}>{player.nachname || "\u00A0"}</div>
          </div>
          {player.spitzname && (
            <div style={{ fontSize: 13, fontStyle: "italic", fontWeight: 600, color: "var(--gold)", marginTop: 4 }}>„{player.spitzname}“</div>
          )}
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", letterSpacing: "0.1em", marginTop: 3 }}>
            {CLUB.name.toUpperCase()} {teamName}
          </div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", marginTop: 6, lineHeight: 1.5 }}>
            <div>{player.geburtsdatum ? `Geboren am ${formatGeburtsdatum(player.geburtsdatum)}` : "\u00A0"}</div>
            <div>
              {player.geburtsdatum && alterVonGeburtsdatum(String(player.geburtsdatum).slice(0, 10)) != null
                ? `${alterVonGeburtsdatum(String(player.geburtsdatum).slice(0, 10))} Jahre`
                : "\u00A0"}
            </div>
          </div>
        </div>

        {stats.length > 0 && (
          <>
        <div
          style={{
            position: "relative",
            height: 1,
            margin: "16px 0",
            background: "linear-gradient(90deg, rgba(242,169,59,0), rgba(242,169,59,0.85), rgba(242,169,59,0))",
          }}
        />

        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gridAutoFlow: "row",
            rowGap: 8,
            columnGap: 6,
          }}
        >
          {stats.map((s, i) =>
            s.icon && s.prozent != null ? (
              <div key={i} title={`${s.label}: ${s.value}`} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.75)", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{s.label}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  {[0, 1, 2, 3, 4].map((k) => (
                    <StatIcon key={k} name={s.icon} size={15} aktiv={k < Math.max(0, Math.min(5, Math.round(s.prozent / 20)))} />
                  ))}
                </div>
              </div>
            ) : (
              <div key={i} style={{ display: "flex", justifyContent: "flex-start", alignItems: "baseline", gap: 5 }}>
                <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 700, color: "var(--gold)" }}>
                  {s.value}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.75)", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                  {s.label}
                </span>
              </div>
            )
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
}

function alterVonGeburtsdatum(iso) {
  if (!iso) return null;
  const g = new Date(iso + "T00:00:00");
  if (isNaN(g)) return null;
  const heute = new Date();
  let a = heute.getFullYear() - g.getFullYear();
  const m = heute.getMonth() - g.getMonth();
  if (m < 0 || (m === 0 && heute.getDate() < g.getDate())) a--;
  return a;
}

function formatGeburtsdatum(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/* Nachname und Geburtsdatum (Spielerverwaltung); Speichern beim Verlassen des Feldes */
function PlayerStammdaten({ player, onSave, trikot }) {
  const gebAlt = player.geburtsdatum ? String(player.geburtsdatum).slice(0, 10) : "";
  const [vorname, setVorname] = useState(player.name || "");
  const [nachname, setNachname] = useState(player.nachname || "");
  const [geb, setGeb] = useState(gebAlt);
  const [spitz, setSpitz] = useState(player.spitzname || "");
  useEffect(() => {
    setVorname(player.name || "");
    setSpitz(player.spitzname || "");
    setNachname(player.nachname || "");
    setGeb(player.geburtsdatum ? String(player.geburtsdatum).slice(0, 10) : "");
  }, [player.name, player.nachname, player.geburtsdatum, player.spitzname]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px 12px" }}>
      <div>
        <label htmlFor={`sd-vorname-${player.id}`} style={{ ...styles.label, display: "block", minWidth: 0, marginBottom: 4 }}>Vorname</label>
        <input id={`sd-vorname-${player.id}`}
          style={{ ...styles.input, width: "100%" }}
          value={vorname}
          onChange={(e) => setVorname(e.target.value)}
          onBlur={() => {
            const v = vorname.trim();
            if (!v) { setVorname(player.name || ""); return; }
            if (v !== (player.name || "")) onSave({ name: v });
          }}
        />
      </div>
      <div>
        <label htmlFor={`sd-nachname-${player.id}`} style={{ ...styles.label, display: "block", minWidth: 0, marginBottom: 4 }}>Nachname (nur im Profil)</label>
        <input id={`sd-nachname-${player.id}`}
          style={{ ...styles.input, width: "100%" }}
          value={nachname}
          onChange={(e) => setNachname(e.target.value)}
          onBlur={() => nachname.trim() !== (player.nachname || "") && onSave({ nachname: nachname.trim() || null })}
        />
      </div>
      {trikot}
      <div>
        <label htmlFor={`sd-geb-${player.id}`} style={{ ...styles.label, display: "block", minWidth: 0, marginBottom: 4 }}>Geburtsdatum</label>
        <input id={`sd-geb-${player.id}`}
          type="date"
          style={{ ...styles.input, width: "100%" }}
          value={geb}
          onChange={(e) => setGeb(e.target.value)}
          onBlur={() => geb !== gebAlt && onSave({ geburtsdatum: geb || null })}
        />
      </div>
      <div>
        <label htmlFor={`sd-spitz-${player.id}`} style={{ ...styles.label, display: "block", minWidth: 0, marginBottom: 4 }}>Spitzname (Sammelkarte)</label>
        <input id={`sd-spitz-${player.id}`}
          style={{ ...styles.input, width: "100%" }}
          value={spitz}
          maxLength={28}
          placeholder="z. B. Der Turbo"
          onChange={(e) => setSpitz(e.target.value)}
          onBlur={() => spitz.trim() !== (player.spitzname || "") && onSave({ spitzname: spitz.trim() || null })}
        />
      </div>
    </div>
  );
}

function SpielerDetail({ player, trainings, entwicklungen, basis, spieltage, month, onClose, onOpenSettings, teamName = TEAM_NAME, vorheriger, naechster, onNavigate }) {
  const [historieTab, setHistorieTab] = useState("training");
  const [kartenLaeuft, setKartenLaeuft] = useState(false);
  const [kartenFehler, setKartenFehler] = useState(null);

  if (!player) {
    return (
      <section>
        <button style={styles.linkBtn} onClick={onClose}>
          ← Zurück
        </button>
        <EmptyState text="Spieler nicht gefunden." />
      </section>
    );
  }

  const saison = seasonKeyOf(month);
  const eigeneTrainings = trainings.filter((t) => t.playerId === player.id).sort((a, b) => b.date.localeCompare(a.date));
  const notizenAlle = eigeneTrainings.filter((t) => hatNotiz(t) && seasonKeyOf(t.date.slice(0, 7)) === saison);
  const saisonTrainings = eigeneTrainings.filter((t) => seasonKeyOf(t.date.slice(0, 7)) === saison);
  const monatsPunkte = saisonTrainings
    .filter((t) => t.date.slice(0, 7) === month)
    .reduce((sum, t) => sum + trainingPunkte(t), 0);
  const saisonPunkte = saisonTrainings.reduce((sum, t) => sum + trainingPunkte(t), 0);
  const basisAktuell = aktuelleBasis(player.id, basis, entwicklungen, month);
  const gesamt = saisonTrainings.length;
  const anwesend = saisonTrainings.filter(
    (t) => ["anwesend", "anwesend_nicht_angemeldet", "verspaetet", "verspaetet_nicht_angemeldet"].includes(t.teilnahme)
  ).length;
  const quoteTraining = gesamt > 0 ? (anwesend / gesamt) * 100 : null;
  // Spieltag-Quote: nur bereits stattgefundene Spieltage der Saison
  const heuteISO = todayISO();
  const vergangeneSpieltage = spieltage.filter(
    (s) => spieltagGespielt(s) && seasonKeyOf(s.date.slice(0, 7)) === saison && s.date <= heuteISO
  );
  const spieltagDabeiAnzahl = vergangeneSpieltage.filter((s) => s.teilnehmer.includes(player.id)).length;
  const quoteSpieltage = vergangeneSpieltage.length > 0 ? (spieltagDabeiAnzahl / vergangeneSpieltage.length) * 100 : null;

  const spieltageDabei = spieltage
    .filter((s) => spieltagGespielt(s) && s.teilnehmer.includes(player.id))
    .sort((a, b) => b.date.localeCompare(a.date));
  const spieltagNr = spieltagNummern(spieltage);
  const toreGesamt = spieltage
    .flatMap((s) => s.spiele)
    .flatMap((sp) => sp.scorers)
    .filter((sc) => sc.playerId === player.id)
    .reduce((sum, sc) => sum + Number(sc.tore || 0), 0);

  const handleSammelkarte = async () => {
    setKartenLaeuft(true);
    setKartenFehler(null);
    try {
      const blob = await generateSammelkarte(
        player,
        sammelkartenWerte({
          tore: toreGesamt,
          spieltage: spieltagDabeiAnzahl,
          training: quoteTraining != null ? Math.round(quoteTraining) : null,
          spieltagQuote: quoteSpieltage != null ? Math.round(quoteSpieltage) : null,
          monat: monatsBewertungProzent(saisonTrainings, month),
          karten: kartenZaehlen(saisonTrainings),
        }),
        saison ? saison.replace("-", "/") : "",
        teamName
      );
      const dateiname = `sammelkarte-${(player.name + (player.nachname ? "-" + player.nachname : "")).toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-")}.png`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = dateiname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setKartenFehler((e && e.message) || "Sammelkarte konnte nicht erstellt werden.");
    } finally {
      setKartenLaeuft(false);
    }
  };

  return (
    <section>
      <div style={styles.rowBetween}>
        <button style={styles.linkBtn} onClick={onClose}>
          ← Zurück zu Home
        </button>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <button style={styles.linkBtn} onClick={handleSammelkarte} disabled={kartenLaeuft}>
            {kartenLaeuft ? "Erstelle Karte…" : "Sammelkarte laden"}
          </button>
          {onOpenSettings && (
            <button style={styles.linkBtn} onClick={() => onOpenSettings(player.id)}>
              Einstellungen
            </button>
          )}
        </div>
      </div>
      {kartenFehler && <div style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 6 }}>{kartenFehler}</div>}
      {(vorheriger || naechster) && onNavigate && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 10 }}>
          <button style={{ ...styles.linkBtn, textAlign: "left" }} onClick={() => onNavigate(vorheriger)} aria-label={`Vorheriger Spieler: ${vorheriger.name}`}>
            ‹ {vorheriger.name}
          </button>
          <button style={{ ...styles.linkBtn, textAlign: "right" }} onClick={() => onNavigate(naechster)} aria-label={`Nächster Spieler: ${naechster.name}`}>
            {naechster.name} ›
          </button>
        </div>
      )}
      <PlayerCard
        player={player}
        teamName={teamName}
        stats={[
          { value: monatsPunkte.toFixed(2), label: "PKT MONAT" },
          { value: saisonPunkte.toFixed(2), label: "PKT SAISON" },
          { value: basisAktuell.toFixed(2), label: "BASIS" },
          { value: toreGesamt, label: "TORE" },
          { value: quoteSpieltage != null ? quoteSpieltage.toFixed(0) + "%" : "–", label: "ANW. SPIELTAGE", kurz: "ANWESENHEIT SPIELTAGE", icon: "pokal", prozent: quoteSpieltage },
          { value: quoteTraining != null ? quoteTraining.toFixed(0) + "%" : "–", label: "ANW. TRAININGS", kurz: "ANWESENHEIT TRAININGS", icon: "schuh", prozent: quoteTraining },
        ]}
      />

      <div style={{ ...styles.segNav, marginTop: 16 }}>
        <button
          onClick={() => setHistorieTab("training")}
          aria-pressed={!!(historieTab === "training")} style={{ ...styles.segBtn, ...(historieTab === "training" ? styles.segBtnActive : {}) }}
        >
          Training {saison ? saison.replace("-", "/") : ""}
        </button>
        <button
          onClick={() => setHistorieTab("spieltage")}
          aria-pressed={!!(historieTab === "spieltage")} style={{ ...styles.segBtn, ...(historieTab === "spieltage" ? styles.segBtnActive : {}) }}
        >
          Spieltag-Teilnahmen
        </button>
        <button
          onClick={() => setHistorieTab("notizen")}
          aria-pressed={!!(historieTab === "notizen")} style={{ ...styles.segBtn, ...(historieTab === "notizen" ? styles.segBtnActive : {}) }}
        >
          Notizen{notizenAlle.length > 0 ? ` (${notizenAlle.length})` : ""}
        </button>
      </div>

      {historieTab === "notizen" &&
        (notizenAlle.length === 0 ? (
          <EmptyState text="Noch keine Notizen in dieser Saison." />
        ) : (
          <>
          <div style={{ margin: "4px 2px 10px" }}><KartenZaehler eintraege={notizenAlle} /></div>
          <div className="card-list" style={styles.cardList}>
            {notizenAlle.map((t) => (
              <div key={t.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{formatTerminLabel(t.date)}</span>
                  {t.karte && t.karte !== "keine" && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 600 }}>
                      <KartenIcon karte={t.karte} /> {KARTEN_LABEL[t.karte]}
                    </span>
                  )}
                </div>
                {t.kommentar && t.kommentar.trim() !== "" && <FormatierterText text={t.kommentar} />}
              </div>
            ))}
          </div>
          </>
        ))}

      {historieTab === "training" &&
        (saisonTrainings.length === 0 ? (
          <EmptyState text="Noch keine Trainingsbewertungen in dieser Saison." />
        ) : (
          <div className="card-list" style={styles.cardList}>
            {saisonTrainings.map((t) => (
              <div key={t.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{formatTerminLabel(t.date)}</span>
                  <span
                    style={{
                      ...styles.pill,
                      background: trainingPunkte(t) >= 0 ? "var(--pos-bg)" : "var(--neg-bg)",
                      color: trainingPunkte(t) >= 0 ? "var(--pos-text)" : "var(--danger-text)",
                    }}
                  >
                    {trainingPunkte(t) >= 0 ? "+" : ""}
                    {trainingPunkte(t).toFixed(2)} Pkt.
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--muted)" }}>
                  {TEILNAHME_LABEL[t.teilnahme]}
                  {t.karte !== "keine" && ` · Karte: ${t.karte[0].toUpperCase() + t.karte.slice(1)}`}
                </div>
              </div>
            ))}
          </div>
        ))}

      {historieTab === "spieltage" &&
        (spieltageDabei.length === 0 ? (
          <EmptyState text="Noch an keinem Spieltag teilgenommen." />
        ) : (
          <div className="card-list" style={styles.cardList}>
            {spieltageDabei.map((s) => {
              const toreAnDiesemTag = s.spiele
                .flatMap((sp) => sp.scorers)
                .filter((sc) => sc.playerId === player.id)
                .reduce((sum, sc) => sum + Number(sc.tore || 0), 0);
              return (
                <div key={s.id} style={styles.spielRow}>
                  <div>
                    {formatTerminLabel(s.date)}
                    <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: 13 }}>{spieltagLabel(s, spieltagNr.get(s.id))}</span>
                  </div>
                  <div>
                    {toreAnDiesemTag > 0 && (
                      <span style={{ ...styles.pill, background: "var(--pos-bg)", color: "var(--pos-text)" }}>
                        ⚽ {toreAnDiesemTag} {toreAnDiesemTag === 1 ? "Tor" : "Tore"}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
}

function SaisonBilanz({ spieltage, players, month, onOpenPlayer }) {
  const saison = seasonKeyOf(month);

  const spieleDerSaison = useMemo(
    () => spieltage.filter((s) => seasonKeyOf(s.date.slice(0, 7)) === saison).flatMap((s) => s.spiele),
    [spieltage, saison]
  );

  const bilanz = spieleDerSaison.reduce(
    (acc, sp) => {
      acc.toreFuer += sp.ourGoals;
      acc.toreGegen += sp.theirGoals;
      if (sp.ourGoals > sp.theirGoals) acc.siege += 1;
      else if (sp.ourGoals < sp.theirGoals) acc.niederlagen += 1;
      else acc.unentschieden += 1;
      sp.scorers.forEach((sc) => {
        acc.tore[sc.playerId] = (acc.tore[sc.playerId] || 0) + Number(sc.tore || 0);
      });
      return acc;
    },
    { siege: 0, unentschieden: 0, niederlagen: 0, toreFuer: 0, toreGegen: 0, tore: {} }
  );

  const spielerName = (id) => players.find((p) => p.id === id)?.name || "Unbekannt";
  const torschuetzen = Object.entries(bilanz.tore)
    .map(([playerId, tore]) => ({ playerId, tore }))
    .sort((a, b) => b.tore - a.tore);

  return (
    <>
    <div style={{ marginTop: 8 }}>
      <KartenTitel block>Saisonbilanz {saison ? saison.replace("-", "/") : ""}</KartenTitel>

      {spieleDerSaison.length === 0 && (
        <EmptyState nach="spieltage" text="Noch keine Spiele in dieser Saison erfasst." />
      )}

      {spieleDerSaison.length > 0 && (
        <>
          <div style={styles.statsRow}>
            <div style={styles.statBox}>
              <div style={styles.statValue}>{spieleDerSaison.length}</div>
              <div style={styles.statLabel}>Spiele</div>
            </div>
            <div style={styles.statBox}>
              <div style={styles.statValue}>{bilanz.siege}</div>
              <div style={styles.statLabel}>Siege</div>
            </div>
            <div style={styles.statBox}>
              <div style={styles.statValue}>{bilanz.unentschieden}</div>
              <div style={styles.statLabel}>Unentschieden</div>
            </div>
            <div style={styles.statBox}>
              <div style={styles.statValue}>{bilanz.niederlagen}</div>
              <div style={styles.statLabel}>Niederlagen</div>
            </div>
            <div style={styles.statBox}>
              <div style={styles.statValue}>
                {bilanz.toreFuer}:{bilanz.toreGegen}
              </div>
              <div style={styles.statLabel}>Tore</div>
            </div>
          </div>
        </>
      )}
    </div>

    {spieleDerSaison.length > 0 && torschuetzen.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <KartenTitel block>Torschützenliste</KartenTitel>
              <div className="nz-tabelle" style={styles.tableWrap}>
                <table style={styles.table}>
                  <tbody>
                    {torschuetzen.map((t, i) => (
                      <tr key={t.playerId}>
                        <td style={styles.tdName}>
                          <span style={styles.rank}>{i + 1}</span>
                          <SpielerLink id={t.playerId} name={spielerName(t.playerId)} players={players} onOpen={onOpenPlayer} />
                        </td>
                        <td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>{t.tore}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
    )}
    </>
  );
}

function GegnerBilanzTabelle({ spieltage, gegner, month }) {
  const [umfang, setUmfang] = useState("saison"); // "saison" (Standard) oder "gesamt"
  const saison = seasonKeyOf(month);
  // „Gesamt“ nur anbieten, wenn Spieltage aus mehr als einer Saison vorliegen
  const mehrereSaisons = useMemo(() => new Set(spieltage.map((s) => seasonKeyOf(s.date.slice(0, 7)))).size > 1, [spieltage]);
  const umfangWirksam = mehrereSaisons ? umfang : "saison";
  const bilanzen = useMemo(() => {
    const alleSpiele = (umfangWirksam === "saison" ? spieltage.filter((s) => seasonKeyOf(s.date.slice(0, 7)) === saison) : spieltage).flatMap((s) => s.spiele);
    const map = {};
    alleSpiele.forEach((sp) => {
      if (!sp.opponentId) return;
      if (!map[sp.opponentId]) {
        map[sp.opponentId] = { spiele: 0, siege: 0, unentschieden: 0, niederlagen: 0, toreFuer: 0, toreGegen: 0 };
      }
      const b = map[sp.opponentId];
      b.spiele += 1;
      b.toreFuer += sp.ourGoals;
      b.toreGegen += sp.theirGoals;
      if (sp.ourGoals > sp.theirGoals) b.siege += 1;
      else if (sp.ourGoals < sp.theirGoals) b.niederlagen += 1;
      else b.unentschieden += 1;
    });
    return gegner
      .filter((g) => map[g.id])
      .map((g) => ({ id: g.id, name: g.name, ...map[g.id] }))
      .sort((a, b) => b.spiele - a.spiele);
  }, [spieltage, gegner, umfangWirksam, saison]);

  return (
    <div style={{ marginTop: 8 }}>
      <KartenTitel block>Bilanz pro Gegner</KartenTitel>
      {mehrereSaisons && (
        <div role="group" aria-label="Zeitraum" style={{ ...styles.segNav, marginBottom: 8 }}>
          {[["saison", `Saison ${saison.replace("-", "/")}`], ["gesamt", "Gesamt"]].map(([k, t]) => (
            <button key={k} aria-pressed={umfang === k} onClick={() => setUmfang(k)} style={{ ...styles.segBtn, ...(umfang === k ? styles.segBtnActive : {}) }}>{t}</button>
          ))}
        </div>
      )}
      {bilanzen.length === 0 ? (
        <EmptyState text={umfangWirksam === "saison" ? "Noch keine Spiele gegen hinterlegte Gegner in dieser Saison." : "Noch keine Spiele gegen hinterlegte Gegner erfasst."} />
      ) : (
        <div className="nz-tabelle" style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Gegner</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Spiele</th>
                <th style={{ ...styles.th, textAlign: "right" }}>S</th>
                <th style={{ ...styles.th, textAlign: "right" }}>U</th>
                <th style={{ ...styles.th, textAlign: "right" }}>N</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Tore</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Diff.</th>
              </tr>
            </thead>
            <tbody>
              {bilanzen.map((b) => {
                const diff = b.toreFuer - b.toreGegen;
                return (
                  <tr key={b.id}>
                    <td style={styles.tdName}>{b.name}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{b.spiele}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{b.siege}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{b.unentschieden}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{b.niederlagen}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>
                      {b.toreFuer}:{b.toreGegen}
                    </td>
                    <td style={{ ...styles.td, textAlign: "right", fontWeight: 700, color: diff > 0 ? "var(--success-text)" : diff < 0 ? "var(--loss-text)" : "var(--text-2)" }}>
                      {diff > 0 ? "+" : ""}
                      {diff}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EntwicklungsVerlauf({ players, basis, entwicklungen, months, month, onOpenPlayer }) {
  const saison = seasonKeyOf(month);
  const saisonMonate = useMemo(() => months.filter((m) => seasonKeyOf(m) === saison).sort(), [months, saison]);

  if (players.length === 0) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <KartenTitel block>Entwicklungsverlauf (Basis-Qualität)</KartenTitel>
      {saisonMonate.length < 2 ? (
        <EmptyState text="Noch nicht genug Monate mit Daten für einen Verlauf." />
      ) : (
        <div style={styles.sparkGrid}>
          {players.map((p) => {
            const werte = saisonMonate.map((m) => basisNachMonat(p.id, basis, entwicklungen, m));
            const letzterWert = werte[werte.length - 1];
            return (
              <div key={p.id} style={styles.sparkCard}>
                <div style={styles.sparkHead}>
                  <span style={{ ...styles.cardName, display: "flex", alignItems: "center", gap: 10 }}><SpielerLink id={p.id} name={p.name} players={players} onOpen={onOpenPlayer} /></span>
                  <span style={styles.sparkValue}>{letzterWert.toFixed(2)}</span>
                </div>
                <Sparkline values={werte} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Sparkline({ values, width = 220, height = 46 }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * (height - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const lastX = (values.length - 1) * step;
  const lastY = height - ((values[values.length - 1] - min) / range) * (height - 6) - 3;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" strokeWidth="2" style={{ stroke: "var(--accent-text)" }} />
      <circle cx={lastX} cy={lastY} r="3" style={{ fill: "var(--accent-text)" }} />
    </svg>
  );
}

/* ---------- Training bewerten ---------- */

function TrainingBewertung({ zielDatum, players, trainings, termine, onSave, onDelete, onSaveTerminNotiz }) {
  const geplanteTermine = useMemo(
    () =>
      termine
        .filter((t) => t.status !== "abgesagt")
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date)),
    [termine]
  );
  const bewerteteDaten = useMemo(() => new Set(trainings.map((t) => t.date)), [trainings]);
  const today = todayISO();

  const ermittleDefaultDate = (liste, bewertet) => {
    const vergangeneUnbewertet = liste.filter((t) => t.date <= today && !bewertet.has(t.date));
    if (vergangeneUnbewertet.length > 0) return vergangeneUnbewertet[0].date;
    const kommende = liste.filter((t) => t.date > today).sort((a, b) => a.date.localeCompare(b.date));
    if (kommende.length > 0) return kommende[0].date;
    return liste.find((t) => t.date <= today)?.date || liste[0]?.date || "";
  };

  const [date, setDate] = useState(() =>
    zielDatum && geplanteTermine.some((t) => t.date === zielDatum) ? zielDatum : ermittleDefaultDate(geplanteTermine, bewerteteDaten)
  );
  const [rows, setRows] = useState({});
  const [geprueft, setGeprueft] = useState(() => new Set());
  useEffect(() => { setGeprueft(new Set()); }, [date]);

  useEffect(() => {
    if (!date && geplanteTermine[0]) setDate(ermittleDefaultDate(geplanteTermine, bewerteteDaten));
  }, [geplanteTermine]); // eslint-disable-line

  useEffect(() => {
    const init = {};
    players.forEach((p) => {
      const existing = trainings.find((t) => t.date === date && t.playerId === p.id);
      init[p.id] = existing
        ? { vorkommnis: existing.vorkommnis, karte: existing.karte, teilnahme: existing.teilnahme, kommentar: existing.kommentar || "" }
        : { vorkommnis: 0, karte: "keine", teilnahme: "anwesend", kommentar: "" };
    });
    setRows(init);
  }, [date, players, trainings]);

  const getRow = (id) => rows[id] || { vorkommnis: 0, karte: "keine", teilnahme: "anwesend", kommentar: "" };
  const setRow = (id, patch) => {
    setRows((r) => ({ ...r, [id]: { ...getRow(id), ...patch } }));
    setGeprueft((g) => (g.has(id) ? g : new Set(g).add(id)));
  };

  const save = async () => {
    if (players.length === 0 || !date) return;
    const entries = players.map((p) => ({ id: uid(), date, playerId: p.id, ...getRow(p.id) }));
    const ok = await onSave(entries, date);
    if (ok === false) return; // bei Fehler bleiben die Eingaben erhalten
    const bewertetNachSpeichern = new Set(bewerteteDaten);
    bewertetNachSpeichern.add(date);
    setDate(ermittleDefaultDate(geplanteTermine, bewertetNachSpeichern));
  };

  const aktuellBewertet = bewerteteDaten.has(date);
  const istGeprueft = (id) => aktuellBewertet || geprueft.has(id);
  const anzGeprueft = players.filter((p) => istGeprueft(p.id)).length;

  const deleteBewertung = () => {
    if (!date || !onDelete) return;
    confirmAnd(
      `Trainingsbewertung für ${formatTerminLabel(date)} wirklich löschen?`,
      () => {
        onDelete(date);
        const bewertetNachLoeschen = new Set(bewerteteDaten);
        bewertetNachLoeschen.delete(date);
        setDate(ermittleDefaultDate(geplanteTermine, bewertetNachLoeschen));
      }
    );
  };

  return (
    <section>
      <div style={{ ...styles.card, marginBottom: 14 }}>
        <KartenTitel>Training bewerten</KartenTitel>
        {geplanteTermine.length > 0 ? (
          <select aria-label="Trainingstermin" style={{ ...styles.select, width: "100%" }} value={date} onChange={(e) => setDate(e.target.value)}>
            {geplanteTermine.filter((t, i, arr) => t.date <= today || t.date === date || arr.filter((x) => x.date > today && x.date < t.date).length < 2).map((t) => (
              <option key={t.id} value={t.date}>
                {formatTerminLabel(t.date)}
                {bewerteteDaten.has(t.date) ? " ✓ bewertet" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span style={styles.hint}>Keine Termine angelegt</span>
        )}
        {geplanteTermine.length > 0 && players.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 4, fontSize: 14, fontWeight: 600 }}>
              <span style={{ whiteSpace: "nowrap" }}>{anzGeprueft} von {players.length} geprüft</span>
              {anzGeprueft < players.length && (
                <button type="button" style={{ ...styles.linkBtn, minHeight: 44, textAlign: "left" }} onClick={() => setGeprueft(new Set(players.map((p) => p.id)))}>
                  Rest als „anwesend“ bestätigen
                </button>
              )}
            </div>
            <div style={{ height: 6, borderRadius: 999, background: "var(--border)", overflow: "hidden", marginTop: 4 }} aria-hidden="true">
              <div style={{ height: "100%", width: `${(anzGeprueft / players.length) * 100}%`, background: "var(--accent)", transition: "width 150ms ease-out" }} />
            </div>
          </div>
        )}
      </div>

      {geplanteTermine.length === 0 && (
        <EmptyState nach="verwaltung" text="Noch keine Trainingstermine angelegt." />
      )}
      {geplanteTermine.length > 0 && players.length === 0 && (
        <EmptyState nach="verwaltung" text="Noch keine aktiven Spieler vorhanden." />
      )}
      {aktuellBewertet && (
        <div style={{ ...styles.editBanner, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span>Dieser Termin wurde bereits bewertet — Änderungen überschreiben die bestehende Bewertung.</span>
          <button style={{ ...styles.linkBtn, ...styles.dangerBtn, whiteSpace: "nowrap" }} onClick={deleteBewertung}>
            Bewertung löschen
          </button>
        </div>
      )}

      {(() => {
        const termin = termine.find((t) => t.date === date);
        if (!termin || !onSaveTerminNotiz) return null;
        return (
          <div style={{ ...styles.card, marginBottom: 12 }}>
            <SpieltagNotizen
              key={termin.id}
              value={termin.bewertung_notizen}
              onSave={(text) => onSaveTerminNotiz(termin.id, text)}
              label="Notizen zur Bewertung"
              placeholder="Allgemeine Eindrücke zum Training, was gut/schlecht lief …"
              rows={3}
            />
          </div>
        );
      })()}

      <div className="card-list" style={styles.cardList}>
        {players.map((p) => {
          const row = getRow(p.id);
          const punkte = trainingPunkte(row);
          return (
            <div key={p.id} style={styles.card}>
              <div style={styles.cardHead}>
                <span style={{ ...styles.cardName, display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar name={p.name} size={36} photoUrl={p.photo_url} />
                  {p.name}
                  {istGeprueft(p.id) && <span title="Geprüft" aria-label="Geprüft" style={{ color: "var(--pos-text)", fontWeight: 800 }}>✓</span>}
                </span>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    minWidth: 64,
                    padding: "6px 12px",
                    borderRadius: 12,
                    lineHeight: 1.1,
                    background: punkte >= 0 ? "var(--pos-bg)" : "var(--neg-bg)",
                    color: punkte >= 0 ? "var(--pos-text)" : "var(--danger-text)",
                  }}
                >
                  <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, fontWeight: 800 }}>
                    {punkte >= 0 ? "+" : ""}
                    {punkte.toFixed(2)}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.8 }}>Punkte</span>
                </div>
              </div>

              <div style={styles.fieldRow}>
                <label htmlFor={`tn-${p.id}`} style={styles.label}>Teilnahme</label>
                <select id={`tn-${p.id}`} style={styles.select} value={row.teilnahme} onChange={(e) => setRow(p.id, { teilnahme: e.target.value })}>
                  {Object.keys(TEILNAHME).map((k) => (
                    <option key={k} value={k}>
                      {TEILNAHME_LABEL[k]} ({TEILNAHME[k] > 0 ? "+" : ""}
                      {TEILNAHME[k]})
                    </option>
                  ))}
                </select>
              </div>

              <div style={styles.fieldRow}>
                <label htmlFor={`vk-${p.id}`} style={{ ...styles.label, flexBasis: "100%" }}>Besonderes Vorkommnis</label>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 100%" }}>
                  <input
                    id={`vk-${p.id}`}
                    type="range"
                    min={-1}
                    max={1}
                    step={0.25}
                    value={row.vorkommnis}
                    onChange={(e) => setRow(p.id, { vorkommnis: Number(e.target.value) })}
                    style={styles.range}
                  />
                  <span style={styles.rangeValue}>
                    {row.vorkommnis > 0 ? "+" : ""}
                    {Number(row.vorkommnis).toFixed(2)}
                  </span>
                </div>
              </div>

              <div style={styles.fieldRow}>
                <span id={`karte-${p.id}`} style={styles.label}>Karte</span>
                <div role="group" aria-labelledby={`karte-${p.id}`} style={styles.chipGroup}>
                  {Object.keys(KARTEN).map((k) => (
                    <button
                      key={k}
                      onClick={(e) => { setRow(p.id, { karte: k }); e.currentTarget.blur(); }}
                      aria-pressed={!!(row.karte === k)} style={{ ...styles.chip, ...(row.karte === k ? styles.chipActive : {}) }}
                    >
                      {k === "keine" ? "Keine" : k[0].toUpperCase() + k.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <FormatTextarea
                  label="Kommentar (optional)"
                  placeholder="Etwas Besonderes zu diesem Spieler festhalten…"
                  value={row.kommentar || ""}
                  onChange={(v) => setRow(p.id, { kommentar: v })}
                  rows={2}
                  hint={false}
                />
              </div>
            </div>
          );
        })}
      </div>

      {players.length > 0 && date && (
        <div style={styles.stickyBar}>
          <button style={styles.primaryBtn} onClick={save}>
            Trainingsbewertung speichern
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------- Monatsentwicklung ---------- */

function MonatsEntwicklung({ players, entwicklungen, onSave }) {
  const [month, setMonth] = useState(monthKey(new Date()));
  const [values, setValues] = useState({});

  useEffect(() => {
    const init = {};
    players.forEach((p) => {
      const existing = entwicklungen.find((e) => e.playerId === p.id && e.month === month);
      init[p.id] = existing ? existing.punkte : 0;
    });
    setValues(init);
  }, [month, players, entwicklungen]);

  const save = () => {
    const entries = players.map((p) => ({ id: uid(), month, playerId: p.id, punkte: Number(values[p.id] || 0) }));
    onSave(entries, month);
  };

  return (
    <section>
      <div style={{ ...styles.card, marginBottom: 14 }}>
        <KartenTitel>Monat wählen</KartenTitel>
        <div style={{ fontSize: 14, lineHeight: 1.45, color: "var(--text)", marginBottom: 12 }}>
          Extrapunkte (-1 bis +1) fließen ab dem Folgemonat in die Basis-Qualität ein.
        </div>
        <input
          type="month"
          aria-label="Monat"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{ ...styles.select, minWidth: 150 }}
        />
      </div>

      {players.length === 0 && <EmptyState nach="verwaltung" text="Noch keine aktiven Spieler vorhanden." />}

      <div className="card-list" style={styles.cardList}>
        {players.map((p) => (
          <div key={p.id} style={styles.card}>
            <div style={styles.cardHead}>
              <span style={styles.cardName}>{p.name}</span>
            </div>
            <div style={styles.fieldRow}>
              <input
                type="range"
                aria-label={`Extrapunkte ${p.name}`}
                min={-1}
                max={1}
                step={0.25}
                value={values[p.id] ?? 0}
                onChange={(e) => setValues((v) => ({ ...v, [p.id]: Number(e.target.value) }))}
                style={styles.range}
              />
              <span style={styles.rangeValue}>
                {(values[p.id] ?? 0) > 0 ? "+" : ""}
                {Number(values[p.id] ?? 0).toFixed(2)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {players.length > 0 && (
        <div style={styles.stickyBar}>
          <button style={styles.primaryBtn} onClick={save}>
            Monatsentwicklung speichern
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------- Spieltage ---------- */

function Spieltage({ zielSpieltagId, players, gegner, spieltage, onRemoveSpieltag, onAddSpiel, onUpdateSpiel, onRemoveSpiel, onToggleTeilnehmer, onUpdateNotizen, onUpdateSpielzeit, onUploadFoto, onOpenPlayer }) {
  const [openSpieltag, setOpenSpieltag] = useState(zielSpieltagId || null);
  const [subTab, setSubTab] = useState("liste");
  const [uebersichtSort, setUebersichtSort] = useState("spiele");
  const sorted = [...spieltage].sort((a, b) => b.date.localeCompare(a.date));
  const nummern = useMemo(() => spieltagNummern(spieltage), [spieltage]);

  const uebersicht = useMemo(() => {
    const stats = {};
    players.forEach((p) => {
      stats[p.id] = { id: p.id, name: p.name, spiele: 0, tore: 0 };
    });
    spieltage.forEach((s) => {
      const anzahlSpiele = s.spiele.length;
      s.teilnehmer.forEach((playerId) => {
        if (stats[playerId]) stats[playerId].spiele += anzahlSpiele;
      });
      s.spiele.forEach((sp) => {
        sp.scorers.forEach((sc) => {
          if (stats[sc.playerId]) stats[sc.playerId].tore += Number(sc.tore) || 0;
        });
      });
    });
    const mitQuote = Object.values(stats).map((p) => ({ ...p, quote: p.spiele > 0 ? p.tore / p.spiele : 0 }));
    return mitQuote.sort((a, b) => {
      if (uebersichtSort === "quote") return b.quote - a.quote || b.spiele - a.spiele || a.name.localeCompare(b.name);
      if (uebersichtSort === "tore") return b.tore - a.tore || b.spiele - a.spiele || a.name.localeCompare(b.name);
      return b.spiele - a.spiele || b.tore - a.tore || a.name.localeCompare(b.name);
    });
  }, [players, spieltage, uebersichtSort]);

  return (
    <section>

      <div style={styles.segNav}>
        <button
          onClick={() => setSubTab("liste")}
          aria-pressed={!!(subTab === "liste")} style={{ ...styles.segBtn, ...(subTab === "liste" ? styles.segBtnActive : {}) }}
        >
          Spieltage
        </button>
        <button
          onClick={() => setSubTab("uebersicht")}
          aria-pressed={!!(subTab === "uebersicht")} style={{ ...styles.segBtn, ...(subTab === "uebersicht" ? styles.segBtnActive : {}) }}
        >
          Übersicht
        </button>
      </div>

      {subTab === "liste" && (
        <>
          {sorted.length === 0 && (
            <EmptyState nach="verwaltung" text="Noch keine Spieltage angelegt. Du legst sie im Setup unter „Spieltage“ an." />
          )}

          <div className="card-list" style={styles.cardList}>
            {sorted.map((s) => (
              <SpieltagCard
                key={s.id}
                spieltag={s}
                nummer={nummern.get(s.id)}
                players={players}
                gegner={gegner}
                open={openSpieltag === s.id}
                onToggle={() => setOpenSpieltag(openSpieltag === s.id ? null : s.id)}
                onRemoveSpieltag={() => onRemoveSpieltag(s.id)}
                onAddSpiel={(spiel) => onAddSpiel(s.id, spiel)}
                onUpdateSpiel={(spiel) => onUpdateSpiel(s.id, spiel)}
                onRemoveSpiel={(spielId) => onRemoveSpiel(s.id, spielId)}
                onToggleTeilnehmer={(playerId, istDabei) => onToggleTeilnehmer(s.id, playerId, istDabei)}
                onUpdateNotizen={(notizen) => onUpdateNotizen(s.id, notizen)}
                onUpdateSpielzeit={(min) => onUpdateSpielzeit(s.id, min)}
                onUploadFoto={(file) => onUploadFoto(s.id, file)}
              />
            ))}
          </div>
        </>
      )}

      {subTab === "uebersicht" && (
        <div style={{ marginTop: 4 }}>
          <div style={{ ...styles.card, marginBottom: 16 }}>
          <KartenTitel>Sortieren nach</KartenTitel>
          <div style={{ fontSize: 14, lineHeight: 1.45, color: "var(--text)", marginBottom: 12 }}>
            Anzahl der Spiele, an denen ein Spieler laut Kader-Eintrag an den jeweiligen Spieltagen teilgenommen hat.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => setUebersichtSort("spiele")}
              aria-pressed={!!(uebersichtSort === "spiele")} style={{ ...styles.chip, ...(uebersichtSort === "spiele" ? styles.chipActive : {}) }}
            >
              Spiele
            </button>
            <button
              onClick={() => setUebersichtSort("tore")}
              aria-pressed={!!(uebersichtSort === "tore")} style={{ ...styles.chip, ...(uebersichtSort === "tore" ? styles.chipActive : {}) }}
            >
              Tore
            </button>
            <button
              onClick={() => setUebersichtSort("quote")}
              aria-pressed={!!(uebersichtSort === "quote")} style={{ ...styles.chip, ...(uebersichtSort === "quote" ? styles.chipActive : {}) }}
            >
              Tore/Spiel
            </button>
          </div>
          </div>
          {uebersicht.length === 0 && <EmptyState text="Noch keine Daten vorhanden." />}
          {uebersicht.length > 0 && (
            <div className="card-list" style={styles.cardList}>
              {uebersicht.map((p, idx) => {
                const player = players.find((pl) => pl.id === p.id);
                return (
                <div key={p.id} style={styles.card}>
                  <div style={styles.cardHead}>
                    <span style={{ ...styles.cardName, display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={styles.rank}>{idx + 1}</span>
                      <Avatar name={p.name} size={36} photoUrl={player?.photo_url} />
                      <button style={styles.playerNameBtn} onClick={() => onOpenPlayer(p.id)}>
                        {p.name}
                      </button>
                    </span>
                    <div style={{ display: "flex", gap: 16, fontSize: 13, color: "var(--muted)", flexShrink: 0 }}>
                      <span>
                        <strong style={{ color: "var(--text)" }}>{p.spiele}</strong> Spiele
                      </span>
                      <span>
                        <strong style={{ color: "var(--text)" }}>{p.tore}</strong> Tore
                      </span>
                      <span>
                        <strong style={{ color: "var(--text)" }}>{p.quote.toFixed(2)}</strong> Tore/Spiel
                      </span>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function EditIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

function ZeitSelect({ value, onChange }) {
  const [h, m] = (value || "").split(":");
  const stunden = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const minuten = ["00", "15", "30", "45"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <select
        aria-label="Stunde"
        style={{ ...styles.select, width: 62 }}
        value={h || ""}
        onChange={(e) => onChange(`${e.target.value}:${m || "00"}`)}
      >
        <option value="" disabled>
          --
        </option>
        {stunden.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <span style={{ color: "var(--muted)" }}>:</span>
      <select
        aria-label="Minute"
        style={{ ...styles.select, width: 62 }}
        value={m || ""}
        onChange={(e) => onChange(`${h || "00"}:${e.target.value}`)}
      >
        <option value="" disabled>
          --
        </option>
        {minuten.map((mn) => (
          <option key={mn} value={mn}>
            {mn}
          </option>
        ))}
      </select>
    </div>
  );
}

function CameraIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-3px" }}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function RestoreIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-3px" }}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function GoalStepper({ value, onChange }) {
  const n = Number(value) || 0;
  return (
    <div style={styles.goalStepper}>
      <button
        type="button"
        style={{ ...styles.goalStepperBtn, ...(n <= 0 ? { opacity: 0.35, cursor: "default" } : {}) }}
        disabled={n <= 0}
        onClick={(e) => { onChange(Math.max(0, n - 1)); e.currentTarget.blur(); }}
        aria-label="Tor abziehen"
      >
        −
      </button>
      <span style={styles.goalStepperValue}>{n}</span>
      <button
        type="button"
        style={styles.goalStepperBtn}
        onClick={(e) => { onChange(n + 1); e.currentTarget.blur(); }}
        aria-label="Tor hinzufügen"
      >
        +
      </button>
    </div>
  );
}

function ChevronIcon({ size = 16, open }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/* Kachel-Titel: Klick klappt die ganze Kachel (Eltern-Element) auf/zu. Zustand bleibt pro Titel bis zum Neuladen erhalten. */
const NZ_ZU = {};
/* Einmalig: welcher Unterbereich in Setup beim nächsten Öffnen vorne liegt (z. B. von Home aus der Briefkasten) */
let NZ_SETUP_START = null;
function KartenTitel({ children, block = false, aktion = null, zuStart = false, style }) {
  const ref = useRef(null);
  const key = [].concat(children).join("");
  const [zu, setZu] = useState(NZ_ZU[key] !== undefined ? !!NZ_ZU[key] : !!zuStart);
  const anwenden = (wert) => {
    const h = ref.current;
    if (!h) return;
    let karte = h.parentElement;
    const pfad = [];
    if (!block) {
      let el = h.parentElement;
      for (let i = 0; el && i < 2; i++) {
        const cs = getComputedStyle(el);
        if (parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderTopLeftRadius) > 0) { karte = el; break; }
        pfad.push(el);
        el = el.parentElement;
      }
      if (karte !== el) pfad.length = 0;
    }
    pfad.forEach((p) => p.classList.add("nz-pfad"));
    if (karte) karte.classList.toggle("nz-zu", wert);
  };
  useLayoutEffect(() => { anwenden(zu); }, []);
  const umschalten = (e) => {
    if (e.target !== e.currentTarget && e.target.closest("button, a, input, select, textarea")) return;
    const neu = !zu;
    NZ_ZU[key] = neu;
    setZu(neu);
    anwenden(neu);
  };
  return (
    <h3
      ref={ref}
      className="nz-titel"
      role="button"
      tabIndex={0}
      aria-expanded={!zu}
      onClick={umschalten}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); umschalten(e); } }}
      style={{ ...(block ? styles.h3Block : styles.h3), display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", ...style }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {aktion}
      <span aria-hidden="true" style={{ flex: "none", display: "inline-flex", color: "var(--muted)" }}><ChevronIcon size={16} open={!zu} /></span>
    </h3>
  );
}

function Hinweis({ children, style }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 14, lineHeight: 1.45, color: "var(--text)", margin: "0 0 14px", ...style }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 11v5.5" />
        <circle cx="12" cy="7.6" r="0.6" fill="var(--accent-text)" />
      </svg>
      <div>{children}</div>
    </div>
  );
}

function TrashIcon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: "-3px" }}
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function ShareIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-3px" }}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="10.6" x2="15.4" y2="6.4" />
      <line x1="8.6" y1="13.4" x2="15.4" y2="17.6" />
    </svg>
  );
}

function SettingsIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PowerIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}

function LogoutIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

function CheckBadge({ size = 9 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 8.2 6.4 11.6 13 4.4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpieltagZusammenfassung({ spiele }) {
  const stats = spiele.reduce(
    (acc, sp) => {
      acc.toreFuer += sp.ourGoals;
      acc.toreGegen += sp.theirGoals;
      if (sp.ourGoals > sp.theirGoals) acc.siege += 1;
      else if (sp.ourGoals < sp.theirGoals) acc.niederlagen += 1;
      else acc.unentschieden += 1;
      return acc;
    },
    { siege: 0, unentschieden: 0, niederlagen: 0, toreFuer: 0, toreGegen: 0 }
  );
  return (
    <div style={styles.spieltagSummary}>
      {stats.siege > 0 && <span style={{ ...styles.summaryPill, ...styles.summaryPillWin }}>{stats.siege}S</span>}
      {stats.unentschieden > 0 && <span style={{ ...styles.summaryPill, ...styles.summaryPillDraw }}>{stats.unentschieden}U</span>}
      {stats.niederlagen > 0 && <span style={{ ...styles.summaryPill, ...styles.summaryPillLoss }}>{stats.niederlagen}N</span>}
      <span style={styles.summaryGoals}>
        Tore {stats.toreFuer}:{stats.toreGegen}
      </span>
    </div>
  );
}

function BulletListIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none" />
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
    </svg>
  );
}

/* Einfaches Text-Format: **fett**, __unterstrichen__, *kursiv*, "• " Aufzählung, "1. " Nummerierung, ![](Bild-URL) Bild */
const BILD_ZEILE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/;

function FormatierterText({ text, style }) {
  const [lightbox, setLightbox] = useState(null);
  const zeilen = (text || "").split("\n");
  const inline = (t) =>
    t.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g).map((teil, i) => {
      if (/^\*\*[^*]+\*\*$/.test(teil)) return <strong key={i}>{inline(teil.slice(2, -2))}</strong>;
      if (/^__[^_]+__$/.test(teil)) return <u key={i}>{inline(teil.slice(2, -2))}</u>;
      if (/^\*[^*\s][^*]*\*$/.test(teil)) return <em key={i}>{inline(teil.slice(1, -1))}</em>;
      return <span key={i}>{teil}</span>;
    });
  return (
    <div style={{ fontSize: 13, lineHeight: 1.45, color: "var(--text)", ...style }}>
      {zeilen.map((z, i) => {
        const bild = z.trim().match(BILD_ZEILE);
        const num = z.match(/^(\d+)\. (.*)$/);
        if (bild) {
          return (
            <img
              key={i}
              src={bild[1]}
              alt=""
              onClick={(e) => { e.stopPropagation(); setLightbox(bild[1]); }}
              style={{ display: "block", maxWidth: "100%", maxHeight: 320, borderRadius: 8, margin: "6px 0", cursor: "zoom-in" }}
            />
          );
        }
        if (z.startsWith("• ")) {
          return (
            <div key={i} style={{ display: "flex", gap: 6, paddingLeft: 2 }}>
              <span aria-hidden="true">•</span>
              <span style={{ flex: 1 }}>{inline(z.slice(2))}</span>
            </div>
          );
        }
        if (num) {
          return (
            <div key={i} style={{ display: "flex", gap: 6, paddingLeft: 2 }}>
              <span aria-hidden="true" style={{ minWidth: 16 }}>{num[1]}.</span>
              <span style={{ flex: 1 }}>{inline(num[2])}</span>
            </div>
          );
        }
        if (z.trim() === "") return <div key={i} style={{ height: 6 }} />;
        return <div key={i}>{inline(z)}</div>;
      })}
      {lightbox && <BildLightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function NumberedListIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 6h11M10 12h11M10 18h11" />
      <path d="M3.5 5l1.5-1v4" strokeWidth="1.6" />
      <path d="M3 13.5c.3-.9 2.5-.9 2.5.3 0 1-2.5 1.6-2.5 2.7h2.7" strokeWidth="1.4" />
    </svg>
  );
}

function ImageIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <circle cx="9" cy="11" r="1.8" />
      <path d="M21 16l-5-5-8 8" />
    </svg>
  );
}

/* ---------- WYSIWYG-Editor ----------
   Gespeichert wird weiterhin das einfache Text-Format (**fett**, __unterstrichen__, *kursiv*, "• ", "1. ", ![](URL)),
   angezeigt/bearbeitet wird es als formatierter Text (contenteditable). */
function escapeHtml(t) {
  // Anführungszeichen mit escapen: escapeHtml landet auch in Attributwerten (<img src="…">), sonst ließen sich dort Attribute einschleusen
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function markupZuHtml(text) {
  const inlineHtml = (t) =>
    escapeHtml(t)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/__([^_]+)__/g, "<u>$1</u>")
      .replace(/\*([^*\s][^*]*)\*/g, "<i>$1</i>");
  const zeilen = (text || "").split("\n");
  let html = "";
  let liste = null; // "ul" | "ol"
  const schliesse = () => {
    if (liste) html += `</${liste}>`;
    liste = null;
  };
  zeilen.forEach((z) => {
    const bild = z.trim().match(BILD_ZEILE);
    const num = z.match(/^(\d+)\. (.*)$/);
    if (z.startsWith("• ")) {
      if (liste !== "ul") { schliesse(); html += "<ul>"; liste = "ul"; }
      html += `<li>${inlineHtml(z.slice(2))}</li>`;
    } else if (num) {
      if (liste !== "ol") { schliesse(); html += `<ol start="${num[1]}">`; liste = "ol"; }
      html += `<li>${inlineHtml(num[2])}</li>`;
    } else if (bild) {
      schliesse();
      html += `<div><img src="${escapeHtml(bild[1])}" alt=""></div>`;
    } else if (z.trim() === "") {
      schliesse();
      html += "<div><br></div>";
    } else {
      schliesse();
      html += `<div>${inlineHtml(z)}</div>`;
    }
  });
  schliesse();
  return html;
}

function htmlZuMarkup(root) {
  const wrap = (m, inner) => {
    const mt = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!mt[2]) return inner;
    return `${mt[1]}${m}${mt[2]}${m}${mt[3]}`;
  };
  const inline = (node) => {
    if (node.nodeType === 3) return node.nodeValue.replace(/ /g, " ");
    if (node.nodeType !== 1) return "";
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (tag === "IMG") return `\n![](${node.getAttribute("src")})\n`;
    const inner = Array.from(node.childNodes).map(inline).join("");
    const st = node.style || {};
    const fett = tag === "B" || tag === "STRONG" || st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600;
    const kursiv = tag === "I" || tag === "EM" || st.fontStyle === "italic";
    const unter = tag === "U" || (st.textDecoration || "").includes("underline");
    let out = inner;
    if (fett) out = wrap("**", out);
    if (kursiv) out = wrap("*", out);
    if (unter) out = wrap("__", out);
    return out;
  };
  const zeilen = [];
  let offen = "";
  const flush = () => {
    if (offen !== "") {
      offen.split("\n").forEach((l) => zeilen.push(l));
      offen = "";
    }
  };
  const verarbeite = (parent) => {
    Array.from(parent.childNodes).forEach((n) => {
      if (n.nodeType === 1 && (n.tagName === "UL" || n.tagName === "OL")) {
        flush();
        const start = n.tagName === "OL" ? parseInt(n.getAttribute("start") || "1", 10) || 1 : 0;
        Array.from(n.children).forEach((li, i) => {
          const t = Array.from(li.childNodes).map(inline).join("").replace(/\n+$/, "").replace(/\n/g, " ");
          zeilen.push((n.tagName === "OL" ? `${start + i}. ` : "• ") + t);
        });
      } else if (n.nodeType === 1 && (n.tagName === "DIV" || n.tagName === "P")) {
        flush();
        if (n.querySelector("ul,ol")) {
          verarbeite(n);
          flush();
        } else {
          const t = Array.from(n.childNodes).map(inline).join("").replace(/^\n/, "").replace(/\n$/, "");
          t.split("\n").forEach((l) => zeilen.push(l));
        }
      } else if (n.nodeType === 1 && n.tagName === "BR") {
        flush();
        zeilen.push("");
      } else {
        offen += inline(n);
      }
    });
  };
  verarbeite(root);
  flush();
  while (zeilen.length && zeilen[zeilen.length - 1].trim() === "") zeilen.pop();
  return zeilen.join("\n");
}

/* Mehrzeiliges Textfeld (WYSIWYG) mit Format-Leiste (Fett, Unterstrichen, Kursiv, Aufzählung, Nummerierung, Bild) und Screenshot-Einfügen per Strg/Cmd+V */
function FormatTextarea({ value, onChange, rows = 5, placeholder, label, hint = true }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const letzter = useRef(null);
  const gemerkterBereich = useRef(null);
  const [ladeBild, setLadeBild] = useState(false);
  const [bildFehler, setBildFehler] = useState(null);
  const [aktiv, setAktiv] = useState({});
  const [leer, setLeer] = useState(!(value || "").trim());
  const text = value || "";

  // Externe Änderungen (Laden, Speichern, Terminwechsel) in den Editor übernehmen, ohne den Cursor bei eigener Eingabe zu verschieben
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (text !== letzter.current) {
      el.innerHTML = markupZuHtml(text);
      letzter.current = text;
    }
    setLeer(!text.trim());
  }, [text]);

  useEffect(() => {
    const onSel = () => {
      const el = ref.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
      gemerkterBereich.current = sel.getRangeAt(0).cloneRange();
      try {
        setAktiv({
          bold: document.queryCommandState("bold"),
          underline: document.queryCommandState("underline"),
          italic: document.queryCommandState("italic"),
          ul: document.queryCommandState("insertUnorderedList"),
          ol: document.queryCommandState("insertOrderedList"),
        });
      } catch (e) {}
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    const md = htmlZuMarkup(el);
    letzter.current = md;
    setLeer(!md.trim() && !el.querySelector("img"));
    onChange(md);
  };

  const fokus = () => {
    const el = ref.current;
    if (!el) return;
    // Ist der Editor schon fokussiert, Auswahl nicht zurücksetzen (sonst geht am Handy der "Format an/aus"-Zustand bei leerem Cursor verloren)
    if (document.activeElement === el) return;
    el.focus();
    const r = gemerkterBereich.current;
    if (r) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  };

  const cmd = (name) => {
    fokus();
    document.execCommand(name, false, null);
    try {
      setAktiv({
        bold: document.queryCommandState("bold"),
        underline: document.queryCommandState("underline"),
        italic: document.queryCommandState("italic"),
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
      });
    } catch (e) {}
    sync();
  };

  const fuegeBildEin = async (file) => {
    setBildFehler(null);
    setLadeBild(true);
    try {
      const url = await uploadTextBild(file);
      fokus();
      document.execCommand("insertHTML", false, `<div><img src="${url}" alt=""></div><div><br></div>`);
      sync();
    } catch (err) {
      setBildFehler(friendlyError(err));
    } finally {
      setLadeBild(false);
    }
  };

  const onPaste = (e) => {
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    const bildItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
    e.stopPropagation();
    if (bildItem) {
      const f = bildItem.getAsFile();
      if (f) {
        e.preventDefault();
        fuegeBildEin(f);
        return;
      }
    }
    // Fremd-Formatierung vermeiden: nur Text einfügen
    e.preventDefault();
    const t = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (t) {
      document.execCommand("insertText", false, t);
      sync();
    }
  };

  const btn = (an) => ({
    ...styles.iconBtn,
    flexShrink: 0,
    ...(an ? { background: "var(--accent-text)", color: "#fff" } : {}),
  });
  const keepFocus = (e) => e.preventDefault();

  return (
    <div className="wys">
      {label && <label style={styles.label}>{label}</label>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: label ? 4 : 0 }}>
        <button type="button" onMouseDown={keepFocus} style={{ ...btn(aktiv.bold), fontWeight: 800, fontSize: 16 }} onClick={() => cmd("bold")} title="Fett" aria-label="Fett">B</button>
        <button type="button" onMouseDown={keepFocus} style={{ ...btn(aktiv.underline), fontSize: 16, textDecoration: "underline" }} onClick={() => cmd("underline")} title="Unterstrichen" aria-label="Unterstrichen">U</button>
        <button type="button" onMouseDown={keepFocus} style={{ ...btn(aktiv.italic), fontSize: 16, fontStyle: "italic", fontFamily: "Georgia, serif" }} onClick={() => cmd("italic")} title="Kursiv" aria-label="Kursiv">I</button>
        <button type="button" onMouseDown={keepFocus} style={btn(aktiv.ul)} onClick={() => cmd("insertUnorderedList")} title="Aufzählung" aria-label="Aufzählung"><BulletListIcon size={15} /></button>
        <button type="button" onMouseDown={keepFocus} style={btn(aktiv.ol)} onClick={() => cmd("insertOrderedList")} title="Nummerierte Liste" aria-label="Nummerierte Liste"><NumberedListIcon size={15} /></button>
        <button type="button" onMouseDown={keepFocus} style={btn(false)} onClick={() => fileRef.current && fileRef.current.click()} title="Bild einfügen" aria-label="Bild einfügen" disabled={ladeBild}><ImageIcon size={15} /></button>
        {ladeBild && <span style={{ fontSize: 13, color: "var(--muted)" }}>Bild wird hochgeladen …</span>}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            e.target.value = "";
            if (f) fuegeBildEin(f);
          }}
        />
      </div>
      <div
        ref={ref}
        className="wys-edit"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label || "Text"}
        data-placeholder={placeholder || ""}
        data-empty={leer ? "true" : "false"}
        style={{ ...styles.textarea, marginTop: 6, minHeight: rows * 20 + 16, overflowY: "auto", resize: "vertical", outline: "none", lineHeight: "20px", wordBreak: "break-word" }}
        onInput={sync}
        onBlur={sync}
        onPaste={onPaste}
      />
      {bildFehler && <div style={{ fontSize: 13, color: "var(--danger-text)", marginTop: 4 }}>{bildFehler}</div>}
      {hint && <div className="nz-nur-maus" style={{ fontSize: 13, color: "var(--muted-2)", marginTop: 4 }}>Screenshot: einfach hier einfügen (Strg/Cmd+V).</div>}
    </div>
  );
}

function SpieltagNotizen({ value, onSave, label = "Notizen", placeholder = "Beobachtungen zu diesem Spieltag …", rows = 4 }) {
  const [text, setText] = useState(value || "");

  useEffect(() => {
    setText(value || "");
  }, [value]);

  const dirty = text !== (value || "");

  return (
    <div style={{ marginBottom: 14 }}>
      <FormatTextarea label={label} value={text} onChange={setText} rows={rows} placeholder={placeholder} />
      {dirty && (
        <button style={{ ...styles.rowBtn, marginTop: 8 }} onClick={() => onSave(text)}>
          Speichern
        </button>
      )}
    </div>
  );
}

function LockIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/* Taschen-Sperre: deckt das Spielformular ab, damit ein Handy in der Jackentasche nichts eintippt.
   Entsperren: 1 Sekunde gedrückt halten (Maus, Touch, Enter/Leertaste). */
const SPERRE_HALTEN_MS = 1000;
const SPERRE_AUTO_MS = 20000; // Automatisch sperren nach so langer Ruhe (nur beim Erfassen eines neuen Spiels)
function SperreAbdeckung({ onFrei, uhr }) {
  const [haelt, setHaelt] = useState(false);
  const timer = useRef(null);
  const stopp = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setHaelt(false);
  };
  const start = () => {
    if (timer.current) return;
    setHaelt(true);
    timer.current = setTimeout(() => { timer.current = null; setHaelt(false); onFrei(); }, SPERRE_HALTEN_MS);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 5, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12, alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--surface) 85%, transparent)", backdropFilter: "blur(2px)" }}>
      {uhr}
      <button
        onPointerDown={start} onPointerUp={stopp} onPointerLeave={stopp} onPointerCancel={stopp}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); start(); } }}
        onKeyUp={stopp} onBlur={stopp} onContextMenu={(e) => e.preventDefault()}
        aria-label="Gesperrt. Zum Entsperren eine Sekunde gedrückt halten."
        style={{ position: "relative", overflow: "hidden", minHeight: 56, padding: "0 22px", borderRadius: 999, border: "2px solid var(--accent)", background: "var(--surface)", color: "var(--accent-text)", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
      >
        <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: haelt ? "100%" : "0%", background: "var(--track)", transition: haelt ? `width ${SPERRE_HALTEN_MS}ms linear` : "none" }} />
        <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 8 }}><LockIcon size={18} /> Gesperrt · 1 s halten</span>
      </button>
    </div>
  );
}

/* Spieluhr eines Spieltags: zählt über Zeitstempel (läuft also auch bei gesperrtem Handy richtig weiter) und bleibt beim
   Neuladen erhalten (nur auf diesem Gerät). Gespeichert wird die gespielte Zeit; angezeigt wird die Restzeit, danach die Nachspielzeit. */
function useSpielUhr(spieltagId, spielzeitMin) {
  const key = `nsz-uhr-${spieltagId}`;
  const [z, setZ] = useState(() => {
    try {
      const r = JSON.parse(localStorage.getItem(key) || "null");
      if (r && typeof r.summeMs === "number") return { summeMs: r.summeMs, startTs: typeof r.startTs === "number" ? r.startTs : null };
    } catch {}
    return { summeMs: 0, startTs: null };
  });
  const [, setTick] = useState(0);
  const zRef = useRef(z);
  const alarm = useRef(false);
  const gesamt = (Number(spielzeitMin) || 12) * 60;
  const sek = () => Math.floor((zRef.current.summeMs + (zRef.current.startTs ? Date.now() - zRef.current.startTs : 0)) / 1000);
  const setze = (n) => {
    zRef.current = n;
    setZ(n);
    try {
      if (n.summeMs === 0 && !n.startTs) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(n));
    } catch {}
  };
  useEffect(() => {
    if (!z.startTs) return;
    alarm.current = sek() >= gesamt; // nach Neuladen in der Nachspielzeit nicht erneut melden
    let letzte = -1;
    const iv = setInterval(() => {
      const s = sek();
      if (s === letzte) return;
      letzte = s;
      setTick((t) => t + 1);
      if (!alarm.current && s >= gesamt) {
        alarm.current = true;
        try { if (navigator.vibrate) navigator.vibrate([400, 200, 400]); } catch {}
        meldung("Spielzeit um. Die Nachspielzeit läuft.", "info");
      }
    }, 250);
    return () => clearInterval(iv);
  }, [z.startTs, gesamt]); // eslint-disable-line
  const rest = gesamt - sek();
  const mmss = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  return {
    sek,
    laeuft: !!z.startTs,
    gestartet: z.summeMs > 0 || !!z.startTs,
    text: rest >= 0 ? mmss(rest) : `+${mmss(-rest)}`,
    nachspielzeit: rest < 0,
    start: () => setze({ summeMs: zRef.current.summeMs, startTs: Date.now() }),
    pause: () => setze({ summeMs: zRef.current.summeMs + (zRef.current.startTs ? Date.now() - zRef.current.startTs : 0), startTs: null }),
    zuruecksetzen: () => setze({ summeMs: 0, startTs: null }),
  };
}

/* Torschützen-Kachel: die ganze Kachel antippen = +1; das − erscheint erst, wenn es ein Tor gibt */
function TorKachel({ name, anzahl, onPlus, onMinus, minusLabel, gegner = false }) {
  const aktiv = anzahl > 0;
  return (
    <div style={{ ...styles.scorerTile, ...(aktiv && !gegner ? styles.scorerTileActive : {}), ...(aktiv && gegner ? { borderColor: "var(--border-strong)" } : {}) }}>
      <button style={styles.scorerName} onClick={onPlus}>
        <span>{name}</span>
        <span aria-hidden="true" style={{ ...styles.scorerBadge, ...(aktiv ? styles.scorerBadgeAktiv : {}) }}>{anzahl}</span>
      </button>
      <span className="nz-sr" aria-live="polite">{anzahl} {anzahl === 1 ? "Tor" : "Tore"}</span>
      {aktiv && (
        <button style={styles.scorerMinus} onClick={onMinus} aria-label={minusLabel}>−</button>
      )}
    </div>
  );
}

/* Protokoll der Tore im Spielformular: Reihenfolge und (wenn stimmig) Spielstand; letztes Tor zurücknehmen */
function TorProtokoll({ eintraege, mitStand, spielerName, onZurueck, spielzeitMin, mitMinuten, onMinute }) {
  if (eintraege.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <span style={styles.label}>Protokoll</span>
      <ol aria-label="Torfolge" style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 4 }}>
        {eintraege.map((e, i) => (
          <li key={i} style={{ display: "flex", gap: 10, alignItems: mitMinuten ? "center" : "baseline", fontSize: 14 }}>
            <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", minWidth: 40 }}>{mitStand ? `${e.wir}:${e.gegner}` : `${i + 1}.`}</span>
            {mitMinuten && (
              <button
                onClick={() => onMinute(i)}
                aria-label={`Spielminute ändern${typeof e.sek === "number" ? `, aktuell ${spielminute(e.sek, spielzeitMin)}` : ""}`}
                style={{ ...styles.linkBtn, minWidth: 44, padding: "0 6px", fontVariantNumeric: "tabular-nums", color: typeof e.sek === "number" ? "var(--text)" : "var(--muted)" }}
              >
                {typeof e.sek === "number" ? spielminute(e.sek, spielzeitMin) : "Min.?"}
              </button>
            )}
            <span style={{ color: e.typ === "gegner" ? "var(--muted)" : "inherit" }}>
              {e.typ === "wir" ? spielerName(e.playerId) : e.typ === "eigen" ? "Eigentor Gegner" : "Gegner"}
            </span>
          </li>
        ))}
      </ol>
      {!mitStand && <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>Das Protokoll passt nicht zum Ergebnis und wird nicht gespeichert.</div>}
      <button style={{ ...styles.linkBtn, marginTop: 4, paddingLeft: 0 }} onClick={onZurueck}>↶ Letztes Tor zurücknehmen</button>
    </div>
  );
}

function SpieltagCard({ spieltag, nummer, players, gegner, open, onToggle, onRemoveSpieltag, onAddSpiel, onUpdateSpiel, onRemoveSpiel, onToggleTeilnehmer, onUpdateNotizen, onUpdateSpielzeit, onUploadFoto }) {
  const [opponentId, setOpponentId] = useState(gegner[0]?.id || "");
  const [ourGoals, setOurGoals] = useState(0);
  const [theirGoals, setTheirGoals] = useState(0);
  const [tally, setTally] = useState({});
  const [eigen, setEigen] = useState(0); // Eigentore des Gegners (zählen für uns, ohne Torschützen)
  const [folge, setFolge] = useState([]); // Torprotokoll: { typ: "wir" | "eigen" | "gegner", playerId? } in Reihenfolge
  const [gesperrt, setGesperrt] = useState(false); // Taschen-Sperre
  const letzteAktion = useRef(Date.now());
  const spielzeitMin = spieltag.spielzeitMin || STANDARDS.spieltag.spielzeit;
  const [zeitWahl, setZeitWahl] = useState(false); // Auswahl der Spielzeit offen
  const uhr = useSpielUhr(spieltag.id, spielzeitMin);
  const marke = () => (uhr.gestartet ? { sek: uhr.sek() } : {}); // Spielzeit des Tors, wenn die Uhr benutzt wird
  const [editingId, setEditingId] = useState(null);
  const [newOpponentId, setNewOpponentId] = useState(null);
  const [addingFree, setAddingFree] = useState(false);
  const [spieltagTab, setSpieltagTab] = useState("spiele");
  const fTeilen = useFeature("teilen");
  const [teilenLaeuft, setTeilenLaeuft] = useState(false);
  const [teilenFehler, setTeilenFehler] = useState(null);

  useEffect(() => {
    if (!opponentId && gegner[0]) setOpponentId(gegner[0].id);
  }, [gegner]); // eslint-disable-line

  const handleTeilen = async () => {
    setTeilenLaeuft(true);
    setTeilenFehler(null);
    try {
      const blob = await generateSpieltagShareImage(spieltag, nummer, gegner, players);
      const dateiname = `${spieltagLabel(spieltag, nummer).toLowerCase().replace(/\s+/g, "-")}-${spieltag.date}.png`;
      const file = new File([blob], dateiname, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: spieltagLabel(spieltag, nummer) });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = dateiname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (e) {
      if (!e || e.name !== "AbortError") {
        setTeilenFehler((e && e.message) || "Bild konnte nicht erstellt werden.");
      }
    } finally {
      setTeilenLaeuft(false);
    }
  };

  const entferneLetzten = (passt) => setFolge((f) => {
    const i = f.map(passt).lastIndexOf(true);
    return i < 0 ? f : f.filter((_, k) => k !== i);
  });
  const eigenPlus = () => {
    setEigen((e) => e + 1);
    setOurGoals((g) => Number(g) + 1);
    setFolge((f) => [...f, { typ: "eigen", ...marke() }]);
  };
  const gegnerPlus = () => {
    setTheirGoals((g) => Number(g) + 1);
    setFolge((f) => [...f, { typ: "gegner", ...marke() }]);
  };
  const gegnerMinus = () => {
    setTheirGoals((g) => Math.max(0, Number(g) - 1));
    entferneLetzten((e) => e.typ === "gegner");
  };
  const eigenMinus = () => {
    setEigen((e) => Math.max(0, e - 1));
    setOurGoals((g) => Math.max(0, Number(g) - 1));
    entferneLetzten((e) => e.typ === "eigen");
  };
  const letztesZurueck = () => {
    const l = folge[folge.length - 1];
    if (!l) return;
    if (l.typ === "wir") dec(l.playerId);
    else if (l.typ === "eigen") eigenMinus();
    else if (l.typ === "gegner") gegnerMinus();
  };
  const minuteAendern = (i) => {
    const e = folge[i];
    const aktuell = e && typeof e.sek === "number" ? String(Math.floor(e.sek / 60) + 1) : "";
    frageAnd("Spielminute (leer = ohne Minute)", aktuell, (v) => {
      const n = parseInt(String(v), 10);
      setFolge((f) => f.map((x, k) => {
        if (k !== i) return x;
        const { sek, ...rest } = x; // eslint-disable-line no-unused-vars
        return n > 0 && n < 100 ? { ...rest, sek: (n - 1) * 60 } : rest;
      }));
    });
  };
  const spielzeitAndere = () => frageAnd("Spielzeit in Minuten", String(spielzeitMin), (v) => {
    const n = parseInt(String(v), 10);
    if (n >= 1 && n <= 90) onUpdateSpielzeit(n);
  });
  const inc = (playerId) => {
    setTally((t) => ({ ...t, [playerId]: (t[playerId] || 0) + 1 }));
    setOurGoals((g) => Number(g) + 1);
    setFolge((f) => [...f, { typ: "wir", playerId, ...marke() }]);
  };
  const dec = (playerId) => {
    entferneLetzten((e) => e.typ === "wir" && e.playerId === playerId);
    setTally((t) => {
      const current = (t[playerId] || 0) - 1;
      const next = { ...t };
      if (current <= 0) delete next[playerId];
      else next[playerId] = current;
      return next;
    });
    setOurGoals((g) => Math.max(0, Number(g) - 1));
  };

  const resetForm = () => {
    setEditingId(null);
    setNewOpponentId(null);
    setAddingFree(false);
    setOpponentId(gegner[0]?.id || "");
    setOurGoals(0);
    setTheirGoals(0);
    setTally({});
    setEigen(0);
    setFolge([]);
    setGesperrt(false);
    uhr.zuruecksetzen();
  };

  const startEditSpiel = (sp) => {
    setNewOpponentId(null);
    setAddingFree(false);
    setEditingId(sp.id);
    setOpponentId(sp.opponentId);
    setOurGoals(sp.ourGoals);
    setTheirGoals(sp.theirGoals);
    const t = {};
    sp.scorers.forEach((sc) => (t[sc.playerId] = sc.tore));
    setTally(t);
    setEigen(Math.max(0, (Number(sp.ourGoals) || 0) - sp.scorers.reduce((a, sc) => a + (Number(sc.tore) || 0), 0)));
    setFolge(Array.isArray(sp.torfolge) ? sp.torfolge : []);
  };

  const startNewForOpponent = (gegnerId) => {
    setEditingId(null);
    setAddingFree(false);
    setNewOpponentId(gegnerId);
    setOpponentId(gegnerId);
    setOurGoals(0);
    setTheirGoals(0);
    setTally({});
    setEigen(0);
    setFolge([]);
  };

  const startNewFree = () => {
    setEditingId(null);
    setNewOpponentId(null);
    setAddingFree(true);
    setOpponentId(gegner[0]?.id || "");
    setOurGoals(0);
    setTheirGoals(0);
    setTally({});
    setEigen(0);
    setFolge([]);
  };

  const zugeordnet = Object.values(tally).reduce((a, b) => a + b, 0);
  const luecke = (Number(ourGoals) || 0) - zugeordnet - eigen; // >0: Tore ohne Torschütze
  const saveSpiel = () => {
    if (!opponentId) return;
    if (luecke !== 0) {
      const msg = luecke > 0
        ? `${luecke === 1 ? "1 Tor hat" : `${luecke} Tore haben`} noch keinen Torschützen. Trotzdem speichern?`
        : `Es sind ${zugeordnet} Torschützen-Tore erfasst, aber nur ${Number(ourGoals) || 0} im Ergebnis. Trotzdem speichern?`;
      confirmAnd(msg, speichernJetzt);
      return;
    }
    speichernJetzt();
  };
  const speichernJetzt = () => {
    const spiel = {
      id: editingId || uid(),
      opponentId,
      ourGoals: Number(ourGoals) || 0,
      theirGoals: Number(theirGoals) || 0,
      scorers: Object.entries(tally).map(([playerId, tore]) => ({ id: uid(), playerId, tore })),
      // Protokoll nur speichern, wenn es zum Ergebnis passt; ein altes, nun unstimmiges Protokoll wird entfernt
      torfolge: stimmig ? folge : null,
      hatteFolge: !!(editingId && spieltag.spiele.find((x) => x.id === editingId)?.torfolge),
    };
    if (editingId) onUpdateSpiel(spiel);
    else onAddSpiel(spiel);
    resetForm();
  };

  const gegnerName = (id) => gegner.find((g) => g.id === id)?.name || "Unbekannt";
  const spielGegnerOptionen =
    spieltag.zugeordneteGegner.length > 0
      ? gegner.filter((g) => spieltag.zugeordneteGegner.includes(g.id))
      : gegner;
  const spielerName = (id) => players.find((p) => p.id === id)?.name || "Unbekannt";
  const torschuetzenOptionen =
    spieltag.teilnehmer.length > 0 ? players.filter((p) => spieltag.teilnehmer.includes(p.id)) : players;

  const gespielteGegnerIds = new Set(spieltag.spiele.map((sp) => sp.opponentId));
  const offeneZugeordneteGegner = spieltag.zugeordneteGegner
    .filter((id) => !gespielteGegnerIds.has(id))
    .map((id) => gegner.find((g) => g.id === id))
    .filter(Boolean);

  const editorOpen = Boolean(editingId || newOpponentId || addingFree);
  const editorOpponentFixed = Boolean(editingId || newOpponentId);

  // Automatische Sperre: nur beim Erfassen eines neuen Spiels, nach SPERRE_AUTO_MS ohne Eingabe
  const erfasstLive = editorOpen && !editingId;
  useEffect(() => {
    if (!erfasstLive || gesperrt) return;
    letzteAktion.current = Date.now();
    const iv = setInterval(() => { if (Date.now() - letzteAktion.current >= SPERRE_AUTO_MS) setGesperrt(true); }, 1000);
    return () => clearInterval(iv);
  }, [erfasstLive, gesperrt]);
  const torStand = torfolgeStand(folge);
  const stimmig = torfolgePasst(folge, ourGoals, theirGoals);

  const datumFormatiert = new Date(spieltag.date + "T00:00:00").toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const spielStats = spieltag.spiele.reduce(
    (acc, sp) => {
      acc.toreFuer += sp.ourGoals;
      acc.toreGegen += sp.theirGoals;
      return acc;
    },
    { toreFuer: 0, toreGegen: 0 }
  );
  const spieltagSubtitle =
    spieltag.spiele.length > 0
      ? `${spieltag.spiele.length} ${spieltag.spiele.length === 1 ? "Spiel" : "Spiele"} · Tore ${spielStats.toreFuer}:${spielStats.toreGegen}`
      : "Noch keine Spiele erfasst";

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardName}>
          {nummer && <>{spieltagLabel(spieltag, nummer)} · </>}
          {new Date(spieltag.date + "T00:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}
          <span style={styles.mutedTag}>
            {" "}
            {spieltag.zeit && <>· {spieltag.zeit} Uhr </>}
            {spieltag.ort && <>· {spieltag.ort} </>}
            · {spieltag.spiele.length} {spieltag.spiele.length === 1 ? "Spiel" : "Spiele"}
          </span>
        </span>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={onToggle}>
              {open ? "Schließen" : "Öffnen"} <ChevronIcon open={open} />
            </button>
            {fTeilen && (
              <button
                style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 4, opacity: teilenLaeuft ? 0.6 : 1 }}
                onClick={handleTeilen}
                disabled={teilenLaeuft}
              >
                <ShareIcon size={14} /> {teilenLaeuft ? "Erstelle Bild …" : "Teilen"}
              </button>
            )}
            <button
              style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
              onClick={() => confirmAnd("Diesen Spieltag in den Papierkorb verschieben? Du kannst ihn dort jederzeit wiederherstellen.", onRemoveSpieltag)}
            >
              <TrashIcon size={14} /> Entfernen
            </button>
          </div>
          {teilenFehler && (
            <span style={{ fontSize: 13, color: "var(--danger-text)", textAlign: "right", maxWidth: 220 }}>{teilenFehler}</span>
          )}
          {spieltag.spiele.length > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--success-text)" }}>
              <span
                style={{
                  width: 15,
                  height: 15,
                  borderRadius: 999,
                  background: "var(--success-text)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <CheckBadge size={9} />
              </span>
              Bereits gespielt
            </span>
          )}
        </div>
      </div>

      {!open && spieltag.spiele.length > 0 && <SpieltagZusammenfassung spiele={spieltag.spiele} />}

      {open && (
        <>
          <TeamHero
            photoUrl={spieltag.fotoUrl}
            teamName={`${nummer ? `${spieltagLabel(spieltag, nummer)} · ` : ""}${spieltag.zeit ? `${datumFormatiert} · ${spieltag.zeit} Uhr` : datumFormatiert}${spieltag.ort ? ` · ${spieltag.ort}` : ""}`}
            subtitle={spieltagSubtitle}
            onUploadFoto={(file) => onUploadFoto(file)}
            height={300}
            marginBottom={14}
            titleSize={19}
          />

          <div style={{ ...styles.segmentedControl, marginBottom: 14 }}>
            <button
              onClick={() => setSpieltagTab("spiele")}
              style={{ ...styles.segmentedBtn, ...(spieltagTab === "spiele" ? styles.segmentedBtnActive : {}) }}
            >
              Spiele
            </button>
            <button
              onClick={() => setSpieltagTab("teilnehmer")}
              style={{ ...styles.segmentedBtn, ...(spieltagTab === "teilnehmer" ? styles.segmentedBtnActive : {}) }}
            >
              Spieler
            </button>
            <button
              onClick={() => setSpieltagTab("notizen")}
              style={{ ...styles.segmentedBtn, ...(spieltagTab === "notizen" ? styles.segmentedBtnActive : {}) }}
            >
              Notizen
            </button>
          </div>

          {spieltagTab === "spiele" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                {spieltag.spiele.map((sp) => {
                  const ergebnis =
                    sp.ourGoals > sp.theirGoals ? "sieg" : sp.ourGoals < sp.theirGoals ? "niederlage" : "unentschieden";
                  const ergebnisColor = {
                    sieg: "var(--success-text)",
                    niederlage: "var(--loss-text)",
                    unentschieden: "var(--text-2)",
                  }[ergebnis];
                  return (
                    <div
                      key={sp.id}
                      style={{
                        position: "relative",
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderBottom: `4px solid ${ergebnisColor}`,
                        borderRadius: 16,
                        padding: 12,
                      }}
                    >
                      <button
                        style={{ ...styles.linkBtn, position: "absolute", top: 8, right: 8, display: "flex", padding: 4 }}
                        onClick={() => startEditSpiel(sp)}
                        title="Bearbeiten"
                        aria-label="Bearbeiten"
                      >
                        <EditIcon size={14} />
                      </button>
                      <div style={{ fontSize: 13, fontWeight: 700, paddingRight: 20 }}>{gegnerName(sp.opponentId)}</div>
                      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, fontWeight: 700, color: ergebnisColor, margin: "4px 0" }}>
                        {sp.ourGoals}:{sp.theirGoals}
                      </div>
                      {sp.scorers.length > 0 && (
                        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.4 }}>
                          ⚽{" "}
                          {sp.scorers.map((sc, i) => (
                            <React.Fragment key={sc.id}>
                              {spielerName(sc.playerId)} ({sc.tore})
                              {i < sp.scorers.length - 1 ? ", " : ""}
                            </React.Fragment>
                          ))}
                        </div>
                      )}
                      {torfolgePasst(sp.torfolge, sp.ourGoals, sp.theirGoals) && (
                        <ol aria-label="Torfolge" style={{ listStyle: "none", margin: "6px 0 0", padding: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
                          {torfolgeStand(sp.torfolge).map((e, i) => (
                            <li key={i}>
                              <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{e.wir}:{e.gegner}</span>{" "}
                              {typeof e.sek === "number" && <>{spielminute(e.sek, spielzeitMin)}{" "}</>}
                              {e.typ === "wir" ? spielerName(e.playerId) : e.typ === "eigen" ? "Eigentor Gegner" : "Gegner"}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  );
                })}

                {offeneZugeordneteGegner.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => startNewForOpponent(g.id)}
                    style={{
                      background: "transparent",
                      border: "1.5px dashed var(--muted-2)",
                      borderRadius: 16,
                      padding: 12,
                      minHeight: 92,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      justifyContent: "center",
                      gap: 8,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{g.name}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--muted-2)", fontSize: 13, fontWeight: 600 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      Ergebnis eintragen
                    </span>
                  </button>
                ))}

                <button
                  onClick={startNewFree}
                  style={{
                    background: "transparent",
                    border: "1.5px dashed var(--border)",
                    borderRadius: 16,
                    padding: 12,
                    minHeight: 92,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--muted-2)",
                    fontSize: 13,
                    fontWeight: 600,
                    textAlign: "center",
                    cursor: "pointer",
                  }}
                >
                  + weiteres Spiel{spieltag.zugeordneteGegner.length > 0 ? " (anderer Gegner)" : ""}
                </button>
              </div>

              {editorOpen && (
                <div style={{ ...styles.basisGrid, position: "relative" }} onPointerDownCapture={() => { letzteAktion.current = Date.now(); }} onKeyDownCapture={() => { letzteAktion.current = Date.now(); }}>
                  {gesperrt && (
                    <SperreAbdeckung
                      onFrei={() => { letzteAktion.current = Date.now(); setGesperrt(false); }}
                      uhr={!editingId && uhr.gestartet ? <div role="timer" aria-label="Restzeit" style={{ ...styles.uhrZeit, color: uhr.nachspielzeit ? "var(--danger-text)" : "var(--text)" }}>{uhr.text}</div> : null}
                    />
                  )}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>
                      {editorOpponentFixed ? `vs. ${gegnerName(opponentId)}` : "Neues Spiel"}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <button style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setGesperrt(true)}>
                        <LockIcon /> Sperren
                      </button>
                      <button style={styles.linkBtn} onClick={resetForm}>
                        Abbrechen
                      </button>
                    </span>
                  </div>

                  {!editingId && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, textAlign: "center", background: uhr.nachspielzeit ? "var(--neg-bg)" : "var(--surface)" }}>
                      <div role="timer" aria-label="Restzeit" style={{ ...styles.uhrZeit, color: uhr.nachspielzeit ? "var(--danger-text)" : "var(--text)" }}>{uhr.text}</div>
                      <div style={{ fontSize: 13, color: "var(--muted)" }}>
                        von {spielzeitMin} Min.
                        <button style={{ ...styles.linkBtn, display: "inline", padding: "0 6px" }} aria-expanded={zeitWahl} onClick={() => setZeitWahl((o) => !o)}>{zeitWahl ? "fertig" : "ändern"}</button>
                      </div>
                      {zeitWahl && (
                        <div role="group" aria-label="Spielzeit in Minuten" style={{ ...styles.chipGroup, justifyContent: "center", marginTop: 6 }}>
                          {[...new Set([...STANDARDS.spieltag.spielzeiten, spielzeitMin])].sort((a, b) => a - b).map((m) => (
                            <button key={m} onClick={(e) => { onUpdateSpielzeit(m); setZeitWahl(false); e.currentTarget.blur(); }} aria-pressed={spielzeitMin === m} style={{ ...styles.chip, ...(spielzeitMin === m ? styles.chipActive : {}) }}>{m} Min.</button>
                          ))}
                          <button onClick={() => { setZeitWahl(false); spielzeitAndere(); }} style={styles.chip}>Andere …</button>
                        </div>
                      )}
                      <button style={{ ...styles.rowBtn, width: "100%", marginTop: 10 }} onClick={uhr.laeuft ? uhr.pause : uhr.start}>
                        {uhr.laeuft ? "Pause" : uhr.gestartet ? "Weiter" : "Start"}
                      </button>
                      {uhr.gestartet && (
                        <button style={{ ...styles.linkBtn, marginTop: 4 }} onClick={() => confirmAnd("Spieluhr auf Anfang zurücksetzen?", uhr.zuruecksetzen)}>Zurücksetzen</button>
                      )}
                    </div>
                  )}

                  {!editorOpponentFixed && (
                    <div>
                      <span id={`sp-gegner-${spieltag.id}`} style={styles.label}>Gegner</span>
                      <div role="group" aria-labelledby={`sp-gegner-${spieltag.id}`} style={{ ...styles.chipGroup, marginTop: 6 }}>
                        {spielGegnerOptionen.length === 0 && (
                          <span style={styles.hint}>Noch kein Gegner im Setup angelegt.</span>
                        )}
                        {spielGegnerOptionen.map((g) => (
                          <button
                            key={g.id}
                            onClick={(e) => { setOpponentId(g.id); e.currentTarget.blur(); }}
                            aria-pressed={!!(opponentId === g.id)} style={{ ...styles.chip, ...(opponentId === g.id ? styles.chipActive : {}) }}
                          >
                            {g.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <span id={`sp-ergebnis-${spieltag.id}`} style={styles.label}>Ergebnis (Wir : Gegner)</span>
                    <div role="group" aria-labelledby={`sp-ergebnis-${spieltag.id}`} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                      <GoalStepper value={ourGoals} onChange={setOurGoals} />
                      <span>:</span>
                      <GoalStepper value={theirGoals} onChange={setTheirGoals} />
                    </div>
                  </div>

                  <div style={{ marginTop: 4 }}>
                    <label style={styles.label}>Torschützen — antippen zum Erfassen</label>
                    {(Number(ourGoals) || 0) > 0 || zugeordnet > 0 ? (
                      <div role="status" style={{ marginTop: 6, fontSize: 13, fontWeight: 700, color: luecke === 0 ? "var(--pos-text)" : "var(--danger-text)" }}>
                        {luecke === 0
                          ? `✓ Alle Tore zugeordnet${eigen > 0 ? ` (davon ${eigen} Eigentor${eigen > 1 ? "e" : ""} des Gegners)` : ""}`
                          : luecke > 0
                          ? `${zugeordnet + eigen} von ${Number(ourGoals) || 0} Toren zugeordnet – ${luecke} ohne Torschütze`
                          : `Mehr Torschützen-Tore (${zugeordnet}) als im Ergebnis (${Number(ourGoals) || 0})`}
                      </div>
                    ) : null}
                    <div style={styles.scorerGrid}>
                      {torschuetzenOptionen.map((p) => (
                        <TorKachel key={p.id} name={p.name} anzahl={tally[p.id] || 0} onPlus={() => inc(p.id)} onMinus={() => dec(p.id)} minusLabel={`Tor von ${p.name} abziehen`} />
                      ))}
                      <TorKachel name="Eigentor Gegner" anzahl={eigen} onPlus={eigenPlus} onMinus={eigenMinus} minusLabel="Eigentor des Gegners abziehen" />
                      <TorKachel name="Tor Gegner" anzahl={Number(theirGoals) || 0} onPlus={gegnerPlus} onMinus={gegnerMinus} minusLabel="Tor des Gegners abziehen" gegner />
                      {torschuetzenOptionen.length === 0 && <span style={styles.hint}>Noch keine Spieler angelegt.</span>}
                    </div>
                    <TorProtokoll eintraege={torStand} mitStand={stimmig} spielerName={spielerName} onZurueck={letztesZurueck} spielzeitMin={spielzeitMin} mitMinuten={uhr.gestartet || folge.some((e) => typeof e.sek === "number")} onMinute={minuteAendern} />
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
                    <button style={{ ...styles.primaryBtn, flex: 1 }} onClick={saveSpiel} disabled={!opponentId}>
                      {editingId ? "Änderungen speichern" : "Spiel speichern"}
                    </button>
                    {editingId && (
                      <button
                        style={{ ...styles.linkBtn, ...styles.dangerBtn, flexShrink: 0 }}
                        onClick={() => confirmAnd("Dieses Spiel wirklich entfernen?", () => { onRemoveSpiel(editingId); resetForm(); })}
                      >
                        Löschen
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {spieltagTab === "teilnehmer" && (
            <div style={{ marginBottom: 4 }}>
              <span id={`sp-kader-${spieltag.id}`} style={styles.label}>Kader an diesem Spieltag</span>
              <div role="group" aria-labelledby={`sp-kader-${spieltag.id}`} style={{ ...styles.chipGroup, marginTop: 6 }}>
                {players.length === 0 && <span style={styles.hint}>Noch keine Spieler im Setup angelegt.</span>}
                {players.map((p) => {
                  const dabei = spieltag.teilnehmer.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={(e) => { onToggleTeilnehmer(p.id, dabei); e.currentTarget.blur(); }}
                      style={{ ...styles.teilnehmerChip, ...(dabei ? styles.teilnehmerChipActive : {}) }}
                    >
                      <span style={styles.teilnehmerChipAvatarWrap}>
                        <Avatar name={p.name} size={28} photoUrl={p.photo_url} ring={dabei ? "gold" : "white"} />
                        {dabei && (
                          <span style={styles.teilnehmerChipCheck}>
                            <CheckBadge />
                          </span>
                        )}
                      </span>
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {spieltagTab === "notizen" && <SpieltagNotizen value={spieltag.notizen} onSave={onUpdateNotizen} />}
        </>
      )}
    </div>
  );
}

/* ---------- Verwaltung ---------- */

/* Darstellung pro Gerät: auto (System) | hell | dunkel */
const DARSTELLUNG_KEY = "nsz_darstellung";
const leseDarstellung = () => {
  try { const v = localStorage.getItem(DARSTELLUNG_KEY); return v === "hell" || v === "dunkel" ? v : "auto"; } catch (e) { return "auto"; }
};
const setzeDarstellung = (wert) => {
  try { if (wert === "auto") localStorage.removeItem(DARSTELLUNG_KEY); else localStorage.setItem(DARSTELLUNG_KEY, wert); } catch (e) {}
  const root = document.documentElement;
  if (wert === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", wert === "dunkel" ? "dark" : "light");
  wendeTeamfarbeAn(); // Akzentfarben hängen vom aktiven Modus ab
};
function DarstellungKarte() {
  const [wert, setWert] = useState(leseDarstellung);
  const optionen = [["auto", "Automatisch"], ["hell", "Hell"], ["dunkel", "Dunkel"]];
  return (
    <div style={styles.card}>
      <KartenTitel>Darstellung</KartenTitel>
      <div role="group" aria-label="Darstellung wählen" style={{ ...styles.segNav, marginBottom: 8 }}>
        {optionen.map(([k, l]) => (
          <button
            key={k}
            onClick={() => { setWert(k); setzeDarstellung(k); }}
            aria-pressed={!!(wert === k)}
            style={{ ...styles.segBtn, ...(wert === k ? styles.segBtnActive : {}) }}
          >
            {l}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 13, color: "var(--muted)" }}>Automatisch folgt der Einstellung deines Geräts. Die Auswahl gilt nur für dieses Gerät.</div>
    </div>
  );
}

function Verwaltung({
  players,
  basis,
  termine,
  gegner,
  onAdd,
  onToggleActive,
  onRemove,
  onBasisChange,
  onUploadPhoto,
  onRemovePhoto,
  onGenerateTermine,
  onToggleAbsage,
  onRemoveTermin,
  onUpdateZeit,
  onAddGegner,
  onRemoveGegner,
  spieltage,
  onAddSpieltag,
  onRemoveSpieltag,
  onToggleGegnerZuordnung,
  uebungen,
  trainingUebungen,
  onSaveUebung,
  onRemoveUebung,
  onAddTrainingUebung,
  onRemoveTrainingUebung,
  onMoveTrainingUebung,
  onSaveTerminNotiz,
  trashPlayers,
  trashGegner,
  trashSpieltage,
  onRestore,
  onHardDelete,
  onOpenPlayer,
  settingsPlayerId,
  onTrikotnummerChange,
  onUpdatePlayer,
  material,
  onSaveBestand,
  onDeleteMaterialEintrag,
  kartenBox,
  briefkasten,
}) {
  const [subTab, setSubTab] = useState(() => { const s = NZ_SETUP_START; NZ_SETUP_START = null; return s || "spieler"; });
  const fUebungen = useFeature("uebungen");
  const fMaterial = useFeature("material");
  const fEltern = useFeature("eltern_seite");
  const trashCount = trashPlayers.length + trashGegner.length + trashSpieltage.length;
  const items = [
    ["spieler", "Spieler"],
    ["trainingsplan", "Trainingsplan"],
    fUebungen && ["uebungen", "Übungen"],
    ["spieltage", "Spieltage"],
    fMaterial && ["material", "Material"],
    fEltern && kartenBox && ["eltern", "Eltern-Seite"],
    fEltern && briefkasten && briefkasten.an && ["briefkasten", `Briefkasten${briefkasten.neu > 0 ? ` (${briefkasten.neu})` : ""}`],
    ["darstellung", "Darstellung"],
    ["papierkorb", `Papierkorb${trashCount > 0 ? ` (${trashCount})` : ""}`],
  ].filter(Boolean);

  return (
    <section>

      <div style={styles.segNav}>
        {items.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            aria-pressed={!!(subTab === key)} style={{ ...styles.segBtn, ...(subTab === key ? styles.segBtnActive : {}) }}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === "eltern" && fEltern && kartenBox}
      {subTab === "briefkasten" && fEltern && briefkasten && briefkasten.an && <BriefkastenListe daten={briefkasten} />}
      {subTab === "spieler" && (
        <SpielerBereich
          players={players}
          basis={basis}
          onAdd={onAdd}
          onToggleActive={onToggleActive}
          onRemove={onRemove}
          onBasisChange={onBasisChange}
          onUploadPhoto={onUploadPhoto}
          onRemovePhoto={onRemovePhoto}
          onOpenPlayer={onOpenPlayer}
          onTrikotnummerChange={onTrikotnummerChange}
          onUpdatePlayer={onUpdatePlayer}
          initialOpenId={settingsPlayerId}
        />
      )}
      {subTab === "trainingsplan" && (
        <TrainingsplanBereich
          termine={termine}
          onGenerateTermine={onGenerateTermine}
          onToggleAbsage={onToggleAbsage}
          onRemoveTermin={onRemoveTermin}
          onUpdateZeit={onUpdateZeit}
          uebungen={uebungen}
          trainingUebungen={trainingUebungen}
          onAddTrainingUebung={onAddTrainingUebung}
          onRemoveTrainingUebung={onRemoveTrainingUebung}
          onMoveTrainingUebung={onMoveTrainingUebung}
          onSaveTerminNotiz={onSaveTerminNotiz}
        />
      )}
      {subTab === "uebungen" && fUebungen && <UebungenBereich uebungen={uebungen} onSave={onSaveUebung} onRemove={onRemoveUebung} />}
      {subTab === "spieltage" && (
        <SpieltageVerwaltungBereich
          gegner={gegner}
          onAddGegner={onAddGegner}
          onRemoveGegner={onRemoveGegner}
          spieltage={spieltage}
          onAddSpieltag={onAddSpieltag}
          onRemoveSpieltag={onRemoveSpieltag}
          onToggleGegnerZuordnung={onToggleGegnerZuordnung}
        />
      )}
      {subTab === "material" && fMaterial && (
        <MaterialBereich
          material={material}
          onSaveBestand={onSaveBestand}
          onDeleteMaterialEintrag={onDeleteMaterialEintrag}
        />
      )}
      {subTab === "darstellung" && <DarstellungKarte />}
      {subTab === "papierkorb" && (
        <PapierkorbBereich
          trashPlayers={trashPlayers}
          trashGegner={trashGegner}
          trashSpieltage={trashSpieltage}
          onRestore={onRestore}
          onHardDelete={onHardDelete}
        />
      )}
    </section>
  );
}

function PapierkorbBereich({ trashPlayers, trashGegner, trashSpieltage, onRestore, onHardDelete }) {
  const gesamt = trashPlayers.length + trashGegner.length + trashSpieltage.length;
  return (
    <div style={{ marginTop: 4 }}>

      {gesamt === 0 && <EmptyState text="Der Papierkorb ist leer." />}
      {EINST.papierkorbTage > 0 && (() => {
        const grenze = Date.now() - EINST.papierkorbTage * 86400000;
        const alt = [
          ...trashPlayers.filter((x) => x.deleted_at && new Date(x.deleted_at).getTime() < grenze).map((x) => ["players", x.id, "Spieler"]),
          ...trashGegner.filter((x) => x.deleted_at && new Date(x.deleted_at).getTime() < grenze).map((x) => ["gegner", x.id, "Gegner"]),
          ...trashSpieltage.filter((x) => x.deletedAt && new Date(x.deletedAt).getTime() < grenze).map((x) => ["spieltage", x.id, "Spieltag"]),
        ];
        if (alt.length === 0) return null;
        return (
          <div style={{ ...styles.seasonHint, marginBottom: 12 }}>
            <span>{alt.length} {alt.length === 1 ? "Eintrag liegt" : "Einträge liegen"} länger als {EINST.papierkorbTage} Tage im Papierkorb.</span>
            <button style={{ ...styles.linkBtn, ...styles.dangerBtn }} onClick={() => confirmAnd(`${alt.length} Einträge endgültig löschen? Das kann nicht rückgängig gemacht werden.`, () => alt.forEach(([t, id, l]) => onHardDelete(t, id, l)))}>Jetzt endgültig löschen</button>
          </div>
        );
      })()}

      {trashPlayers.length > 0 && (
        <>
          <div style={styles.subheading}>Spieler</div>
          <div className="card-list" style={styles.cardList}>
            {trashPlayers.map((p) => (
              <div key={p.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{p.name}</span>
                  <div style={styles.cardActions}>
                    <button
                      style={{ ...styles.linkBtn, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
                      onClick={() => onRestore("players", p.id)}
                    >
                      <RestoreIcon size={14} /> Wiederherstellen
                    </button>
                    <button
                      style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}
                      onClick={() =>
                        confirmAnd(`Spieler "${p.name}" endgültig löschen? Das kann nicht rückgängig gemacht werden.`, () =>
                          onHardDelete("players", p.id, "Spieler")
                        )
                      }
                    >
                      <TrashIcon size={14} /> Endgültig löschen
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {trashGegner.length > 0 && (
        <>
          <div style={styles.subheading}>Gegner</div>
          <div className="card-list" style={styles.cardList}>
            {trashGegner.map((g) => (
              <div key={g.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{g.name}</span>
                  <div style={styles.cardActions}>
                    <button
                      style={{ ...styles.linkBtn, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
                      onClick={() => onRestore("gegner", g.id)}
                    >
                      <RestoreIcon size={14} /> Wiederherstellen
                    </button>
                    <button
                      style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}
                      onClick={() =>
                        confirmAnd(`Gegner "${g.name}" endgültig löschen? Das kann nicht rückgängig gemacht werden.`, () =>
                          onHardDelete("gegner", g.id, "Gegner")
                        )
                      }
                    >
                      <TrashIcon size={14} /> Endgültig löschen
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {trashSpieltage.length > 0 && (
        <>
          <div style={styles.subheading}>Spieltage</div>
          <div className="card-list" style={styles.cardList}>
            {trashSpieltage.map((s) => (
              <div key={s.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{formatTerminLabel(s.date)}</span>
                  <div style={styles.cardActions}>
                    <button
                      style={{ ...styles.linkBtn, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
                      onClick={() => onRestore("spieltage", s.id)}
                    >
                      <RestoreIcon size={14} /> Wiederherstellen
                    </button>
                    <button
                      style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}
                      onClick={() =>
                        confirmAnd(
                          `Spieltag vom ${formatTerminLabel(s.date)} endgültig löschen? Das kann nicht rückgängig gemacht werden.`,
                          () => onHardDelete("spieltage", s.id, "Spieltag")
                        )
                      }
                    >
                      <TrashIcon size={14} /> Endgültig löschen
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MaterialBereich({ material, onSaveBestand, onDeleteMaterialEintrag }) {
  const [gruppeId, setGruppeId] = useState(MATERIAL_GRUPPEN[0].id);
  const [openKey, setOpenKey] = useState(null);
  const [formDate, setFormDate] = useState(todayISO());
  const [formMenge, setFormMenge] = useState("");
  const [customDrafts, setCustomDrafts] = useState([]);
  const [neuesMaterial, setNeuesMaterial] = useState("");

  const aktuelleGruppe = MATERIAL_GRUPPEN.find((g) => g.id === gruppeId) || MATERIAL_GRUPPEN[0];

  const verlaufFuer = (key) =>
    material.filter((m) => m.material === key).sort((a, b) => b.date.localeCompare(a.date));

  const aktuellerBestand = (key) => {
    const eintraege = verlaufFuer(key);
    return eintraege.length > 0 ? eintraege[0].menge : null;
  };

  const bekannteKeys = new Set(MATERIAL_TYPEN.map(([k]) => k));
  const eigeneAusDaten = Array.from(
    new Set(
      material.filter((m) => !bekannteKeys.has(m.material) && m.gruppe === aktuelleGruppe.id).map((m) => m.material)
    )
  );
  const eigeneEntwuerfe = customDrafts
    .filter((d) => d.gruppeId === aktuelleGruppe.id && !eigeneAusDaten.includes(d.name))
    .map((d) => d.name);
  const items = [
    ...aktuelleGruppe.items,
    ...[...eigeneAusDaten, ...eigeneEntwuerfe].map((name) => [name, name]),
  ];

  const speichern = (key) => {
    const menge = Number(formMenge);
    if (!formDate || formMenge === "" || Number.isNaN(menge) || menge < 0) return;
    onSaveBestand(key, formDate, menge, aktuelleGruppe.id);
    setFormMenge("");
  };

  const materialHinzufuegen = () => {
    const name = neuesMaterial.trim();
    if (!name) return;
    const existiertSchon = items.some(([, label]) => label.toLowerCase() === name.toLowerCase());
    setNeuesMaterial("");
    if (existiertSchon) {
      setOpenKey(items.find(([, label]) => label.toLowerCase() === name.toLowerCase())[0]);
      return;
    }
    setCustomDrafts((d) => [...d, { name, gruppeId: aktuelleGruppe.id }]);
    setOpenKey(name);
    setFormDate(todayISO());
    setFormMenge("");
  };

  return (
    <div style={{ marginTop: 4 }}>

      <div style={styles.segNav}>
        {MATERIAL_GRUPPEN.map((g) => (
          <button
            key={g.id}
            onClick={() => setGruppeId(g.id)}
            aria-pressed={!!(gruppeId === g.id)} style={{ ...styles.segBtn, ...(gruppeId === g.id ? styles.segBtnActive : {}) }}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="card-list" style={styles.cardList}>
        {items.map(([key, label]) => {
          const bestand = aktuellerBestand(key);
          const offen = openKey === key;
          const verlauf = verlaufFuer(key);
          return (
            <div key={key} style={styles.card}>
              <div style={styles.cardHead}>
                <span style={styles.cardName}>
                  {label}
                  <span style={styles.mutedTag}> · {bestand !== null ? `${bestand} Stück` : "noch nicht erfasst"}</span>
                </span>
                <div style={styles.cardActions}>
                  <button
                    style={styles.iconBtn}
                    title={offen ? "Schließen" : "Verlauf & erfassen"}
                    aria-label={offen ? "Schließen" : "Verlauf & erfassen"}
                    onClick={() => {
                      setOpenKey(offen ? null : key);
                      setFormDate(todayISO());
                      setFormMenge("");
                    }}
                  >
                    <SettingsIcon size={15} />
                  </button>
                </div>
              </div>

              {offen && (
                <div>
                  <div style={styles.fieldRow}>
                    <label htmlFor={"mat-datum"} style={styles.label}>Datum</label>
                    <input id={"mat-datum"}
                      type="date"
                      style={{ ...styles.input, flex: "none", width: 160 }}
                      value={formDate}
                      onChange={(e) => setFormDate(e.target.value)}
                    />
                    <label htmlFor={"mat-menge"} style={styles.label}>Menge</label>
                    <input id={"mat-menge"}
                      type="number"
                      min={0}
                      style={{ ...styles.input, flex: "none", width: 90 }}
                      value={formMenge}
                      onChange={(e) => setFormMenge(e.target.value)}
                      placeholder={bestand !== null ? String(bestand) : "0"}
                    />
                    <button style={styles.rowBtn} onClick={() => speichern(key)}>
                      Speichern
                    </button>
                  </div>

                  <div style={{ marginTop: 16 }}>
                    {verlauf.length === 0 && <EmptyState text="Noch keine Erfassung für dieses Material." />}
                  </div>

                  {verlauf.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div style={styles.subheading}>Verlauf</div>
                      {verlauf.map((eintrag, idx) => {
                        const vorheriger = verlauf[idx + 1];
                        const delta = vorheriger ? eintrag.menge - vorheriger.menge : null;
                        return (
                          <div
                            key={eintrag.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "6px 0",
                              borderBottom: "1px solid var(--border)",
                              fontSize: 13,
                            }}
                          >
                            <span>
                              {new Date(eintrag.date + "T00:00:00").toLocaleDateString("de-DE", {
                                day: "2-digit",
                                month: "2-digit",
                                year: "numeric",
                              })}
                              {" · "}
                              <strong>{eintrag.menge}</strong> Stück
                              {delta !== null && delta !== 0 && (
                                <span style={{ color: delta < 0 ? "var(--danger-text)" : "var(--muted)", marginLeft: 6 }}>
                                  {delta > 0 ? `+${delta}` : delta}
                                </span>
                              )}
                            </span>
                            <button
                              style={{ ...styles.iconBtn, ...styles.iconBtnDanger }}
                              title="Eintrag löschen"
                              aria-label="Eintrag löschen"
                              onClick={() =>
                                confirmAnd("Diesen Eintrag löschen?", () => onDeleteMaterialEintrag(eintrag.id))
                              }
                            >
                              <TrashIcon size={13} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ ...styles.addRow, marginTop: 4 }}>
        <input
          style={styles.input}
          placeholder={`Weiteres Material bei "${aktuelleGruppe.label}" hinzufügen`}
          value={neuesMaterial}
          onChange={(e) => setNeuesMaterial(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && neuesMaterial.trim()) materialHinzufuegen();
          }}
        />
        <button style={styles.rowBtn} onClick={materialHinzufuegen} disabled={!neuesMaterial.trim()}>
          Hinzufügen
        </button>
      </div>
    </div>
  );
}

function JerseyBadge({ number, size = 20 }) {
  if (number === null || number === undefined || number === "") return null;
  const zweistellig = String(number).length >= 2;
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="var(--trikot)" stroke="var(--border-strong)" strokeWidth="0.6" strokeLinejoin="round">
        <path d="M16 3l-2.2 1.8a2.2 2.2 0 0 1-3.6 0L8 3 2 7.5 4.3 11H7v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-9h2.7L22 7.5 16 3z" />
      </svg>
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          paddingTop: Math.round(size * 0.18),
          fontSize: Math.round(size * (zweistellig ? 0.32 : 0.42)),
          fontWeight: 700,
          color: "var(--trikot-text)",
          lineHeight: 1,
          letterSpacing: zweistellig ? -0.5 : 0,
        }}
      >
        {number}
      </span>
    </span>
  );
}

function SpielerBereich({
  players,
  basis,
  onAdd,
  onToggleActive,
  onRemove,
  onBasisChange,
  onUploadPhoto,
  onRemovePhoto,
  onOpenPlayer,
  onTrikotnummerChange,
  onUpdatePlayer,
  initialOpenId,
}) {
  const [name, setName] = useState("");
  const [openId, setOpenId] = useState(initialOpenId || null);
  const [uploadTargetId, setUploadTargetId] = useState(null);
  const fileInputRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (file && uploadTargetId) onUploadPhoto(uploadTargetId, file);
    e.target.value = "";
  };

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      <div style={{ ...styles.card, marginBottom: 14 }}>
      <KartenTitel>Spieler hinzufügen</KartenTitel>
      <div style={styles.addRow}>
        <input
          style={styles.input}
          aria-label="Name des Spielers"
          placeholder="Name des Spielers"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              onAdd(name.trim());
              setName("");
            }
          }}
        />
        <button
          style={styles.rowBtn}
          onClick={() => {
            if (name.trim()) {
              onAdd(name.trim());
              setName("");
            }
          }}
        >
          Hinzufügen
        </button>
      </div>
      </div>

      {players.length === 0 && <EmptyState text="Noch keine Spieler angelegt." />}

      <div className="card-list" style={styles.cardList}>
        {players.map((p) => {
          const wert = Number(basis[p.id]) || 0;
          const open = openId === p.id;
          return (
            <div key={p.id} style={styles.card}>
              {/* Eine Zeile ohne Umbruch: Bei Platzmangel wird der Name gekürzt (voller Name im Tooltip), die drei Knöpfe bleiben rechts auf gleicher Höhe. */}
              <div style={{ ...styles.cardHead, flexWrap: "nowrap" }}>
                <span style={{ ...styles.cardName, display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: "1 1 auto" }}>
                  <span style={{ display: "inline-flex", flexShrink: 0 }}>
                    <Avatar name={p.name} size={36} photoUrl={p.photo_url} />
                  </span>
                  <button title={p.name} style={{ ...styles.playerNameBtn, minWidth: 0, flex: "0 1 auto", overflow: "hidden" }} onClick={() => onOpenPlayer(p.id)}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  </button>
                  <JerseyBadge number={p.trikotnummer} size={36} />
                  {p.active === false && <span style={{ ...styles.mutedTag, flexShrink: 0, whiteSpace: "nowrap" }}> · inaktiv</span>}
                </span>
                <div style={{ ...styles.cardActions, gap: 4, flexShrink: 0 }}>
                  <button
                    style={styles.iconBtn}
                    title={open ? "Schließen" : "Einstellungen"}
                    aria-label={open ? "Schließen" : "Einstellungen"}
                    onClick={() => setOpenId(open ? null : p.id)}
                  >
                    <SettingsIcon size={15} />
                  </button>
                  <button
                    style={{ ...styles.iconBtn, ...styles.iconBtnLavender }}
                    title={p.active === false ? "Aktivieren" : "Deaktivieren"}
                    aria-label={p.active === false ? "Aktivieren" : "Deaktivieren"}
                    onClick={() => onToggleActive(p.id)}
                  >
                    <PowerIcon size={15} />
                  </button>
                  <button
                    style={{ ...styles.iconBtn, ...styles.iconBtnDanger }}
                    title="Entfernen"
                    aria-label="Entfernen"
                    onClick={() =>
                      confirmAnd(
                        `${p.name} in den Papierkorb verschieben? Du kannst ihn dort jederzeit wiederherstellen.`,
                        () => onRemove(p.id)
                      )
                    }
                  >
                    <TrashIcon size={15} />
                  </button>
                </div>
              </div>

              {open && (
                <div style={styles.basisGrid}>
                  <div>
                    <label htmlFor={`bq-${p.id}`} style={{ ...styles.label, display: "block", minWidth: 0, marginBottom: 4 }}>Basis-Qualität</label>
                    <div style={styles.basisItem}>
                      <input
                        id={`bq-${p.id}`}
                        type="range"
                        min={0}
                        max={40}
                        step={0.5}
                        value={wert}
                        onChange={(e) => onBasisChange(p.id, Number(e.target.value))}
                        style={styles.range}
                      />
                      <span style={styles.rangeValue}>{wert.toFixed(1)}</span>
                    </div>
                  </div>
                  <PlayerStammdaten trikot={(
                      <div>
                        <label htmlFor={`trikot-${p.id}`} style={{ ...styles.label, display: "block", minWidth: 0, marginBottom: 4 }}>Trikotnummer</label>
                        <div style={styles.basisItem}>
                          <input
                            id={`trikot-${p.id}`}
                            type="number"
                            min={0}
                            max={99}
                            style={{ ...styles.input, flex: "none", width: 90 }}
                            value={p.trikotnummer ?? ""}
                            onChange={(e) =>
                              onTrikotnummerChange(p.id, e.target.value === "" ? null : Number(e.target.value))
                            }
                          />
                          <JerseyBadge number={p.trikotnummer} size={36} />
                        </div>
                      </div>
                    )} player={p} onSave={(patch) => onUpdatePlayer && onUpdatePlayer(p.id, patch)} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", borderRadius: "50%" }}
                      title="Profilbild ändern"
                      onClick={() => {
                        setUploadTargetId(p.id);
                        fileInputRef.current && fileInputRef.current.click();
                      }}
                    >
                      <Avatar name={p.name} size={40} photoUrl={p.photo_url} />
                    </button>
                    <button
                      style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
                      onClick={() => {
                        setUploadTargetId(p.id);
                        fileInputRef.current && fileInputRef.current.click();
                      }}
                    >
                      <CameraIcon size={14} /> Profilbild {p.photo_url ? "ändern" : "hochladen"}
                    </button>
                    {p.photo_url && (
                      <button
                        style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
                        onClick={() => confirmAnd("Profilbild entfernen?", () => onRemovePhoto(p.id))}
                      >
                        <TrashIcon size={14} /> Entfernen
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrainingsplanBereich({
  termine,
  onGenerateTermine,
  onToggleAbsage,
  onRemoveTermin,
  onUpdateZeit,
  uebungen,
  trainingUebungen,
  onAddTrainingUebung,
  onRemoveTrainingUebung,
  onMoveTrainingUebung,
  onSaveTerminNotiz,
}) {
  const uebungProps = { uebungen, trainingUebungen, onAddTrainingUebung, onRemoveTrainingUebung, onMoveTrainingUebung, onSaveTerminNotiz };
  const [wochentage, setWochentage] = useState(STANDARDS.training.tage);
  const [wochen, setWochen] = useState(STANDARDS.training.wochen);
  const [startDatum, setStartDatum] = useState(todayISO());
  const [terminTab, setTerminTab] = useState("kommende");
  const [terminTyp, setTerminTyp] = useState("training");
  const [vonZeit, setVonZeit] = useState(STANDARDS.training.von);
  const [bisZeit, setBisZeit] = useState(STANDARDS.training.bis);
  const [rhythmus, setRhythmus] = useState("woechentlich");

  const toggleWochentag = (idx) => {
    setWochentage((w) => (w.includes(idx) ? w.filter((x) => x !== idx) : [...w, idx].sort()));
  };

  const waehleTyp = (typ) => {
    setTerminTyp(typ);
    if (typ === "training") {
      setVonZeit(STANDARDS.training.von);
      setBisZeit(STANDARDS.training.bis);
    } else {
      setVonZeit("");
      setBisZeit("");
    }
  };

  const generieren = () => {
    if (wochentage.length === 0 || !startDatum) return;
    const neue = [];
    const [jahr, monat, tag] = startDatum.split("-").map(Number);
    const start = new Date(jahr, monat - 1, tag);
    start.setHours(0, 0, 0, 0);
    for (let i = 0; i < wochen * 7; i++) {
      const wochenIndex = Math.floor(i / 7);
      if (rhythmus === "zweiwoechentlich" && wochenIndex % 2 !== 0) continue;
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      if (wochentage.includes(d.getDay())) {
        neue.push({
          id: uid(),
          date: toLocalISODate(d),
          status: "geplant",
          typ: terminTyp,
          start_zeit: vonZeit || null,
          end_zeit: bisZeit || null,
        });
      }
    }
    onGenerateTermine(neue);
  };

  const sortiert = [...termine].sort((a, b) => a.date.localeCompare(b.date));
  const heute = todayISO();
  const kommende = sortiert.filter((t) => t.date >= heute);
  const vergangene = sortiert.filter((t) => t.date < heute).reverse();

  return (
    <div style={{ marginTop: 4 }}>

      <div style={styles.card}>
        <KartenTitel>Termine generieren</KartenTitel>
        <div style={styles.fieldRow}>
          <label htmlFor={"tt-start"} style={styles.label}>Erstes Training ab</label>
          <input id={"tt-start"}
            type="date"
            style={{ ...styles.input, flex: "none", width: 160 }}
            value={startDatum}
            onChange={(e) => setStartDatum(e.target.value)}
          />
        </div>
        <div style={styles.fieldRow}>
          <span id={"tt-art"} style={styles.label}>Art</span>
          <div role="group" aria-labelledby={"tt-art"} style={styles.chipGroup}>
            <button
              onClick={(e) => { waehleTyp("training"); e.currentTarget.blur(); }}
              aria-pressed={!!(terminTyp === "training")} style={{ ...styles.chip, ...(terminTyp === "training" ? styles.chipActive : {}) }}
            >
              Training
            </button>
            <button
              onClick={(e) => { waehleTyp("hallentraining"); e.currentTarget.blur(); }}
              aria-pressed={!!(terminTyp === "hallentraining")} style={{ ...styles.chip, ...(terminTyp === "hallentraining" ? styles.chipActive : {}) }}
            >
              Hallentraining
            </button>
          </div>
        </div>
        <div style={styles.fieldRow}>
          <span id={"tt-zeit"} style={styles.label}>Uhrzeit</span>
          <div role="group" aria-labelledby={"tt-zeit"} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ZeitSelect value={vonZeit} onChange={setVonZeit} />
            <span style={{ color: "var(--muted)" }}>bis</span>
            <ZeitSelect value={bisZeit} onChange={setBisZeit} />
          </div>
        </div>
        <div style={styles.fieldRow}>
          <span id={"tt-tage"} style={styles.label}>Wochentage</span>
          <div role="group" aria-labelledby={"tt-tage"} style={styles.chipGroup}>
            {[1, 2, 3, 4, 5, 6].map((idx) => (
              <button
                key={idx}
                onClick={(e) => { toggleWochentag(idx); e.currentTarget.blur(); }}
                aria-pressed={!!(wochentage.includes(idx))} style={{ ...styles.chip, ...(wochentage.includes(idx) ? styles.chipActive : {}) }}
              >
                {WOCHENTAGE[idx]}
              </button>
            ))}
          </div>
        </div>
        <div style={styles.fieldRow}>
          <span id={"tt-rhythmus"} style={styles.label}>Rhythmus</span>
          <div role="group" aria-labelledby={"tt-rhythmus"} style={styles.chipGroup}>
            <button
              onClick={(e) => { setRhythmus("woechentlich"); e.currentTarget.blur(); }}
              aria-pressed={!!(rhythmus === "woechentlich")} style={{ ...styles.chip, ...(rhythmus === "woechentlich" ? styles.chipActive : {}) }}
            >
              Wöchentlich
            </button>
            <button
              onClick={(e) => { setRhythmus("zweiwoechentlich"); e.currentTarget.blur(); }}
              aria-pressed={!!(rhythmus === "zweiwoechentlich")} style={{ ...styles.chip, ...(rhythmus === "zweiwoechentlich" ? styles.chipActive : {}) }}
            >
              Zweiwöchentlich
            </button>
          </div>
        </div>
        <div style={styles.fieldRow}>
          <label htmlFor={"tt-wochen"} style={{ ...styles.label, flexBasis: "100%" }}>Wochen im Voraus</label>
          <input id={"tt-wochen"}
            type="number"
            min={1}
            max={52}
            style={{ ...styles.input, flex: "none", width: 70 }}
            value={wochen}
            onChange={(e) => setWochen(Number(e.target.value) || 1)}
          />
        </div>
        <button style={{ ...styles.rowBtn, marginTop: 10 }} onClick={generieren}>
          Termine generieren
        </button>
      </div>

      {sortiert.length === 0 && (
        <div style={{ marginTop: 12 }}>
          <EmptyState text="Noch keine Trainingstermine angelegt." />
        </div>
      )}

      {sortiert.length > 0 && (
        <>
          <div style={{ ...styles.segNav, marginTop: 16 }}>
            <button
              onClick={() => setTerminTab("kommende")}
              aria-pressed={!!(terminTab === "kommende")} style={{ ...styles.segBtn, ...(terminTab === "kommende" ? styles.segBtnActive : {}) }}
            >
              Kommende{kommende.length > 0 ? ` (${kommende.length})` : ""}
            </button>
            <button
              onClick={() => setTerminTab("vergangene")}
              aria-pressed={!!(terminTab === "vergangene")} style={{ ...styles.segBtn, ...(terminTab === "vergangene" ? styles.segBtnActive : {}) }}
            >
              Vergangene{vergangene.length > 0 ? ` (${vergangene.length})` : ""}
            </button>
          </div>

          {terminTab === "kommende" &&
            (kommende.length > 0 ? (
              <div className="card-list" style={styles.cardList}>
                {kommende.map((t) => (
                  <TerminRow key={t.id} termin={t} onToggleAbsage={onToggleAbsage} onRemoveTermin={onRemoveTermin} onUpdateZeit={onUpdateZeit} {...uebungProps} />
                ))}
              </div>
            ) : (
              <EmptyState text="Keine kommenden Termine." />
            ))}

          {terminTab === "vergangene" &&
            (vergangene.length > 0 ? (
              <div className="card-list" style={styles.cardList}>
                {vergangene.map((t) => (
                  <TerminRow key={t.id} termin={t} onToggleAbsage={onToggleAbsage} onRemoveTermin={onRemoveTermin} onUpdateZeit={onUpdateZeit} {...uebungProps} />
                ))}
              </div>
            ) : (
              <EmptyState text="Keine vergangenen Termine." />
            ))}
        </>
      )}
    </div>
  );
}

function TerminRow({ termin, onToggleAbsage, onRemoveTermin, onUpdateZeit, uebungen, trainingUebungen, onAddTrainingUebung, onRemoveTrainingUebung, onMoveTrainingUebung, onSaveTerminNotiz }) {
  const abgesagt = termin.status === "abgesagt";
  const istHalle = termin.typ === "hallentraining";
  const [bearbeiten, setBearbeiten] = useState(false);
  const [vonZeit, setVonZeit] = useState(termin.start_zeit || "");
  const [bisZeit, setBisZeit] = useState(termin.end_zeit || "");
  const [datum, setDatum] = useState(termin.date);

  const speichern = async () => {
    const ok = await onUpdateZeit(termin.id, vonZeit || null, bisZeit || null, datum || termin.date);
    if (ok !== false) setBearbeiten(false);
  };

  return (
    <div style={{ ...styles.spielRow, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ display: "flex", alignItems: "center", color: istHalle ? "var(--gold-2)" : "var(--accent-text)", flexShrink: 0 }}>
          {istHalle ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 11l9-6 9 6" />
              <path d="M5 10v9h14v-9" />
              <path d="M9 19v-5h6v5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l4 18H8z" />
              <ellipse cx="12" cy="19.5" rx="6" ry="1.5" />
            </svg>
          )}
        </span>
        <span>
          <strong>{formatTerminLabel(termin.date)}</strong>
          {istHalle && <span style={{ ...styles.mutedTag, color: "var(--gold-2)" }}> · Hallentraining</span>}
          {abgesagt && <span style={{ ...styles.mutedTag, color: "var(--danger-text)" }}> · abgesagt</span>}
          {!bearbeiten && termin.start_zeit && termin.end_zeit && (
            <span style={styles.mutedTag}> · {termin.start_zeit}–{termin.end_zeit} Uhr</span>
          )}
          {!bearbeiten && !(termin.start_zeit && termin.end_zeit) && (
            <span style={{ ...styles.mutedTag, color: "var(--muted-2)" }}> · keine Uhrzeit</span>
          )}
        </span>
      </div>

      {bearbeiten ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <input type="date" aria-label="Datum" style={{ ...styles.input, width: "auto" }} value={datum} onChange={(e) => setDatum(e.target.value)} />
          <ZeitSelect value={vonZeit} onChange={setVonZeit} />
          <span style={{ color: "var(--muted)" }}>bis</span>
          <ZeitSelect value={bisZeit} onChange={setBisZeit} />
          <button style={styles.linkBtn} onClick={speichern}>
            Speichern
          </button>
          <button style={styles.linkBtn} onClick={() => { setDatum(termin.date); setBearbeiten(false); }}>
            Abbrechen
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10 }}>
          <button
            style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
            onClick={() => setBearbeiten(true)}
          >
            <EditIcon size={14} /> Datum & Zeit
          </button>
          <button
            style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
            onClick={() => onToggleAbsage(termin.id)}
          >
            {abgesagt ? <RestoreIcon size={14} /> : <PowerIcon size={14} />} {abgesagt ? "Wieder aktivieren" : "Absagen"}
          </button>
          <button
            style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
            onClick={() => confirmAnd("Diesen Trainingstermin wirklich entfernen?", () => onRemoveTermin(termin.id))}
          >
            <TrashIcon size={14} /> Entfernen
          </button>
        </div>
      )}

      {!abgesagt && (
        <div style={{ flexBasis: "100%" }}>
          <TerminUebungen
            termin={termin}
            uebungen={uebungen || []}
            eintraege={(trainingUebungen || []).filter((t) => t.terminId === termin.id)}
            onAdd={onAddTrainingUebung}
            onRemove={onRemoveTrainingUebung}
            onMove={onMoveTrainingUebung}
            onSaveNotiz={onSaveTerminNotiz}
          />
        </div>
      )}
    </div>
  );
}

/* ---------- Übungsbibliothek ---------- */

function BildLightbox({ url, alt, onClose }) {
  return (
    <div
      style={{ ...styles.modalOverlay, background: "rgba(10,6,6,0.9)", zIndex: 150, padding: 16 }}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      role="dialog"
      aria-label="Bild vergrößert"
    >
      <img src={url} alt={alt || ""} style={{ maxWidth: "100%", maxHeight: "92vh", objectFit: "contain", borderRadius: 12 }} />
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Schließen"
        style={{ position: "fixed", top: 16, right: 16, width: 44, height: 44, borderRadius: 999, border: "none", background: "rgba(255,255,255,0.18)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

function UebungBild({ url, size = 64, titel = "", zoom = false }) {
  const [offen, setOffen] = useState(false);
  const box = { width: size, height: size, borderRadius: 12, flexShrink: 0, overflow: "hidden", background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center" };
  if (!url) {
    return (
      <div style={box} aria-hidden="true">
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l4 18H8z" />
          <ellipse cx="12" cy="19.5" rx="6" ry="1.5" />
        </svg>
      </div>
    );
  }
  const img = <img src={url} alt={titel} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />;
  if (!zoom) return <div style={box}>{img}</div>;
  return (
    <>
      <button
        type="button"
        onClick={() => setOffen(true)}
        aria-label={`Bild von ${titel || "Übung"} vergrößern`}
        style={{ ...box, padding: 0, border: "none", cursor: "zoom-in" }}
      >
        {img}
      </button>
      {offen && <BildLightbox url={url} alt={titel} onClose={() => setOffen(false)} />}
    </>
  );
}

function filterUebungen(uebungen, suche, filter) {
  const q = suche.trim().toLowerCase();
  return uebungen.filter((u) => {
    if (filter.length > 0 && !filter.every((k) => u.keywords.includes(k))) return false;
    if (!q) return true;
    return (u.titel + " " + u.beschreibung + " " + u.keywords.join(" ")).toLowerCase().includes(q);
  });
}

function alleKeywordsVon(uebungen) {
  return [...new Set(uebungen.flatMap((u) => u.keywords))].sort((a, b) => a.localeCompare(b, "de"));
}

function UebungFilterLeiste({ uebungen, suche, setSuche, filter, setFilter, karte = false, aktion = null, titel = "Suchen und filtern" }) {
  const alle = useMemo(() => alleKeywordsVon(uebungen), [uebungen]);
  const toggle = (k) => setFilter(filter.includes(k) ? filter.filter((x) => x !== k) : [...filter, k]);
  const Huelle = karte ? "div" : React.Fragment;
  const huelleProps = karte ? { style: { ...styles.card, marginBottom: 14 } } : {};
  return (
    <Huelle {...huelleProps}>
      {karte && (
        <KartenTitel aktion={aktion}>{titel}</KartenTitel>
      )}
      <input
        style={{ ...styles.input, width: "100%", flex: "none", marginBottom: 10 }}
        placeholder="Übung suchen …"
        aria-label="Übung suchen"
        value={suche}
        onChange={(e) => setSuche(e.target.value)}
      />
      {alle.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <button
            onClick={() => setFilter([])}
            aria-pressed={!!(filter.length === 0)} style={{ ...styles.chip, ...(filter.length === 0 ? styles.chipActive : {}) }}
          >
            Alle
          </button>
          {alle.map((k) => (
            <button
              key={k}
              onClick={(e) => { toggle(k); e.currentTarget.blur(); }}
              aria-pressed={!!(filter.includes(k))} style={{ ...styles.chip, ...(filter.includes(k) ? styles.chipActive : {}) }}
            >
              {k}
            </button>
          ))}
        </div>
      )}
    </Huelle>
  );
}

const tagStyle = { background: "var(--surface-2)", color: "var(--muted)", borderRadius: 999, padding: "3px 9px", fontSize: 13, fontWeight: 600 };

function UebungenBereich({ uebungen, onSave, onRemove }) {
  const [suche, setSuche] = useState("");
  const [filter, setFilter] = useState([]);
  const [edit, setEdit] = useState(null);

  const gefiltert = useMemo(() => filterUebungen(uebungen, suche, filter), [uebungen, suche, filter]);

  if (edit) {
    return (
      <UebungForm
        key={edit === "neu" ? "neu" : edit.id}
        start={edit === "neu" ? null : edit}
        alleKeywords={alleKeywordsVon(uebungen)}
        onSave={(u, file) => {
          onSave(u, file);
          setEdit(null);
        }}
        onCancel={() => setEdit(null)}
        gesperrt={edit !== "neu" && (edit.teamIds || []).includes("alle")}
        onRemove={
          edit === "neu" || (edit.teamIds || []).includes("alle")
            ? null
            : () => confirmAnd(`Übung „${edit.titel}“ wirklich löschen?`, () => { onRemove(edit.id); setEdit(null); })
        }
      />
    );
  }

  return (
    <div style={{ marginTop: 4 }}>

      {uebungen.length === 0 ? (
        <EmptyState text="Noch keine Übungen angelegt." />
      ) : (
        <>
          <UebungFilterLeiste karte aktion={<button style={styles.rowBtn} onClick={() => setEdit("neu")}>+ Übung</button>} uebungen={uebungen} suche={suche} setSuche={setSuche} filter={filter} setFilter={setFilter} />
          <div style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>
            {gefiltert.length} {gefiltert.length === 1 ? "Übung" : "Übungen"}
            {filter.length > 0 ? ` · Filter: ${filter.join(", ")}` : ""}
          </div>
          {gefiltert.length === 0 ? (
            <EmptyState text="Keine Übung passt zu Suche und Filter." />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
              {gefiltert.map((u) => (
                <button
                  key={u.id}
                  onClick={() => setEdit(u)}
                  style={{ ...styles.card, padding: 0, overflow: "hidden", textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit", display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "stretch" }}
                >
                  <div style={{ height: 110, flex: "none", background: "var(--surface-2)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "hidden" }}>
                    {u.bildUrl ? (
                      <img src={u.bildUrl} alt={u.titel} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
                    ) : (
                      <UebungBild url={null} size={64} />
                    )}
                  </div>
                  <div style={{ padding: "10px 12px 12px" }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 3 }}>{u.titel}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {(u.teamIds || []).includes("alle") && <span style={{ ...tagStyle, background: "var(--pos-bg)", color: "var(--pos-text)" }}>Alle Teams</span>}
                      {u.keywords.map((k) => (
                        <span key={k} style={tagStyle}>{k}</span>
                      ))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FormVorschau({ url }) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOffen(true)} aria-label="Bild vergrößern" style={{ width: "100%", height: "100%", padding: 0, border: "none", cursor: "zoom-in", background: "transparent" }}>
        <img src={url} alt="Vorschau" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </button>
      {offen && <BildLightbox url={url} alt="Vorschau" onClose={() => setOffen(false)} />}
    </>
  );
}

function UebungForm({ start, alleKeywords, onSave, onCancel, onRemove, gesperrt = false }) {
  const [titel, setTitel] = useState(start?.titel || "");
  const [beschreibung, setBeschreibung] = useState(start?.beschreibung || "");
  const [keywords, setKeywords] = useState(start?.keywords || []);
  const [neuesKeyword, setNeuesKeyword] = useState("");
  const [bildFile, setBildFile] = useState(null);
  const [vorschau, setVorschau] = useState(start?.bildUrl || null);
  const fileRef = useRef(null);

  const setzeBild = (f) => {
    setBildFile(f);
    setVorschau(URL.createObjectURL(f));
  };

  // Screenshot/Bild aus der Zwischenablage einfügen (Strg/Cmd+V), solange das Formular offen ist
  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : [];
      const bildItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!bildItem) return;
      const f = bildItem.getAsFile();
      if (!f) return;
      e.preventDefault();
      setzeBild(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const addKeyword = (k) => {
    const wert = k.trim();
    if (!wert) return;
    const vorhanden = [...alleKeywords, ...keywords].find((x) => x.toLowerCase() === wert.toLowerCase());
    const final = vorhanden || wert;
    if (!keywords.includes(final)) setKeywords([...keywords, final]);
    setNeuesKeyword("");
  };
  const vorschlaege = alleKeywords.filter((k) => !keywords.includes(k));

  const speichern = () => {
    if (!titel.trim()) return;
    const offen = neuesKeyword.trim();
    const kw = offen && !keywords.some((x) => x.toLowerCase() === offen.toLowerCase()) ? [...keywords, offen] : keywords;
    onSave(
      {
        id: start?.id || uid(),
        titel: titel.trim(),
        beschreibung: beschreibung.trim(),
        keywords: kw,
        bildUrl: start?.bildUrl || null,
      },
      bildFile
    );
  };

  return (
    <div style={{ marginTop: 4 }}>
      <h3 style={styles.h3}>{start ? "Übung bearbeiten" : "Neue Übung"}</h3>
      <div style={styles.card}>
        <div style={{ ...styles.label, marginBottom: 6 }}>Bild</div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
          <div style={{ width: 120, height: 90, borderRadius: 12, overflow: "hidden", background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {vorschau ? <FormVorschau url={vorschau} /> : <UebungBild url={null} size={64} />}
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                setzeBild(f);
              }}
            />
            <button style={styles.rowBtn} onClick={() => fileRef.current && fileRef.current.click()}>
              {vorschau ? "Bild ändern" : "Bild hochladen"}
            </button>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
              Foto, Skizze oder Screenshot – Strg/Cmd+V fügt ihn direkt ein.
            </div>
          </div>
        </div>

        <div style={{ ...styles.label, marginBottom: 6 }}>Titel</div>
        <input style={{ ...styles.input, width: "100%", flex: "none", marginBottom: 14 }} value={titel} onChange={(e) => setTitel(e.target.value)} placeholder="z. B. Passdreieck" />

        <div style={{ marginBottom: 14 }}>
          <FormatTextarea label="Ablauf" value={beschreibung} onChange={setBeschreibung} rows={7} placeholder="Aufbau, Ablauf, Coaching-Hinweise …" />
        </div>

        <div style={{ ...styles.label, marginBottom: 6 }}>Keywords</div>
        {keywords.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {keywords.map((k) => (
              <button key={k} onClick={() => setKeywords(keywords.filter((x) => x !== k))} style={{ ...styles.chip, ...styles.chipActive }} aria-label={`Keyword ${k} entfernen`}>
                {k} ×
              </button>
            ))}
          </div>
        )}
        <div style={{ ...styles.addRow, marginBottom: 10 }}>
          <input
            style={styles.input}
            placeholder="Keyword hinzufügen …"
            aria-label="Keyword hinzufügen"
            value={neuesKeyword}
            onChange={(e) => setNeuesKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addKeyword(neuesKeyword); }}
          />
          <button style={styles.rowBtn} onClick={() => addKeyword(neuesKeyword)}>Hinzufügen</button>
        </div>
        {vorschlaege.length > 0 && (
          <>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 6 }}>Vorhandene Keywords:</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              {vorschlaege.map((k) => (
                <button key={k} onClick={() => addKeyword(k)} style={styles.chip}>{k}</button>
              ))}
            </div>
          </>
        )}

        {gesperrt && (
          <div style={{ ...styles.editBanner, marginBottom: 12 }}>Diese Übung gehört allen Teams und kann nur in der Administration geändert werden.</div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={{ ...styles.primaryBtn, opacity: titel.trim() && !gesperrt ? 1 : 0.5 }} disabled={!titel.trim() || gesperrt} onClick={speichern}>Speichern</button>
          <button style={styles.rowBtn} onClick={onCancel}>Abbrechen</button>
          {onRemove && (
            <button style={{ ...styles.linkBtn, ...styles.dangerBtn, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={onRemove}>
              <TrashIcon size={14} /> Löschen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TerminBoards({ termin }) {
  const tb = React.useContext(TrainingBoardCtx);
  const fTaktik = useFeature("taktik");
  const [ansicht, setAnsicht] = useState(null);
  const [waehlen, setWaehlen] = useState(false);
  const [suche, setSuche] = useState("");
  if (!tb || !fTaktik) return null;
  const liste = tb.links
    .filter((l) => l.terminId === termin.id)
    .sort((a, b) => a.position - b.position)
    .map((l) => ({ ...l, board: tb.boards.find((b) => b.id === l.boardId) }))
    .filter((l) => l.board);
  const dabei = new Set(liste.map((l) => l.boardId));
  const verfuegbar = tb.boards.filter((b) => !dabei.has(b.id) && (!suche.trim() || String(b.name || "").toLowerCase().includes(suche.trim().toLowerCase()))).sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
  const vorschau = (b, h) => {
    const d = tkNormalisiere(b.data);
    const g = tkGeo(d);
    const s0 = d.schritte[0];
    return (
      <div style={{ width: h * (g.vbW / g.vbH), height: h, flex: "none", maxWidth: 160 }}>
        <TkBrett data={d} g={g} players={tb.players} objekte={s0.objekte} linien={s0.linien} nurAnzeige />
      </div>
    );
  };
  const info = (b) => {
    const d = tkNormalisiere(b.data);
    return `${(TK_FELDER[d.feld] || TK_FELDER.f5).label} · ${d.schritte.length} ${d.schritte.length === 1 ? "Schritt" : "Schritte"}`;
  };
  return (
    <div style={{ marginTop: 4 }}>
      {ansicht && <TkAnsicht board={ansicht} players={tb.players} onClose={() => setAnsicht(null)} />}
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Taktik-Boards{liste.length > 0 ? ` (${liste.length})` : ""}</div>
      {tb.fehlt && <TrainingBoardSqlHinweis />}
      {!tb.fehlt && liste.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Noch kein Board für dieses Training.</div>}
      {!tb.fehlt && liste.map((l, i) => (
        <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 8, marginBottom: 8 }}>
          <button type="button" onClick={() => setAnsicht(l.board)} aria-label={`Board „${l.board.name}“ ansehen`} style={{ border: "none", background: "none", padding: 0, cursor: "pointer" }}>
            {vorschau(l.board, 72)}
          </button>
          <button type="button" onClick={() => setAnsicht(l.board)} style={{ flex: 1, minWidth: 0, border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "inherit" }}>
            <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.board.name}</div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>{info(l.board)} · ansehen</div>
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <button style={styles.linkBtn} disabled={i === 0} onClick={() => tb.move(termin.id, l.id, -1)} aria-label="Nach oben">↑</button>
            <button style={styles.linkBtn} disabled={i === liste.length - 1} onClick={() => tb.move(termin.id, l.id, 1)} aria-label="Nach unten">↓</button>
          </div>
          <button style={{ ...styles.linkBtn, ...styles.dangerBtn }} onClick={() => tb.remove(l.id)} aria-label="Board entfernen">
            <TrashIcon size={14} />
          </button>
        </div>
      ))}
      {!tb.fehlt && (!waehlen ? (
        <button style={styles.rowBtn} onClick={() => setWaehlen(true)}>+ Taktik-Board hinzufügen</button>
      ) : (
        <div style={{ ...styles.card, background: "var(--bg)" }}>
          <KartenTitel aktion={<button style={styles.linkBtn} onClick={() => setWaehlen(false)}>Fertig</button>}>Board hinzufügen</KartenTitel>
          {tb.boards.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Noch kein Board angelegt – das geht im Tab „Taktik“.</div>
          ) : verfuegbar.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Alle Boards sind schon in diesem Training.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {tb.boards.length > 5 && (
                <input type="search" value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Board suchen …" aria-label="Board suchen" style={{ ...styles.input, width: "100%", boxSizing: "border-box" }} />
              )}
              {verfuegbar.map((b) => (
                <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 8 }}>
                  {vorschau(b, 56)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                    <div style={{ fontSize: 13, color: "var(--muted)" }}>{info(b)}</div>
                  </div>
                  <button style={{ ...styles.primaryBtn, padding: "0 16px", height: 44, width: "auto", flexShrink: 0, whiteSpace: "nowrap" }} onClick={() => tb.add(termin.id, b.id)}>Hinzufügen</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TerminUebungen({ termin, uebungen, eintraege, onAdd, onRemove, onMove, onSaveNotiz }) {
  const tbCtx = React.useContext(TrainingBoardCtx);
  const anzBoards = tbCtx ? tbCtx.links.filter((l) => l.terminId === termin.id && tbCtx.boards.some((b) => b.id === l.boardId)).length : 0;
  const mitUebungen = useFeature("uebungen");
  const [offen, setOffen] = useState(false);
  const [ausgeblendet, setAusgeblendet] = useState([]);
  const [pickerAblaufId, setPickerAblaufId] = useState(null);
  const [waehlen, setWaehlen] = useState(false);
  const [suche, setSuche] = useState("");
  const [filter, setFilter] = useState([]);

  const liste = useMemo(
    () =>
      [...eintraege]
        .sort((a, b) => a.position - b.position)
        .map((e) => ({ ...e, uebung: uebungen.find((u) => u.id === e.uebungId) }))
        .filter((e) => e.uebung),
    [eintraege, uebungen]
  );
  const dabei = new Set(liste.map((e) => e.uebungId));
  // Bereits geplante Übungen erscheinen in der Auswahl nicht mehr
  const verfuegbar = useMemo(() => uebungen.filter((u) => !dabei.has(u.id)), [uebungen, eintraege]);
  const gefiltert = useMemo(() => filterUebungen(verfuegbar, suche, filter), [verfuegbar, suche, filter]);

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <button style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setOffen(!offen)}>
        <ChevronIcon open={offen} /> {mitUebungen ? "Übungen" : "Notizen"}{mitUebungen && liste.length > 0 ? ` (${liste.length})` : ""}{mitUebungen && termin.notizen && termin.notizen.trim() ? " · Notiz" : ""}{anzBoards > 0 ? ` · ${anzBoards} Board${anzBoards > 1 ? "s" : ""}` : ""}
      </button>

      {offen && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <SpieltagNotizen
            value={termin.notizen}
            onSave={(text) => onSaveNotiz && onSaveNotiz(termin.id, text)}
            label="Notizen zum Ablauf"
            placeholder="Schwerpunkt, Ablauf des Trainings, allgemeine Themen neben den Übungen …"
            rows={4}
          />
          {mitUebungen && liste.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)" }}>Noch keine Übungen für dieses Training geplant.</div>}
          {mitUebungen && liste.map((e, i) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 8 }}>
              <UebungBild url={e.uebung.bildUrl} size={72} titel={e.uebung.titel} zoom />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--muted-2)" }}>{i + 1}</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{e.uebung.titel}</div>
                {e.uebung.keywords.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    {e.uebung.keywords.map((k) => <span key={k} style={tagStyle}>{k}</span>)}
                  </div>
                )}
                {e.uebung.beschreibung && (
                  <>
                    <button
                      style={{ ...styles.linkBtn, padding: "6px 0 0" }}
                      onClick={() => setAusgeblendet(ausgeblendet.includes(e.id) ? ausgeblendet.filter((x) => x !== e.id) : [...ausgeblendet, e.id])}
                    >
                      {ausgeblendet.includes(e.id) ? "Ablauf anzeigen" : "Ablauf ausblenden"}
                    </button>
                    {!ausgeblendet.includes(e.id) && <FormatierterText text={e.uebung.beschreibung} style={{ marginTop: 6 }} />}
                  </>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <button style={styles.linkBtn} disabled={i === 0} onClick={() => onMove(termin.id, e.id, -1)} aria-label="Nach oben">↑</button>
                <button style={styles.linkBtn} disabled={i === liste.length - 1} onClick={() => onMove(termin.id, e.id, 1)} aria-label="Nach unten">↓</button>
              </div>
              <button style={{ ...styles.linkBtn, ...styles.dangerBtn }} onClick={() => onRemove(e.id)} aria-label="Übung entfernen">
                <TrashIcon size={14} />
              </button>
            </div>
          ))}

          {!mitUebungen ? null : !waehlen ? (
            <button style={styles.rowBtn} onClick={() => setWaehlen(true)}>+ Übung aus Bibliothek hinzufügen</button>
          ) : (
            <div style={{ ...styles.card, background: "var(--bg)" }}>
              <div style={{ ...styles.h3, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span>Übung hinzufügen</span>
                <button style={styles.linkBtn} onClick={() => setWaehlen(false)}>Fertig</button>
              </div>
              {uebungen.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--muted)" }}>Die Bibliothek ist noch leer – lege unter „Übungen“ die erste an.</div>
              ) : (
                <>
                  <UebungFilterLeiste uebungen={uebungen} suche={suche} setSuche={setSuche} filter={filter} setFilter={setFilter} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {gefiltert.length === 0 && (
                      <div style={{ fontSize: 13, color: "var(--muted)" }}>
                        {verfuegbar.length === 0 ? "Alle Übungen der Bibliothek sind schon in diesem Training." : "Keine Übung passt zu Suche und Filter."}
                      </div>
                    )}
                    {gefiltert.map((u) => (
                      <div key={u.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <UebungBild url={u.bildUrl} size={64} titel={u.titel} zoom />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>{u.titel}</div>
                            {u.keywords.length > 0 && (
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                                {u.keywords.map((k) => <span key={k} style={tagStyle}>{k}</span>)}
                              </div>
                            )}
                            {u.beschreibung && (
                              <button
                                style={{ ...styles.linkBtn, padding: "6px 0 0" }}
                                onClick={() => setPickerAblaufId(pickerAblaufId === u.id ? null : u.id)}
                              >
                                {pickerAblaufId === u.id ? "Ablauf ausblenden" : "Ablauf anzeigen"}
                              </button>
                            )}
                          </div>
                          <button
                            style={{ ...styles.primaryBtn, padding: "0 16px", height: 44, width: "auto", flexShrink: 0, whiteSpace: "nowrap" }}
                            onClick={() => onAdd(termin.id, u.id)}
                          >
                            Hinzufügen
                          </button>
                        </div>
                        {pickerAblaufId === u.id && <FormatierterText text={u.beschreibung} style={{ marginTop: 8 }} />}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <TerminBoards termin={termin} />
        </div>
      )}
    </div>
  );
}

function SpieltageVerwaltungBereich({ gegner, onAddGegner, onRemoveGegner, spieltage, onAddSpieltag, onRemoveSpieltag, onToggleGegnerZuordnung }) {
  const [name, setName] = useState("");
    const [neuesDatum, setNeuesDatum] = useState(todayISO());
  const [openSpieltagId, setOpenSpieltagId] = useState(null);
  const [gegnerHinzufuegen, setGegnerHinzufuegen] = useState(false);
  const [neuerGegnerId, setNeuerGegnerId] = useState("");
  const [neueZeit, setNeueZeit] = useState(STANDARDS.spieltag.zeit);
  const [neuerTyp, setNeuerTyp] = useState("spieltag");
  const [neuerOrt, setNeuerOrt] = useState(STANDARDS.spieltag.ort);

  const sorted = [...spieltage].sort((a, b) => b.date.localeCompare(a.date));
  const nummern = useMemo(() => spieltagNummern(spieltage), [spieltage]);

  return (
    <div style={{ marginTop: 4 }}>

      {/* Gegner verwalten */}
      <div style={{ ...styles.card, marginBottom: 18 }}>
        <KartenTitel>Gegner</KartenTitel>

          <>
            <div style={{ ...styles.addRow, marginTop: 10 }}>
              <input
                style={styles.input}
                placeholder="Name des Gegners"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) {
                    onAddGegner(name.trim());
                    setName("");
                  }
                }}
              />
              <button
                style={styles.rowBtn}
                onClick={() => {
                  if (name.trim()) {
                    onAddGegner(name.trim());
                    setName("");
                  }
                }}
              >
                Hinzufügen
              </button>
            </div>

            {gegner.length === 0 && <EmptyState text="Noch keine Gegner hinterlegt." />}

            <div style={{ ...styles.chipGroup, marginTop: 12 }}>
              {gegner.map((g) => (
                <span key={g.id} style={{ ...styles.chip, cursor: "default", gap: 6 }}>
                  {g.name}
                  <button
                    aria-label={`${g.name} entfernen`}
                    onClick={() =>
                      confirmAnd(`Gegner "${g.name}" in den Papierkorb verschieben? Du kannst ihn dort jederzeit wiederherstellen.`, () =>
                        onRemoveGegner(g.id)
                      )
                    }
                    style={{ border: "none", background: "transparent", color: "inherit", display: "inline-flex", padding: 0, cursor: "pointer" }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </span>
              ))}
            </div>
          </>
      </div>

      {/* Spieltag anlegen */}
      <div style={{ ...styles.card, marginBottom: 14 }}>
        <KartenTitel>Neuen Spieltag anlegen</KartenTitel>
        <div style={styles.chipGroup}>
          <button
            onClick={(e) => { setNeuerTyp("spieltag"); e.currentTarget.blur(); }}
            aria-pressed={!!(neuerTyp === "spieltag")} style={{ ...styles.chip, ...(neuerTyp === "spieltag" ? styles.chipActive : {}) }}
          >
            Spieltag
          </button>
          <button
            onClick={(e) => { setNeuerTyp("turnier"); e.currentTarget.blur(); }}
            aria-pressed={!!(neuerTyp === "turnier")} style={{ ...styles.chip, ...(neuerTyp === "turnier" ? styles.chipActive : {}) }}
          >
            Turnier
          </button>
          <button
            onClick={(e) => { setNeuerTyp("hallenturnier"); e.currentTarget.blur(); }}
            aria-pressed={!!(neuerTyp === "hallenturnier")} style={{ ...styles.chip, ...(neuerTyp === "hallenturnier" ? styles.chipActive : {}) }}
          >
            Hallenturnier
          </button>
          <button
            onClick={(e) => { setNeuerTyp("freundschaftsspiel"); e.currentTarget.blur(); }}
            aria-pressed={!!(neuerTyp === "freundschaftsspiel")} style={{ ...styles.chip, ...(neuerTyp === "freundschaftsspiel" ? styles.chipActive : {}) }}
          >
            Freundschaftsspiel
          </button>
        </div>
        <div style={{ ...styles.addRow, flexWrap: "wrap", rowGap: 8, marginTop: 8 }}>
          <input type="date" style={styles.select} value={neuesDatum} onChange={(e) => setNeuesDatum(e.target.value)} />
          <ZeitSelect value={neueZeit} onChange={setNeueZeit} />
          <input
            style={{ ...styles.input, flex: "1 1 160px", minWidth: 140 }}
            placeholder="Ort (optional)"
            value={neuerOrt}
            onChange={(e) => setNeuerOrt(e.target.value)}
          />
          <button
            style={styles.rowBtn}
            onClick={() => {
              onAddSpieltag(neuesDatum, neueZeit, neuerTyp, neuerOrt.trim());
              setNeueZeit("");
              setNeuerTyp("spieltag");
              setNeuerOrt("");
            }}
          >
            Anlegen
          </button>
        </div>
        <Hinweis style={{ marginTop: 6, marginBottom: 0 }}>Spieltage, Turniere, Hallenturniere und Freundschaftsspiele werden getrennt durchnummeriert (Spieltag 1, 2, … bzw. Turnier 1, 2, …). Uhrzeit und Ort sind optional.</Hinweis>
      </div>

      {/* Spieltag-Liste mit Gegner-Zuordnung */}
      <div style={styles.subheading}>Spieltage · antippen zum Zuordnen</div>

      {sorted.length === 0 && <EmptyState text="Noch keine Spieltage angelegt." />}

      <div className="card-list" style={styles.cardList}>
        {sorted.map((s) => {
          const open = openSpieltagId === s.id;
          const zugeordnet = gegner.filter((g) => s.zugeordneteGegner.includes(g.id));
          const verfuegbareGegner = gegner.filter((g) => !s.zugeordneteGegner.includes(g.id));
          return (
            <div key={s.id} style={styles.card}>
              <div
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setGegnerHinzufuegen(false);
                  setOpenSpieltagId(open ? null : s.id);
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ ...styles.cardName, flex: 1, minWidth: 0 }}>
                    {nummern.get(s.id) && <>{spieltagLabel(s, nummern.get(s.id))} · </>}
                    {formatTerminLabel(s.date)}
                    {s.zeit && <span style={styles.mutedTag}> · {s.zeit} Uhr</span>}
                    {s.ort && <span style={styles.mutedTag}> · {s.ort}</span>}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <button
                      aria-label="Spieltag entfernen"
                      onClick={(e) => {
                        e.stopPropagation();
                        confirmAnd(`Spieltag ${formatTerminLabel(s.date)} in den Papierkorb verschieben?`, () => onRemoveSpieltag(s.id));
                      }}
                      style={{ ...styles.linkBtn, ...styles.dangerBtn, padding: 0 }}
                    >
                      <TrashIcon size={14} />
                    </button>
                    <span aria-hidden="true" style={{ flex: "none", display: "inline-flex", color: "var(--muted)" }}><ChevronIcon open={open} /></span>
                  </div>
                </div>
                {!open && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                    {zugeordnet.length === 0 && <span style={styles.hint}>kein Gegner</span>}
                    {zugeordnet.slice(0, 2).map((g) => (
                      <span key={g.id} style={styles.tag}>{g.name}</span>
                    ))}
                    {zugeordnet.length > 2 && <span style={styles.tag}>+{zugeordnet.length - 2}</span>}
                  </div>
                )}
              </div>

              {open && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--divider)" }}>
                  <div style={styles.hint}>Gegner</div>
                  <div style={styles.chipGroup}>
                    {zugeordnet.length === 0 && !gegnerHinzufuegen && (
                      <span style={{ ...styles.hint, marginTop: 0, marginBottom: 0 }}>Noch kein Gegner zugeordnet.</span>
                    )}
                    {zugeordnet.map((g) => (
                      <span key={g.id} style={{ ...styles.chip, cursor: "default", gap: 6 }}>
                        {g.name}
                        <button
                          aria-label={`${g.name} entfernen`}
                          onClick={() => onToggleGegnerZuordnung(s.id, g.id, true)}
                          style={{ border: "none", background: "transparent", color: "inherit", display: "inline-flex", padding: 0, cursor: "pointer" }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                      </span>
                    ))}
                  </div>

                  {gegnerHinzufuegen ? (
                    verfuegbareGegner.length === 0 ? (
                      <span style={{ ...styles.hint, marginTop: 10, marginBottom: 0 }}>Alle hinterlegten Gegner sind bereits zugeordnet.</span>
                    ) : (
                      <div style={{ ...styles.addRow, marginTop: 10, marginBottom: 0 }}>
                        <select aria-label="Gegner hinzufügen" style={styles.select} value={neuerGegnerId} onChange={(e) => setNeuerGegnerId(e.target.value)}>
                          <option value="">Gegner wählen …</option>
                          {verfuegbareGegner.map((g) => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                        <button
                          style={styles.rowBtn}
                          onClick={() => {
                            if (!neuerGegnerId) return;
                            onToggleGegnerZuordnung(s.id, neuerGegnerId, false);
                            setNeuerGegnerId("");
                            setGegnerHinzufuegen(false);
                          }}
                        >
                          Zuordnen
                        </button>
                      </div>
                    )
                  ) : (
                    <button
                      style={{ ...styles.linkBtn, display: "inline-flex", alignItems: "center", gap: 4, marginTop: 10 }}
                      onClick={() => {
                        setNeuerGegnerId("");
                        setGegnerHinzufuegen(true);
                      }}
                    >
                      + Gegner hinzufügen
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const NavCtx = React.createContext(null);
const NAV_ZIELE = { verwaltung: "Zum Setup", spieltage: "Zu den Spieltagen" };
const EMPTY_ICONS = {
  spiel: <><path d="M8 4h8v4a4 4 0 0 1-8 0V4z" /><path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4M12 12v4M9 20h6M10 16h4l1 4H9z" /></>,
  spieler: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><circle cx="17" cy="9" r="2.4" /><path d="M16.5 14.6c2.6.2 4.5 2 4.5 4.9" /></>,
  termin: <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>,
  board: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 5v14M3 12h18" /><circle cx="12" cy="12" r="2.5" /></>,
  notiz: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h5" /></>,
  gegner: <><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></>,
  papierkorb: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></>,
  uebung: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7l4 3-1.5 4.5h-5L8 10z" /></>,
  leer: <><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></>,
};
const emptyIconFuer = (t) => {
  const x = String(t).toLowerCase();
  if (x.includes("papierkorb")) return "papierkorb";
  if (x.includes("board")) return "board";
  if (x.includes("notiz")) return "notiz";
  if (x.includes("gegner")) return "gegner";
  if (x.includes("spieltag") || x.includes("spiel")) return "spiel";
  if (x.includes("spieler")) return "spieler";
  if (x.includes("termin") || x.includes("training")) return "termin";
  if (x.includes("übung") || x.includes("material")) return "uebung";
  return "leer";
};
function EmptyState({ text, nach }) {
  const gehe = React.useContext(NavCtx);
  const m = String(text).match(/^(.+?[.!?])\s+(.+)$/);
  const kopf = m ? m[1] : text;
  const rest = m ? m[2] : null;
  return (
    <div style={styles.empty}>
      <div aria-hidden="true" style={{ width: 48, height: 48, borderRadius: 999, background: "var(--track)", color: "var(--accent-text)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px" }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{EMPTY_ICONS[emptyIconFuer(text)]}</svg>
      </div>
      <div style={{ fontWeight: 600, color: "var(--text)" }}>{kopf}</div>
      {rest && <div style={{ marginTop: 4, fontSize: 13 }}>{rest}</div>}
      {nach && gehe && NAV_ZIELE[nach] && (
        <button type="button" style={{ ...styles.rowBtn, width: "auto", height: 44, padding: "0 18px", marginTop: 12 }} onClick={() => gehe(nach)}>
          {NAV_ZIELE[nach]}
        </button>
      )}
    </div>
  );
}

const AVATAR_FARBEN = ["#AE1E1D", "#2E7D32", "#1565C0", "#8A6F00", "#6A4C93", "#B0603E", "#2B6F76", "#8A2B5A"];
function avatarFarbe(name) {
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_FARBEN[hash % AVATAR_FARBEN.length];
}
function initialen(name) {
  const teile = (name || "").trim().split(/\s+/).filter(Boolean);
  if (teile.length === 0) return "?";
  if (teile.length === 1) return teile[0].slice(0, 2).toUpperCase();
  return (teile[0][0] + teile[teile.length - 1][0]).toUpperCase();
}
function Avatar({ name, size = 32, photoUrl, ring }) {
  const ringShadow =
    ring === "gold"
      ? "0 0 0 2.5px var(--gold)"
      : ring === "white"
      ? "0 0 0 2px var(--surface)"
      : "none";
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        style={{ ...styles.avatar, width: size, height: size, objectFit: "cover", background: "var(--border)", boxShadow: ringShadow }}
      />
    );
  }
  const farbe = avatarFarbe(name);
  return (
    <span
      style={{
        ...styles.avatar,
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.38)),
        background: `linear-gradient(135deg, ${farbe}, ${farbe}cc)`,
        boxShadow: ringShadow,
      }}
    >
      {initialen(name)}
    </span>
  );
}

/* ---------- Styles ---------- */

const styles = {
  app: { fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg)", minHeight: "100vh", color: "var(--text)" },
  loadingScreen: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    gap: 12,
    color: "var(--muted)",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  loadingBall: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    border: "3px solid var(--border)",
    borderTopColor: "var(--accent)",
    animation: "spin 0.8s linear infinite",
  },
  loginCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: "32px 28px",
    width: 260,
    boxShadow: "var(--sh-2)",
  },
  loginLogo: { width: 56, height: "auto", objectFit: "contain", marginBottom: 4 },
  loginTitle: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 19, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" },
  loginSubtitle: { fontSize: 13, color: "var(--muted)", marginTop: -8, marginBottom: 6 },
  loginInput: {
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    textAlign: "center",
    width: "100%",
  },
  loginError: { color: "var(--danger-text)", fontSize: 13, textAlign: "center" },
  loginBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "12px 18px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    marginTop: 4,
  },
  header: { background: "var(--header-grad)", color: "var(--on-header)", padding: "20px 20px 0 20px" },
  headerTop: { display: "flex", alignItems: "center", gap: 12, paddingBottom: 16 },
  logoutBtn: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    background: "rgba(255,255,255,0.14)",
    border: "1px solid rgba(255,255,255,0.22)",
    borderRadius: 999,
    color: "var(--on-header-soft)",
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 14px",
    minHeight: 44,
    cursor: "pointer",
  },
  crestImg: { width: 40, height: 48, objectFit: "contain", background: "#FFFFFF", borderRadius: 8, padding: 3 },
  title: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 19, lineHeight: 1.1, letterSpacing: "-0.01em" },
  subtitle: { fontSize: 13, color: "var(--on-header-soft)", marginTop: 2 },
  nav: {
    display: "flex",
    gap: 4,
    overflowX: "auto",
    overflowY: "hidden",
  },
  navBtn: {
    background: "transparent",
    border: "none",
    color: "var(--on-header-soft)",
    padding: "10px 14px",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    borderBottom: "2px solid transparent",
    whiteSpace: "nowrap",
    minHeight: 44,
  },
  navBtnActive: { color: "var(--on-header)", borderBottom: "2px solid var(--on-header)" },
  subNav: {
    display: "flex",
    gap: 20,
    marginBottom: 20,
    overflowX: "auto",
    overflowY: "hidden",
    borderBottom: "1px solid var(--divider)",
  },
  subNavBtn: {
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    padding: "0 0 10px 0",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    borderBottom: "2px solid transparent",
    marginBottom: -1,
  },
  // Umschalter: weißer Rahmen, der aktive Reiter ist Vollfläche in --auswahl (Weinrot, wie die Filter-Chips)
  segNav: { display: "flex", gap: 4, padding: 4, marginBottom: 16, background: "linear-gradient(90deg, var(--surface) 30%, transparent) 0 0 / 36px 100% no-repeat local, linear-gradient(270deg, var(--surface) 30%, transparent) 100% 0 / 36px 100% no-repeat local, radial-gradient(farthest-side at 0 50%, rgba(0,0,0,0.22), transparent) 0 0 / 12px 100% no-repeat scroll, radial-gradient(farthest-side at 100% 50%, rgba(0,0,0,0.22), transparent) 100% 0 / 12px 100% no-repeat scroll, var(--surface)", border: "1px solid var(--divider)", borderRadius: 12, overflowX: "auto" },
  segBtn: { flex: "1 1 auto", border: "none", background: "transparent", color: "var(--muted)", minHeight: 44, padding: "8px 14px", borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", textAlign: "center" },
  segBtnActive: { background: "var(--auswahl)", color: "var(--auswahl-text)" },
  subNavBtnActive: { color: "var(--accent)", borderBottom: "2px solid var(--accent)" },
  segmentedControl: {
    display: "flex",
    background: "var(--track)",
    borderRadius: 12,
    padding: 4,
    marginTop: 20,
  },
  segmentedBtn: {
    flex: 1,
    textAlign: "center",
    padding: "9px 0",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--muted)",
    cursor: "pointer",
  },
  segmentedBtnActive: {
    background: "var(--auswahl)",
    boxShadow: "var(--sh-1)",
    color: "var(--auswahl-text)",
    fontWeight: 700,
  },
  main: { padding: "20px", maxWidth: 760, margin: "0 auto" },
  h2: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, margin: "4px 0 14px 0", letterSpacing: "-0.01em" },
  h3: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 600, margin: "0 0 12px 0", paddingBottom: 8, borderBottom: "1px solid var(--divider)", letterSpacing: "-0.005em" },
  h3Block: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 600, margin: 0, padding: "12px 0", borderTop: "1px solid var(--divider)", letterSpacing: "-0.005em" },
  h3Plain: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, margin: "0 0 10px 0", letterSpacing: "-0.005em" },
  tabLabel: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--muted)", margin: "4px 0 10px 0" },
  subheading: { fontSize: 13, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px 0" },
  rowBetween: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 6 },
  select: {
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    borderRadius: 8,
    minHeight: 44,
    padding: "8px 10px",
    fontSize: 14,
    color: "var(--text)",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  selectGroup: { display: "flex", flexDirection: "column", gap: 2 },
  selectGroupLabel: { fontSize: 13, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" },
  input: {
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    flex: 1,
    minWidth: 0, // erlaubt dem Feld zu schrumpfen, damit der Button in der Zeile Platz behält
    color: "var(--text)",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  textarea: {
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 13,
    width: "100%",
    marginTop: 6,
    fontFamily: "'Inter', system-ui, sans-serif",
    resize: "vertical",
  },
  addRow: { display: "flex", gap: 8, marginBottom: 16 },
  tableWrap: { overflowX: "auto", background: "var(--surface)", borderRadius: 16, border: "1px solid var(--border)", boxShadow: "var(--sh-1)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "10px 12px", color: "var(--muted)", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--border)" },
  td: { padding: "10px 12px", borderBottom: "1px solid var(--divider)" },
  tdName: { padding: "10px 12px", borderBottom: "1px solid var(--divider)", display: "flex", alignItems: "center", gap: 8, fontWeight: 500 },
  rank: {
    width: 20,
    height: 20,
    borderRadius: 8,
    background: "var(--divider)",
    color: "var(--muted)",
    fontSize: 13,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
  },
  cardList: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 },
  playerNameBtn: {
    background: "transparent",
    border: "none",
    padding: 0,
    minHeight: 44,
    display: "inline-flex",
    alignItems: "center",
    font: "inherit",
    fontWeight: 500,
    color: "var(--text)",
    textDecoration: "underline",
    textDecorationColor: "var(--border-strong)",
    cursor: "pointer",
  },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 14, boxShadow: "var(--sh-1)" },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 },
  cardActions: { display: "flex", gap: 6, flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch", maxWidth: "100%" },
  iconBtn: {
    width: 44,
    height: 44,
    minWidth: 44,
    borderRadius: 999,
    border: "none",
    background: "var(--tan-bg)",
    color: "var(--tan-text)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  iconBtnLavender: { background: "var(--lav-bg)", color: "var(--lav-text)" },
  iconBtnDanger: { background: "var(--track)", color: "var(--danger-text)" },
  teilnehmerChip: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "8px 11px 8px 8px",
    borderRadius: 16,
    border: "1.5px solid var(--border)",
    background: "var(--surface)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text)",
  },
  teilnehmerChipActive: {
    background: "var(--surface)",
    border: "1.5px solid var(--accent)",
    color: "var(--text)",
    boxShadow: "var(--sh-1)",
  },
  teilnehmerChipAvatarWrap: { position: "relative", flexShrink: 0, display: "flex" },
  teilnehmerChipCheck: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 15,
    height: 15,
    borderRadius: 999,
    background: "var(--accent)",
    border: "2px solid var(--surface)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  cardName: { fontWeight: 600, fontSize: 16 },
  mutedTag: { color: "var(--muted-2)", fontWeight: 400, fontSize: 13 },
  spieltagSummary: { display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" },
  summaryPill: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 22,
    height: 22,
    padding: "0 6px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
  },
  summaryPillWin: { background: "var(--win-bg)", color: "var(--success-text)" },
  summaryPillDraw: { background: "var(--draw-bg)", color: "var(--muted)" },
  summaryPillLoss: { background: "var(--loss-bg)", color: "var(--loss-text)" },
  summaryGoals: { fontSize: 13, color: "var(--muted)", fontWeight: 600 },
  pill: { padding: "3px 10px", borderRadius: 999, fontSize: 13, fontWeight: 700 },
  fieldRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" },
  goalStepper: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 2,
  },
  goalStepperBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    border: "none",
    background: "var(--surface)",
    color: "var(--accent-text)",
    fontSize: 21,
    fontWeight: 700,
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  goalStepperValue: {
    minWidth: 30,
    textAlign: "center",
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 20,
    fontWeight: 700,
    color: "var(--text)",
  },
  label: { fontSize: 13, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", minWidth: 130 },
  range: { flex: 1, accentColor: "var(--regler)", minWidth: 100, height: 44, margin: 0 },
  rangeValue: { fontSize: 13, fontWeight: 600, width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" },
  chipGroup: { display: "flex", gap: 6, flexWrap: "wrap" },
  // Spieluhr: bewusst groß (40), damit sie auf dem Spielfeld lesbar ist; Ausnahme von der Schriftskala
  uhrZeit: { fontFamily: "'Space Grotesk', Inter, sans-serif", fontSize: 40, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" },
  chip: { border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--muted)", minHeight: 44, padding: "10px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer" },
  chipActive: { background: "var(--chip)", color: "var(--chip-text)", border: "1px solid var(--chip)" },
  chipRemove: { background: "transparent", border: "none", color: "var(--danger-text)", marginLeft: 6, cursor: "pointer", fontSize: 14, lineHeight: 1 },
  tag: { display: "inline-flex", alignItems: "center", borderRadius: 999, padding: "3px 9px", fontSize: 13, fontWeight: 600, background: "var(--track)", color: "var(--accent-text)", whiteSpace: "nowrap" },
  primaryBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "12px 18px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    minHeight: 44,
    boxShadow: "var(--sh-1)",
    transition: "box-shadow 150ms ease, transform 100ms ease",
  },
  stickyBar: {
    position: "sticky",
    bottom: 0,
    background: "var(--bg)",
    paddingTop: 12,
    paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
    marginTop: 16,
  },
  rowBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "0 18px",
    height: 44,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "var(--sh-1)",
    flexShrink: 0, // Button behält seine Breite, das Eingabefeld gibt nach
    whiteSpace: "nowrap",
  },
  dangerBtn: { color: "var(--danger-text)", background: "transparent", fontWeight: 600, borderRadius: 12, padding: "6px 12px" }, // Gefahr: nur rote Schrift, keine Fläche
  linkBtn: {
    background: "transparent",
    border: "none",
    color: "var(--accent-text)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: "6px 8px",
    minHeight: 44,
  },
  basisGrid: { marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--divider)", display: "flex", flexDirection: "column", gap: 8 },
  basisItem: { display: "flex", alignItems: "center", gap: 10 },
  empty: { background: "var(--surface)", border: "1px dashed var(--border-strong)", borderRadius: 12, padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 14 },
  cardDesc: { fontSize: 14, lineHeight: 1.45, color: "var(--text)", margin: "0 0 12px" },
  hint: { fontSize: 13, color: "var(--muted)", marginTop: -4, marginBottom: 6 },
  toast: {
    position: "fixed",
    bottom: 20,
    left: "50%",
    transform: "translateX(-50%)",
    background: "var(--accent)",
    color: "#fff",
    padding: "10px 18px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 500,
    boxShadow: "var(--sh-2)",
    display: "flex",
    alignItems: "center",
    gap: 14,
    zIndex: 60,
  },
  toastUndoBtn: {
    background: "rgba(255,255,255,0.18)",
    border: "none",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    padding: "4px 10px",
    borderRadius: 999,
    whiteSpace: "nowrap",
  },
  avatar: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    color: "#fff",
    fontWeight: 700,
    flexShrink: 0,
    letterSpacing: "-0.02em",
  },
  progressBar: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    background: "linear-gradient(90deg, transparent, var(--accent), transparent)",
    backgroundSize: "200% 100%",
    animation: "progressSlide 1.1s linear infinite",
    zIndex: 70,
  },
  statsRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  statBox: { flex: "1 1 90px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 8px", textAlign: "center", boxShadow: "var(--sh-1)" },
  statValue: { fontSize: 20, fontWeight: 700, color: "var(--accent-text)", fontFamily: "'Space Grotesk', sans-serif", fontVariantNumeric: "tabular-nums" },
  statLabel: { fontSize: 13, color: "var(--muted)", marginTop: 2 },
  sparkGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 },
  sparkCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 12px", boxShadow: "var(--sh-1)" },
  sparkHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  sparkValue: { fontSize: 14, fontWeight: 700, color: "var(--accent-text)", fontVariantNumeric: "tabular-nums" },
  spielRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 13,
    boxShadow: "var(--sh-1)",
  },
  scorerGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginTop: 8 },
  scorerTile: { border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)", display: "flex", alignItems: "center", minHeight: 48, boxShadow: "var(--sh-1)" },
  scorerTileActive: { border: "1px solid var(--accent)", background: "var(--surface)" },
  scorerName: { flex: 1, minWidth: 0, minHeight: 48, padding: "0 8px 0 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, background: "transparent", border: "none", textAlign: "left", fontFamily: "inherit", fontSize: 14, fontWeight: 600, color: "var(--text)", cursor: "pointer" },
  scorerBadge: { minWidth: 30, height: 30, borderRadius: 999, border: "1px solid var(--border-strong)", color: "var(--muted)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums", flexShrink: 0 },
  scorerBadgeAktiv: { background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" },
  scorerMinus: { width: 44, height: 44, flexShrink: 0, marginRight: 2, borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--accent-text)", fontSize: 20, fontWeight: 700, cursor: "pointer", lineHeight: 1 },
  stepBtn: { width: 44, height: 44, borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--accent-text)", fontSize: 20, fontWeight: 700, cursor: "pointer", lineHeight: 1 },
  editBanner: { background: "var(--warn-bg)", color: "var(--warn-text)", borderRadius: 8, padding: "8px 12px", fontSize: 13, display: "flex", alignItems: "center", gap: 8 },
  seasonHint: {
    background: "var(--info-bg)",
    color: "var(--info-text)",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 14,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(28,20,20,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 80,
  },
  modalCard: {
    background: "var(--surface)",
    borderRadius: 16,
    padding: 20,
    maxWidth: 380,
    width: "100%",
    boxShadow: "var(--sh-3)",
  },
  modalText: { fontSize: 14, color: "var(--text)", margin: "0 0 18px 0", lineHeight: 1.5 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10 },
  rowBtnOutline: {
    background: "transparent",
    color: "var(--text-2)",
    border: "1px solid var(--border-strong)",
    borderRadius: 8,
    padding: "0 16px",
    height: 40,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};

const styleSheet = document.createElement("style");
styleSheet.textContent =
  "@keyframes spin { to { transform: rotate(360deg); } } " +
  "@keyframes progressSlide { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } } " +
  "button { transition: filter 120ms ease, transform 80ms ease, opacity 120ms ease; } " +
  "button:active { transform: scale(0.97); } " +
  "button:hover:not(:disabled) { filter: brightness(0.96); } " +
  "button:disabled { cursor: default; opacity: 0.6; }";
document.head.appendChild(styleSheet);

window.addEventListener("error", (ev) => meldeFehler("unbehandelt", ev.error || ev.message));
window.addEventListener("unhandledrejection", (ev) => meldeFehler("unbehandelt", ev.reason));

try {
  const suche = new URLSearchParams(window.location.search);
  const pfadMatch = window.location.pathname.match(/^\/([a-z0-9][a-z0-9-]{6,63})\/?$/);
  const kartenToken = suche.get("karten") || (pfadMatch ? pfadMatch[1] : null);
  ReactDOM.createRoot(document.getElementById("root")).render(kartenToken ? (suche.get("seite") === "vorschau" ? <KartenSeiteVorschau token={kartenToken} /> : <KartenSeitePlus token={kartenToken} />) : <Root />);
  document.getElementById("root").dataset.rendered = "true";
} catch (e) {
  document.getElementById("root").innerHTML =
    '<div style="padding:20px;font-family:monospace;white-space:pre-wrap;color:#9B2226;font-size:13px;">Fehler beim Rendern:\n\n' +
    (e.message || e) +
    "</div>";
}
