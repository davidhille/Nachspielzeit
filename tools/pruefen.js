// Prüft die App-Quelle aus index.html: 1) Syntax (acorn + JSX), 2) Lint auf nicht definierte Namen (ESLint no-undef).
// Aufruf: cd tools && npm install && npm run pruefen
const acorn = require("acorn");
const jsx = require("acorn-jsx");
const { Linter } = require("eslint");
const { appQuelle } = require("./test/lade-app");

const src = appQuelle();
try {
  acorn.Parser.extend(jsx()).parse(src, { ecmaVersion: "latest", sourceType: "script" });
  console.log("ACORN_OK");
} catch (e) {
  console.error("SYNTAXFEHLER:", e.message);
  process.exit(1);
}

// Die Quelle enthält eslint-disable-Kommentare für react-hooks; die Regel ist hier nur ein leerer Platzhalter.
// Bekannte Browser-/Sprach-Globals (React kommt als Global aus vendor/)
const globals = {};
"React ReactDOM window document localStorage sessionStorage fetch console navigator URL URLSearchParams FileReader Image Blob crypto setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame Uint8Array AbortController Promise JSON Math Date Intl Audio Event CustomEvent getComputedStyle matchMedia ResizeObserver IntersectionObserver MutationObserver FormData TextDecoder TextEncoder atob btoa encodeURIComponent decodeURIComponent structuredClone performance queueMicrotask XMLSerializer DOMParser Path2D OffscreenCanvas createImageBitmap Symbol Map Set WeakMap Array Object Number String Boolean Error TypeError RegExp isNaN parseFloat parseInt Infinity NaN undefined Float32Array Uint8ClampedArray Uint16Array Int32Array Float64Array ArrayBuffer DataView Reflect Proxy BigInt MediaRecorder MediaMetadata AudioContext Worker history location screen alert confirm prompt HTMLElement SVGElement Node File DOMException Response Headers Request WebSocket indexedDB caches self globalThis"
  .split(" ")
  .forEach((k) => (globals[k] = "readonly"));

const meldungen = new Linter()
  .verify(
    src,
    [{ files: ["**/*.js"], plugins: { "react-hooks": { rules: { "exhaustive-deps": { create: () => ({}) } } } }, languageOptions: { ecmaVersion: "latest", sourceType: "script", parserOptions: { ecmaFeatures: { jsx: true } }, globals }, rules: { "no-undef": "error", "no-redeclare": "error" } }],
    "app.js"
  )
  .filter((m) => m.fatal || m.ruleId);
meldungen.forEach((m) => console.error(`${m.line}:${m.column} ${m.ruleId} ${m.message}`));
if (meldungen.length) process.exit(1);
console.log("LINT_OK");
