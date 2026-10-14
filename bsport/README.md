# @magistr/bsport

Swamp model for the **bsport member/consumer API** — the API that powers the
studio customer portal at `backoffice.bsport.io/c/<company>/booking`. It reads
the class calendar, the signed-in member's own bookings, and their waitlist
positions.

This is **not** the public B2B "management" API (`public.production.bsport.io`,
`X-Api-Key`). It is the same member API the portal itself calls, discovered from
its network traffic.

## Auth

A two-step flow, handled internally (the model logs in once per method call and
never stores the token in swamp data):

1. `POST <baseUrl>/api-v0/authentication/signin/with-login/` with
   `{email, password}` → `{ token, is_manager, … }`.
2. Every subsequent request carries `Authorization: Token <token>`.

With `token` set (recommended), step 1 is skipped.

| Global arg  | Meaning                                | Default                            |
| ----------- | -------------------------------------- | ---------------------------------- |
| `token`     | DRF token, skips the login (vault ref) | —                                  |
| `email`     | Member login email (vault ref)         | —                                  |
| `password`  | Member login password (vault ref)      | —                                  |
| `companyId` | Studio company id (calendar `company`) | required, e.g. `1234`              |
| `baseUrl`   | API host                               | `https://api.production.bsport.io` |
| `authPath`  | Auth-service path prefix               | `/api-v0`                          |

## Configuration

The recommended setup passes a token straight from a vault (no login call):

```yaml
type: "@magistr/bsport"
typeVersion: "2026.09.15.1"
name: bsport
globalArguments:
  token: ${{ vault.get(bsport, TOKEN) }}
  companyId: "1234"
  memberId: ${{ vault.get(bsport, MEMBER_ID) }}
  consumerId: ${{ vault.get(bsport, CONSUMER_ID) }}
methods: {}
```

`token` and `password` are declared sensitive. `baseUrl` must be `http` or
`https` and must not embed credentials.

## Methods (read-only)

Fan-out factories — one call writes one resource per item plus a `summary`:

| Method                 | Endpoint                                                  | Needs        | Writes                                         |
| ---------------------- | --------------------------------------------------------- | ------------ | ---------------------------------------------- |
| `listOffers`           | GET `/book/v1/offer/?min_date&max_date&company`           | —            | `offer` + summary                              |
| `getOffers`            | GET `/book/v1/offer/?id__in=…`                            | —            | `offer` + summary                              |
| `listEstablishments`   | GET `/book/v1/establishment/?company`                     | —            | `establishment` + summary                      |
| `listFutureBookings`   | GET `/book/v1/booking/` (before_date_end)                 | `memberId`   | `booking` + summary                            |
| `listPastBookings`     | GET `/book/v1/booking/` (after_date_end)                  | `memberId`   | `booking` + summary                            |
| `listMyWaitlist`       | GET `/book/v1/waiting-list/booking-option/` + positions   | `consumerId` | `waitlistEntry` + `waitlistPosition` + summary |
| `listWaitlist`         | GET `/book/v1/offer/waiting_list_position_list/?id__in=…` | offerIds     | `waitlistPosition` + summary                   |
| `listRegisteredOffers` | GET `/book/v1/offer/registered/`                          | —            | `offer` + summary                              |

Each `offer` carries `effectif` (capacity) / `validated_booking_count` (booked),
`full`, and `waiting_list_max_size` / `is_waiting_list_full`, so a full class
(BOOK vs WAITLIST in the UI) and its waitlist state are visible without an extra
call. `level` 2 = Beginner (Débutant), 3 = Intermediate, 4 = Advanced. The offer
list returns a single page (no DRF `next`) — use `pageSize` ≥ 300 for a month.
`listMyWaitlist` needs no offer ids; `listWaitlist` takes explicit `offerIds`
(`/offer/registered/` returns nothing for a plain member).

## Booking / cancellation (not yet implemented)

Writes go through bsport's basket funnel (`/book/v1/offer/user_registration/`,
`create_pending_bookings_and_block_basket`,
`/book/v1/booking/cancel_multiple_offers/`,
`/booking/{id}/set_spot_for_member/`). Their exact payloads must be captured
from a **live, supervised** book+cancel before they can be trusted against a
real member account — deliberately left out of v1 rather than guessed.

## Example

```bash
# This week's calendar at North, beginner level (ids resolved from the calendar UI)
swamp model @magistr/bsport method run listOffers bsport \
  --input minDate=2026-09-15 --input maxDate=2026-09-22

# My waitlist positions
swamp model @magistr/bsport method run listWaitlist bsport
```

## Rate limits

The shared HTTP client retries transparently on HTTP 429, backing off per the
`Retry-After` header (delay-seconds or an HTTP-date, capped at 60 s; 1 s when
absent) up to `maxRetries` (default 5). The request timeout covers the body read
as well as the headers. The token and password are never echoed in error
messages.
