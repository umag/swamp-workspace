---
name: comfyui
description: Drive a ComfyUI server from swamp via the @magistr/comfyui/instance model. Ships two bundled workflow templates — `ideogram` (Ideogram 4.0, STRUCTURED JSON CAPTION with per-object bounding boxes) and `krea` (FLUX Krea turbo, plain-text prompt + stackable style LoRAs). Turn an idea into a bboxed caption with Claude (generate_caption), assemble one by hand (build_caption), render one image (generate) or a batch by seed (generate_batch), inspect a node class (node_info), or snapshot the server (lookup/sync). Triggers on "comfyui", "ideogram", "krea", "flux krea", "generate image", "text to image", "image batch", "style lora", "bounding box prompt", "bbox caption", "@magistr/comfyui", "drive comfyui", "queue prompt", "comfyui workflow".
---

# @magistr/comfyui

Drives a ComfyUI server over its HTTP API. Two bundled **API-format** workflow
templates, picked by name so you never hand-wire node ids:

- **`ideogram`** (default) — local **Ideogram 4.0**, prompt = a **structured
  JSON caption** whose `compositional_deconstruction.elements[]` each carry a
  **bounding box**.
- **`krea`** — **FLUX Krea turbo**, a **plain-text** prompt (bboxes ignored)
  with stackable **style LoRAs**.

## The bbox/caption contract (Ideogram)

- A caption element bbox is **`[y1, x1, y2, x2]`** (Y-first), **integers
  normalized 0–1000**, top-left origin, `y1<y2` and `x1<x2`. Optional per
  element (omit for crowds/skies/scattered detail).
- Two element types: `obj` (a subject) and `text` (carries a verbatim `text`
  string). One coherent subject = one `obj`; never split a subject into parts.
- Three top-level keys: `aspect_ratio`, `high_level_description`,
  `compositional_deconstruction{background, elements}`.

```json
{
  "aspect_ratio": "9:16",
  "high_level_description": "retro travel poster of a mountain cabin at dusk, title SWAMP",
  "compositional_deconstruction": {
    "background": "deep teal dusk sky fading to orange over the peaks",
    "elements": [
      {
        "type": "obj",
        "bbox": [380, 250, 760, 720],
        "description": "a wooden cabin, warm lit windows"
      },
      { "type": "obj", "description": "scattered pine forest along the ridge" },
      {
        "type": "text",
        "bbox": [800, 200, 920, 800],
        "text": "SWAMP",
        "description": "bold condensed title"
      }
    ]
  }
}
```

## Model: `@magistr/comfyui/instance`

Global args: `baseUrl` (default `http://127.0.0.1:8188`), `clientId?`,
`workflowPath?` (host path to an API-format graph; overrides the bundled
template), `outputDir` (default `./out`), `pollIntervalMs`, `timeoutMs`, and for
`generate_caption`: `anthropicApiKey` (vault ref), `captionModel`,
`captionMaxTokens`.

| Method             | What it does                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `lookup` / `sync`  | GET `/system_stats` → `server` resource snapshot                                                                |
| `node_info`        | GET `/object_info/<classType>` → `node_info` resource (valid combos, e.g. ResolutionSelector aspect ratios)     |
| `build_caption`    | assemble + validate a caption from explicit `summary`/`style`/`background`/`objects[{bbox,desc}]` → `caption`   |
| `generate_caption` | idea + aspectRatio → Claude (Anthropic Messages API) → validated caption → `caption`                            |
| `generate`         | pick `template`, patch caption/seed/resolution (+LoRA) → POST `/prompt` → poll `/history` → save → `generation` |
| `generate_batch`   | queue many prompts varying only by seed (`count` random, or `seeds[]`) → save all → `batch`                     |

```bash
# idea → caption (Claude); then render with the ideogram template
swamp model method run mycomfy generate_caption --input idea="a cozy retro travel poster of a mountain cabin, title SWAMP" --input aspectRatio=9:16
swamp model method run mycomfy generate --input template=ideogram --input caption@caption.txt --input 'resolution=9:16 (Portrait Widescreen)'

# Krea: plain-text prompt + a style LoRA, random seed
swamp model method run mycomfy generate --input template=krea --input lora=krea2_softwatercolor --input 'caption=art deco watercolor style. a fox asleep in tall grass'

# a batch of 6 variations
swamp model method run mycomfy generate_batch --input template=krea --input count=6 --input 'caption=a lighthouse at dusk'
```

## Templates, seeds, LoRAs

- **template**: `ideogram` (bboxes honored) or `krea` (plain text). Each maps
  caption/seed/resolution node ids automatically; override with explicit
  `*NodeId`/`*InputKey`, an inline `workflow`, or `workflowPath`.
- **resolution**: an aspect-ratio combo string — list them with
  `node_info --input classType=ResolutionSelector` (e.g. `3:2 (Photo)`,
  `16:9 (Widescreen)`, `9:16 (Portrait Widescreen)`).
- **seed**: omit `seed` for a random one (recorded in `generation`/`batch`);
  pass `seed=<n>` to fix it. `generate_batch` takes `seeds:[…]` or `count`.
- **LoRAs (krea)**: `lora=<name>` + `loraStrength`, or stack with
  `loras=["a","b"]` (+ `loraStrengths=[…]`). List installed with
  `node_info --input classType=LoraLoaderModelOnly`. Put trigger words in the
  caption.

## Typical flow

1. `lookup`/`sync` first — confirms the server is up. If it errors, start
   ComfyUI (default `:8188`) before going further.
2. `generate_caption` (idea → caption) **or** `build_caption` (explicit boxes)
   for Ideogram; for Krea just write a plain-text prompt.
3. **Validate before you generate.** Both caption methods reject a malformed
   caption (bad bbox / out of 0–1000 / reversed axis / `text` missing its text).
   Confirm the `caption` resource exists before generating.
4. `generate` (one) or `generate_batch` (many) with the caption + `template` (+
   `lora`/`resolution`/`seed`). Read the saved path(s) from the
   `generation`/`batch` resource.

## Errors & recovery

- **Server down** → `lookup`/`sync` fails fast on `/system_stats`; start
  ComfyUI.
- **`generate` 400 with `node_errors`** → wrong graph or node ids (a UI-format
  workflow, stale ids, or a bad `template`). The client surfaces `node_errors`;
  fix and retry. Most common failure.
- **Poll timeout (`timeoutMs`)** → queued but not finished in time; check the
  ComfyUI queue/console, then raise `timeoutMs`/`pollIntervalMs`.
- **`generate_caption` validation throw** → Claude returned an off-contract
  caption; re-run (often transient) or fall back to `build_caption`.
