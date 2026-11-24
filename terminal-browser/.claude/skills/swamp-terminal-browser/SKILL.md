---
name: swamp-terminal-browser
description: Open, inspect and drive terminal-browser (a Chromium browser drawn inside a terminal pane) through the @magistr/terminal-browser swamp model — open it as a side panel next to the agent (herdr/Rex/tmux split), open tabs without duplicates, run agent-browser commands (snapshot, click, fill, eval, get) with the output recorded as swamp data, read the fleet, change settings, shut down or upgrade. Triggers on "terminal-browser", "browser side panel", "open a browser in the terminal", "show this page next to me", "browser in herdr", "split a browser", "snapshot the page", "click in the terminal browser", "@magistr/terminal-browser". Do NOT use for headless scraping or screenshots in CI (no terminal pane to split), or from swamp serve.
---

# swamp-terminal-browser

`@magistr/terminal-browser` wraps the `terminal-browser` CLI. The browser splits
the terminal pane that swamp runs in, so run the model from the terminal next to
the user, never on serve.

## Before you start

1. Check the install with
   `swamp behavior type describe @magistr/terminal-browser --json`. When the CLI
   is missing, the methods fail with the install command:
   `curl -fsSL https://terminal-browser.sh/install | bash`.
2. Find an instance with `swamp behavior list | grep terminal-browser`. The
   usual name is `tb`. When there is none, create it:
   `swamp behavior create @magistr/terminal-browser tb`.
3. Use a workflow when one exists. `tb-open`, `tb-status` and `tb-shutdown` wrap
   these methods. Run a bare method only for interactive exploration.

## Methods

| Method     | Inputs                                                       | Data written                                               |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `status`   | none                                                         | `status`: version, caller tab/pane, browsers[] with tabs[] |
| `open`     | `url?`, `split` (right), `size?` 0.2–0.95, `ssh?`, `reuse`   | `browser`: outcome `opened`, `reused` or `tab-opened`      |
| `new-tab`  | `url`, `browser?`, `dedupe` (true)                           | `browser`: outcome `tab-opened` or `tab-exists`            |
| `action`   | `command[]`, `browser?`, `tab?`, `target?`, `follow`, `name` | `action/<name>`: exitCode, ok, output, truncated           |
| `config`   | `op` list/get/set/unset, `key?`, `value?`                    | `config`: settings, changed                                |
| `shutdown` | none                                                         | `lifecycle/shutdown`                                       |
| `upgrade`  | none                                                         | `lifecycle/upgrade`: before, after                         |

## Recipes

Open a side panel, or reuse the panel already in this terminal tab:

```bash
swamp workflow run tb-open --input url=localhost:3000 --input size=0.4
swamp data query 'behavior("tb") && name == "browser"' --select content
```

Read the page, then act on it. Element refs such as `@e3` come from the
snapshot:

```bash
swamp behavior run tb action --input 'command=["snapshot"]' --input name=snap
swamp data query 'behavior("tb") && name == "snap"' --select content
swamp behavior run tb action --input 'command=["click","@e3"]'
swamp behavior run tb action --input 'command=["eval","document.title"]'
```

Wire the results into a workflow with CEL, for example
`data.latest("tb", "browser").attributes.browser.key` as the `browser` input of
a later `action` step.

## Rules

- **Read the state first.** Run `status` (or a workflow that starts with it)
  before `shutdown`. Shutdown closes every browser, including the one the user
  is reading.
- **Prefer `open` over a second panel.** With `reuse: true` (the default),
  `open` adds a tab to the browser already in this terminal tab. Set
  `reuse: false` only when the user asks for a second panel.
- **One browser, or name it.** `new-tab` and `action` target the single browser
  in the caller's terminal tab. When there are several, pass `browser` with a
  key from `status`.
- **`action` fails loud.** A non-zero exit is first written to data, then the
  run fails. Read `action/<name>` to see the error text.
- **Values that start with `-` are refused.** This applies to urls, config
  values and the action verb, because the CLI would read them as flags.
- **`ssh` changes where requests go.** `open --ssh user@host` sends all network
  traffic through that host. Use it to view a remote `localhost`.
