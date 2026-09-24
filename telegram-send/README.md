# @magistr/telegram-send

Send messages, photos, documents, videos, and rich messages to Telegram chats,
manage the bot's webhook, and receive updates on `swamp serve`, from
[swamp](https://github.com/systeminit/swamp) workflows, via the
[Telegram Bot API](https://core.telegram.org/bots/api).

A natural complement to
[`@magistr/telegram-import`](https://swamp-club.com/extensions/@magistr/telegram-import),
which goes the other direction — importing Telegram exports into Obsidian.

## Features

- **Methods**: `getMe`, `sendMessage`, `sendPhoto`, `sendDocument`, `sendVideo`,
  `sendRichMessage`, `getFile`, `setWebhook`, `getWebhookInfo`, `deleteWebhook`.
- **Serve webhook scheme** `@magistr/telegram-webhook`: Telegram calls a
  `swamp serve` webhook directly; see
  [Receive updates](#receive-updates-on-swamp-serve).
- **Sensitive token storage**: `botToken` is marked `sensitive`, so swamp routes
  it to a vault automatically. The plaintext never lives on disk in the model
  instance YAML.
- **Smart attachments**: `sendPhoto` and `sendDocument` accept an `https://`
  URL, a Telegram `file_id`, **or** a local filesystem path — the model picks
  multipart upload vs. JSON automatically.
- **Optional default chat**: set `defaultChatId` on the instance and omit it on
  every send. Method argument always wins if both are set.
- **MarkdownV2 / HTML** formatting via `parseMode`.

## Install

```bash
swamp extension pull @magistr/telegram-send
```

## Setup

Create a bot through [@BotFather](https://t.me/BotFather) and grab its token,
then store the token in a vault:

```bash
# 1. create a vault (one-time)
swamp vault create local_encryption telegram

# 2. store the token (prefix the line with a space so it stays out of history)
 swamp vault put telegram BOT_TOKEN='123456:ABCdef...' -f
```

Get your numeric `chat_id` by messaging [@userinfobot](https://t.me/userinfobot)
on Telegram, or send any message to your bot and
`curl https://api.telegram.org/bot<TOKEN>/getUpdates`.

Create the model instance and wire the vault reference:

```bash
swamp model create @magistr/telegram/send tg-bot
swamp model edit tg-bot <<'EOF'
type: '@magistr/telegram/send'
typeVersion: 2026.09.24.1
name: tg-bot
version: 1
tags: {}
globalArguments:
  botToken: ${{ vault.get(telegram, BOT_TOKEN) }}
  defaultChatId: "123456789"
methods: {}
EOF
```

## Usage

### Smoke-test the token

```bash
swamp model method run tg-bot getMe
```

Returns a `botInfo` resource with the bot's `id`, `username`, and capability
flags. Use this as the first call after onboarding a new token — it confirms the
vault wiring works without sending a message.

### Send a text message

```bash
swamp model method run tg-bot sendMessage \
  --input text='Hello from swamp 👋' \
  --input parseMode=HTML
```

### Send a photo

```bash
# from a local file (uploaded via multipart)
swamp model method run tg-bot sendPhoto \
  --input photo='/Users/me/Pictures/screenshot.png' \
  --input caption='build green'

# or from a public URL
swamp model method run tg-bot sendPhoto \
  --input photo='https://example.com/img.jpg'
```

### Send a document

```bash
swamp model method run tg-bot sendDocument \
  --input document='/path/to/report.pdf' \
  --input caption='nightly report'
```

### Send a rich message

```bash
swamp model method run tg-bot sendRichMessage \
  --input richMessage='{"blocks":[{"type":"paragraph","text":"build green"}]}'
```

Local images go in `files` as `{attachName: localPath}` and are referenced as
`attach://<attachName>` inside blocks.

### Receive updates on swamp serve

Store a random secret, add it to the instance as `webhookSecret`, and register
the route in `.swamp/serve.yaml`:

```yaml
webhooks:
  - route: /hooks/telegram
    workflow: telegram-callback
    secret: "@vault=secrets:telegram-webhook-secret"
    scheme: "@magistr/telegram-webhook"
```

Then point Telegram at it and confirm:

```bash
swamp model method run tg-bot setWebhook --input url=https://serve.example/hooks/telegram
swamp model method run tg-bot getWebhookInfo
```

The scheme checks `X-Telegram-Bot-Api-Secret-Token` in constant time. The bound
workflow gets the raw update plus flat views: `webhook.body.callback` (`id`,
`data`, `kind`, `arg`, `from` — inline-button taps split on the first `:`),
`webhook.body.document` (`fileId`, `fileName`, `mimeType`, `chatId`, `from` —
pass `fileId` to `getFile`), and `webhook.body.magnet` (`url`, `chatId`,
`from`). Serve it over TLS only: a static token has no body integrity.

### Override chat_id per call

Every method accepts an optional `chatId` argument that overrides
`defaultChatId`. Useful for routing a single bot to multiple chats:

```bash
swamp model method run tg-bot sendMessage \
  --input chatId='@my_channel' \
  --input text='channel update'
```

## Arguments

### Global arguments

| Field           | Type     | Required | Notes                                           |
| --------------- | -------- | -------- | ----------------------------------------------- |
| `botToken`      | `string` | yes      | Marked sensitive — store via vault reference.   |
| `defaultChatId` | `string` | no       | Numeric ID, `@channelusername`, or `@username`. |
| `webhookSecret` | `string` | no       | Sensitive. Required by `setWebhook`.            |

### Method arguments

`sendMessage`: `chatId?`, `text`, `parseMode?`, `disableWebPagePreview?`,
`disableNotification?`, `replyToMessageId?`, `replyMarkup?` (object or JSON
string).

`sendPhoto`: `chatId?`, `photo`, `caption?`, `parseMode?`,
`disableNotification?`.

`sendDocument`: `chatId?`, `document`, `caption?`, `parseMode?`,
`disableNotification?`.

`sendVideo`: `chatId?`, `video`, `caption?`, `parseMode?`, `width?`, `height?`,
`disableNotification?`.

`sendRichMessage`: `chatId?`, `richMessage` (JSON), `files?` (JSON map),
`disableNotification?`.

`getFile`: `fileId`, `fileName?`, `mimeType?`.

`setWebhook`: `url`, `dropPendingUpdates?`, `allowedUpdates?`. `deleteWebhook`:
`dropPendingUpdates?`. `getWebhookInfo`: no arguments.

`getMe`: no arguments.

## Outputs

- `botInfo` resource — single instance `main`, written by `getMe`.
- `sentMessage` resource — one instance per Telegram `message_id` (e.g.
  `msg-6423`), written by every `send*` method. Use the `messageId` field in
  `replyToMessageId` on a later call to build a thread.
- `webhookInfo` resource — instance `main`, written by the three webhook
  methods.
- `downloadedFile` resource — one instance per `file_id`, written by `getFile`
  (base64 content; Telegram caps downloads at 20 MB).

## Limits

The Bot API caps payloads at:

- `sendPhoto`: 10 MB per photo.
- `sendDocument`: 50 MB per file (upload); 20 MB per file (download — not
  applicable here).
- Global rate: ~30 messages/sec; 1 msg/sec per chat; 20 msgs/min per group.

This extension does **not** implement retry/backoff — a 429 from Telegram
surfaces as a thrown error from the method.

**Security note:** the bot token is embedded in the Bot API request URL
(`.../bot<token>/<method>`), not the request body. A well-formed API error
response never echoes the token back. A network-layer failure (DNS, TLS,
connection reset) is caught and its message redacted before it reaches the
caller — the `/bot<token>/` URL segment is replaced with `/bot<redacted>/` (a
generic backstop also scrubs any `/bot.../` path segment that reaches the
message reformatted). See `CHANGELOG.md` for details.

## License

MIT — see [LICENSE.md](./LICENSE.md).
