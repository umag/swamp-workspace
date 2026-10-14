# @magistr/ns-international

Plan train trips on **NS** and **NS International** via the official
[NS Reisinformatie API](https://apiportal.ns.nl) — the only public, supported NS
interface.

**Planning only.** NS exposes no public booking or payment API, so this model
never purchases tickets. Every planned option carries a `bookingUrl` deep-link
into the NS / NS International site, where you complete the booking with your
own account and payment method.

## What it covers

- Domestic NL journeys, and the international connections NS International sells
  (Belgium, Germany, France; Eurostar, Eurocity Direct, ICE).
- Journey advice with times, transfers, per-leg train and operator, crowding,
  and the cheapest fare the API returns.
- Live departures context via disruptions/maintenance.

**Not covered:** stations outside NS's routable catalog. NS International's
directly-sold Belgian corridor is Amsterdam → Antwerp → Brussels; destinations
like Ghent are reached by continuing on Belgian rail (SNCB) and are not
plannable through this API. Cross-border ICE/Eurostar fares are frequently
absent from the API and show as `price n/a` — times and routing are still
complete.

## Setup

1. Register at [apiportal.ns.nl](https://apiportal.ns.nl) and subscribe to the
   **Reisinformatie API** product (free). Copy the primary key.
2. Store it in a vault and wire the model to it — never pass the key as a
   literal:

   ```bash
   swamp vault put <vault> NS_API_KEY            # prompts, hidden input
   swamp model create @magistr/ns-international ns \
     --global-arg 'apiKey=${{ vault.get(<vault>, NS_API_KEY) }}'
   ```

## Global arguments

| Field       | Default                      | Description                          |
| ----------- | ---------------------------- | ------------------------------------ |
| `apiKey`    | (required)                   | Reisinformatie API subscription key. |
| `baseUrl`   | `…/reisinformatie-api/api`   | API base URL.                        |
| `userAgent` | `swamp-ns-international/1.0` | User-Agent header.                   |

## Methods

### `stations`

Fetch the station directory and cache it as `station-index` for name→code/UIC
resolution. With `query`, also print matching stations.

```bash
swamp model method run ns stations --input query=amsterdam
```

### `plan`

Journey advice between two stations. `from`/`to` accept a station name, NS code
(e.g. `ASD`), or UIC code.

| Argument           | Default | Description                                   |
| ------------------ | ------- | --------------------------------------------- |
| `from`             | —       | Origin: name, code, or UIC.                   |
| `to`               | —       | Destination: name, code, or UIC.              |
| `dateTime`         | now     | ISO-8601 time; empty = now.                   |
| `searchForArrival` | `false` | `true` = treat `dateTime` as desired arrival. |
| `travelClass`      | —       | `1` or `2`; omit for API default.             |

```bash
swamp model method run ns plan \
  --input "from=Amsterdam Centraal" --input to=BERHBT \
  --input dateTime=2026-09-22T08:00:00+02:00
```

Ambiguous station names throw with a candidate list — use a code or UIC to
disambiguate (e.g. Berlin Hbf = `BERHBT`).

### `disruptions`

Active disruptions and maintenance works.

```bash
swamp model method run ns disruptions --input type=MAINTENANCE
```

## Notes

- The NS journey planner has a booking/advice horizon of roughly the next ~90
  days; dates further out return "too far in the future".
- Data source discovery and API behaviour are documented inline in
  `extensions/models/ns_international.ts`.
