import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  formatChain,
  formatDedupResult,
  formatTask,
  formatTaskDetail,
  formatUsage,
} from "../src/formatters.js";

test("formatTask renders an unassigned task without assignment lines", () => {
  const out = formatTask({
    id: 1,
    content: "Write docs",
    completed: false,
  });
  assert.match(out, /^\[#1\] Write docs/);
  assert.doesNotMatch(out, /Assigned to:/);
  assert.doesNotMatch(out, /Created by:/);
  assert.doesNotMatch(out, /Completed by:/);
  assert.match(out, /Completed: no/);
});

test("formatTask shows agent name when self-hosted nested agent is present", () => {
  const out = formatTask({
    id: 42,
    content: "Ship feature",
    completed: false,
    assigned_to_agent: { id: 7, name: "coordinator", display_name: "Coordinator" },
    created_by_agent: { id: 3, name: "planner" },
  });
  assert.match(out, /Assigned to: Coordinator \(#7\)/);
  // Falls back to name when display_name is absent.
  assert.match(out, /Created by: planner \(#3\)/);
});

test("formatTask shows raw agent id when only hosted flat field is present", () => {
  const out = formatTask({
    id: "t_01HABC",
    content: "Migrate DB",
    completed: false,
    assigned_to_agent_id: "a_01XYZ",
    created_by_agent_id: "a_01AAA",
  });
  assert.match(out, /Assigned to: #a_01XYZ/);
  assert.match(out, /Created by: #a_01AAA/);
});

test("formatTask only shows 'Completed by' when the task is actually completed", () => {
  const openOut = formatTask({
    id: 5,
    content: "In progress",
    completed: false,
    completed_by_agent: { id: 9, name: "worker" },
  });
  assert.doesNotMatch(openOut, /Completed by:/);

  const doneOut = formatTask({
    id: 5,
    content: "Finished",
    completed: true,
    completed_by_agent: { id: 9, name: "worker", display_name: "Worker Bee" },
  });
  assert.match(doneOut, /Completed by: Worker Bee \(#9\)/);
});

test("formatTask output order is stable", () => {
  const out = formatTask({
    id: 1,
    content: "Do thing",
    description: "Context",
    project: { name: "Alpha" },
    labels: ["urgent"],
    priority: 3,
    due_date: "2026-04-20",
    status: "in_progress",
    assigned_to_agent: { id: 7, name: "coordinator" },
    created_by_agent: { id: 3, name: "planner" },
    delegation_depth: 1,
    parent_task_id: 99,
    root_task_id: 99,
    delegated_by_agent: { id: 3, name: "planner" },
    completed: true,
    completed_by_agent: { id: 7, name: "coordinator" },
    context: { step: "done" },
  });
  const lines = out.split("\n");
  assert.deepEqual(lines, [
    "[#1] Do thing",
    "  Description: Context",
    "  Project: Alpha",
    "  Labels: urgent",
    "  Priority: 3",
    "  Due: 2026-04-20",
    "  Status: in_progress",
    "  Assigned to: coordinator (#7)",
    "  Created by: planner (#3)",
    "  Delegation: depth 1, parent #99, root #99",
    "  Delegated by: planner (#3)",
    "  Completed: yes",
    "  Completed by: coordinator (#7)",
    "  Context keys: step (1)",
  ]);
});

// ── 1.2.0 additions ──

test("formatTask hides delegation block and status when task is a plain root", () => {
  const out = formatTask({
    id: 1,
    content: "Root task",
    completed: false,
    delegation_depth: 0,
    parent_task_id: null,
    root_task_id: null,
    status: "open",
  });
  assert.doesNotMatch(out, /Delegation:/);
  assert.doesNotMatch(out, /Delegated by:/);
  assert.doesNotMatch(out, /Status:/);
});

test("formatTask shows delegation block whenever depth>0 or parent is set", () => {
  const withDepth = formatTask({
    id: "child",
    content: "Child task",
    completed: false,
    delegation_depth: 2,
    parent_task_id: "abc",
    root_task_id: "xyz",
  });
  assert.match(withDepth, /Delegation: depth 2, parent #abc, root #xyz/);

  const withParentOnly = formatTask({
    id: 5,
    content: "Parented",
    completed: false,
    delegation_depth: 0,
    parent_task_id: 3,
  });
  assert.match(withParentOnly, /Delegation: depth 0, parent #3/);
});

test("formatTask shows Status only for non-default values", () => {
  const delegated = formatTask({ id: 1, content: "x", completed: false, status: "delegated" });
  assert.match(delegated, /Status: delegated/);

  const open = formatTask({ id: 1, content: "x", completed: false, status: "open" });
  assert.doesNotMatch(open, /Status:/);

  const pending = formatTask({ id: 1, content: "x", completed: false, status: "pending" });
  assert.doesNotMatch(pending, /Status:/);
});

test("formatTask renders Delegated by with both nested and flat shapes", () => {
  const nested = formatTask({
    id: 1,
    content: "x",
    completed: false,
    parent_task_id: 9,
    delegated_by_agent: { id: 7, name: "coordinator", display_name: "Coordinator" },
  });
  assert.match(nested, /Delegated by: Coordinator \(#7\)/);

  const flat = formatTask({
    id: "t1",
    content: "x",
    completed: false,
    parent_task_id: "p",
    delegated_by_agent_id: "agent_abc",
  });
  assert.match(flat, /Delegated by: #agent_abc/);
});

test("formatTask list view shows context keys with count, hides empty", () => {
  const populated = formatTask({
    id: 1,
    content: "x",
    completed: false,
    context: { step: "research", findings: ["a"] },
  });
  assert.match(populated, /Context keys: step, findings \(2\)/);

  const empty = formatTask({ id: 1, content: "x", completed: false, context: {} });
  assert.doesNotMatch(empty, /Context/);

  const missing = formatTask({ id: 1, content: "x", completed: false });
  assert.doesNotMatch(missing, /Context/);
});

test("formatTaskDetail pretty-prints context", () => {
  const out = formatTaskDetail({
    id: 1,
    content: "x",
    completed: false,
    context: { step: "done", notes: ["one", "two"] },
  });
  assert.match(out, /  Context:/);
  assert.match(out, /    {/);
  assert.match(out, /"step": "done"/);
  assert.match(out, /"notes": \[/);
  // Detail view must NOT also render the "Context keys" list-view line.
  assert.doesNotMatch(out, /Context keys:/);
});

test("formatTaskDetail truncates oversized context blobs", () => {
  const big = { data: "x".repeat(3000) };
  const out = formatTaskDetail({ id: 1, content: "x", completed: false, context: big });
  assert.match(out, /… \(truncated, \d+ more chars\)/);
});

test("formatTaskDetail omits context block when context is empty or missing", () => {
  const empty = formatTaskDetail({ id: 1, content: "x", completed: false, context: {} });
  assert.doesNotMatch(empty, /Context:/);
  const missing = formatTaskDetail({ id: 1, content: "x", completed: false });
  assert.doesNotMatch(missing, /Context:/);
});

test("formatTask parses JSON-string context returned by hosted backend", () => {
  // Hosted (D1/SQLite) returns context as a JSON-encoded string.
  const populated = formatTask({
    id: "t1",
    content: "x",
    completed: false,
    context: '{"step":"research_done","count":3}',
  });
  assert.match(populated, /Context keys: step, count \(2\)/);

  const empty = formatTask({ id: "t1", content: "x", completed: false, context: "{}" });
  assert.doesNotMatch(empty, /Context/);
});

test("formatTaskDetail parses JSON-string context and pretty-prints it", () => {
  const out = formatTaskDetail({
    id: "t1",
    content: "x",
    completed: false,
    context: '{"step":"research_done","findings":["a","b"]}',
  });
  assert.match(out, /  Context:/);
  assert.match(out, /"step": "research_done"/);
  assert.match(out, /"findings": \[/);
});

test("formatChain indents nodes by depth and shows tallies in header", () => {
  const out = formatChain({
    root_id: "abc",
    depth: 2,
    completed_count: 2,
    total_count: 4,
    chain: [
      { id: "abc", content: "Write report", delegation_depth: 0, status: "delegated" },
      { id: "def", content: "Draft intro", delegation_depth: 1, status: "completed", completed: true },
      { id: "ghi", content: "Research sources", delegation_depth: 2, status: "completed", completed: true },
      { id: "jkl", content: "Draft conclusion", delegation_depth: 1, completed: false },
    ],
  });
  // Chain is stably sorted by depth (matches the API's own ordering: depth ASC, created_at ASC).
  const lines = out.split("\n");
  assert.equal(lines[0], "Delegation chain (root #abc, depth 2, 2/4 complete):");
  assert.equal(lines[1], "  [#abc] Write report (depth 0, delegated)");
  assert.equal(lines[2], "    [#def] Draft intro (depth 1, completed)");
  assert.equal(lines[3], "    [#jkl] Draft conclusion (depth 1, pending)");
  assert.equal(lines[4], "      [#ghi] Research sources (depth 2, completed)");
});

test("formatChain handles empty chain gracefully", () => {
  const out = formatChain({
    root_id: 42,
    chain: [],
    depth: 0,
    completed_count: 0,
    total_count: 0,
  });
  assert.match(out, /Delegation chain \(root #42/);
  assert.match(out, /\(empty chain\)/);
});

test("formatDedupResult renders no-match and match states, with int and string task ids", () => {
  const empty = formatDedupResult({ has_duplicates: false, matches: [] });
  assert.equal(empty, "No duplicates found.");

  const hosted = formatDedupResult({
    has_duplicates: true,
    matches: [{ task_id: "abc123", content: "Research pricing", score: 0.85 }],
  });
  assert.match(hosted, /Found 1 possible duplicate:/);
  assert.match(hosted, /\[#abc123\] Research pricing \(score 0\.85\)/);

  const selfHosted = formatDedupResult({
    has_duplicates: true,
    matches: [
      { task_id: 42, content: "Foo", score: 0.72 },
      { task_id: 43, content: "Bar", score: 0.61 },
    ],
  });
  assert.match(selfHosted, /Found 2 possible duplicates:/);
  assert.match(selfHosted, /\[#42\] Foo \(score 0\.72\)/);
  assert.match(selfHosted, /\[#43\] Bar \(score 0\.61\)/);
});

test("formatUsage renders representative hosted payload", () => {
  const out = formatUsage({
    plan: "free",
    task_count_month: 142,
    task_limit: 1000,
    reset_date: "2026-05-01T00:00:00.000Z",
    agent_count: 3,
    agent_limit: null,
    webhook_count: 1,
    webhook_limit: 5,
    project_count: 4,
    project_limit: 100,
    rate_limit_rpm: 60,
    max_content_chars: 2000,
  });
  assert.match(out, /^Usage:/);
  assert.match(out, /Plan: free/);
  assert.match(out, /Tasks: 142\/1000 \(resets 2026-05-01T00:00:00.000Z\)/);
  assert.match(out, /Agents: 3\/unlimited/);
  assert.match(out, /Webhooks: 1\/5/);
  assert.match(out, /Projects: 4\/100/);
  assert.match(out, /Rate limit: 60 req\/min/);
});
