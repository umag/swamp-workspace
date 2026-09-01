# @magistr/swamp-scoring

Swamp Club scoring tracker — scrapes user profiles and the leaderboard from
swamp-club.com, compares users, tracks scoring deltas, reports top operations,
and sends Telegram alerts.

## Model: `@magistr/swamp-scoring`

### Global Arguments

| Argument         | Type   | Required | Description                                   |
| ---------------- | ------ | -------- | --------------------------------------------- |
| `baseUrl`        | string | no       | Swamp Club base URL (default: swamp-club.com) |
| `users`          | array  | yes      | Users to track `[{username: "..."}]`          |
| `telegramModel`  | string | no       | Telegram send model instance name for alerts  |
| `telegramChatId` | string | no       | Telegram chat ID for alert delivery           |

### Methods

| Method        | Arguments                   | Description                                           |
| ------------- | --------------------------- | ----------------------------------------------------- |
| `sync`        | —                           | Scrape profiles and activity for all configured users |
| `leaderboard` | `board` (default: all-time) | Scrape the public leaderboard                         |
| `compare`     | —                           | Rank tracked users by score and daily rate            |
| `delta`       | —                           | Compute scoring changes since last snapshot           |
| `top-ops`     | `username`                  | Rank operations by total points for a user            |
| `alert`       | `minDelta` (default: 0)     | Send Telegram summary if any delta exceeds threshold  |

### Data Resources

| Resource      | Description                         |
| ------------- | ----------------------------------- |
| `snapshot`    | Per-user profile snapshot           |
| `activity`    | Per-user activity breakdown         |
| `leaderboard` | Leaderboard snapshot                |
| `comparison`  | Cross-user scoring comparison       |
| `delta`       | Scoring changes between snapshots   |
| `top-ops`     | Top operations by points for a user |

## Example

```bash
swamp model create @magistr/swamp-scoring scoring \
  --global-arg 'users=[{"username":"magistr"},{"username":"webframp"}]' \
  --global-arg telegramModel=tg-bot \
  --global-arg telegramChatId=154348275

swamp model @magistr/swamp-scoring method run sync scoring
swamp model @magistr/swamp-scoring method run compare scoring
swamp model @magistr/swamp-scoring method run delta scoring
swamp model @magistr/swamp-scoring method run top-ops scoring --arg username=magistr
swamp model @magistr/swamp-scoring method run alert scoring --arg minDelta=1000
```
