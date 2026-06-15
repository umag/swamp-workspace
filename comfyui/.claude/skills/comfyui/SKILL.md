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
  `high_level_description`,
  `compositional_deconstruction{background, elements}`.

A well-formed caption (the shape both `generate_caption` and `build_caption`
emit and validate):

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

Global args: `baseUrl` (default `http://127.0.0.1:8188`; set to your server),
`clientId?`, `workflowPath?` (host path to an **API-format** workflow JSON),
`outputDir` (default `./out`), `pollIntervalMs`, `timeoutMs`, and for
`generate_caption`: `anthropicApiKey` (set via a vault ref), `captionModel`
(default `claude-sonnet-4-20250514`), `captionMaxTokens`.

| Method             | What it does                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookup` / `sync`  | GET `/system_stats` → `server` resource snapshot                                                                                                              |
| `generate_caption` | idea + aspectRatio → Claude (Anthropic Messages API, same contract as `@keeb/anthropic`) → validated caption → `caption` resource                             |
| `build_caption`    | assemble + validate a caption from explicit `summary`/`style`/`background`/`objects[{bbox,desc}]` (you supply the boxes) → `caption` resource                 |
| `generate`         | patch `caption`/`seed`/`resolution` into an API-format graph by node id → POST `/prompt` → poll `/history` → GET `/view` → save image → `generation` resource |

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
the UI (or use ComfyUI's _Export (API)_ menu). In the Ideogram-4 template the
caption node is `CLIPTextEncode` (flattened id `98:24`, input `text`) and the
seed is `RandomNoise` (`98:18`, input `noise_seed`).

## Typical flow

1. `lookup` / `sync` first — confirms the server is up (writes the `server`
   resource). If it errors, the ComfyUI server is unreachable; start it (default
   `:8188`) before going further.
2. `generate_caption` (idea → caption) **or** `build_caption` (explicit boxes).
3. **Validate before you generate.** Both caption methods reject a malformed
   caption at build time (bbox not `[y1,x1,y2,x2]` / out of 0–1000 / `y1≥y2` or
   `x1≥x2`, a `text` element missing its `text`). Confirm the `caption` resource
   was written before step 5 — a rejected caption never reaches `generate`.
4. Read the caption text from the `caption` resource (CEL:
   `data.latest("mycomfy","caption").attributes.text`).
5. `generate` with that caption text + the caption/seed node ids + the
   API-format `workflow`.

## Errors & recovery

- **Server down** → `lookup`/`sync` fails fast on `GET /system_stats`; start
  ComfyUI and retry. Don't call `generate` against a dead server.
- **`generate` 400 with `node_errors`** → the API-format graph or the
  `captionNodeId`/`seedNodeId` are wrong (e.g. a UI-format workflow, or stale
  node ids). The client surfaces the `node_errors` text; fix the graph/ids (see
  the API-format gotcha above) and retry. This is the most common failure.
- **Poll timeout (`timeoutMs`)** → the prompt was queued but didn't finish in
  time; check the ComfyUI queue/console, then raise `timeoutMs` or
  `pollIntervalMs`.
- **`generate_caption` validation throw** → Claude returned a caption that fails
  the contract; re-run (often transient) or fall back to `build_caption` with
  explicit boxes.
