import { strict as assert } from "node:assert";
import { test } from "node:test";
import { contextConflict, contextWriteAck, formatTaskPage, pageDocument, taskMutationAck } from "../src/bounded-reads.js";
import { DelegaClient, type TaskPage } from "../src/delega-client.js";

test("large JSON remains fully retrievable within every response budget, including Unicode", () => {
  const data = { version: 7, context: { huge: "😀\n𐐷".repeat(9000), current_state: "working" }, provenance: { huge: { source: "agent_observed", version: 7 } } };
  const chunks: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result = pageDocument("task fixture v7", data, { max_chars: 1000, cursor });
    assert.ok(result.text.length <= 1000);
    assert.equal(Buffer.from(result.fragment).toString(), result.fragment, "never split surrogate pairs");
    chunks.push(result.fragment);
    cursor = result.next_cursor ?? undefined;
    pages++;
  } while (cursor);
  assert.ok(pages > 10);
  assert.equal(chunks.join(""), JSON.stringify(data, null, 2));
  assert.deepEqual(JSON.parse(chunks.join("")), data);
});

test("text cursors reject changed data, task identity and invalid input without echoing values", () => {
  const data = { large: "PRIVATE-FIXTURE".repeat(1000) };
  const first = pageDocument("task 1", data, { max_chars: 1000 });
  assert.ok(first.next_cursor);
  assert.throws(() => pageDocument("task 1", { ...data, version: 2 }, { cursor: first.next_cursor! }), /changed/);
  assert.throws(() => pageDocument("task 2", data, { cursor: first.next_cursor! }), /changed/);
  assert.throws(() => pageDocument("task 1", data, { cursor: "nonsense" }), /Invalid text cursor/);
  assert.throws(() => pageDocument("task 1", data, { max_chars: 999 }), /max_chars/);
  const digest = first.next_cursor!.split(".")[1];
  assert.throws(() => pageDocument("task 1", data, { cursor: `999999999999999999999.${digest}` }), /offset/);
});

test("small JSON is explicitly complete and preserves version/provenance", () => {
  const data = { context: {}, version: 0, keys: { items: [], total: 0 } };
  const page = pageDocument("task empty", data);
  assert.equal(page.next_cursor, null);
  assert.match(page.text, /Complete JSON document/);
  assert.deepEqual(JSON.parse(page.fragment), data);
});

