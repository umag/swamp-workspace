# @magistr/terminal-browser

Manage [terminal-browser](https://terminal-browser.com) from swamp.
terminal-browser is a real Chromium browser that renders inside a terminal pane.
It supports herdr, Rex, Ghostty, Kitty, tmux and other terminals. When it opens,
it splits the pane it was started from. Many agent tools also drive it through
an agent-browser compatible CLI.

This model records the browser fleet as swamp data. It opens the browser as a
side panel next to the pane where swamp runs, and it drives tabs with snapshot,
click, fill and eval commands.

## Install terminal-browser

```bash
curl -fsSL https://terminal-browser.sh/install | bash
```

The installer puts the launcher in `~/.local/bin`. The model finds it there when
the directory is not on swamp's `PATH`.

## Methods

| Method     | What it does                                                                               |
| ---------- | ------------------------------------------------------------------------------------------ |
| `status`   | Records the installed version and every running browser with its tabs.                     |
| `open`     | Opens a browser as a split of the caller's terminal tab. Reuses one already open there.    |
| `new-tab`  | Opens a url in a running browser. Skips the url when a tab already shows it.               |
| `action`   | Runs one agent-browser command (`snapshot`, `click @e3`, `eval …`) and records its output. |
| `config`   | Lists, gets, sets or unsets a setting. `set` skips when the value is already in place.     |
| `shutdown` | Stops the shared browser daemon. When no browser runs, it records a no-op.                 |
| `upgrade`  | Upgrades terminal-browser and records the version before and after.                        |

Every mutating method reads state first, so you can run any method again without
side effects.

## Usage

```bash
swamp extension pull @magistr/terminal-browser
swamp behavior create @magistr/terminal-browser tb

# side panel on the right, 40% wide
swamp behavior run tb open --input url=localhost:3000 --input size=0.4

# drive it
swamp behavior run tb action --input 'command=["snapshot"]'
swamp data query 'behavior("tb") && name == "last"' --select content
```

A workflow that reads state before it opens the panel:

```yaml
jobs:
  - name: main
    steps:
      - name: read-state
        task: { type: model_method, modelIdOrName: tb, methodName: status }
        dependsOn: []
      - name: open
        task:
          type: model_method
          modelIdOrName: tb
          methodName: open
          inputs: { url: "${{ inputs.url }}", split: right, size: 0.4 }
        dependsOn:
          - step: read-state
            condition: { type: succeeded }
```

## Limits

- **Local only.** The browser splits the terminal pane that swamp runs in. Run
  the model from a terminal. `swamp serve` has no terminal to split.
- **Only `ls` scopes to the caller.** `ls` without `--all` lists only the
  browsers in the caller's terminal tab. `open` and `new-tab` rely on this
  scope, so they reuse the browser next to you and not a browser in another tab.
- **No shell.** The model calls the CLI through `Deno.Command`, never through a
  shell. The model refuses a url, value or command name that starts with `-`,
  because the CLI would read it as a flag.

## License

MIT, see [LICENSE.md](LICENSE.md).
