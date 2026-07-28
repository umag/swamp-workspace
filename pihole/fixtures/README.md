# pihole fixtures — SYNTHETIC, hand-authored

Both files in this directory are **hand-authored synthetic fixtures**, not a
captured live response. They exist only to pin the wire SHAPE `pihole_test.ts`
decodes against, independent of any real Pi-hole instance.

- `list-response.json` — the `/api/config/dns/hosts` response shape. Uses RFC
  5737 documentation IPs (`192.0.2.0/24`, `198.51.100.0/24`) and `.example.test`
  hostnames. No real LAN address or internal hostname.
- `auth-response.json` — the `/api/auth` response shape. `sid`/`csrf` are
  obviously-fake placeholder strings (`FAKE-SID-SYNTHETIC-...`), never a real
  captured session token.

## Replacing with a real capture

A sanitized capture from the homelab `aopab-local-dns` instance can be produced
later via the existing `ext-canary-fixtures` swamp workflow (id `d1354265`), run
from a WireGuard-connected host (zeroclaw/DO) — never from a developer laptop.
Any such capture MUST go through the workflow's in-memory sanitizer AND a human
diff-review before commit: trim the record set to a small wire-shape sample, and
re-verify (or replace) the two safety assertions in `pihole_test.ts` (no
`192.168.x` address, no real `*.aopab.art` host, fake-looking `sid`/`csrf`).

Until that capture lands, these synthetic fixtures are the supported contract
pin for `pihole_test.ts` — they are not a placeholder that blocks anything, and
`contract-fixture` is independently already `present` via `pihole_dns_test.ts`.
