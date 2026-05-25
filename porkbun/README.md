# @magistr/porkbun

Porkbun DNS record management for [swamp](https://github.com/systeminit/swamp).
Full CRUD over the
[Porkbun DNS API v3](https://porkbun.com/api/json/v3/documentation) for every
common record type: `A`, `AAAA`, `MX`, `CNAME`, `ALIAS`, `TXT`, `NS`, `SRV`,
`TLSA`, `CAA`, `HTTPS`, `SVCB`, and `SSHFP`.

## Model

- `@magistr/porkbun` — credentials-scoped DNS management for a single domain.

## Configuration

The model is scoped to one domain and authenticates with a Porkbun API key pair.
Store the keys in a vault and reference them with vault expressions:

```yaml
type: "@magistr/porkbun"
name: example-dns
globalArguments:
  domain: "example.com"
  apiKey: "${{ vault.get(porkbun, API_KEY) }}"
  secretApiKey: "${{ vault.get(porkbun, SECRET_API_KEY) }}"
```

Enable API access for the domain in the Porkbun control panel first, then mint
an API key + secret key pair under **Account → API Access**.

## Methods

| Method             | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `ping`             | Test credentials and return your public IP address |
| `list`             | List all DNS records for the domain                |
| `get`              | Get records by subdomain + type                    |
| `create`           | Create a new record                                |
| `update`           | Update an existing record by ID                    |
| `delete`           | Delete a record by ID                              |
| `deleteByNameType` | Delete records by subdomain + type                 |

## Usage

Verify credentials:

```bash
swamp model method run example-dns ping
```

Create an `A` record for `www`:

```bash
swamp model method run example-dns create \
  --input subdomain=www --input type=A \
  --input content=203.0.113.10 --input ttl=600
```

List every record, then read the result from the data model:

```bash
swamp model method run example-dns list
swamp data query example-dns dns-records
```

## Notes

- TTL defaults to 600 seconds when omitted.
- `prio` is only meaningful for `MX` and `SRV` records.
- API failures surface the Porkbun error message verbatim.
