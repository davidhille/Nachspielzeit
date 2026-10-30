/* Nachspielzeit – Sitzung: Zugangscode, aktuelles Team und Zugangsinfo an einer Stelle.
   Klassisches Skript vor der App. Gelesen wird überall als Sitzung.code / .team / .info. */
const Sitzung = (() => {
  const SCHLUESSEL = "nsz_access_code";
  const lese = () => {
    try {
      return localStorage.getItem(SCHLUESSEL) || "";
    } catch {
      return ""; // z. B. privater Modus: dann gilt der Code nur bis zum Neuladen
    }
  };
  /* Team aus ?team=…, sonst aus dem Hostnamen (u8.nachspielzeit.app -> "u8"), sonst "u8". Im Admin wird es per Team-Auswahl überschrieben. */
  const ermittleTeam = () => {
    try {
      const q = new URLSearchParams(window.location.search).get("team");
      if (q && /^[a-z0-9-]+$/i.test(q)) return q.toLowerCase();
      const m = window.location.hostname.match(/^([a-z0-9-]+)\.nachspielzeit\.app$/i);
      if (m && !["admin", "www"].includes(m[1].toLowerCase())) return m[1].toLowerCase();
    } catch {}
    return "u8";
  };
  return {
    code: lese(),
    team: ermittleTeam(),
    info: null, // { ok, team_id, verein_id }  (beides leer = Haupt-Admin; nur verein_id = Vereins-Admin; team_id = Trainer), Rolle: zugangsRolle(info)
    /** Nach erfolgreicher Prüfung: Code merken (auch über Neuladen hinaus). */
    merkeCode(code) {
      this.code = code;
      try {
        localStorage.setItem(SCHLUESSEL, code);
      } catch {}
    },
    /** Abmelden bzw. ungültigen Code verwerfen. */
    vergiss() {
      this.code = "";
      this.info = null;
      try {
        localStorage.removeItem(SCHLUESSEL);
      } catch {}
    },
  };
})();
