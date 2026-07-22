# @magistr/comfyui

Drive a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server from swamp.
Ships two bundled **API-format** workflow templates so you generate images
without hand-wiring node ids:

- **`ideogram`** (default) — the local **Ideogram 4.0** model, whose prompt is a
  **structured JSON caption** with per-object **bounding boxes**, so you can
  place named objects and text in precise regions of the frame.
- **`krea`** — **FLUX Krea turbo**, a plain-text prompt with stackable **style
  LoRAs**.

The full path: a natural-language idea → a validated caption (via Claude) or a
hand-assembled one → a patched ComfyUI workflow → a rendered image, all inside
swamp.

## Install

```bash
swamp extension pull @magistr/comfyui
swamp model @magistr/comfyui/instance create mycomfy \
  --global-arg 'baseUrl=http://192.0.2.10:8188' \
  --global-arg 'anthropicApiKey=${{ vault.get(hashi, ANTHROPIC_API_KEY) }}'
```

`anthropicApiKey` (only needed for `generate_caption`) accepts a standard
Anthropic API key **or** a Claude Code OAuth token (`sk-ant-oat…`).

## Quick start

```bash
# Ideogram (structured caption + bbox placement)
swamp model method run mycomfy build_caption \
  --input summary="a cozy retro travel poster of a mountain cabin, title SWAMP" \
  --input-file caption.yaml            # background/style/objects[{bbox,desc}]
swamp model method run mycomfy generate \
  --input template=ideogram \
  --input "caption=$(swamp data get mycomfy caption --json | jq -r .content.text)" \
  --input 'resolution=9:16 (Portrait Widescreen)'

# Krea (plain-text prompt + a style LoRA), random seed each run
swamp model method run mycomfy generate \
  --input template=krea \
  --input lora=krea2_softwatercolor \
  --input 'resolution=3:2 (Photo)' \
  --input 'caption=art deco watercolor style. a fox curled up asleep in tall grass'

# A batch of variations (one image per seed)
swamp model method run mycomfy generate_batch \
  --input template=krea --input count=6 \
  --input 'caption=a lighthouse at dusk, dramatic clouds'
```

Saved image path(s) land in the `generation` (single) or `batch` resource.

## Model: `@magistr/comfyui/instance`

Global args: `baseUrl` (default `http://127.0.0.1:8188`), `clientId?`,
`workflowPath?` (host path to an API-format workflow JSON, overrides the bundled
template), `outputDir` (default `./out`), `pollIntervalMs`, `timeoutMs`, and for
`generate_caption`: `anthropicApiKey`, `captionModel`, `captionMaxTokens`.

| Method             | Description                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lookup` / `sync`  | Snapshot the server (`/system_stats`) into a `server` resource.                                                                                  |
| `node_info`        | Fetch a node class's input spec from `/object_info` (e.g. the valid `aspect_ratio` combo values) into a `node_info` resource.                    |
| `build_caption`    | Assemble + validate an Ideogram caption from explicit `summary`/`style`/`background`/`objects[{bbox,desc}]` → `caption` resource.                |
| `generate_caption` | Idea + aspect ratio → Claude (Anthropic Messages API) using the Ideogram-4 magic prompt → a validated caption → `caption` resource.              |
| `generate`         | Pick a bundled `template`, patch caption/seed/resolution (+ any LoRA), POST `/prompt`, poll `/history`, fetch the image → `generation` resource. |
| `generate_batch`   | Same as `generate` but queues many prompts that vary only by seed (`count` random, or explicit `seeds`), fetches them all → `batch` resource.    |

## Templates

`generate`/`generate_batch` take a `template` name; each maps the caption / seed
/ resolution to the right node ids automatically (override with explicit
`*NodeId`/`*InputKey` args, an inline `workflow`, or `workflowPath`).

| template             | prompt style                         | resolution     | LoRAs |
| -------------------- | ------------------------------------ | -------------- | ----- |
| `ideogram` (default) | structured JSON caption + **bboxes** | `aspect_ratio` | —     |
| `krea`               | **plain text** (bboxes ignored)      | `aspect_ratio` | yes   |

Valid `resolution` values (from `node_info ResolutionSelector`): `1:1 (Square)`,
`2:3 (Portrait Photo)`, `3:2 (Photo)`, `3:4 (Portrait Standard)`,
`4:3 (Standard)`, `9:16 (Portrait Widescreen)`, `16:9 (Widescreen)`,
`21:9 (Ultrawide)`.

## Seeds

Pass `--input seed=<n>` for a fixed seed. **Omit it and `generate` picks a
random seed**, recorded in the result (`generation`/`batch` `.seed`/`.seeds`) so
a run stays reproducible. `generate_batch` uses `seeds: [<n>,…]` if given, else
`count` random seeds (default 4).

## Style LoRAs (Krea)

Krea gates its LoRA behind a switch, and multiple LoRAs are chained
automatically:

```bash
# one LoRA
--input lora=krea2_darkbrush --input loraStrength=1.0
# stack several (align strengths by index, or one strength for all)
--input 'loras=["krea2_vintagetarot","krea2_softwatercolor"]' \
--input 'loraStrengths=[1.0,0.6]'
```

Names take an optional `.safetensors` suffix. Put each LoRA's trigger words in
the caption. List installed LoRAs with
`node_info --input classType=LoraLoaderModelOnly`.

## The caption / bbox contract (Ideogram)

A caption is single-line JSON with three top-level keys — `aspect_ratio`,
`high_level_description`, and `compositional_deconstruction` (`background` +
`elements[]`). Each element is an `obj` or `text` element with an optional
**`bbox: [y1, x1, y2, x2]`** (Y-first), integers normalized **0–1000**, top-left
origin (`y1<y2`, `x1<x2`). Omit the bbox for crowds, skies, or scattered detail.
`text` elements carry the verbatim characters to render. A reversed axis is
repaired; a zero-area box is dropped rather than failing the whole caption.
**Krea ignores bboxes** — give it a plain descriptive prompt.

## Bundled workflows / bring your own

The bundled `workflows/*.api.json` graphs are ready to run; their example prompt
text is a neutral placeholder (it's overwritten at generation time). To use your
own graph, export the flattened **API format** from ComfyUI (Settings → enable
Dev mode → workflow menu → **Export (API)** — a _saved_ UI-format workflow with
subgraphs cannot be POSTed to `/prompt`) and pass it via `workflowPath` or the
inline `workflow` arg with explicit `*NodeId` args.

## Development

```bash
deno task test    # deno test -A
deno task check   # type check
deno task fmt
deno task lint
```

See the bundled `comfyui` skill for in-context guidance. MIT licensed.
