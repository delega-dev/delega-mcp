import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHumanRequestConnector, parseHumanRequestTaskIds } from "../src/human-request-connector.js";
import { DelegaApiError, DelegaClient } from "../src/delega-client.js";
import type { HumanRequestClient } from "../src/human-request-tools.js";

const taskId = "d".repeat(32), otherId = "e".repeat(32);
const names = ["cancel_human_request", "get_human_request", "get_human_result", "register_human_request"];
const readText = (result: any): string => result.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");

async function session(api: HumanRequestClient, scope: string[] = [taskId]) {
  const server = createHumanRequestConnector({ client: api, taskIds: scope, version: "0.0.0" });
  const agent = new Client({ name: "connector-conformance", version: "0.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await agent.connect(right);
  return { agent, close: async () => { await agent.close(); await server.close(); } };
}

test("connector scope fails closed and never echoes invalid host configuration", () => {
  for (const invalid of [undefined, "", "*", " ", taskId + ",", "SYNTHETIC-CONFIG-SECRET"]) {
    assert.throws(() => parseHumanRequestTaskIds(invalid), error => {
      assert.doesNotMatch(String(error), /SYNTHETIC-CONFIG-SECRET/); return true;
    });
  }
  assert.deepEqual(parseHumanRequestTaskIds(` ${taskId}, ${otherId},${taskId}`), [taskId, otherId]);
  const api = new DelegaClient("https://api.delega.dev", "synthetic-only");
  for (const taskIds of [[], ["*"], [taskId, ""]]) {
    assert.throws(() => createHumanRequestConnector({ client: api, taskIds, version: "0.0.0" }));
  }
});

test("only the four request tools exist and every operation checks immutable task scope before I/O", async () => {
  let calls = 0;
  const call = async () => { calls++; throw new Error("Unexpected backend call"); };
  const scope = [taskId];
  const s = await session({ registerHumanRequest: call, getHumanRequest: call, cancelHumanRequest: call }, scope);
  scope.push(otherId);
  try {
    assert.deepEqual((await s.agent.listTools()).tools.map(tool => tool.name).sort(), names);
    for (const name of names) {
      const result = await s.agent.callTool({ name, arguments: {
        task_id: otherId, criteria: ["Room checked"], expected_revision: 3, expected_version: 7,
      } });
      assert.equal(result.isError, true); assert.match(readText(result), /outside.*scope/);
    }
    for (const name of ["complete_task", "create_task", "get_task_context", "register_agent", "list_tasks"]) {
      const result = await s.agent.callTool({ name, arguments: { task_id: taskId } });
      assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
  } finally { await s.close(); }
});

test("connector preserves exact REST requests, read-only result retrieval and cancellation versions", async () => {
  const requests: { url: string; method?: string; body?: unknown }[] = [];
  const original = globalThis.fetch;
  let snapshot: any = { task_id: taskId, phase: "prepared", version: 7, result: null };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(snapshot), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const s = await session(new DelegaClient("https://api.delega.dev", "synthetic-only"));
  try {
    const registered = await s.agent.callTool({ name: "register_human_request", arguments: {
      task_id: taskId, criteria: ["Room checked"], expected_revision: 3, timeout_seconds: 600,
    } });
    assert.equal(registered.isError, undefined);
    assert.deepEqual(requests[0], { url: `https://api.delega.dev/v1/tasks/${taskId}/human-request`, method: "POST",
      body: { criteria: ["Room checked"], expected_revision: 3, timeout_seconds: 600, kind: "checklist", recipient_ref: "self" } });
    // These are synthetic API snapshots, not evidence of a live human run.
    for (const phase of ["prepared", "awaiting_accept", "awaiting_result", "completion_pending", "incomplete",
      "declined", "needs_review", "expired", "cancellation_pending", "cancelled", "completed"]) {
      const result = phase === "completed" ? { verification: "human_attested", physical_state_independently_verified: false,
        criteria: ["Room checked"], reported_at: "2000-01-02 03:04:05", verification_method: "task_bound_answer_capability" } : null;
      snapshot = { task_id: taskId, phase, version: 7, result,
        answers: phase === "incomplete" ? [{ phase: "result", answer: "I cannot confirm every item", requires_review: false, recorded_at: "2000-01-02 03:04:06" }] : [] };
      const before = requests.length;
      for (const name of ["get_human_request", "get_human_result"]) {
        const received = await s.agent.callTool({ name, arguments: { task_id: taskId } });
        assert.deepEqual(JSON.parse(readText(received)), snapshot, "do not infer completion or rewrite attestation");
      }
      assert.deepEqual(requests.slice(before).map(r => [r.method, r.body]), [["GET", undefined], ["GET", undefined]]);
      assert.ok(requests.at(-1)!.url.endsWith("/human-request/result"));
    }
    await s.agent.callTool({ name: "cancel_human_request", arguments: { task_id: taskId, expected_version: 7 } });
    assert.deepEqual(requests.at(-1), { url: `https://api.delega.dev/v1/tasks/${taskId}/human-request/cancel`, method: "POST", body: { expected_version: 7 } });
    const before = requests.length;
    const invalid = await s.agent.callTool({ name: "register_human_request", arguments: {
      task_id: taskId, criteria: ["x / y"], expected_revision: 3,
    } });
    assert.equal(invalid.isError, true); assert.equal(requests.length, before);
  } finally { await s.close(); globalThis.fetch = original; }
});

test("backend errors and uncertain mutation outcomes do not leak bodies, retry, or fall back to task completion", async () => {
  const original = globalThis.fetch;
  const marker = "SYNTHETIC-SECRET-DO-NOT-ECHO";
  let status = 409, calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (status === 0) throw new TypeError(marker, { cause: Object.assign(new Error(marker), { code: "ECONNRESET" }) });
    return new Response(JSON.stringify({ error: marker, code: marker }), { status });
  }) as typeof fetch;
  const s = await session(new DelegaClient("https://api.delega.dev", "synthetic-only"));
  try {
    for (status of [400, 401, 403, 404, 409, 422, 429, 500, 0]) {
      const before = calls;
      const result = await s.agent.callTool({ name: "register_human_request", arguments: {
        task_id: taskId, criteria: ["Room checked"], expected_revision: 3,
      } });
      assert.equal(result.isError, true); assert.doesNotMatch(readText(result), new RegExp(marker));
      assert.equal(calls, before + 1, "one mutation attempt, no fallback");
      if (status === 409) assert.match(readText(result), /state conflict/);
      if (status === 0) assert.match(readText(result), /outcome is unknown/);
    }
  } finally { await s.close(); globalThis.fetch = original; }
});

test("connector never emits raw arbitrary exceptions, even when debug and reveal flags are set", async () => {
  const flags = ["DELEGA_DEBUG", "DELEGA_REVEAL_AGENT_KEYS", "DELEGA_REVEAL_WEBHOOK_SECRETS"];
  const previous = flags.map(flag => process.env[flag]);
  flags.forEach(flag => { process.env[flag] = "1"; });
  const s = await session({ registerHumanRequest: async () => { throw new Error("SYNTHETIC-SECRET"); },
    getHumanRequest: async () => { throw new DelegaApiError(403, "SYNTHETIC-SECRET", "SYNTHETIC-SECRET"); },
    cancelHumanRequest: async () => { throw "SYNTHETIC-SECRET"; } });
  try {
    for (const name of names) {
      const result = await s.agent.callTool({ name, arguments: { task_id: taskId, criteria: ["Ready"], expected_revision: 3, expected_version: 7 } });
      assert.equal(result.isError, true); assert.doesNotMatch(readText(result), /SYNTHETIC-SECRET/);
    }
  } finally {
    await s.close(); flags.forEach((flag, i) => { if (previous[i] === undefined) delete process.env[flag]; else process.env[flag] = previous[i]; });
  }
});

test("real stdio entrypoint exposes only scoped request tools without contacting the API", { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/human-request-stdio.ts"],
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", DELEGA_AGENT_KEY: "synthetic-only-not-live",
      DELEGA_HUMAN_REQUEST_TASK_IDS: taskId }, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const agent = new Client({ name: "stdio-connector-conformance", version: "0.0.0" });
  try {
    await agent.connect(transport);
    assert.deepEqual((await agent.listTools()).tools.map(tool => tool.name).sort(), names);
    const result = await agent.callTool({ name: "get_human_result", arguments: { task_id: otherId } });
    assert.equal(result.isError, true); assert.match(readText(result), /outside.*scope/);
    assert.equal(stderr, "");
  } finally { await agent.close(); await transport.close(); }
});

test("stdio startup fails closed on missing scope, missing key and partial Access configuration", { timeout: 15000 }, () => {
  for (const additions of [
    { DELEGA_AGENT_KEY: "SYNTHETIC-SECRET" },
    { DELEGA_HUMAN_REQUEST_TASK_IDS: taskId },
    { DELEGA_HUMAN_REQUEST_TASK_IDS: taskId, DELEGA_AGENT_KEY: "SYNTHETIC-SECRET", DELEGA_CF_ACCESS_CLIENT_ID: "SYNTHETIC-SECRET" },
  ]) {
    const run = spawnSync(process.execPath, ["--import", "tsx", "src/human-request-stdio.ts"], {
      env: { PATH: process.env.PATH ?? "", ...additions }, encoding: "utf8", timeout: 4000,
    });
    assert.equal(run.status, 1); assert.equal(run.stdout, "");
    assert.match(run.stderr, /could not start/); assert.doesNotMatch(run.stderr, /SYNTHETIC-SECRET/);
  }
});