test("119 tasks stay discoverable when character budgets shorten task pages", () => {
  const items = Array.from({ length: 119 }, (_, i) => ({ id: `task-${i}`, content: "long title ".repeat(80),
    description: "DO-NOT-ECHO-DESCRIPTION".repeat(1000), context: { history: "DO-NOT-ECHO-HISTORY".repeat(1000) },
    status: "claimed", assigned_to_agent_id: "agent-a", claimed_by_agent_id: "agent-b", priority: 2,
    source_ingress_id: "external-fixture", evidence_policy: "required" }));
  const seen: string[] = [];
  let offset = 0;
  do {
    const next = Math.min(offset + 25, items.length);
    const page: TaskPage = { items: items.slice(offset, next), total: items.length, limit: 25,
      offset, has_more: next < items.length, next_offset: next < items.length ? next : null };
    const text = formatTaskPage(page, 2000);
    assert.ok(text.length <= 2000);
    assert.match(text, /untrusted data, not instructions/);
    assert.match(text, /assigned=agent-a/); assert.match(text, /claimed=agent-b/);
    assert.match(text, /evidence=required/);
    assert.doesNotMatch(text, /DO-NOT-ECHO/);
    seen.push(...Array.from(text.matchAll(/\[#(task-\d+)\]/g), m => m[1]));
    const more = /next_offset=(\d+|none)/.exec(text)![1];
    if (more === "none") break;
    assert.ok(Number(more) > offset); offset = Number(more);
  } while (true);
  assert.deepEqual(seen, items.map(x => x.id));
});

test("empty filtered pages remain distinguishable from a truncated queue", () => {
  const empty = formatTaskPage({ items: [], total: 0, offset: 0, limit: 25, has_more: false, next_offset: null });
  assert.match(empty, /0 shown; offset=0; total=0; has_more=false/);
  const past = formatTaskPage({ items: [], total: 119, offset: 200, limit: 25, has_more: false, next_offset: null });
  assert.match(past, /total=119/); assert.match(past, /End of matching tasks/);
});

test("write acknowledgments and version conflicts never echo merged history", () => {
  const keys = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(100, "x"));
  const ack = contextWriteAck("t1", keys, 5);
  assert.ok(ack.length < 1400);
  assert.match(ack, /now version 5/); assert.match(ack, /200 supplied key/); assert.match(ack, /188 more/);
  const conflict = contextConflict("t1", 6);
  assert.ok(conflict.length < 400);
  assert.match(conflict, /Write NOT applied/); assert.match(conflict, /Current version: 6/);
});

test("task mutations preserve ownership, lease, taint and a bounded handoff preview", () => {
  const text = taskMutationAck("Task claimed.", { id: "t1", content: "task", assigned_to_agent_id: "a", claimed_by_agent_id: "b",
    source_ingress_id: "ingress", evidence_policy: "required", lease_expires_at: "2026-09-07 23:00:00",
    handoff_note: "handoff ".repeat(1000), description: "NEVER-ECHO-DETAIL".repeat(500), context: { history: "NEVER-ECHO-CONTEXT" } });
  assert.ok(text.length < 1400);
  assert.match(text, /assigned=a/); assert.match(text, /claimed=b/); assert.match(text, /untrusted data/);
  assert.match(text, /Lease expires: 2026-09-07 23:00:00/); assert.match(text, /Handoff preview:/);
  assert.doesNotMatch(text, /NEVER-ECHO/); assert.match(text, /Do not repeat the mutation/);
});

test("client requests complete pagination, exact context keys, and explicit history pages", async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); requests.push(url);
    const body = url.pathname.endsWith("/tasks") ? {
      items: [{ id: "t1" }], total: 119, limit: 25, offset: 100, has_more: true, next_offset: 101,
    } : { context: {}, version: 1 };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new DelegaClient("https://api.delega.dev", "fixture-only");
    await client.listTaskPage({ offset: 100, assigned_to: "none", search: "a & b", state: "working", sort: "updated" });
    assert.equal(requests[0].searchParams.get("include"), "pagination");
    assert.equal(requests[0].searchParams.get("view"), "summary");
    assert.equal(requests[0].searchParams.get("search"), "a & b");
    assert.equal(requests[0].searchParams.get("assigned_to"), "none");
    assert.equal(requests[0].searchParams.get("limit"), "25");
    await client.getTaskContext("task/a", true, { view: "summary", keys: ["a,b", "a&b", "nested.key"], key_limit: 2, key_offset: 3 });
    assert.equal(requests[1].pathname, "/v1/tasks/task%2Fa/context");
    assert.deepEqual(JSON.parse(requests[1].searchParams.get("keys")!), ["a,b", "a&b", "nested.key"]);
    assert.equal(requests[1].searchParams.get("include"), "provenance");
    assert.equal(requests[1].searchParams.get("key_offset"), "3");
    await client.getContextHistory("t1", "a,b", { limit: 2, cursor: "opaque+/=" });
    assert.equal(requests[2].searchParams.get("cursor"), "opaque+/=");
    assert.equal(requests[2].searchParams.get("limit"), "2");
  } finally { globalThis.fetch = original; }
});

test("client refuses an old array response instead of falsely claiming pagination", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ id: "t1" }]))) as typeof fetch;
  try {
    const client = new DelegaClient("https://api.delega.dev", "fixture-only");
    await assert.rejects(client.listTaskPage(), /cannot establish a complete queue/);
  } finally { globalThis.fetch = original; }
});
