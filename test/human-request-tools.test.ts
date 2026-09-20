import { strict as assert } from "node:assert";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DelegaClient } from "../src/delega-client.js";
import { registerHumanRequestTools } from "../src/human-request-tools.js";

const taskId = "d".repeat(32);

test("human request tools validate input and preserve API versions through a real MCP session", async () => {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  const agent = new Client({ name: "test-agent", version: "0.0.0" });
  const api = new DelegaClient("https://api.delega.dev", "dlg_synthetic");
  const requests: { url: string; method: string | undefined; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ task_id: taskId, phase: "prepared", version: 7, result: null }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  registerHumanRequestTools(server, api, () => ({ isError: true, content: [{ type: "text", text: "Request failed" }] }));
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await agent.connect(right);
    assert.deepEqual((await agent.listTools()).tools.map(tool => tool.name).sort(), [
      "cancel_human_request", "get_human_request", "get_human_result", "register_human_request",
    ]);
    const registered = await agent.callTool({ name: "register_human_request",
      arguments: { task_id: taskId, criteria: ["Room checked"], expected_revision: 3, timeout_seconds: 600 } });
    assert.equal(registered.isError, undefined);
    assert.deepEqual(requests[0], {
      url: "https://api.delega.dev/v1/tasks/" + taskId + "/human-request", method: "POST",
      body: { kind: "checklist", recipient_ref: "self", criteria: ["Room checked"], expected_revision: 3, timeout_seconds: 600 },
    });
    await agent.callTool({ name: "get_human_request", arguments: { task_id: taskId } });
    await agent.callTool({ name: "get_human_result", arguments: { task_id: taskId } });
    await agent.callTool({ name: "cancel_human_request", arguments: { task_id: taskId, expected_version: 7 } });
    assert.equal(requests[1].method, "GET"); assert.equal(requests[1].body, undefined);
    assert.ok(requests[2].url.endsWith("/human-request/result"));
    assert.deepEqual(requests[3].body, { expected_version: 7 });
    for (const change of [{ criteria: [] }, { criteria: ["x / y"] }, { criteria: ["same", "same"] },
      { timeout_seconds: 1201 }, { expected_revision: -1 }, { task_id: "../secrets" }]) {
      const invalid = await agent.callTool({ name: "register_human_request",
        arguments: { task_id: taskId, criteria: ["Ready"], expected_revision: 0, ...change } });
      assert.equal(invalid.isError, true);
    }
    assert.equal(requests.length, 4);
  } finally {
    globalThis.fetch = original; await agent.close(); await server.close();
  }
});

test("client carries completion fences, preserves old empty completions and gates custom hosts", async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response("{}");
  }) as typeof fetch;
  try {
    const api = new DelegaClient("https://staging-api.delega.dev", "dlg_synthetic");
    await api.completeTask(taskId, [{ kind: "artifact_url", ref: "https://example.test/evidence" }],
      { expected_revision: 12, claim_generation: 4 });
    assert.equal(bodies[0].expected_revision, 12); assert.equal(bodies[0].claim_generation, 4);
    await api.completeTask(taskId);
    assert.equal(bodies[1], undefined);
    const custom = new DelegaClient("https://example.test", "dlg_synthetic");
    await assert.rejects(custom.getHumanRequest(taskId), /only available/);
    await assert.rejects(custom.registerHumanRequest(taskId, { criteria: ["Ready"], expected_revision: 0 }), /only available/);
    await assert.rejects(custom.cancelHumanRequest(taskId, 0), /only available/);
    assert.equal(bodies.length, 2);
  } finally { globalThis.fetch = original; }
});
