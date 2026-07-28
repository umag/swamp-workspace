# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the published
[Porkbun DNS API v3 documentation](https://porkbun.com/api/json/v3/documentation),
never captured from a live call. This mirrors the `lastfm` precedent (synthetic
fixtures, no live capture) and is a deliberate security decision, not an
oversight.

## What was NOT done (explicit prohibition)

A live `my-porkbun` (`@dns/porkbun`) model instance and a `porkbun` vault **do
exist** in this homelab. **Live capture from that instance is FORBIDDEN** for
this fixture corpus — not "not done this time", but a standing rule for anyone
regenerating these fixtures later:

- No `swamp model method run my-porkbun <method>` call was made while authoring
  these fixtures.
- No vault credential (`porkbun` vault: `API_KEY` / `SECRET_API_KEY`) was read,
  exported, or otherwise touched.
- No real domain, subdomain, or DNS record content from any zone this account
  manages appears anywhere below.
- The destructive endpoints (`create`, `edit`, `delete`, `deleteByNameType`)
  were never invoked against the live API — their fixture shapes are transcribed
  from the documentation's example responses, not observed side effects.

The fixtures-secret-scan test in
`../extensions/models/porkbun_adversarial_test.ts` is a **mechanical backstop**,
not the primary control — the primary control is this prohibition plus never
running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data (see the security
review's residual LOW finding on plan v2).

## Every value is synthetic

- Domain: `example.com` / `www.example.com` — IANA's reserved example domain
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never a real zone.
- IP addresses: `192.0.2.10` — from the `TEST-NET-1` documentation range
  ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)).
- `yourIp` in `ping.json`: `203.0.113.42` — from the `TEST-NET-3` documentation
  range (RFC 5737).
- Record ids: `1000000001`–`1000000005` — synthetic sequential placeholders, not
  real Porkbun record ids.
- TXT content (`_dmarc` record): a generic, non-secret DMARC policy string
  (`v=DMARC1; p=none;`) — no real domain's DMARC policy or any credential
  material.

## Per-file mapping to the documented endpoint

| File                      | Documented endpoint                                        |
| ------------------------- | ---------------------------------------------------------- |
| `ping.json`               | `POST /ping`                                               |
| `retrieve.json`           | `POST /dns/retrieve/<domain>`                              |
| `retrieveByNameType.json` | `POST /dns/retrieveByNameType/<domain>/<type>/<subdomain>` |
| `create.json`             | `POST /dns/create/<domain>`                                |
| `edit.json`               | `POST /dns/edit/<domain>/<id>`                             |
| `delete.json`             | `POST /dns/delete/<domain>/<id>`                           |
| `error.json`              | Generic Porkbun error envelope (any endpoint)              |

## A documented API quirk this corpus deliberately preserves

The Porkbun v3 docs show `retrieve`/`retrieveByNameType` records with `ttl` and
`prio` serialized as **strings** (e.g. `"ttl": "600"`), while `create`'s
response `id` is a **number** (e.g. `"id": 1000000005`) rather than the string
`id` seen on retrieved records. This asymmetry is real and intentional in the
fixtures — `porkbun.ts`'s resource schemas use `z.any()` for exactly these
fields, and the contract-fixture suite pins the concrete wire types so a future
Porkbun API change (or a future `porkbun.ts` refactor that tightens the schema
incorrectly) turns a test red instead of passing silently.
