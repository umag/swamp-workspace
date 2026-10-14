# Fixture provenance

- `openapi.reference.yml` — bsport's published OpenAPI document for the public
  B2B API (`public.production.bsport.io`, `X-Api-Key`). This model does NOT call
  that API. The file is kept as a reference for the DRF conventions the member
  API shares with it: `page` / `page_size` query parameters and the paginated
  envelope `{count, next, next_page, previous, results}`
  (`PaginatedDeprecatedBookingOutputList`). The `fixtures/` directory is excluded from `deno fmt`.
- `offers.json`, `bookings_page1.json`, `bookings_page2.json`,
  `establishments.json`, `waitlist_booking_options.json`,
  `waitlist_positions.json`, `login.json` — hand-written in the shape of the
  member API (`api.production.bsport.io/book/v1/*`,
  `/api-v0/authentication/signin/with-login/`) as observed from the studio
  portal's network traffic and recorded in the model's module doc and README.
  Ids, names and the token are synthetic. No value here came from a real member
  account.
