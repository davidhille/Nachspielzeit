// Übersetzt src/app.jsx (JSX) mit dem mitgelieferten Babel (vendor/babel.min.js) zu app.<Hash>.js im Hauptordner
// und trägt den Dateinamen in index.html ein. Gleiche Einstellungen wie früher im Browser (classic runtime, Skript).
//   node tools/bauen.js            übersetzen und index.html aktualisieren
//   node tools/bauen.js --pruefen  nur prüfen: passt app.<Hash>.js zu src/app.jsx und steht er in index.html? (für CI)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const wurzel = path.join(__dirname, "..");
const quelle = fs.readFileSync(path.join(wurzel, "src", "app.jsx"), "utf8");
const Babel = require(path.join(wurzel, "vendor", "babel.min.js"));

const code = Babel.transform(quelle, { presets: [["react", { runtime: "classic" }]], sourceType: "script" }).code;
const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 10);
const name = `app.${hash}.js`;
const tag = `<script src="${name}"></script>`;
const indexPfad = path.join(wurzel, "index.html");
const html = fs.readFileSync(indexPfad, "utf8");
const platzhalter = /<!--APP-->|<script src="app\.[0-9a-f]{10}\.js"><\/script>/;

if (process.argv.includes("--pruefen")) {
  const ok = html.includes(tag) && fs.existsSync(path.join(wurzel, name)) && fs.readFileSync(path.join(wurzel, name), "utf8") === code;
  if (!ok) {
    console.error(`NICHT AKTUELL: src/app.jsx wurde geändert, aber nicht neu gebaut (erwartet ${name}). Bitte "node tools/bauen.js" ausführen und die Dateien committen.`);
    process.exit(1);
  }
  console.log(`BUILD_OK ${name}`);
} else {
  if (!platzhalter.test(html)) throw new Error('In index.html fehlt der Platzhalter <!--APP--> bzw. das App-Skript.');
  fs.writeFileSync(path.join(wurzel, name), code);
  fs.writeFileSync(indexPfad, html.replace(platzhalter, tag));
  for (const f of fs.readdirSync(wurzel)) if (/^app\.[0-9a-f]{10}\.js$/.test(f) && f !== name) fs.unlinkSync(path.join(wurzel, f));
  console.log(`gebaut: ${name} (${Math.round(code.length / 1024)} KB)`);
}
