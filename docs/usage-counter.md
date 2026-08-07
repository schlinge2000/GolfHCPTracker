# Anonymer Nutzungszähler

Zählt, wie viele Geräte die App nutzen – ohne Login, ohne Analytics-Dienst, ohne Cookies.
Ist der Endpoint nicht eingerichtet, verhält sich die App wie vorher: sie sendet nichts.

## Wie es funktioniert

1. Beim ersten Start erzeugt die App eine Zufalls-UUID und legt sie unter
   `golf_hcp_usage` im `localStorage` ab (`src/usagePing.ts`).
2. Höchstens **einmal pro Kalendertag** geht ein `POST` mit genau dieser ID an
   den Zähl-Endpoint. Mehr wird nicht übertragen.
3. Schlägt der Ping fehl (offline, Endpoint down), bleibt der Tag ungezählt und
   wird beim nächsten App-Start oder beim nächsten `online`-Event erneut
   versucht. Das ist wichtig, weil die App als PWA offline auf dem Platz läuft.
4. Der Server speichert nur das Paar `(install_id, day)` – den Tag setzt **er
   selbst** (UTC), nicht der Client. Keine IP, kein User-Agent, keine Uhrzeit.
5. Zeilen älter als 400 Tage werden automatisch gelöscht (gelegentlich beim
   Schreiben, `PRUNE_PROBABILITY` in `functions/api/usage.ts`).
6. `GET` auf denselben Pfad liefert die Aggregate. Die App zeigt sie unter
   **HCP-Info → Datenschutz**; dort sitzt auch der Opt-out-Schalter.

Beim Opt-out wird die ID auf dem Gerät gelöscht. Nach dem Wiedereinschalten
entsteht eine neue ID, die sich nicht mit der alten Zählung verknüpfen lässt.
Bereits gezählte Tage der alten ID bleiben als anonyme Zeile im Zähler stehen.

## Endpoint

| Methode | Antwort |
| --- | --- |
| `POST /api/usage` mit `{"installId":"<uuid>"}` | `204` (oder `400` bei ungültiger ID, `503` wenn keine DB gebunden ist) |
| `GET /api/usage` | `{"activeToday":3,"activeLast7Days":8,"activeLast30Days":12,"total":15,"retentionDays":400}` |

## Deployment auf Cloudflare Pages (Standardweg)

Die Function unter `functions/api/usage.ts` wird von Cloudflare Pages
automatisch als Route `/api/usage` deployt. Nötig ist nur die D1-Datenbank:

```bash
# 1. Datenbank anlegen
npx wrangler d1 create golf-hcp-usage

# 2. Schema einspielen (--remote = produktive DB)
npx wrangler d1 execute golf-hcp-usage --remote --file=db/usage-schema.sql
```

Dann im Pages-Projekt unter **Settings → Functions → D1 database bindings**
binden – Variablenname muss `USAGE_DB` sein, Datenbank `golf-hcp-usage`.
Für Production **und** Preview eintragen, sonst gibt Preview `503` zurück.

Zahl abfragen: `https://<deine-domain>/api/usage` im Browser öffnen, oder

```bash
npx wrangler d1 execute golf-hcp-usage --remote \
  --command "SELECT COUNT(DISTINCT install_id) FROM usage_pings"
```

### Optionale Variablen

| Variable | Wirkung |
| --- | --- |
| `USAGE_ALLOWED_ORIGIN` | Komma-Liste erlaubter Origins, z. B. `https://golf.example.com`. Nicht gesetzt = alle erlaubt (`Access-Control-Allow-Origin: *`). |
| `VITE_USAGE_PING_URL` | Build-Zeit-Variable im Frontend. Nur nötig, wenn der Endpoint **nicht** unter `/api/usage` derselben Domain liegt. |

## Anderes Hosting

Der Client ist hostingunabhängig – er braucht nur einen Pfad, der `POST` und
`GET` wie oben beantwortet. Die Logik in `functions/api/usage.ts` ist rund
50 Zeilen und leicht portierbar:

- **Vercel**: Datei nach `api/usage.ts` verschieben und auf
  `export default function handler(req, res)` umstellen; als Speicher passt
  Vercel Postgres oder Upstash Redis (`PFADD usage:<tag> <id>` + `PFCOUNT`).
- **Netlify**: `netlify/functions/usage.ts` plus Redirect `/api/usage` →
  Function; Speicher z. B. Netlify Blobs oder Upstash.
- **Eigener Server**: SQLite reicht, das Schema in `db/usage-schema.sql` ist
  Standard-SQL.

Wichtig bleibt in jedem Fall: kein Speichern von IP oder User-Agent, `INSERT OR
IGNORE` auf `(install_id, day)` für die Deduplizierung, und der Tag kommt vom
Server.

## Grenzen

- Gezählt werden **Geräte/Browser**, nicht Personen. Handy + Laptop = 2.
  Ohne Login ist es genauer nicht möglich.
- Wer den Browser-Speicher löscht oder privat surft, zählt beim nächsten
  Besuch als neues Gerät. `total` ist deshalb eine Obergrenze; die
  30-Tage-Zahl ist der belastbarere Wert.
- Der Endpoint ist offen. Theoretisch kann jemand fremde IDs einschicken und
  die Zahl aufblähen. Für eine private App ist das vertretbar; bei Bedarf
  helfen `USAGE_ALLOWED_ORIGIN` plus eine Cloudflare-Rate-Limiting-Regel auf
  `/api/usage`.
- Rechtlicher Hinweis: Das Ablegen der ID auf dem Gerät passiert hier ohne
  vorherige Einwilligung, mit Opt-out (§ 25 TTDSG kennt für nicht zwingend
  erforderliche Speicherung streng genommen nur die Einwilligung). Für eine
  private, nicht vermarktete App ist das die üblich gewählte Abwägung; soll es
  strikt sein, muss der Zähler auf Opt-in umgestellt werden – dazu in
  `normalizeUsageState` (`src/usagePing.ts`) das Default von
  `source.enabled !== false` auf `source.enabled === true` ändern.
