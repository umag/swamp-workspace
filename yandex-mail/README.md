# @magistr/yandex-mail

Yandex Mail for swamp: read, search, and organise mail over **IMAP**, and send
over **SMTP**. Yandex offers no JMAP or public REST mail API, so this model uses
the standard protocols the Yandex mail-client docs describe
(`imap.yandex.com:993` and `smtp.yandex.com:465`, both TLS).

## Setup

1. Yandex Mail → Settings → **Email clients**: enable _IMAP access_ and _App
   passwords and OAuth tokens_.
2. Yandex ID → Security → **App passwords** → create one of type **Mail**. It is
   shown only once.
3. Store it in a vault and create the model:

```bash
swamp vault put yandex-mail APP_PASSWORD
swamp model create @magistr/yandex-mail my-yandex
```

```yaml
globalArguments:
  username: you@yandex.ru
  appPassword: ${{ vault.get(yandex-mail, APP_PASSWORD) }}
  fromName: Your Name
```

Use `oauthToken` instead of `appPassword` for XOAUTH2. Outside Russia,
`imapHost: imap.ya.ru` is the documented alternative. If port 465 is blocked on
your network, set `smtpPort: 587` (STARTTLS).

## Email ids

IMAP addresses a message by mailbox plus UID. The model joins them into one id,
`<mailbox>:<uid>` (for example `INBOX:1234`), returned by `query-emails` and
accepted by every other method. Moves return the new id as `newId` when the
server reports it (Yandex supports UIDPLUS).

## Examples

```bash
swamp model method run my-yandex query-emails --input unseen=true --input limit=20
swamp model method run my-yandex get-email --input emailId=INBOX:1234
swamp model method run my-yandex send-email \
  --input 'to=["friend@example.com"]' --input subject=Hi --input text=Hello
swamp model method run my-yandex bulk-email-action \
  --input 'emailIds=["INBOX:1","INBOX:2"]' --input action=mark-read
```

## Sending and idempotency

`send-email`, `reply-email`, and `forward-email` accept a stable `messageId`.
When set, the Sent folder is checked first and the send is skipped if that
Message-ID is already there, so retried workflow steps do not send twice.
`saveToSent` (default `false`) appends a copy to Sent; leave it off if your
account already files SMTP mail in Sent, otherwise copies appear twice.

## Backup to Maildir

`archive-mailbox` writes every folder (or `mailboxes`, minus `exclude`) to a
Maildir under `outputDir`: one directory per folder, one raw RFC 5322 file per
message named `<uidvalidity>-<uid>:2,<flags>` in `cur/`, with the file time set
to the server receive date. Thunderbird, mutt, notmuch and mu read it directly.

The disk is the state. Each run fetches only server UIDs that have no file yet,
so re-runs are incremental and an interrupted run resumes. Yandex answers some
old messages with `NO [UNAVAILABLE] backend error`; those are reported as
`failed` and retried on the next run, never skipped.

```bash
swamp model method run my-yandex archive-mailbox \
  --input outputDir=./yandex-backup --input 'exclude=["Spam"]'
```

## Filling gaps from Apple Mail (macOS)

Some Yandex messages permanently fail over IMAP with
`NO [UNAVAILABLE] backend
error`. `import-apple-mail` copies those UIDs from
Apple Mail's local cache (`.emlx`), matching them by IMAP UID through Mail's
Envelope Index (a private copy is read; Mail's files are never modified).
Partial copies (Mail had not downloaded every part) are listed in
`apple-mail.json`, and their cached attachments are copied to
`attachments/<uid>/`.

```bash
swamp model method run my-yandex import-apple-mail \
  --input outputDir=./yandex-backup \
  --input accountDir=~/Library/Mail/V10/<account-uuid>
```

## Notes

- Fetching a message never marks it read; pass `markRead: true` to `get-email`
  to do so.
- `delete-email` expunges permanently. Use `bulk-email-action` with
  `action: trash` to move to Trash instead.
- `delete-mailbox` refuses INBOX and special-use folders.
