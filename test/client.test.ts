import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DelegaClient } from "../src/delega-client.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls++;
    return handler(url, init);
  }) as typeof fetch;
  return {
    get calls() {
      return calls;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("DelegaClient.getTaskChain normalizes self-hosted {root: Task} to root_id", async () => {
  const selfHostedPayload = {
    root: { id: 42, content: "root task" },
    chain: [{ id: 42, content: "root task", delegation_depth: 0 }],
    depth: 0,
    completed_count: 0,
    total_count: 1,
  };
  const mock = mockFetch(() => jsonResponse(selfHostedPayload));
  try {
    const client = new DelegaClient("http://127.0.0.1:18890", "dlg_test_key");
    const result: any = await client.getTaskChain(42);
    assert.equal(result.root_id, 42);
    assert.equal(result.depth, 0);
    assert.equal(result.total_count, 1);
    assert.equal(mock.calls, 1);
  } finally {
    mock.restore();
  }
});

test("DelegaClient.getTaskChain passes through hosted {root_id} unchanged", async () => {
  const hostedPayload = {
    root_id: "abc123",
    chain: [{ id: "abc123", content: "root", delegation_depth: 0 }],
    depth: 0,
    completed_count: 0,
    total_count: 1,
  };
  const mock = mockFetch(() => jsonResponse(hostedPayload));
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    const result: any = await client.getTaskChain("abc123");
    assert.equal(result.root_id, "abc123");
    assert.equal(result.chain[0].id, "abc123");
  } finally {
    mock.restore();
  }
});

test("DelegaClient.getUsage gates client-side on self-hosted before any HTTP call", async () => {
  const mock = mockFetch(() => {
    throw new Error("fetch should not have been called");
  });
  try {
    const client = new DelegaClient("http://127.0.0.1:18890", "dlg_test_key");
    await assert.rejects(
      () => client.getUsage(),
      /get_usage is only available on the hosted Delega API/,
    );
    assert.equal(mock.calls, 0, "fetch should NOT be called when gate triggers");
  } finally {
    mock.restore();
  }
});

test("DelegaClient.getUsage hits /v1/usage on hosted", async () => {
  let capturedUrl = "";
  const mock = mockFetch((url) => {
    capturedUrl = url;
    return jsonResponse({ plan: "free", task_count_month: 0, task_limit: 1000, rate_limit_rpm: 60 });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    const usage: any = await client.getUsage();
    assert.equal(usage.plan, "free");
    assert.match(capturedUrl, /\/v1\/usage$/);
    assert.equal(mock.calls, 1);
  } finally {
    mock.restore();
  }
});

test("DelegaClient.updateTaskContext normalizes hosted bare-context vs self-hosted full-task", async () => {
  // Hosted returns the merged context object directly.
  const hostedMock = mockFetch(() => jsonResponse({ step: "done", count: 2 }));
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    const result = await client.updateTaskContext("t1", { count: 2 });
    assert.deepEqual(result.context, { step: "done", count: 2 });
    assert.equal(result.task, undefined);
  } finally {
    hostedMock.restore();
  }

  // Self-hosted returns the full task (id + content + context).
  const selfMock = mockFetch(() =>
    jsonResponse({
      id: 42,
      content: "t",
      completed: false,
      context: { step: "done", count: 2 },
    }),
  );
  try {
    const client = new DelegaClient("http://127.0.0.1:18890", "dlg_test_key");
    const result = await client.updateTaskContext(42, { count: 2 });
    assert.deepEqual(result.context, { step: "done", count: 2 });
    assert.equal(result.task?.id, 42);
  } finally {
    selfMock.restore();
  }
});
