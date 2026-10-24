// Lädt einzelne Top-Level-Deklarationen (Funktionen/Konstanten) aus der App-Quelle in index.html,
// ohne die App zu starten. So lassen sich die reinen Rechenfunktionen direkt testen.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const jsx = require("acorn-jsx");

function appQuelle() {
  // Quelle der App: src/app.jsx (index.html lädt nur die daraus gebaute app.<Hash>.js, siehe tools/bauen.js)
  return fs.readFileSync(path.join(__dirname, "..", "..", "src", "app.jsx"), "utf8");
}

function logikQuelle() {
  return fs.readFileSync(path.join(__dirname, "..", "..", "js", "logik.js"), "utf8");
}

/** Gibt ein Objekt mit den angeforderten Namen zurück (Funktionen oder Konstanten). */
function ladeAusApp(namen) {
  // Rechenlogik liegt in js/logik.js, alles andere in der App-Quelle; beide werden gemeinsam durchsucht.
  const src = logikQuelle() + "\n" + appQuelle();
  const ast = acorn.Parser.extend(jsx()).parse(src, { ecmaVersion: "latest", sourceType: "script" });
  const teile = [];
  for (const node of ast.body) {
    let name = null;
    if (node.type === "FunctionDeclaration") name = node.id.name;
    else if (node.type === "VariableDeclaration") name = node.declarations.map((d) => d.id.name).join(",");
    if (name && name.split(",").some((n) => namen.includes(n))) teile.push(src.slice(node.start, node.end));
  }
  const ctx = vm.createContext({ Date, Math, Number, String, Array, Object });
  vm.runInContext(teile.join("\n") + `\nthis.__out = { ${namen.join(", ")} };`, ctx);
  return ctx.__out;
}

module.exports = { ladeAusApp, appQuelle, logikQuelle };
