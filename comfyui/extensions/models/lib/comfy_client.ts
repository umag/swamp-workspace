export interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

/**
 * A saved output file from a completed prompt. Images, animated gifs and videos
 * all surface in `/history` as `{filename, subfolder, type}` entries under some
 * output key; `collectFiles` gathers them regardless of that key so video
 * (`SaveVideo`) output is picked up the same way as `SaveImage`. `format` is
 * carried through when present (e.g. `video/mp4`).
 */
export interface FileRef extends ImageRef {
  format?: string;
}

export interface HistoryEntry {
  prompt_id?: string;
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs: Record<string, { images?: ImageRef[] } & Record<string, unknown>>;
}

export interface ComfyClientOptions {
  baseUrl: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ComfyClient {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly #fetch: typeof fetch;

  constructor(opts: ComfyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.clientId = opts.clientId ?? crypto.randomUUID();
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  async queuePrompt(graph: Record<string, unknown>): Promise<string> {
    const res = await this.#fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ComfyUI /prompt failed: ${res.status} ${res.statusText} ${text}`
          .trim(),
      );
    }
    let data: { prompt_id?: unknown };
    try {
      data = JSON.parse(text) as { prompt_id?: unknown };
    } catch {
      throw new Error(`ComfyUI /prompt returned invalid JSON: ${text}`);
    }
    if (typeof data.prompt_id !== "string") {
      throw new Error(`ComfyUI /prompt missing prompt_id: ${text}`);
    }
    return data.prompt_id;
  }

  async getHistory(promptId: string): Promise<HistoryEntry | null> {
    const res = await this.#fetch(
      `${this.baseUrl}/history/${encodeURIComponent(promptId)}`,
    );
    if (!res.ok) {
      throw new Error(
        `ComfyUI /history failed: ${res.status} ${res.statusText}`,
      );
    }
    const map = (await res.json()) as Record<string, HistoryEntry>;
    if (!map || typeof map !== "object") return null;
    const entry = map[promptId];
    return entry ?? null;
  }

  /** Fetch a node class's input spec from `/object_info/<classType>`. */
  async fetchObjectInfo(
    classType: string,
  ): Promise<Record<string, unknown>> {
    const res = await this.#fetch(
      `${this.baseUrl}/object_info/${encodeURIComponent(classType)}`,
    );
    if (!res.ok) {
      throw new Error(
        `ComfyUI /object_info failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * The set of node class names installed on the server (`/object_info` keys).
   * Used to skip optional patchers whose custom node isn't installed, so a
   * churning node set doesn't break a render with a `missing_node_type` error.
   */
  async fetchInstalledClasses(): Promise<Set<string>> {
    const res = await this.#fetch(`${this.baseUrl}/object_info`);
    if (!res.ok) {
      throw new Error(
        `ComfyUI /object_info failed: ${res.status} ${res.statusText}`,
      );
    }
    const info = await res.json() as Record<string, unknown>;
    return new Set(Object.keys(info ?? {}));
  }

  collectImages(entry: HistoryEntry): ImageRef[] {
    const images: ImageRef[] = [];
    const outputs = entry.outputs ?? {};
    for (const nodeId of Object.keys(outputs)) {
      const node = outputs[nodeId];
      if (node && Array.isArray(node.images)) {
        for (const img of node.images) {
          images.push(img);
        }
      }
    }
    return images;
  }

  /**
   * Every saved file across all output nodes, regardless of the output key.
   * Scans each output node's array values and keeps entries shaped like a file
   * ref (a string `filename` and `type`) — so images (`images`), gifs (`gifs`)
   * and videos (`SaveVideo`, whatever key it uses) are all collected uniformly.
   */
  collectFiles(entry: HistoryEntry): FileRef[] {
    const files: FileRef[] = [];
    const outputs = entry.outputs ?? {};
    for (const nodeId of Object.keys(outputs)) {
      const node = outputs[nodeId];
      if (!node || typeof node !== "object") continue;
      for (const value of Object.values(node)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          if (
            item && typeof item === "object" &&
            typeof (item as FileRef).filename === "string" &&
            typeof (item as FileRef).type === "string"
          ) {
            const f = item as FileRef;
            files.push({
              filename: f.filename,
              subfolder: typeof f.subfolder === "string" ? f.subfolder : "",
              type: f.type,
              ...(typeof f.format === "string" ? { format: f.format } : {}),
            });
          }
        }
      }
    }
    return files;
  }

  viewUrl(ref: ImageRef): string {
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type,
    });
    return `${this.baseUrl}/view?${params.toString()}`;
  }

  async fetchImage(ref: ImageRef): Promise<Uint8Array> {
    const res = await this.#fetch(this.viewUrl(ref));
    if (!res.ok) {
      throw new Error(
        `ComfyUI /view failed: ${res.status} ${res.statusText}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Upload an image to the server's input directory via `POST /upload/image`,
   * returning the server-side `{name, subfolder, type}`. A `LoadImage` node then
   * references it by `name` (or `subfolder/name` when a subfolder is set). Used
   * to get a local reference image onto the server before a reference-to-video
   * run. `overwrite` defaults to true so re-runs reuse the same filename.
   */
  async uploadImage(
    bytes: Uint8Array,
    filename: string,
    opts: { subfolder?: string; overwrite?: boolean } = {},
  ): Promise<{ name: string; subfolder: string; type: string }> {
    const form = new FormData();
    form.append(
      "image",
      new Blob([bytes as BlobPart]),
      filename,
    );
    form.append("overwrite", String(opts.overwrite ?? true));
    if (opts.subfolder) form.append("subfolder", opts.subfolder);
    const res = await this.#fetch(`${this.baseUrl}/upload/image`, {
      method: "POST",
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ComfyUI /upload/image failed: ${res.status} ${res.statusText} ${text}`
          .trim(),
      );
    }
    let data: { name?: unknown; subfolder?: unknown; type?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new Error(`ComfyUI /upload/image returned invalid JSON: ${text}`);
    }
    if (typeof data.name !== "string") {
      throw new Error(`ComfyUI /upload/image missing name: ${text}`);
    }
    return {
      name: data.name,
      subfolder: typeof data.subfolder === "string" ? data.subfolder : "",
      type: typeof data.type === "string" ? data.type : "input",
    };
  }

  async waitForResult(
    promptId: string,
    opts: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<HistoryEntry> {
    const pollIntervalMs = opts.pollIntervalMs ?? 1000;
    const timeoutMs = opts.timeoutMs ?? 120000;
    const sleep = opts.sleep ?? defaultSleep;
    const start = Date.now();

    while (true) {
      const entry = await this.getHistory(promptId);
      if (entry) {
        const files = this.collectFiles(entry);
        const errored = entry.status?.status_str === "error";
        if (errored && files.length === 0) {
          throw new Error(
            `ComfyUI render failed for prompt ${promptId} (status: ${entry.status?.status_str})`,
          );
        }
        const done = entry.status?.completed === true || files.length > 0;
        if (done) return entry;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `ComfyUI waitForResult timed out after ${timeoutMs}ms for prompt ${promptId}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }
}
