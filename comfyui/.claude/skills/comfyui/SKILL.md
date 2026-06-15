---
name: comfyui
description: Drive a ComfyUI server from swamp via the @magistr/comfyui/instance model — generate images with the local Ideogram 4.0 text-to-image model whose prompt is a STRUCTURED JSON CAPTION with per-object bounding boxes. Turn a plain idea into a bboxed caption with Claude (generate_caption), validate/assemble one by hand (build_caption), patch+queue a workflow and fetch the image (generate), or snapshot the server (lookup/sync). Triggers on "comfyui", "ideogram", "ideogram 4", "generate image", "text to image", "bounding box prompt", "bbox caption", "structured caption", "@magistr/comfyui", "drive comfyui", "queue prompt", "comfyui workflow".
---

# @magistr/comfyui

Drives a ComfyUI server over its HTTP API. Built for the **local Ideogram 4.0**
text-to-image model, whose prompt is a **structured JSON caption**: a scene
summary plus a `compositional_deconstruction` whose `elements[]` each carry a
**bounding box** and description.

## The bbox/caption contract (important)

- A caption element bbox is **`[y1, x1, y2, x2]`** (Y-first), **integers
  normalized 0–1000**, top-left origin, with `y1<y2` and `x1<x2`. The bbox is
  **optional** per element (omit it for crowds/skies/scattered detail).
- Two element types: `obj` (a subject) and `text` (carries a verbatim `text`
  string). One coherent subject = one `obj` element; never split a subject into
  its parts.
- The generator emits three top-level keys: `aspect_ratio`,
  `high_level_description`, `compositional_deconstruction{background, elements}`.

## Model: `@magistr/comfyui/instance`

Global args: `baseUrl` (default `http://127.0.0.1:8188`; set to your server),
`clientId?`,
`workflowPath?` (host path to an **API-format** workflow JSON), `outputDir`
(default `./out`), `pollIntervalMs`, `timeoutMs`, and for `generate_caption`:
`anthropicApiKey` (set via a vault ref), `captionModel`
(default `claude-sonnet-4-20250514`), `captionMaxTokens`.

| Method | What it does |
|--------|--------------|
| `lookup` / `sync` | GET `/system_stats` → `server` resource snapshot |
| `generate_caption` | idea + aspectRatio → Claude (Anthropic Messages API, same contract as `@keeb/anthropic`) → validated caption → `caption` resource |
| `build_caption` | assemble + validate a caption from explicit `summary`/`style`/`background`/`objects[{bbox,desc}]` (you supply the boxes) → `caption` resource |
| `generate` | patch `caption`/`seed`/`resolution` into an API-format graph by node id → POST `/prompt` → poll `/history` → GET `/view` → save image → `generation` resource |

```bash
# idea → bboxed caption (Claude); set anthropicApiKey via a vault ref
swamp model method run mycomfy generate_caption --input idea="a cozy retro travel poster of a mountain cabin, title SWAMP" --input aspectRatio=9:16
# caption → image (needs the API-format graph + the caption/seed node ids)
swamp model method run mycomfy generate --input caption@... --input captionNodeId=98:24 --input seed=77777 --input seedNodeId=98:18 --input workflow@graph.json
```

## Getting the API-format workflow graph (gotcha)

ComfyUI's **saved** workflows are UI-format with subgraphs and **cannot** be
POSTed to `/prompt`. Get the flattened **API-format** graph from
`GET {baseUrl}/history` → `entry.prompt[2]` after running the workflow once in
the UI (or use ComfyUI's *Export (API)* menu). In the Ideogram-4 template the
caption node is `CLIPTextEncode` (flattened id `98:24`, input `text`) and the
seed is `RandomNoise` (`98:18`, input `noise_seed`).

## Typical flow

1. `generate_caption` (idea → caption) **or** `build_caption` (explicit boxes).
2. Read the caption text from the `caption` resource (CEL:
   `data.latest("mycomfy","caption").attributes.text`).
3. `generate` with that caption text + the caption/seed node ids + the
   API-format `workflow`.
