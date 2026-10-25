// Design-Check: prüft src/app.jsx und index.html gegen die Design-Regeln aus CLAUDE.md.
// Aufruf: cd tools && npm run design           (prüfen, Exit 1 bei neuen Verstößen)
//         cd tools && npm run design -- --ausnahmen-schreiben   (aktuelle Treffer als bewusste Ausnahmen festhalten)
//
// Regeln:
//   outline-none      kein `outline: none` (sichtbarer Fokus)
//   token-undefiniert var(--x) ohne Definition in index.html oder App
//   hex-fallback      kein var(--x, #hex), das Token muss existieren
//   radius            nur 8 / 12 / 16 / 999 (und 50 % für Kreise, 0)
//   schatten          nur var(--sh-*) oder none
//
// Der Taktik-Editor (Top-Level-Namen Tk…/tk…/Taktik…) ist ausgenommen (Entscheidung von David).
// Bewusste Ausnahmen stehen in design-ausnahmen.json (Regel + Zeilentext). Ändert sich die Zeile, wird neu geprüft.
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const jsx = require("acorn-jsx");

const WURZEL = path.join(__dirname, "..");
const AUSNAHMEN_DATEI = path.join(__dirname, "design-ausnahmen.json");
const app = fs.readFileSync(path.join(WURZEL, "src", "app.jsx"), "utf8");
const html = fs.readFileSync(path.join(WURZEL, "index.html"), "utf8");

// Zeilenbereiche des Taktik-Editors aus dem AST ermitteln (Namensmuster der Top-Level-Deklarationen)
function taktikBereiche(quelle) {
  const ast = acorn.Parser.extend(jsx()).parse(quelle, { ecmaVersion: "latest", sourceType: "script", locations: true });
  const bereiche = [];
  for (const n of ast.body) {
    const name = n.type === "FunctionDeclaration" ? n.id.name : n.type === "VariableDeclaration" ? n.declarations.map((d) => d.id && d.id.name).join(",") : "";
    if (/^(Tk|tk|TK_|Taktik|SQL_TAKTIK)/.test(name)) bereiche.push([n.loc.start.line, n.loc.end.line]);
  }
  return bereiche;
}
const taktik = taktikBereiche(app);
const imTaktik = (zeile) => taktik.some(([a, b]) => zeile >= a && zeile <= b);

const ERLAUBTE_RADIEN = new Set([0, 8, 12, 16, 999]);

// Definierte Tokens: Zeilen mit `--name:` in index.html, dazu zur Laufzeit gesetzte (setProperty / "--name": in der App)
const definiert = new Set();
for (const m of html.matchAll(/(--[a-z0-9-]+)\s*:/g)) definiert.add(m[1]);
for (const m of app.matchAll(/setProperty\(\s*["'`](--[a-z0-9-]+)/g)) definiert.add(m[1]);
for (const m of app.matchAll(/["'](--[a-z0-9-]+)["']\s*:/g)) definiert.add(m[1]);

const treffer = [];
function melde(datei, zeilenNr, zeile, regel, text) {
  treffer.push({ datei, zeilenNr, regel, text, zeile: zeile.trim() });
}

function pruefeZeilen(datei, quelle, mitTaktikAusnahme) {
  quelle.split("\n").forEach((zeile, i) => {
    const nr = i + 1;
    if (mitTaktikAusnahme && imTaktik(nr)) return;
    if (/outline\s*:\s*["']?none/.test(zeile)) melde(datei, nr, zeile, "outline-none", "outline: none entfernt den Fokusring");
    for (const m of zeile.matchAll(/var\((--[a-z0-9-]+)\s*(,\s*#[0-9a-fA-F]{3,8})?\s*\)/g)) {
      if (!definiert.has(m[1])) melde(datei, nr, zeile, "token-undefiniert", `${m[1]} ist nirgends definiert`);
      if (m[2]) melde(datei, nr, zeile, "hex-fallback", `Hex-Fallback bei ${m[1]}: Token statt Wert verwenden`);
    }
    for (const m of zeile.matchAll(/(?:borderRadius|border-radius)\s*:\s*([^,};\n]+)/g)) {
      const wert = m[1].replace(/\d+(\.\d+)?%/g, "").replace(/var\([^)]*\)/g, "");
      const zahlen = (wert.match(/\d+(\.\d+)?/g) || []).map(Number);
      const falsch = zahlen.filter((z) => !ERLAUBTE_RADIEN.has(z));
      if (falsch.length) melde(datei, nr, zeile, "radius", `Radius ${falsch.join(", ")} liegt nicht in 8/12/16/999`);
    }
    for (const m of zeile.matchAll(/(?:boxShadow|box-shadow)\s*:\s*([^;\n]+)/g)) {
      const wert = m[1].replace(/!important/g, "").replace(/[,}\s]+$/, "").replace(/^["'`]|["'`]$/g, "").trim();
      if (wert === "none" || /^var\(--sh-[a-z0-9-]+\)$/.test(wert)) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(wert)) continue; // Variable (z. B. ringShadow): dort prüfen, wo sie definiert ist
      melde(datei, nr, zeile, "schatten", "Schatten ohne --sh-Token");
    }
  });
}

pruefeZeilen("src/app.jsx", app, true);
pruefeZeilen("index.html", html, false);

const schluessel = (t) => `${t.regel}|${t.datei}|${t.zeile}`;

if (process.argv.includes("--ausnahmen-schreiben")) {
  const liste = [...new Set(treffer.map(schluessel))].sort();
  fs.writeFileSync(AUSNAHMEN_DATEI, JSON.stringify(liste, null, 2) + "\n");
  console.log(`${liste.length} Ausnahmen in design-ausnahmen.json geschrieben.`);
  process.exit(0);
}

const erlaubt = new Set(fs.existsSync(AUSNAHMEN_DATEI) ? JSON.parse(fs.readFileSync(AUSNAHMEN_DATEI, "utf8")) : []);
const neu = treffer.filter((t) => !erlaubt.has(schluessel(t)));
const benutzt = new Set(treffer.map(schluessel));
const veraltet = [...erlaubt].filter((k) => !benutzt.has(k));

neu.forEach((t) => console.error(`${t.datei}:${t.zeilenNr} [${t.regel}] ${t.text}\n    ${t.zeile.slice(0, 140)}`));
if (veraltet.length) console.warn(`Hinweis: ${veraltet.length} Ausnahme(n) treffen nicht mehr zu (Zeile geändert oder behoben). Aufräumen mit: npm run design -- --ausnahmen-schreiben`);
if (neu.length) {
  console.error(`DESIGN_FEHLER: ${neu.length} neue Verstöße. Beheben oder bewusst erlauben (npm run design -- --ausnahmen-schreiben).`);
  process.exit(1);
}
console.log(`DESIGN_OK (${erlaubt.size} bewusste Ausnahmen, Taktik-Editor ausgenommen)`);
