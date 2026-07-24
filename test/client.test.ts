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
      /get_usage is only available on the Delega API/,
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

test("DelegaClient.updateTaskContext passes provenance source", async () => {
  let capturedUrl = "";
  const mock = mockFetch((url) => {
    capturedUrl = String(url);
    return jsonResponse({ context: { step: "done" }, version: 4 });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.updateTaskContext("t1", { step: "done" }, 3, "human_stated");
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t1/context?expected_version=3&source=human_stated");
  } finally {
    mock.restore();
  }
});

test("DelegaClient.getTaskContext can request provenance", async () => {
  let capturedUrl = "";
  const mock = mockFetch((url) => {
    capturedUrl = String(url);
    return jsonResponse({ context: { step: "done" }, version: 4, provenance: {} });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.getTaskContext("t1", true);
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t1/context?include=provenance");
  } finally {
    mock.restore();
  }
});

test("DelegaClient task link methods call hosted link endpoints", async () => {
  const captured: Array<{ url: string; method?: string; body?: any }> = [];
  const mock = mockFetch((url, init) => {
    captured.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return jsonResponse(init?.method === "POST"
      ? { id: "lnk1", kind: "branch", repo: "delega-dev/delega-api", ref: "main" }
      : [{ id: "lnk1", kind: "branch", repo: "delega-dev/delega-api", ref: "main" }]);
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.linkTask("t1", { kind: "branch", repo: "delega-dev/delega-api", ref: "main", url: null });
    await client.listTaskLinks("t1");
    assert.deepEqual(captured, [
      {
        url: "https://api.delega.dev/v1/tasks/t1/links",
        method: "POST",
        body: { kind: "branch", repo: "delega-dev/delega-api", ref: "main", url: null },
      },
      {
        url: "https://api.delega.dev/v1/tasks/t1/links",
        method: "GET",
        body: undefined,
      },
    ]);
  } finally {
    mock.restore();
  }
});

test("DelegaClient recurrence methods call hosted recurrence endpoints", async () => {
  const captured: Array<{ url: string; method?: string; body?: any }> = [];
  const mock = mockFetch((url, init) => {
    captured.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (init?.method === "GET") return jsonResponse([]);
    if (init?.method === "DELETE") return jsonResponse({ ok: true });
    return jsonResponse({
      id: "rec1",
      content: "Replace furnace filter",
      rule_type: "monthly",
      interval: 1,
      timezone: "America/Chicago",
      anchor_day: 1,
      next_due_at: "2026-07-01T05:00:00.000Z",
    });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.listRecurrences();
    await client.createRecurrence({
      content: "Replace furnace filter",
      rule_type: "monthly",
      interval: 1,
      timezone: "America/Chicago",
      anchor_day: 1,
    });
    await client.updateRecurrence("rec/with?query=true", { active: false });
    await client.deleteRecurrence("rec/with?query=true");

    assert.deepEqual(captured, [
      {
        url: "https://api.delega.dev/v1/recurrences",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.delega.dev/v1/recurrences",
        method: "POST",
        body: {
          content: "Replace furnace filter",
          rule_type: "monthly",
          interval: 1,
          timezone: "America/Chicago",
          anchor_day: 1,
        },
      },
      {
        url: "https://api.delega.dev/v1/recurrences/rec%2Fwith%3Fquery%3Dtrue",
        method: "PUT",
        body: { active: false },
      },
      {
        url: "https://api.delega.dev/v1/recurrences/rec%2Fwith%3Fquery%3Dtrue",
        method: "DELETE",
        body: undefined,
      },
    ]);
  } finally {
    mock.restore();
  }
});

test("DelegaClient encodes path parameters before building URLs", async () => {
  const captured: string[] = [];
  const mock = mockFetch((url) => {
    captured.push(String(url));
    return jsonResponse({});
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.getTask("../agents?x=y");
    await client.assignTask("../agents?x=y", "agt_safe");
    await client.updateTaskContext("task/with?query=true", { step: "safe" }, 2);
    await client.deleteAgent("agt/with/slash");
    await client.deleteWebhook("wh?redirect=/tasks");

    assert.deepEqual(captured, [
      "https://api.delega.dev/v1/tasks/..%2Fagents%3Fx%3Dy",
      "https://api.delega.dev/v1/tasks/..%2Fagents%3Fx%3Dy",
      "https://api.delega.dev/v1/tasks/task%2Fwith%3Fquery%3Dtrue/context?expected_version=2",
      "https://api.delega.dev/v1/agents/agt%2Fwith%2Fslash",
      "https://api.delega.dev/v1/webhooks/wh%3Fredirect%3D%2Ftasks",
    ]);
  } finally {
    mock.restore();
  }
});

test("DelegaClient rejects URL-normalized dot-segment ids", async () => {
  const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
  for (const id of ["", ".", ".."]) {
    await assert.rejects(client.getTask(id), /unsafe id/);
    await assert.rejects(client.deleteAgent(id), /unsafe id/);
    await assert.rejects(client.deleteWebhook(id), /unsafe id/);
  }
});

test("DelegaClient.getContextHistory fetches all keys or one key", async () => {
  const captured: string[] = [];
  const mock = mockFetch((url) => {
    captured.push(String(url));
    return jsonResponse({ entries: [], next_cursor: null });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.getContextHistory("t1");
    await client.getContextHistory("t1", "step");
    assert.deepEqual(captured, [
      "https://api.delega.dev/v1/tasks/t1/context/history",
      "https://api.delega.dev/v1/tasks/t1/context/history?key=step",
    ]);
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
  await assert.rejects(() => client.claimTask({}), /available on the Delega API/);
  await assert.rejects(() => client.heartbeatTask("t1"), /available on the Delega API/);
  await assert.rejects(() => client.releaseTask("t1"), /available on the Delega API/);
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

test("DelegaClient.heartbeatTask posts state and detail alongside lease_seconds", async () => {
  let capturedUrl = "";
  let capturedBody: any = null;
  const mock = mockFetch((url, init) => {
    capturedUrl = String(url);
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ id: "t1", lease_expires_at: "2026-06-10 12:05:00", session_state: "waiting_input" });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.heartbeatTask("t1", 600, "waiting_input", "needs prod API key");
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t1/heartbeat");
    assert.deepEqual(capturedBody, { lease_seconds: 600, state: "waiting_input", detail: "needs prod API key" });
  } finally {
    mock.restore();
  }
});

test("DelegaClient.setTaskState posts to the state endpoint", async () => {
  let capturedUrl = "";
  let capturedBody: any = null;
  const mock = mockFetch((url, init) => {
    capturedUrl = String(url);
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ id: "t1", session_state: "errored", session_state_detail: "build failed" });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.setTaskState("t1", "errored", "build failed");
    assert.equal(capturedUrl, "https://api.delega.dev/v1/tasks/t1/state");
    assert.deepEqual(capturedBody, { state: "errored", detail: "build failed" });
  } finally {
    mock.restore();
  }
});

test("DelegaClient.setTaskState omits detail when not provided and rejects self-hosted", async () => {
  let capturedBody: any = null;
  const mock = mockFetch((_url, init) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ id: "t1", session_state: "working" });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.setTaskState("t1", "working");
    assert.deepEqual(capturedBody, { state: "working" });
  } finally {
    mock.restore();
  }
  const selfHosted = new DelegaClient("http://127.0.0.1:18890", "dlg_test_key");
  await assert.rejects(() => selfHosted.setTaskState("t1", "working"), /available on the Delega API/);
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

test("DelegaClient automation methods hit the /v1/automations endpoints", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const mock = mockFetch((url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return jsonResponse(calls.length === 1 ? [] : { id: "r1" });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.listAutomations();
    await client.createAutomation({
      name: "triage bugs",
      event: "task.created",
      conditions: [{ field: "label", op: "has", value: "bug" }],
      actions: [{ type: "set_priority", priority: 3 }],
    });
    await client.updateAutomation("r1", { active: false });
    await client.deleteAutomation("r1");

    assert.deepEqual(calls.map((c) => [c.method ?? "GET", c.url]), [
      ["GET", "https://api.delega.dev/v1/automations"],
      ["POST", "https://api.delega.dev/v1/automations"],
      ["PUT", "https://api.delega.dev/v1/automations/r1"],
      ["DELETE", "https://api.delega.dev/v1/automations/r1"],
    ]);
    assert.equal((calls[1].body as any).name, "triage bugs");
    assert.deepEqual((calls[2].body as any), { active: false });
  } finally {
    mock.restore();
  }
});

test("DelegaClient.updateAutomation rejects unsafe path segments", async () => {
  const mock = mockFetch(() => jsonResponse({}));
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await assert.rejects(() => client.updateAutomation("..", { active: false }));
    await assert.rejects(() => client.deleteAutomation(""));
    assert.equal(mock.calls, 0);
  } finally {
    mock.restore();
  }
});

test("DelegaClient ingress-source methods hit the /v1/ingress-sources endpoints", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const mock = mockFetch((url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return jsonResponse(calls.length === 1 ? [] : { id: "s1" });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.listIngressSources();
    await client.createIngressSource({
      name: "ci",
      template: { content: "CI failed: {{workflow.name}}", dedupe_key: "{{run.id}}" },
      filters: [{ path: "conclusion", op: "eq", value: "failure" }],
    });
    await client.updateIngressSource("s1", { rotate_secret: true });
    await client.deleteIngressSource("s1");

    assert.deepEqual(calls.map((c) => [c.method ?? "GET", c.url]), [
      ["GET", "https://api.delega.dev/v1/ingress-sources"],
      ["POST", "https://api.delega.dev/v1/ingress-sources"],
      ["PUT", "https://api.delega.dev/v1/ingress-sources/s1"],
      ["DELETE", "https://api.delega.dev/v1/ingress-sources/s1"],
    ]);
    assert.equal((calls[1].body as any).name, "ci");
    assert.deepEqual(calls[2].body, { rotate_secret: true });
  } finally {
    mock.restore();
  }
});

test("DelegaClient ingress-source methods reject unsafe path segments", async () => {
  const mock = mockFetch(() => jsonResponse({}));
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await assert.rejects(() => client.updateIngressSource("..", { active: false }));
    await assert.rejects(() => client.deleteIngressSource(""));
    assert.equal(mock.calls, 0);
  } finally {
    mock.restore();
  }
});

test("DelegaClient.completeTask sends evidence only when provided", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const mock = mockFetch((url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return jsonResponse({ id: "t1", completed: 1 });
  });
  try {
    const client = new DelegaClient("https://api.delega.dev", "dlg_test_key");
    await client.completeTask("t1");
    await client.completeTask("t1", [{ kind: "commit", ref: "abc123", summary: "the fix" }]);
    assert.equal(calls[0].body, undefined); // no body when no evidence
    assert.deepEqual((calls[1].body as any).evidence, [{ kind: "commit", ref: "abc123", summary: "the fix" }]);
    assert.equal(calls[1].url, "https://api.delega.dev/v1/tasks/t1/complete");
  } finally {
    mock.restore();
  }
});
