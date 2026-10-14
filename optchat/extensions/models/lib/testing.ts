// Test seams shared by the optchat suites: a scripted claude session, a fake
// method context, and temp chat directories. Not shipped in the bundle.

import type {
  Reply,
  Session,
  SessionFactory,
  SessionOptions,
  StreamEvent,
} from "./llm.ts";

/** One recorded conversation with the fake claude. */
export interface FakeCall {
  opts: SessionOptions;
  sent: string[];
  closed: boolean;
}

/** How the fake answers: a reply text, or events then a reply text. */
export type Responder = (
  prompt: string,
  call: FakeCall,
) =>
  | string
  | { events: StreamEvent[]; text: string }
  | Promise<string | { events: StreamEvent[]; text: string }>;

/** A SessionFactory whose replies come from `respond`; it records calls. */
export function fakeClaude(
  respond: Responder,
): { factory: SessionFactory; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const factory: SessionFactory = (opts) => {
    const call: FakeCall = { opts, sent: [], closed: false };
    calls.push(call);
    const session: Session = {
      async send(text, onEvent): Promise<Reply> {
        call.sent.push(text);
        const r = await respond(text, call);
        const { events, text: out } = typeof r === "string"
          ? { events: [], text: r }
          : r;
        for (const e of events) onEvent?.(e);
        const result = { type: "result", result: out, is_error: false };
        onEvent?.(result);
        return { text: out, result };
      },
      close() {
        call.closed = true;
        return Promise.resolve();
      },
    };
    return session;
  };
  return { factory, calls };
}

/** A compaction responder: a fixed short line naming what it compressed. */
export function shortLines(): Responder {
  return (prompt) => {
    const m = prompt.match(
      /Compaction: (compress message \d+|merge lines \S+ and \S+)/,
    );
    return `summary of ${m ? m[1] : "?"}`;
  };
}

/** A data write captured from a method run. */
export interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** A method context over `globalArgs`, capturing writeResource calls. */
export function fakeContext(
  globalArgs: Record<string, unknown>,
  factory?: SessionFactory,
): {
  context: {
    globalArgs: unknown;
    logger: { info: () => void };
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => Promise<unknown>;
    sessionFactory?: SessionFactory;
  };
  written: Written[];
} {
  const written: Written[] = [];
  return {
    written,
    context: {
      globalArgs,
      logger: { info: () => {} },
      writeResource: (spec, name, data) => {
        written.push({ spec, name, data });
        return Promise.resolve({ spec, name });
      },
      sessionFactory: factory,
    },
  };
}

/** A fresh temp directory for a chat. */
export async function tempChat(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "optchat-test-" });
}

/** Repeat a string to `n` characters. */
export function filler(n: number, ch = "x"): string {
  return ch.repeat(n);
}
