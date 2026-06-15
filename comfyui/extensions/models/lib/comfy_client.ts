export interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
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
        const done = entry.status?.completed === true ||
          this.collectImages(entry).length > 0;
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
