// Tests for the source-integration pure cores: the @@EDIT envelope parser (with
// nonce-fence forgery defense), planApply (allowlist/DENY/cap enforcement over an
// injectable file snapshot — no filesystem), and the apply-boundary secret scrub.
import {
  MAX_ENVELOPE_BYTES,
  parseEnvelope,
  planApply,
  scrubSecrets,
} from "./source_integration.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const NONCE = "n0nce123";
function fence(body: string): string {
  return "preamble chatter\n<<<GOBRR:" + NONCE + "\n" + body + "\nGOBRR:" +
    NONCE + ">>>\ntrailing\n";
}

// ── parseEnvelope (@@EDIT / @@NEWFILE) ──────────────────────────────────────

Deno.test("parseEnvelope extracts edits and new files", () => {
  const body = [
    "@@EDIT src/a.ts",
    "@@OLD",
    "const x = 1;",
    "@@NEW",
    "const x = 2;",
    "@@ENDEDIT",
    "@@NEWFILE done/marker.txt",
    "done",
    "@@ENDFILE",
  ].join("\n");
  const r = parseEnvelope(fence(body), NONCE);
  assert("env" in r, "parsed");
  if (!("env" in r)) return;
  assert(
    r.env.edits.length === 1 && r.env.edits[0].path === "src/a.ts",
    "one edit",
  );
  assert(
    r.env.edits[0].old === "const x = 1;" &&
      r.env.edits[0].new === "const x = 2;",
    "edit body",
  );
  assert(
    r.env.newFiles.length === 1 && r.env.newFiles[0].path === "done/marker.txt",
    "one newfile",
  );
  assert(r.env.newFiles[0].content === "done", "newfile body");
});

Deno.test("parseEnvelope: wrong-nonce fence → nonce_mismatch (forgery)", () => {
  const out =
    "<<<GOBRR:WRONGNONCE\n@@NEWFILE x\ny\n@@ENDFILE\nGOBRR:WRONGNONCE>>>";
  const r = parseEnvelope(out, NONCE);
  assert(
    "failureKind" in r && r.failureKind === "nonce_mismatch",
    "forged nonce rejected",
  );
});

Deno.test("parseEnvelope: no fence → envelope_parse; claude error → claude_error; oversize → envelope_oversize", () => {
  assert(
    "failureKind" in parseEnvelope("nothing here", NONCE) &&
      (parseEnvelope("nothing here", NONCE) as { failureKind: string })
          .failureKind === "envelope_parse",
    "no fence",
  );
  const ce = parseEnvelope("ERROR: claude exit=1: boom", NONCE);
  assert(
    "failureKind" in ce && ce.failureKind === "claude_error",
    "claude error",
  );
  const ov = parseEnvelope("x".repeat(20), NONCE, 5);
  assert(
    "failureKind" in ov && ov.failureKind === "envelope_oversize",
    "oversize",
  );
});

Deno.test("parseEnvelope: a fenced body with no blocks → envelope_parse", () => {
  const r = parseEnvelope(fence("just prose, no markers"), NONCE);
  assert(
    "failureKind" in r && r.failureKind === "envelope_parse",
    "empty body rejected",
  );
});

// ── planApply (pure, over a file snapshot) ──────────────────────────────────

const SNAP = { "src/a.ts": "const x = 1;\nconst y = 2;\n" };

Deno.test("planApply applies a unique edit + a new file within the allowlist", () => {
  const env = {
    edits: [{ path: "src/a.ts", old: "const x = 1;", new: "const x = 9;" }],
    newFiles: [{ path: "done/m.txt", content: "done" }],
  };
  const r = planApply(env, ["src/a.ts", "done/m.txt"], SNAP);
  assert("writes" in r, "planned");
  if (!("writes" in r)) return;
  assert(
    r.changedPaths.sort().join(",") === "done/m.txt,src/a.ts",
    "changedPaths",
  );
  const a = r.writes.find((w) => w.path === "src/a.ts")!;
  assert(a.content === "const x = 9;\nconst y = 2;\n", "edit applied");
});

