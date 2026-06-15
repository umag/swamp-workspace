import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { describe, it } from "jsr:@std/testing@1/bdd";
import { assertSpyCalls, spy } from "jsr:@std/testing@1/mock";
import {
  ComfyClient,
  type HistoryEntry,
  type ImageRef,
} from "./comfy_client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("ComfyClient construction", () => {
  it("strips a trailing slash from baseUrl", () => {
    const c = new ComfyClient({
      baseUrl: "http://host:8081/",
      fetchImpl: fetch,
    });
    assertEquals(c.baseUrl, "http://host:8081");
  });

  it("strips multiple trailing slashes", () => {
    const c = new ComfyClient({
      baseUrl: "http://host:8081///",
      fetchImpl: fetch,
    });
    assertEquals(c.baseUrl, "http://host:8081");
  });

  it("defaults clientId to a uuid", () => {
    const c = new ComfyClient({ baseUrl: "http://host", fetchImpl: fetch });
    assertEquals(UUID_RE.test(c.clientId), true);
  });

  it("allows overriding clientId", () => {
    const c = new ComfyClient({
      baseUrl: "http://host",
      clientId: "abc",
      fetchImpl: fetch,
    });
    assertEquals(c.clientId, "abc");
  });
});

describe("queuePrompt", () => {
  it("posts to /prompt with {prompt, client_id} and returns prompt_id", async () => {
    const fetchSpy = spy((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({ prompt_id: "pid-1", number: 1, node_errors: {} }),
      )
    );
    const c = new ComfyClient({
      baseUrl: "http://host:8081",
      clientId: "cid-1",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const graph = { "1": { class_type: "X" } };
    const pid = await c.queuePrompt(graph);
    assertEquals(pid, "pid-1");
    assertSpyCalls(fetchSpy, 1);
    const [url, init] = fetchSpy.calls[0].args;
    assertEquals(url, "http://host:8081/prompt");
    assertEquals(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assertEquals(body, { prompt: graph, client_id: "cid-1" });
  });

  it("throws on a 400 carrying node_errors, including the error text", async () => {
    const errBody = {
      error: { type: "prompt_outputs_failed_validation" },
      node_errors: {
        "3": { errors: [{ message: "Required input is missing" }] },
      },
    };
    const fetchImpl = () => Promise.resolve(jsonResponse(errBody, 400));
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await assertRejects(
      () => c.queuePrompt({}),
      Error,
      "400",
    );
    assertEquals(err.message.includes("Required input is missing"), true);
    assertEquals(err.message.includes("node_errors"), true);
  });
});

describe("getHistory", () => {
  it("returns the entry when present", async () => {
    const entry: HistoryEntry = { prompt_id: "pid", outputs: {} };
    const fetchImpl = (url: string | URL | Request) => {
      assertEquals(String(url), "http://host/history/pid");
      return Promise.resolve(jsonResponse({ pid: entry }));
    };
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const got = await c.getHistory("pid");
    assertExists(got);
    assertEquals(got?.prompt_id, "pid");
  });

  it("returns null when the history map is empty", async () => {
    const fetchImpl = () => Promise.resolve(jsonResponse({}));
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assertEquals(await c.getHistory("pid"), null);
  });

  it("returns null when the map lacks the id", async () => {
    const fetchImpl = () =>
      Promise.resolve(jsonResponse({ other: { outputs: {} } }));
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assertEquals(await c.getHistory("pid"), null);
  });
});

describe("collectImages", () => {
  it("flattens images across multiple output nodes", () => {
    const c = new ComfyClient({ baseUrl: "http://host", fetchImpl: fetch });
    const a: ImageRef = { filename: "a.png", subfolder: "", type: "output" };
    const b: ImageRef = { filename: "b.png", subfolder: "sub", type: "output" };
    const d: ImageRef = { filename: "c.png", subfolder: "", type: "output" };
    const entry: HistoryEntry = {
      outputs: {
        "9": { images: [a, b] },
        "10": { images: [d] },
        "11": { latents: [] },
      },
    };
    assertEquals(c.collectImages(entry), [a, b, d]);
  });

  it("returns [] when there are no images", () => {
    const c = new ComfyClient({ baseUrl: "http://host", fetchImpl: fetch });
    assertEquals(c.collectImages({ outputs: {} }), []);
    assertEquals(c.collectImages({ outputs: { "1": { gifs: [] } } }), []);
  });
});

describe("viewUrl", () => {
  it("encodes query params, including a subfolder with a space", () => {
    const c = new ComfyClient({
      baseUrl: "http://host:8081",
      fetchImpl: fetch,
    });
    const url = c.viewUrl({
      filename: "img 1.png",
      subfolder: "my dir",
      type: "output",
    });
    assertEquals(
      url,
      "http://host:8081/view?filename=img+1.png&subfolder=my+dir&type=output",
    );
  });
});

describe("fetchImage", () => {
  it("returns the bytes on success", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = (url: string | URL | Request) => {
      assertEquals(
        String(url),
        "http://host/view?filename=a.png&subfolder=&type=output",
      );
      return Promise.resolve(new Response(bytes, { status: 200 }));
    };
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await c.fetchImage({
      filename: "a.png",
      subfolder: "",
      type: "output",
    });
    assertEquals(out, bytes);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = () =>
      Promise.resolve(new Response("nope", { status: 404 }));
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await assertRejects(
      () => c.fetchImage({ filename: "a.png", subfolder: "", type: "output" }),
      Error,
      "404",
    );
  });
});

describe("waitForResult", () => {
  it("resolves once the fetch reports completion", async () => {
    const incomplete: HistoryEntry = { outputs: {} };
    const complete: HistoryEntry = {
      status: { completed: true },
      outputs: {
        "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
      },
    };
    let call = 0;
    const fetchImpl = () => {
      call++;
      const entry = call >= 3 ? complete : incomplete;
      return Promise.resolve(jsonResponse({ pid: entry }));
    };
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const sleepSpy = spy((_ms: number) => Promise.resolve());
    const entry = await c.waitForResult("pid", {
      pollIntervalMs: 5,
      timeoutMs: 60000,
      sleep: sleepSpy as unknown as (ms: number) => Promise<void>,
    });
    assertEquals(entry.status?.completed, true);
    assertEquals(call, 3);
    assertSpyCalls(sleepSpy, 2);
  });

  it("resolves when images are present even without completed flag", async () => {
    const entry: HistoryEntry = {
      outputs: {
        "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
      },
    };
    const fetchImpl = () => Promise.resolve(jsonResponse({ pid: entry }));
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const got = await c.waitForResult("pid", {
      sleep: () => Promise.resolve(),
    });
    assertEquals(c.collectImages(got).length, 1);
  });

  it("rejects on timeout", async () => {
    const incomplete: HistoryEntry = { outputs: {} };
    const fetchImpl = () => Promise.resolve(jsonResponse({ pid: incomplete }));
    const c = new ComfyClient({
      baseUrl: "http://host",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await assertRejects(
      () =>
        c.waitForResult("pid", {
          pollIntervalMs: 1,
          timeoutMs: 0,
          sleep: () => Promise.resolve(),
        }),
      Error,
      "timed out",
    );
  });
});
