# @magistr/juick

A swamp model for the [Juick.com](https://juick.com) microblogging service. It
wraps Juick's public read-only JSON API (no authentication required) to fetch
feed messages, full comment threads, and user profiles. Its headline capability
is `getUserPosts`, which paginates through a user's entire post history, fetches
the comments for each post, and renders every post as an Obsidian-ready markdown
note (YAML frontmatter, body, attached image, source backlink, and a comments
section). A bundled workflow, `juick-to-obsidian`, chains this model with an
Obsidian vault model to import an account end-to-end.

## Global arguments

| Argument       | Type     | Default                 | Description                                                                                                                                                           |
| -------------- | -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiUrl`       | string   | `https://api.juick.com` | Juick API base URL                                                                                                                                                    |
| `allowedHosts` | string[] | `["api.juick.com"]`     | Default-deny hostname allowlist applied to the request and to every redirect it follows. A custom `apiUrl`'s host must be added here too, or the request is rejected. |
| `timeout`      | number   | `30000`                 | Per-request timeout (ms), applied via `AbortController` to every Juick API fetch (including redirect hops).                                                           |
| `maxPages`     | number   | `1000`                  | Maximum number of pages `getUserPosts` will paginate through before stopping (safety cap against unbounded/stuck pagination).                                         |

## Methods

| Method         | Description                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------- |
| `getMessages`  | Fetch feed messages, optionally filtered by `uname`, `tag`, `search`, or `popular`.          |
| `getThread`    | Fetch a full thread (post + comments) by message id (`mid`).                                 |
| `getUser`      | Fetch a user profile by `uname`.                                                             |
| `getUserPosts` | Fetch ALL posts by a user (paginated) with comments and Obsidian-formatted markdown content. |

## Model instance config

Define an instance in your swamp definitions. `apiUrl` defaults to the public
Juick API, so an empty `globalArguments` block is sufficient:

```yaml
type: "@magistr/juick"
typeVersion: 2026.03.29.1
name: juick
version: 1
tags: {}
globalArguments:
  apiUrl: "https://api.juick.com"
methods: {}
```

If you point `apiUrl` at a host other than the default, add that host to
`allowedHosts` too — every request (and every redirect it follows) is rejected
unless its host is in this list, and a loopback/link-local/ private-range IP
literal is rejected unconditionally regardless of `allowedHosts`:

```yaml
globalArguments:
  apiUrl: "https://juick.example.net"
  allowedHosts:
    - "juick.example.net"
```

## Usage

Run methods directly with the swamp CLI:

```bash
# Get the public feed, filtered by tag
swamp model method run juick getMessages --input tag=music

# Fetch a full thread by message id
swamp model method run juick getThread --input mid=123456

# Look up a user profile
swamp model method run juick getUser --input uname=example-user

# Import a user's full post history as Obsidian markdown
swamp model method run juick getUserPosts \
  --input uname=example-user \
  --input folder=juick \
  --input withComments=true
```

The included `juick-to-obsidian` workflow fans the formatted posts out into an
Obsidian vault model (named `my-vault` in the workflow) one note per post:

```bash
swamp workflow run juick-to-obsidian \
  --input uname=example-user \
  --input folder=juick
```

## License

MIT — see [LICENSE.md](LICENSE.md).
