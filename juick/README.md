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

| Argument | Type   | Default                 | Description        |
| -------- | ------ | ----------------------- | ------------------ |
| `apiUrl` | string | `https://api.juick.com` | Juick API base URL |

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
