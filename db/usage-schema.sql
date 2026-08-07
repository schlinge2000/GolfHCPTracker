-- Schema fuer den anonymen Nutzungszaehler (Cloudflare D1).
-- Anwenden: siehe docs/usage-counter.md
--
-- Eine Zeile bedeutet nur: "diese anonyme Installations-ID war an diesem Tag aktiv".
-- Kein Name, keine IP, kein User-Agent, keine Runden- oder Handicap-Daten.

CREATE TABLE IF NOT EXISTS usage_pings (
  install_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);

-- Fuer die Tagesfenster (heute / 7 / 30 Tage) und das Loeschen alter Zeilen.
CREATE INDEX IF NOT EXISTS idx_usage_pings_day ON usage_pings (day);
