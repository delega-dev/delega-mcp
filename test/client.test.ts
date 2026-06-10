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

test("DelegaClient preserves external string project IDs in task requests", async () => {
  const captured: Array<{ url: string; body?: any }> = [];
  const mock = mockFetch((url, init) => {
    captured.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return jsonResponse([]);
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.listTasks({ project_id: "prj_external_123" });
    await client.createTask({ content: "external project", project_id: "prj_external_123" });
    await client.updateTask("tsk_123", { project_id: "prj_external_456" });
    await client.delegateTask("tsk_123", { content: "child", project_id: "prj_external_789" });

    assert.match(captured[0].url, /\/v1\/tasks\?project_id=prj_external_123$/);
    assert.equal(captured[1].body.project_id, "prj_external_123");
    assert.equal(captured[2].body.project_id, "prj_external_456");
    assert.equal(captured[3].body.project_id, "prj_external_789");
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

test("DelegaClient.updateTaskContext passes expected_version and parses { context, version }", async () => {
  let capturedUrl = "";
  const mock = mockFetch((url) => {
    capturedUrl = String(url);
    return jsonResponse({ context: { step: "done" }, version: 4 });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    const result = await client.updateTaskContext("t1", { step: "done" }, 3);
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t1/context?expected_version=3");
    assert.deepEqual(result.context, { step: "done" });
    assert.equal(result.version, 4);
    assert.equal(result.task, undefined);
  } finally {
    mock.restore();
  }
});

test("DelegaClient.claimTask posts filters and returns the claimed task", async () => {
  let capturedUrl = "";
  let capturedBody: any = null;
  const mock = mockFetch((url, init) => {
    capturedUrl = String(url);
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ task: { id: "t1", status: "claimed", lease_expires_at: "2026-06-10 12:00:00" } });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    const result = await client.claimTask({ labels: ["bug"], lease_seconds: 120 });
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/claim");
    assert.deepEqual(capturedBody, { labels: ["bug"], lease_seconds: 120 });
    assert.equal((result.task as any).status, "claimed");
  } finally {
    mock.restore();
  }
});

test("DelegaClient.claimTask with task_id posts a targeted claim", async () => {
  let capturedUrl = "";
  let capturedBody: any = null;
  const mock = mockFetch((url, init) => {
    capturedUrl = String(url);
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ task: { id: "t9", status: "claimed", lease_expires_at: "2026-06-10 12:00:00" } });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    // Queue-only filters must not leak into the targeted claim body
    const result = await client.claimTask({ task_id: "t9", labels: ["bug"], lease_seconds: 120 });
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t9/claim");
    assert.deepEqual(capturedBody, { lease_seconds: 120 });
    assert.equal((result.task as any).id, "t9");
  } finally {
    mock.restore();
  }
});

test("DelegaClient.claimTask surfaces an empty queue as task: null", async () => {
  const mock = mockFetch(() => jsonResponse({ task: null }));
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    const result = await client.claimTask({});
    assert.equal(result.task, null);
  } finally {
    mock.restore();
  }
});

test("DelegaClient claiming methods reject self-hosted base URLs", async () => {
  const client = new DelegaClient("http://127.0.0.1:18890", "dlg_test_key");
  await assert.rejects(() => client.claimTask({}), /hosted Delega API/);
  await assert.rejects(() => client.heartbeatTask("t1"), /hosted Delega API/);
  await assert.rejects(() => client.releaseTask("t1"), /hosted Delega API/);
});

test("DelegaClient.heartbeatTask posts lease_seconds to the heartbeat endpoint", async () => {
  let capturedUrl = "";
  let capturedBody: any = null;
  const mock = mockFetch((url, init) => {
    capturedUrl = String(url);
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ id: "t1", lease_expires_at: "2026-06-10 12:05:00" });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.heartbeatTask("t1", 600);
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t1/heartbeat");
    assert.deepEqual(capturedBody, { lease_seconds: 600 });
  } finally {
    mock.restore();
  }
});

test("DelegaClient.releaseTask posts to the release endpoint", async () => {
  let capturedUrl = "";
  const mock = mockFetch((url) => {
    capturedUrl = String(url);
    return jsonResponse({ id: "t1", status: "open", claimed_by_agent_id: null });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    const task: any = await client.releaseTask("t1");
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t1/release");
    assert.equal(task.status, "open");
  } finally {
    mock.restore();
  }
});

test("DelegaClient.listTasks passes the claimed filter", async () => {
  let capturedUrl = "";
  const mock = mockFetch((url) => {
    capturedUrl = String(url);
    return jsonResponse([]);
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.listTasks({ claimed: true });
    assert.ok(capturedUrl.includes("claimed=true"));
  } finally {
    mock.restore();
  }
});
