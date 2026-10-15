# Changelog

## 2026.10.15.6

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.5

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.4

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.3

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.1

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.11.1

First release.

- Yandex Mail over IMAP (imap.yandex.com:993, TLS) and SMTP (465 implicit TLS or
  587 STARTTLS), with an app password of type Mail or an OAuth token (XOAUTH2).
- Mailboxes: `get-account-summary`, `list-mailboxes`, and idempotent
  `create-mailbox`, `rename-mailbox`, `delete-mailbox` (INBOX and special-use
  folders are never deleted).
- Reading: `query-emails`, `get-email`, `get-thread`, `get-attachment`.
- Sending: `send-email`, `reply-email`, `forward-email`, `create-draft`,
  `send-draft`. A `messageId` makes a send idempotent: if that Message-ID is
  already in Sent, the send is skipped.
- Organising: `set-email`, `archive-email`, `delete-email`, `bulk-email-action`.
- Backup: `archive-mailbox` writes an incremental Maildir and records messages
  the server cannot deliver in `unavailable.json`; `import-apple-mail` fills
  those gaps from Apple Mail's local cache.

### Fixed before release

Found while writing the test suites:

- `archive-mailbox` `maxMessages` subtracted every UID already listed as
  unavailable from the budget, so a folder with old unavailable messages used up
  the budget of the folders after it. The budget now counts only the fetch
  attempts made in the current run.
- `reply-email` crashed with a TypeError when the original had a Reply-To but no
  From header and quoting was on.
- A message with an unparseable Date header made `query-emails` and `get-thread`
  fail with `RangeError: Invalid time value`. The date now falls back to
  INTERNALDATE, then to "".
- Email ids with a non-decimal UID (`INBOX:1e3`, `INBOX:0x10`, `INBOX: 1`) or a
  UID above 2^32-1 were accepted. They are now rejected.
- `get-thread`, `get-email`, `get-attachment` and `set-email` on two folders
  with non-ASCII (for example Cyrillic) names and the same UID wrote the same
  resource name, so the second overwrote the first. Non-ASCII ids now get a
  short hash suffix; ASCII ids keep their names.
- A `messageId` containing CR/LF or spaces was folded into a malformed
  Message-ID header and broke the idempotency lookup. It is now rejected, and
  `a@b>` no longer becomes `<a@b>>`.
- An attachment named `.`, `..`, or an empty name made `get-attachment` write to
  the output directory path itself. Such names, and control characters, are now
  replaced.
- Mailbox arguments and email ids with CR, LF or NUL are rejected before any
  IMAP connection is opened.
- Error messages are scrubbed of the app password and OAuth token.

### Internal

- `transport` export: the factories that build the IMAP client and SMTP
  transport. Tests replace them with in-memory fakes.
