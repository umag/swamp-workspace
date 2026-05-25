# @magistr/homeassistant

A swamp model for the [Home Assistant](https://www.home-assistant.io/) REST and
WebSocket APIs. Query entity states, call services, inspect and update
automations, and pull historical state data and long-term sensor statistics —
all written back as typed, queryable swamp resources.

## Configuration

The model takes three global arguments. Store the long-lived access token in a
vault and reference it; never inline the token.

```yaml
type: "@magistr/homeassistant"
typeVersion: 2026.05.25.1
name: home
globalArguments:
  host: "homeassistant.example.com"
  token: "${{ vault.get(home-assistant, HA_TOKEN) }}"
  protocol: "https"
methods: {}
```

| Argument   | Required | Description                                      |
| ---------- | -------- | ------------------------------------------------ |
| `host`     | yes      | Host (e.g. `homeassistant.example.com` or an IP) |
| `token`    | yes      | Long-lived access token (use a vault reference)  |
| `protocol` | no       | `http` or `https` (default `https`)              |

Create the vault and store the token:

```bash
swamp vault create local_encryption home-assistant --json
swamp vault put home-assistant HA_TOKEN=eyJhbGci... -f --json
```

## Methods

| Method                  | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `list-entities`         | List all entities, optionally filtered by domain or search        |
| `get-state`             | Current state and attributes of one entity                        |
| `call-service`          | Call a service (e.g. `light.turn_on`, `switch.toggle`)            |
| `list-services`         | List available services, optionally filtered by domain            |
| `list-automations`      | List automations with state, last-triggered, and id               |
| `get-automation-config` | Full config of an automation by its id                            |
| `update-automation`     | Write a new config for an existing automation                     |
| `get-history`           | Historical state points for an entity (JSON + CSV resources)      |
| `get-statistics`        | Long-term statistics via the WebSocket recorder API               |
| `backfill-to-vm`        | Bulk-import HA statistics into VictoriaMetrics (`/api/v1/import`) |

## Usage

```bash
# List all light entities
swamp model method run home list-entities --input domain=light

# Get a single entity's state
swamp model method run home get-state \
  --input entityId=sensor.living_room_temperature

# Turn on a light
swamp model method run home call-service \
  --input domain=light --input service=turn_on \
  --input entityId=light.kitchen_lamp

# Fetch a month of history (JSON + CSV resources)
swamp model method run home get-history \
  --input entityId=sensor.living_room_temperature \
  --input startTime=2026-04-01T00:00:00Z \
  --input endTime=2026-05-01T00:00:00Z
```

Every method writes a typed resource, so results can be inspected with
`swamp data` and referenced from CEL expressions in workflows. For example, the
`get-history` method emits both a structured `history` resource and a
`history-csv` resource ready for export.

## Backfill to VictoriaMetrics

`backfill-to-vm` pulls long-term statistics for a list of entities and bulk
imports them into a VictoriaMetrics instance so historical data sits alongside
live scrapes. Point it at your own VM endpoint with the `vmUrl` argument (it
defaults to a documentation-only placeholder such as
`http://203.0.113.10:8428`).

## License

MIT — see [LICENSE.md](LICENSE.md).
