import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatTask } from "../src/formatters.js";

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
    assigned_to_agent: { id: 7, name: "coordinator" },
    created_by_agent: { id: 3, name: "planner" },
    completed: true,
    completed_by_agent: { id: 7, name: "coordinator" },
  });
  const lines = out.split("\n");
  assert.deepEqual(lines, [
    "[#1] Do thing",
    "  Description: Context",
    "  Project: Alpha",
    "  Labels: urgent",
    "  Priority: 3",
    "  Due: 2026-04-20",
    "  Assigned to: coordinator (#7)",
    "  Created by: planner (#3)",
    "  Completed: yes",
    "  Completed by: coordinator (#7)",
  ]);
});
