# Changelog

## 2026.10.15.1

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.09.15.1

First release.

- Read-only member-API client for bsport studios: `listOffers`, `getOffers`,
  `listEstablishments`, `listFutureBookings`, `listPastBookings`,
  `listMyWaitlist`, `listWaitlist`, `listRegisteredOffers`. Each is a fan-out
  factory that writes one resource per item plus a `summary`.
- Auth by a configured DRF `token`, or by email/password login against
  `authPath`. The token is held in memory only and never stored.
- DRF `page`/`page_size` pagination, and retry on HTTP 429 per `Retry-After`.
- Test suites: contract-fixture (against `fixtures/`), methods, adversarial,
  coverage and fast-check property tests. No test touches the network.

### Fixed before release

- `companyId` has no default: it is required, so the extension ships no
  particular studio. Set it to your studio's `company` id.
- `token` and `password` are now declared sensitive, so swamp masks them.
- `listOffers` rejects `minDate`/`maxDate` that are not `YYYY-MM-DD`. Before,
  free text went into the summary instance name.
- Pagination stops when a page adds no new items. Before, a server that ignored
  `page` and kept sending `next` made the method loop forever.
- `summary.ids` holds only real item ids. Before, items without an id added
  negative placeholder numbers; they still count toward `total`.
- `listMyWaitlist` caps entries at `maxResults`, sets `truncated`, removes
  duplicate offer ids before the position lookup, and gives id-less entries
  distinct instance names. Before, it could exceed `maxResults` by one page, and
  id-less entries overwrote each other.
- `listFutureBookings`/`listPastBookings` check `memberId` before they log in.
- `Retry-After` in HTTP-date form is honoured. Before, it fell back to 1 s.
- The request timeout now also covers reading the response body, and a non-JSON
  2xx body gives a clear error.
- `baseUrl` must be `http`/`https` with no embedded credentials.