Deno.test("planApply: @@OLD not found / not unique → envelope_parse (unapplicable)", () => {
  const notFound = planApply(
    { edits: [{ path: "src/a.ts", old: "MISSING", new: "z" }], newFiles: [] },
    ["src/a.ts"],
    SNAP,
  );
  assert(
    "failureKind" in notFound && notFound.failureKind === "envelope_parse",
    "old not found",
  );
  const ambiguous = planApply(
    { edits: [{ path: "src/a.ts", old: "const ", new: "let " }], newFiles: [] },
    ["src/a.ts"],
    SNAP,
  );
  assert(
    "failureKind" in ambiguous && ambiguous.failureKind === "envelope_parse",
    "old not unique",
  );
});

Deno.test("planApply: out-of-allowlist path → out_of_allowlist", () => {
  const r = planApply(
    { edits: [], newFiles: [{ path: "other/x.ts", content: "z" }] },
    ["src"],
    SNAP,
  );
  assert(
    "failureKind" in r && r.failureKind === "out_of_allowlist",
    "outside allowlist",
  );
});

Deno.test("planApply: denied control path or traversal → unsafe_change", () => {
  const denied = planApply(
    {
      edits: [],
      newFiles: [{ path: ".git/hooks/pre-commit", content: "#!/bin/sh" }],
    },
    [".git/hooks/pre-commit"],
    SNAP,
  );
  assert(
    "failureKind" in denied && denied.failureKind === "unsafe_change",
    "denied path",
  );
  const traversal = planApply(
    { edits: [], newFiles: [{ path: "../escape.txt", content: "z" }] },
    ["../escape.txt"],
    SNAP,
  );
  assert(
    "failureKind" in traversal && traversal.failureKind === "unsafe_change",
    "traversal",
  );
});

Deno.test("planApply: oversize content or too many blocks → envelope_oversize", () => {
  const big = planApply(
    {
      edits: [],
      newFiles: [{
        path: "src/big.ts",
        content: "x".repeat(MAX_ENVELOPE_BYTES + 1),
      }],
    },
    ["src"],
    SNAP,
  );
  assert(
    "failureKind" in big && big.failureKind === "envelope_oversize",
    "oversize content",
  );
});

// ── planApply: cumulative same-file @@EDIT fold ─────────────────────────────
// Issue si-apply-multi-edit-same-file. RED until planApply applies a file's
// @@EDIT blocks one after another against a per-path running working-copy and
// emits one cumulative write per path. Single-block edits and @@NEWFILE remain
// covered by the green tests above.

