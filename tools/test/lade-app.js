// Lädt einzelne Top-Level-Deklarationen (Funktionen/Konstanten) aus der App-Quelle in index.html,
// ohne die App zu starten. So lassen sich die reinen Rechenfunktionen direkt testen.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const jsx = require("acorn-jsx");

function appQuelle() {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
  const m = html.match(/<script type="text\/plain" id="app-source">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("app-source nicht gefunden");
  return m[1];
}

/** Gibt ein Objekt mit den angeforderten Namen zurück (Funktionen oder Konstanten). */
function ladeAusApp(namen) {
  const src = appQuelle();
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

module.exports = { ladeAusApp, appQuelle };
