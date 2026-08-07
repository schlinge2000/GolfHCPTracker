# Anonymer Nutzungszähler

Zählt, wie viele Geräte die App nutzen – ohne Login, ohne Analytics-Dienst, ohne
Cookies, ohne zusätzlichen Dienstleister. Ist der Endpoint nicht erreichbar,
verhält sich die App wie vorher: sie sendet nichts.

## Wie es funktioniert

1. Beim ersten Start erzeugt die App eine Zufalls-UUID und legt sie unter
   `golf_hcp_usage` im `localStorage` ab (`src/usagePing.ts`).
2. Höchstens **einmal pro Kalendertag** geht ein `POST` mit genau dieser ID an
   `/api/usage`. Mehr wird nicht übertragen.
3. Schlägt der Ping fehl (offline, Endpoint down), bleibt der Tag ungezählt und
   wird beim nächsten App-Start oder beim nächsten `online`-Event erneut
   versucht. Das ist wichtig, weil die App als PWA offline auf dem Platz läuft.
4. Die Function speichert einen leeren Blob unter `pings/<tag>/<installId>` –
   den Tag setzt **sie selbst** (UTC), nicht der Client. Derselbe Schlüssel ist
   derselbe Blob, damit ist die Deduplizierung pro Tag geschenkt. Keine IP,
   kein User-Agent, keine Uhrzeit.
5. Blobs älter als 400 Tage werden automatisch gelöscht: immer beim `GET`
   (die Liste liegt dort schon vor) und mit 2 % Wahrscheinlichkeit beim `POST`.
6. `GET /api/usage` liefert die Aggregate. Die App zeigt sie unter
   **HCP-Info → Datenschutz**; dort sitzt auch der Opt-out-Schalter.

Beim Opt-out wird die ID auf dem Gerät gelöscht. Nach dem Wiedereinschalten
entsteht eine neue ID, die sich nicht mit der alten Zählung verknüpfen lässt.
Bereits gezählte Tage der alten ID bleiben als anonyme Zeile im Zähler stehen.

## Endpoint

| Methode | Antwort |
| --- | --- |
| `POST /api/usage` mit `{"installId":"<uuid>"}` | `204`; `400` bei ungültiger ID oder kaputtem JSON, `413` bei zu großem Body, `503` wenn der Blob-Store nicht erreichbar ist |
| `GET /api/usage` | `{"activeToday":3,"activeLast7Days":8,"activeLast30Days":12,"total":15,"retentionDays":400}` |
| `OPTIONS /api/usage` | `204` mit CORS-Headern (nur nötig, wenn der Endpoint auf einer anderen Domain liegt) |

## Deployment auf Netlify

Es ist **nichts zu provisionieren**. Netlify findet `netlify/functions/usage.mts`
automatisch, und die Route kommt aus der Function selbst:

```ts
export const config = { path: "/api/usage" };
```

Als Speicher dient [Netlify Blobs](https://docs.netlify.com/blobs/overview/) –
Teil der Plattform, auf der die App schon läuft, also kein weiterer Anbieter und
keine Zugangsdaten. Das Paket `@netlify/blobs` steht in den `dependencies`, das
genügt.

Nach dem nächsten Deploy also direkt:

```bash
curl https://<deine-domain>/api/usage
# {"activeToday":1,"activeLast7Days":1,...,"retentionDays":400}
```

Wenn im Netlify-UI ein **abweichendes Functions-Verzeichnis** konfiguriert ist,
muss `netlify/functions/usage.mts` dorthin – `netlify/functions` ist der
Standard und braucht keine `netlify.toml`.

Deploy-Previews und Branch-Deploys schreiben in einen eigenen Store
(`usage-deploy-preview` statt `usage`, abgeleitet aus Netlifys `CONTEXT`),
damit Testaufrufe den Produktionszähler nicht hochtreiben.

### Optionale Variablen

| Variable | Wirkung |
| --- | --- |
| `USAGE_ALLOWED_ORIGIN` | Komma-Liste erlaubter Origins, z. B. `https://golf.example.com`. Nicht gesetzt = alle erlaubt (`Access-Control-Allow-Origin: *`). |
| `VITE_USAGE_PING_URL` | Build-Zeit-Variable im Frontend. Nur nötig, wenn der Endpoint **nicht** unter `/api/usage` derselben Domain liegt. |

## Aufbau

| Datei | Rolle |
| --- | --- |
| `src/usagePing.ts` | Client: ID, Tagesdrossel, Offline-Nachtrag, Opt-out |
| `src/usageAggregate.ts` | Geteilt: Schlüsselformat, ID-Muster, Aggregation, Retention |
| `netlify/functions/usage.mts` | Function: Routing, Validierung, Blob-Zugriff |
| `netlify/functions/usage.test.mts` | Function gegen einen In-Memory-Blob-Store |
| `public/sw.js` | `/api/` wird nicht gecacht, sonst zeigt die App veraltete Zahlen |

ID-Muster und Aufbewahrungsdauer stehen absichtlich nur an einer Stelle
(`src/usageAggregate.ts`) – sonst laufen Client-Prüfung, Serverprüfung und die
im Datenschutztext genannte Frist auseinander.

## Grenzen

- Gezählt werden **Geräte/Browser**, nicht Personen. Handy + Laptop = 2.
  Ohne Login ist es genauer nicht möglich.
- Wer den Browser-Speicher löscht oder privat surft, zählt beim nächsten
  Besuch als neues Gerät. `total` ist deshalb eine Obergrenze; die
  30-Tage-Zahl ist der belastbarere Wert.
- `GET` listet alle Blobs und zählt in Node. Bei einer privaten App (Dutzende
  Geräte, also einige Tausend Schlüssel) ist das unkritisch. Ab grob
  100 Geräten × 400 Tagen wird das Listen träge – dann auf Netlify DB
  (Postgres) mit `COUNT(DISTINCT …)` wechseln; die Logik dafür steckt
  vollständig in `src/usageAggregate.ts` und der Function.
- Der Endpoint ist offen. Theoretisch kann jemand fremde IDs einschicken und
  die Zahl aufblähen. Für eine private App ist das vertretbar; bei Bedarf
  helfen `USAGE_ALLOWED_ORIGIN` plus eine Rate-Limit-Regel vor `/api/usage`.
- Rechtlicher Hinweis: Das Ablegen der ID auf dem Gerät passiert hier ohne
  vorherige Einwilligung, mit Opt-out (§ 25 TTDSG kennt für nicht zwingend
  erforderliche Speicherung streng genommen nur die Einwilligung). Für eine
  private, nicht vermarktete App ist das die üblich gewählte Abwägung; soll es
  strikt sein, muss der Zähler auf Opt-in umgestellt werden – dazu in
  `normalizeUsageState` (`src/usagePing.ts`) das Default von
  `source.enabled !== false` auf `source.enabled === true` ändern.
