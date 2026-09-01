import { assertEquals } from "jsr:@std/assert@1";
import { run } from "./checks.ts";

// A child that exits immediately without reading stdin. Piping a payload larger
// than the OS pipe buffer means the write/close cannot complete before the
// process is gone — the unguarded path throws (BrokenPipe on Linux, a
// "Writable stream is closed or errored" TypeError from the web-stream layer on
// macOS); the guarded path lets child.output() resolve and returns the exit
// code. deno is a guaranteed-present binary that runs its eval immediately and
// never drains stdin.
Deno.test("run() returns a RunResult when the child exits before draining stdin", async () => {
  const big = "x".repeat(5_000_000);
  const res = await run(Deno.execPath(), ["eval", "Deno.exit(3)"], {
    stdin: big,
    timeoutSeconds: 30,
  });
  assertEquals(res.timedOut, false);
  assertEquals(res.code, 3);
});
