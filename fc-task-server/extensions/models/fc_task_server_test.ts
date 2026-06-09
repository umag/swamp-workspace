// Unit tests for the @magistr/fc-task-server model — global/method schema
// validation (incl. the sk-ant token guard and HTTPS-only git URL) and the
// pre-flight checks. These import the REAL model, so a behaviour change breaks
// these tests.
//
// Run: deno test extensions/models/fc_task_server_test.ts

import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./fc_task_server.ts";
import { isValidSshHost } from "./lib/ssh.ts";

const baseArgs = {
  host: "fc.example.com",
  oauthToken: "sk-ant-test-token",
};

// --- globalArguments ---

Deno.test("globalArguments: accepts a host + sk-ant token", () => {
  assertEquals(model.globalArguments.safeParse(baseArgs).success, true);
});

Deno.test("globalArguments: applies user/tapIp/tapPort defaults", () => {
  const parsed = model.globalArguments.parse(baseArgs);
  assertEquals(parsed.user, "root");
  assertEquals(parsed.tapIp, "172.16.0.1");
  assertEquals(parsed.tapPort, 8080);
});

Deno.test("globalArguments: rejects a token without the sk-ant prefix", () => {
  const r = model.globalArguments.safeParse({
    ...baseArgs,
    oauthToken: "csk-ant-corrupted",
  });
  assertFalse(r.success);
});

Deno.test("globalArguments: rejects a tapPort below the privileged range", () => {
  const r = model.globalArguments.safeParse({ ...baseArgs, tapPort: 80 });
  assertFalse(r.success);
});

// --- method argument schemas ---

Deno.test("inject_task: accepts an https git repo URL", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    gitRepoUrl: "https://github.com/example/repo",
  });
  assertEquals(r.success, true);
});

Deno.test("inject_task: accepts an empty git repo URL", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    gitRepoUrl: "",
  });
  assertEquals(r.success, true);
});

Deno.test("inject_task: rejects a non-HTTPS (scp-style) git URL", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    gitRepoUrl: "git@github.com:example/repo.git",
  });
  assertFalse(r.success);
});

Deno.test("inject_task: defaults effort to low", () => {
  const parsed = model.methods.inject_task.arguments.parse({
    prompt: "do the thing",
  });
  assertEquals(parsed.effort, "low");
});

Deno.test("inject_task: accepts an explicit effort level", () => {
  const parsed = model.methods.inject_task.arguments.parse({
    prompt: "do the thing",
    effort: "xhigh",
  });
  assertEquals(parsed.effort, "xhigh");
});

Deno.test("inject_task: rejects an unknown effort level", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    effort: "ultra",
  });
  assertFalse(r.success);
});

Deno.test("collect_result: rejects a timeout below the minimum", () => {
  const r = model.methods.collect_result.arguments.safeParse({
    timeoutSeconds: 5,
  });
  assertFalse(r.success);
});

Deno.test("collect_result: defaults the timeout to 300s", () => {
  const parsed = model.methods.collect_result.arguments.parse({});
  assertEquals(parsed.timeoutSeconds, 300);
});

// --- pre-flight checks ---

Deno.test("valid-ssh-host check: passes for a real host", async () => {
  const res = await model.checks["valid-ssh-host"].execute({
    globalArgs: { ...baseArgs, user: "root" },
  });
  assertEquals(res.pass, true);
});

Deno.test("valid-ssh-host check: fails with an error for an empty host", async () => {
  const res = await model.checks["valid-ssh-host"].execute({
    globalArgs: { ...baseArgs, host: "" },
  });
  assertFalse(res.pass);
  assertEquals(typeof res.errors?.[0], "string");
});

Deno.test("host-reachable check: registered with the live label", () => {
  assertEquals(model.checks["host-reachable"].labels, ["live"]);
});

// --- shared ssh helper ---

Deno.test("isValidSshHost rejects empty and placeholder hosts", () => {
  assertEquals(isValidSshHost("fc.example.com"), true);
  assertFalse(isValidSshHost(""));
  assertFalse(isValidSshHost("null"));
});
