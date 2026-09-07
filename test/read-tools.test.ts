import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("real stdio tools enforce bounded reads and compact writes, not just helper functions", { timeout: 30000 }, async () => {
  const requests: Array<{ method: string; url: URL }> = [];
  let conflict = false;
  const task = { id: "t1", content: "task", source_ingress_id: "fixture", description: "detail ".repeat(3000),
    context: { history: "NEVER-ECHO-TASK-CONTEXT".repeat(1000) }, handoff_note: "handoff ".repeat(1000) };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost"); requests.push({ method: req.method!, url });
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/context/history")) {
      res.end(JSON.stringify({ entries: [{ key: "history", value: "large-history".repeat(2000) }], next_cursor: "25" }));
    } else if (url.pathname.endsWith("/context")) {
      if (req.method === "PATCH") {
        for await (const _chunk of req) { /* consume test request */ }
        if (conflict) res.statusCode = 409;
        res.end(JSON.stringify({ context: { historical_payload: "NEVER-ECHO-WRITE-HISTORY".repeat(1000) }, version: conflict ? 6 : 5 }));
      } else {
        const selected = url.searchParams.has("keys");
        res.end(JSON.stringify(selected ? { context: { large: "😀".repeat(9000) }, version: 5, missing_keys: [] }
          : { context: { current_state: "working" }, version: 5, keys: { items: [{ key: "large", chars: 18002 }], total: 1, limit: 25, offset: 0, has_more: false, next_offset: null } }));
      }
    } else if (url.pathname.endsWith("/tasks")) {
      if (req.method === "POST") {
        for await (const _chunk of req) { /* consume test request */ }
        res.statusCode = 201; res.end(JSON.stringify(task)); return;
      }
      const offset = Number(url.searchParams.get("offset")); const limit = Number(url.searchParams.get("limit"));
      const items = Array.from({ length: Math.max(0, Math.min(limit, 119 - offset)) }, (_, i) => ({ id: `t${offset + i}`, content: "task", assigned_to_agent_id: "a", source_ingress_id: "fixture" }));
      const has_more = offset + items.length < 119;
      res.end(JSON.stringify({ items, offset, limit, total: 119, has_more, next_offset: has_more ? offset + items.length : null }));
    } else if (url.pathname.endsWith("/tasks/t1/links")) { res.end('[]');
    } else if (url.pathname.endsWith("/tasks/t1")) { res.end(JSON.stringify(task));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", DELEGA_API_URL: `http://127.0.0.1:${address.port}`, DELEGA_AGENT_KEY: "fixture-only-not-a-live-key" }, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "bounded-read-test", version: "1.0.0" });
  const readText = (result: any) => result.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const schema = listed.tools.find(x => x.name === "list_tasks")!.inputSchema;
    assert.ok(schema.properties?.offset); assert.ok(schema.properties?.max_chars);
    const page = readText(await client.callTool({ name: "list_tasks", arguments: { completed: false, offset: 100, max_chars: 2000 } }));
    assert.ok(page.length <= 2000); assert.match(page, /total=119/); assert.match(page, /untrusted data/);
    assert.equal(requests[0].url.searchParams.get("include"), "pagination");
    const detail = readText(await client.callTool({ name: "get_task", arguments: { task_id: "t1", max_chars: 1000 } }));
    assert.ok(detail.length <= 1000); assert.match(detail, /External ingress: untrusted data/);
    assert.match(detail, /Next text cursor/); assert.doesNotMatch(detail, /NEVER-ECHO-TASK-CONTEXT/);
    const created = readText(await client.callTool({ name: "create_task", arguments: { content: "fixture" } }));
    assert.ok(created.length < 1500); assert.match(created, /Task created/); assert.match(created, /Handoff preview/);
    assert.doesNotMatch(created, /NEVER-ECHO-TASK-CONTEXT/);
    const summary = readText(await client.callTool({ name: "get_task_context", arguments: { task_id: "t1" } }));
    assert.match(summary, /working/); assert.match(summary, /Complete JSON document/);
    assert.equal(requests.at(-1)!.url.searchParams.get("view"), "summary");
    let cursor: string | undefined;
    const fragments: string[] = [];
    do {
      const result = await client.callTool({ name: "get_task_context", arguments: { task_id: "t1", keys: ["large"], max_chars: 2000, ...(cursor ? { cursor } : {}) } });
      assert.notEqual(result.isError, true);
      const text = readText(result); assert.ok(text.length <= 2000);
      const start = text.indexOf("\n", text.indexOf("JSON fragment")) + 1;
      const footer = text.lastIndexOf("\nNext text cursor:");
      fragments.push(text.slice(start, footer >= 0 ? footer : text.lastIndexOf("\nEnd of document.")));
      cursor = /Next text cursor: (\S+)/.exec(text)?.[1];
    } while (cursor);
    assert.deepEqual(JSON.parse(fragments.join("")), { context: { large: "😀".repeat(9000) }, version: 5, missing_keys: [] });
    const ack = readText(await client.callTool({ name: "update_task_context", arguments: { task_id: "t1", context: { next_step: "test" }, expected_version: 4 } }));
    assert.match(ack, /now version 5/); assert.doesNotMatch(ack, /NEVER-ECHO/); assert.ok(ack.length < 1000);
    conflict = true;
    const failed = await client.callTool({ name: "update_task_context", arguments: { task_id: "t1", context: { next_step: "test" }, expected_version: 4 } });
    assert.equal(failed.isError, true); assert.match(readText(failed), /Write NOT applied/); assert.doesNotMatch(readText(failed), /NEVER-ECHO/);
    assert.equal(requests.filter(x => x.method === "PATCH").length, 2, "no automatic mutation retry");
    const history = readText(await client.callTool({ name: "get_context_history", arguments: { task_id: "t1", key: "history", limit: 2, history_cursor: "7", max_chars: 1500 } }));
    assert.ok(history.length <= 1500); assert.match(history, /Next text cursor/);
    assert.equal(requests.at(-1)!.url.searchParams.get("cursor"), "7");
    assert.equal(requests.at(-1)!.url.searchParams.get("limit"), "2");
    assert.doesNotMatch(stderr, /NEVER-ECHO|fixture-only-not-a-live-key/);
  } finally {
    await client.close(); await transport.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
