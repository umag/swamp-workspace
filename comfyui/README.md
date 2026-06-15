# @magistr/comfyui

Drive a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server from swamp.
Built for the local **Ideogram 4.0** text-to-image model, whose prompt is a
**structured JSON caption** with per-object **bounding boxes** — so you can
place named objects and text in precise regions of the frame.

The full path is: a natural-language idea → a validated bbox'd caption (via
Claude) → a patched ComfyUI workflow → a rendered image, all inside swamp.

## Install

```bash
swamp extension pull @magistr/comfyui
swamp model @magistr/comfyui/instance create mycomfy \
  --global-arg 'baseUrl=http://192.0.2.10:8188' \
  --global-arg 'anthropicApiKey=${{ vault.get(hashi, ANTHROPIC_API_KEY) }}'
```

`anthropicApiKey` accepts a standard Anthropic API key **or** a Claude Code
OAuth token (`sk-ant-oat…`); the client auto-selects `x-api-key` vs OAuth Bearer
auth.

## Quick start — idea → image

```bash
# 1. Turn an idea into a validated, bbox'd Ideogram-4 caption (Claude).
swamp model method run mycomfy generate_caption \
  --input idea="a retro travel poster of a pine mire at golden hour, title 'KARELIA'" \
  --input aspectRatio=3:2

# 2. Render it. Pass the API-format workflow graph + the caption/seed node ids.
#    (caption text comes from the `caption` resource written in step 1.)
swamp model method run mycomfy generate \
  --input "caption=$(swamp data get mycomfy caption --json | jq -r .content.text)" \
  --input captionNodeId=98:24 \
  --input seed=42 --input seedNodeId=98:18 \
  --input resolution='3:2 (Photo)' --input resolutionNodeId=37 \
  --stdin <<<'{"workflow": <API-format graph> }'
```

The saved image path(s) land in the `generation` resource
(`swamp data get mycomfy generation --json`).

## Model: `@magistr/comfyui/instance`

Global args: `baseUrl` (default `http://127.0.0.1:8188`; set to your ComfyUI
server, e.g. `http://192.0.2.10:8080`), `clientId?`, `workflowPath?` (host path
to an **API-format** workflow JSON), `outputDir` (default `./out`),
`pollIntervalMs`, `timeoutMs`, and for `generate_caption`: `anthropicApiKey`,
`captionModel` (default `claude-sonnet-4-6`), `captionMaxTokens`.

| Method             | Description                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookup` / `sync`  | Snapshot the server (`/system_stats`) into a `server` resource.                                                                                                                   |
| `generate_caption` | Idea + aspect ratio → Claude (Anthropic Messages API, same request contract as `@keeb/anthropic`) using the Ideogram-4 magic prompt → a validated caption → `caption` resource.   |
| `build_caption`    | Assemble + validate a caption from explicit `summary`/`style`/`background`/`objects[{bbox,desc}]` — you supply the boxes.                                                         |
| `generate`         | Patch `caption`/`seed`/`resolution` into an API-format workflow graph by node id → POST `/prompt` → poll `/history` → fetch the image via `/view` → save → `generation` resource. |

## The caption / bbox contract

A generated caption is single-line JSON with three top-level keys —
`aspect_ratio`, `high_level_description`, and `compositional_deconstruction`
(`background` + `elements[]`). Each element is an `obj` or `text` element with
an optional **`bbox: [y1, x1, y2, x2]`** (Y-first), integers normalized
**0–1000**, top-left origin (`y1<y2`, `x1<x2`). The bbox is optional per element
— omit it for crowds, skies, or scattered detail. `text` elements carry the
verbatim characters to render.

Bboxes from Claude are validated; a reversed axis is repaired (sorted) and a
zero-area box is dropped rather than failing the whole caption.

## Getting the API-format workflow graph

ComfyUI's _saved_ workflows are UI-format (with subgraphs) and **cannot** be
POSTed to `/prompt`. Fetch the flattened **API-format** graph from
`GET {baseUrl}/history` → `entry.prompt[2]` after one UI run, or use ComfyUI's
_Export (API)_ menu. In the Ideogram-4 template the caption node is
`CLIPTextEncode` (flattened id `98:24`, input `text`), the seed is `RandomNoise`
(`98:18`), and the aspect is `ResolutionSelector` (`37`, input `aspect_ratio`).

## Development

```bash
deno task test    # deno test -A
deno task check   # type check
deno task fmt
deno task lint
```

See the bundled `comfyui` skill for in-context guidance. MIT licensed.
