# Changelog

## 2026.10.19.1

### Added

- `archive` method: pages a whole Boosty blog and writes one Markdown note per
  post (YAML frontmatter: title, date, source, tags, access) with images
  downloaded to `attachments/`, named by Boosty image id. Idempotent reruns.
- `whoami` method: checks the configured `accessToken` against the current-user
  endpoint and a sample of the blog's posts.
- `accessToken` accepts the bare token or the raw (URL-encoded) `auth` cookie.