Deno.test("planApply: two @@EDIT blocks on one file fold into a single cumulative write", () => {
  const snap = { "vae.py": "import os\n\nclass VAE:\n    pass\n" };
  const env = {
    edits: [
      {
        path: "vae.py",
        old: "import os",
        new: "import os\nfrom norm import get_latent_norm",
      },
      {
        path: "vae.py",
        old: "    pass",
        new: "    def encode(self):\n        return get_latent_norm(self)",
      },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["vae.py"], snap);
  assert("writes" in r, "planned");
  if (!("writes" in r)) return;
  const forFile = r.writes.filter((w) => w.path === "vae.py");
  assert(forFile.length === 1, "exactly one write for the file");
  assert(r.writes.length === 1, "no spurious extra writes");
  assert(
    forFile[0].content ===
      "import os\nfrom norm import get_latent_norm\n\nclass VAE:\n    def encode(self):\n        return get_latent_norm(self)\n",
    "exact cumulative content (both blocks, applied in order)",
  );
  assert(
    r.changedPaths.filter((p) => p === "vae.py").length === 1,
    "one changedPath for the file",
  );
});

Deno.test("planApply: three @@EDIT blocks on one file all land (running-copy write-back)", () => {
  const snap = { "m.txt": "A\nB\nC\n" };
  const env = {
    edits: [
      { path: "m.txt", old: "A", new: "A1" },
      { path: "m.txt", old: "B", new: "B2" },
      { path: "m.txt", old: "C", new: "C3" },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["m.txt"], snap);
  assert("writes" in r, "planned");
  if (!("writes" in r)) return;
  const w = r.writes.filter((x) => x.path === "m.txt");
  assert(w.length === 1, "one write");
  assert(
    w[0].content === "A1\nB2\nC3\n",
    "all three edits applied cumulatively",
  );
});

Deno.test("planApply: a later @@OLD matches text an earlier block inserted", () => {
  const snap = { "f.ts": "line1\nline2\n" };
  const env = {
    edits: [
      { path: "f.ts", old: "line1", new: "line1\nINSERTED" },
      { path: "f.ts", old: "INSERTED", new: "INSERTED_DONE" },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["f.ts"], snap);
  assert("writes" in r, "applies against running content");
  if (!("writes" in r)) return;
  const w = r.writes.find((x) => x.path === "f.ts")!;
  assert(
    w.content === "line1\nINSERTED_DONE\nline2\n",
    "second edit matched inserted text",
  );
});

Deno.test("planApply: an @@OLD made ambiguous by an earlier edit → envelope_parse", () => {
  const snap = { "f.ts": "uniq\n" };
  const env = {
    edits: [
      { path: "f.ts", old: "uniq", new: "uniq\nuniq" },
      { path: "f.ts", old: "uniq", new: "X" },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["f.ts"], snap);
  assert(
    "failureKind" in r && r.failureKind === "envelope_parse",
    "ambiguous @@OLD on running content rejected",
  );
});

Deno.test("planApply: two under-cap edits whose folded result exceeds MAX_ENVELOPE_BYTES → envelope_oversize", () => {
  const snap = { "big.ts": "AAA\nBBB\n" };
  const half = "x".repeat(Math.floor(MAX_ENVELOPE_BYTES * 0.6));
  const env = {
    edits: [
      { path: "big.ts", old: "AAA", new: "AAA" + half },
      { path: "big.ts", old: "BBB", new: "BBB" + half },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["big.ts"], snap);
  assert(
    "failureKind" in r && r.failureKind === "envelope_oversize",
    "cumulative folded size over the cap caught",
  );
});

Deno.test("planApply: a path in both @@EDIT and @@NEWFILE → envelope_parse", () => {
  const snap = { "src/a.ts": "const x = 1;\n" };
  const env = {
    edits: [{ path: "src/a.ts", old: "const x = 1;", new: "const x = 2;" }],
    newFiles: [{ path: "src/a.ts", content: "brand new" }],
  };
  const r = planApply(env, ["src/a.ts"], snap);
  assert(
    "failureKind" in r && r.failureKind === "envelope_parse",
    "same-path @@EDIT + @@NEWFILE rejected before any write",
  );
});

Deno.test("planApply: a no-op edit (@@OLD == @@NEW) produces no write and no changedPath", () => {
  const snap = { "src/a.ts": "const x = 1;\nconst y = 2;\n" };
  const env = {
    edits: [{ path: "src/a.ts", old: "const x = 1;", new: "const x = 1;" }],
    newFiles: [],
  };
  const r = planApply(env, ["src/a.ts"], snap);
  assert("writes" in r, "planned");
  if (!("writes" in r)) return;
  assert(
    r.writes.filter((w) => w.path === "src/a.ts").length === 0,
    "no write for unchanged file",
  );
  assert(
    r.changedPaths.filter((p) => p === "src/a.ts").length === 0,
    "no spurious changedPath",
  );
});

Deno.test("planApply: a denied path as the 2nd @@EDIT block → unsafe_change (guard stays per block)", () => {
  const snap = { "src/a.ts": "const x = 1;\n" };
  const env = {
    edits: [
      { path: "src/a.ts", old: "const x = 1;", new: "const x = 2;" },
      { path: ".git/config", old: "x", new: "y" },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["src/a.ts", ".git/config"], snap);
  assert(
    "failureKind" in r && r.failureKind === "unsafe_change",
    "denied 2nd block rejected",
  );
});

Deno.test("planApply: edit-A deletes text that edit-B's @@OLD needs → envelope_parse", () => {
  const snap = { "f.ts": "const x = 1;\nconst y = 2;\n" };
  const env = {
    edits: [
      { path: "f.ts", old: "const x = 1;\n", new: "" },
      { path: "f.ts", old: "const x = 1;", new: "const x = 9;" },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["f.ts"], snap);
  assert(
    "failureKind" in r && r.failureKind === "envelope_parse",
    "edit-B @@OLD removed by edit-A on the running content → not found",
  );
});

Deno.test("planApply: 201 @@EDIT blocks on one file still hit the block cap → envelope_oversize", () => {
  const snap = { "f.ts": "seed\n" };
  // 201 > MAX_BLOCKS (200); same-file folding must not bypass the block-count cap.
  const edits = Array.from(
    { length: 201 },
    () => ({ path: "f.ts", old: "seed", new: "seed" }),
  );
  const r = planApply({ edits, newFiles: [] }, ["f.ts"], snap);
  assert(
    "failureKind" in r && r.failureKind === "envelope_oversize",
    "block-count cap enforced regardless of same-file fold",
  );
});

Deno.test("planApply: an out-of-allowlist path as a later block alongside a same-file fold → out_of_allowlist", () => {
  const snap = { "src/a.ts": "const x = 1;\nconst y = 2;\n" };
  const env = {
    edits: [
      { path: "src/a.ts", old: "const x = 1;", new: "const x = 2;" },
      { path: "src/a.ts", old: "const y = 2;", new: "const y = 3;" },
      { path: "other/z.ts", old: "a", new: "b" },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["src"], snap);
  assert(
    "failureKind" in r && r.failureKind === "out_of_allowlist",
    "guard runs per block; later out-of-allowlist path rejected",
  );
});

Deno.test("planApply: same-file fold plus a @@NEWFILE for a different path keeps both", () => {
  const snap = { "vae.py": "import os\nclass V:\n    pass\n" };
  const env = {
    edits: [
      { path: "vae.py", old: "import os", new: "import os\nimport sys" },
      { path: "vae.py", old: "    pass", new: "    x = 1" },
    ],
    newFiles: [{ path: "done/m.txt", content: "ok" }],
  };
  const r = planApply(env, ["vae.py", "done/m.txt"], snap);
  assert("writes" in r, "planned");
  if (!("writes" in r)) return;
  assert(
    r.writes.filter((w) => w.path === "vae.py").length === 1,
    "one folded write for vae.py",
  );
  assert(
    r.writes.filter((w) => w.path === "done/m.txt").length === 1,
    "newFile for a different path preserved",
  );
  assert(
    r.changedPaths.slice().sort().join(",") === "done/m.txt,vae.py",
    "both paths in changedPaths",
  );
});

Deno.test("planApply: a no-op edit followed by a real edit on the same file yields one real write", () => {
  const snap = { "f.ts": "alpha\nbeta\n" };
  const env = {
    edits: [
      { path: "f.ts", old: "alpha", new: "alpha" },
      { path: "f.ts", old: "beta", new: "BETA" },
    ],
    newFiles: [],
  };
  const r = planApply(env, ["f.ts"], snap);
  assert("writes" in r, "planned");
  if (!("writes" in r)) return;
  const w = r.writes.filter((x) => x.path === "f.ts");
  assert(w.length === 1, "one write");
  assert(
    w[0].content === "alpha\nBETA\n",
    "real edit applied over the running copy",
  );
});

Deno.test("planApply: a denied path as the 2nd @@NEWFILE block → unsafe_change (guard per newFile)", () => {
  const env = {
    edits: [],
    newFiles: [
      { path: "src/new.ts", content: "ok" },
      { path: ".git/hooks/post-update", content: "#!/bin/sh" },
    ],
  };
  const r = planApply(env, ["src/new.ts", ".git/hooks/post-update"], {});
  assert(
    "failureKind" in r && r.failureKind === "unsafe_change",
    "denied 2nd newFile rejected",
  );
});

// ── scrubSecrets (apply-boundary, final diff) ───────────────────────────────

Deno.test("scrubSecrets redacts anthropic tokens and bearer values in the persisted diff", () => {
  const dirty =
    'token = "sk-ant-oat01-AbC_def-123"\nAuthorization: Bearer abc.def.ghi\nconst ok = "hello";';
  const clean = scrubSecrets(dirty);
  assert(!/sk-ant-oat01/.test(clean), "anthropic token redacted");
  assert(!/abc\.def\.ghi/.test(clean), "bearer value redacted");
  assert(/const ok = "hello";/.test(clean), "ordinary code preserved");
});
