// Formatting helpers for Delega MCP output.
// Kept in a separate module so they can be unit-tested without starting the server.

function maskApiKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export function normalizePermissions(value: unknown, prefix = ""): string[] {
  if (value == null || value === false) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizePermissions(item, prefix));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return normalizePermissions(JSON.parse(trimmed), prefix);
      } catch {
        // Fall through to treating it as a plain permission string.
      }
    }
    return trimmed
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (prefix ? `${prefix}.${item}` : item));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      if (child === true) return [childPrefix];
      if (child == null || child === false) return [];

      const nested = normalizePermissions(child, childPrefix);
      return nested.length ? nested : [childPrefix];
    });
  }

  return prefix ? [prefix] : [];
}

// Render an agent reference in the most informative form available.
// Accepts either a nested agent object (flux: { id, name, display_name }) or a bare id.
// Returns null when there is nothing useful to show.
function formatAgentRef(
  nested: any,
  fallbackId: unknown,
): string | null {
  if (nested && typeof nested === "object") {
    const label = nested.display_name || nested.name;
    if (label) return `${label} (#${nested.id})`;
    if (nested.id !== undefined && nested.id !== null) return `#${nested.id}`;
  }
  if (fallbackId !== undefined && fallbackId !== null && fallbackId !== "") {
    return `#${fallbackId}`;
  }
  return null;
}

// "open" and "pending" are the API's "nothing interesting to report" statuses.
// Show the Status line only for richer values like "delegated", "in_progress", "blocked", "completed".
function isInterestingStatus(status: unknown): status is string {
  return typeof status === "string" && status !== "" && status !== "open" && status !== "pending";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Hosted API returns `context` as a JSON-encoded string (D1/SQLite text column).
// Self-hosted (Pydantic + SQLAlchemy JSON column) returns a parsed object.
// Normalize to a plain object or null so the formatter can handle both.
function normalizeContext(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (isPlainObject(raw)) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseLabels(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Build the common body of a task render. Callers decide whether to append a
// context-keys line (list view) or a pretty-printed context block (detail view),
// so the shared body stops right before the context section.
function formatTaskBody(t: any): string[] {
  const lines: string[] = [];
  lines.push(`[#${t.id}] ${t.content}`);
  if (t.description) lines.push(`  Description: ${t.description}`);
  if (t.project?.name ?? t.project_name)
    lines.push(`  Project: ${t.project?.name ?? t.project_name}`);

  const labels = parseLabels(t.labels);
  if (labels.length) lines.push(`  Labels: ${labels.join(", ")}`);
  if (t.priority) lines.push(`  Priority: ${t.priority}`);
  if (t.due_date) lines.push(`  Due: ${t.due_date}`);

  if (isInterestingStatus(t.status)) lines.push(`  Status: ${t.status}`);

  const assignee = formatAgentRef(t.assigned_to_agent, t.assigned_to_agent_id);
  if (assignee) lines.push(`  Assigned to: ${assignee}`);

  const creator = formatAgentRef(t.created_by_agent, t.created_by_agent_id);
  if (creator) lines.push(`  Created by: ${creator}`);

  // Delegation metadata — only show when the task is part of a chain.
  const depth = typeof t.delegation_depth === "number" ? t.delegation_depth : 0;
  const parent = t.parent_task_id ?? null;
  const root = t.root_task_id ?? null;
  if (depth > 0 || parent !== null) {
    const parts: string[] = [`depth ${depth}`];
    if (parent !== null) parts.push(`parent #${parent}`);
    if (root !== null) parts.push(`root #${root}`);
    lines.push(`  Delegation: ${parts.join(", ")}`);
  }

  const delegator = formatAgentRef(t.delegated_by_agent, t.delegated_by_agent_id);
  if (delegator) lines.push(`  Delegated by: ${delegator}`);

  lines.push(`  Completed: ${t.completed ? "yes" : "no"}`);

  const completer = formatAgentRef(t.completed_by_agent, t.completed_by_agent_id);
  if (completer && t.completed) lines.push(`  Completed by: ${completer}`);

  return lines;
}

function formatSubtaskLines(t: any): string[] {
  if (!t.subtasks?.length) return [];
  const out: string[] = ["  Subtasks:"];
  for (const s of t.subtasks) {
    out.push(`    [#${s.id}] ${s.content} (${s.completed ? "done" : "pending"})`);
  }
  return out;
}

// List-view render: include keys-only context (cheap, non-polluting).
export function formatTask(t: any): string {
  const lines = formatTaskBody(t);
  const ctx = normalizeContext(t.context);
  if (ctx) {
    const keys = Object.keys(ctx);
    if (keys.length) {
      lines.push(`  Context keys: ${keys.join(", ")} (${keys.length})`);
    }
  }
  lines.push(...formatSubtaskLines(t));
  return lines.join("\n");
}

const CONTEXT_MAX_CHARS = 2000;

function formatContextPretty(ctx: Record<string, unknown>): string[] {
  const pretty = JSON.stringify(ctx, null, 2);
  const truncated =
    pretty.length > CONTEXT_MAX_CHARS
      ? `${pretty.slice(0, CONTEXT_MAX_CHARS)}\n… (truncated, ${pretty.length - CONTEXT_MAX_CHARS} more chars)`
      : pretty;
  const indented = truncated
    .split("\n")
    .map((line) => `    ${line}`);
  return ["  Context:", ...indented];
}

// Detail-view render: pretty-print the context blob (truncated).
// Used for single-task tool results where the agent has asked for the full task.
export function formatTaskDetail(t: any): string {
  const lines = formatTaskBody(t);
  const ctx = normalizeContext(t.context);
  if (ctx && Object.keys(ctx).length) {
    lines.push(...formatContextPretty(ctx));
  }
  lines.push(...formatSubtaskLines(t));
  return lines.join("\n");
}

// Render a task node inside a delegation-chain tree.
function chainNodeStatus(task: any): string {
  if (typeof task.status === "string" && task.status !== "") {
    return task.status;
  }
  return task.completed ? "completed" : "pending";
}

export function formatChain(resp: {
  root_id: string | number;
  chain: any[];
  depth: number;
  completed_count: number;
  total_count: number;
}): string {
  const { root_id, chain, depth, completed_count, total_count } = resp;
  const header = `Delegation chain (root #${root_id}, depth ${depth}, ${completed_count}/${total_count} complete):`;
  const sorted = [...(chain ?? [])].sort((a, b) => {
    const da = typeof a.delegation_depth === "number" ? a.delegation_depth : 0;
    const db = typeof b.delegation_depth === "number" ? b.delegation_depth : 0;
    if (da !== db) return da - db;
    // Stable within a depth: keep input order.
    return 0;
  });
  const lines = [header];
  for (const node of sorted) {
    const d = typeof node.delegation_depth === "number" ? node.delegation_depth : 0;
    const indent = "  ".repeat(1 + d);
    lines.push(
      `${indent}[#${node.id}] ${node.content} (depth ${d}, ${chainNodeStatus(node)})`,
    );
  }
  if (!sorted.length) {
    lines.push("  (empty chain)");
  }
  return lines.join("\n");
}

export function formatDedupResult(resp: {
  has_duplicates: boolean;
  matches: Array<{ task_id: string | number; content: string; score: number }>;
}): string {
  const matches = resp?.matches ?? [];
  if (!matches.length) return "No duplicates found.";
  const header = `Found ${matches.length} possible duplicate${matches.length === 1 ? "" : "s"}:`;
  const lines = [header];
  for (const m of matches) {
    const score = typeof m.score === "number" ? m.score.toFixed(2) : String(m.score);
    lines.push(`  [#${m.task_id}] ${m.content} (score ${score})`);
  }
  return lines.join("\n");
}

function formatLimitValue(limit: unknown): string {
  if (limit === null || limit === undefined) return "unlimited";
  return String(limit);
}

export function formatUsage(u: any): string {
  const lines: string[] = ["Usage:"];
  if (u.plan) lines.push(`  Plan: ${u.plan}`);
  const taskCount = u.task_count_month ?? u.tasks_this_month ?? u.task_count;
  const taskLimit = u.task_limit ?? u.limit;
  if (taskCount !== undefined) {
    const reset = u.reset_date ?? u.resets_at;
    const resetLabel = reset ? ` (resets ${reset})` : "";
    lines.push(`  Tasks: ${taskCount}/${formatLimitValue(taskLimit)}${resetLabel}`);
  }
  if (u.agent_count !== undefined)
    lines.push(`  Agents: ${u.agent_count}/${formatLimitValue(u.agent_limit)}`);
  if (u.webhook_count !== undefined)
    lines.push(`  Webhooks: ${u.webhook_count}/${formatLimitValue(u.webhook_limit)}`);
  if (u.project_count !== undefined)
    lines.push(`  Projects: ${u.project_count}/${formatLimitValue(u.project_limit)}`);
  if (u.rate_limit_rpm !== undefined)
    lines.push(`  Rate limit: ${u.rate_limit_rpm} req/min`);
  if (u.max_content_chars !== undefined)
    lines.push(`  Max content chars: ${u.max_content_chars}`);
  return lines.join("\n");
}

export function formatProject(p: any): string {
  return `[#${p.id}] ${p.name}`;
}

export function formatAgent(a: any, options: { revealApiKey?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`[#${a.id}] ${a.name}${a.display_name ? ` (${a.display_name})` : ""}`);
  if (a.description) lines.push(`  Description: ${a.description}`);
  if (a.api_key) {
    if (options.revealApiKey) {
      lines.push(`  API Key: ${a.api_key}`);
    } else {
      lines.push(`  API Key Preview: ${maskApiKey(a.api_key)}`);
    }
  }
  const permissions = normalizePermissions(a.permissions);
  if (permissions.length) lines.push(`  Permissions: ${permissions.join(", ")}`);
  if (a.active !== undefined) lines.push(`  Active: ${a.active ? "yes" : "no"}`);
  return lines.join("\n");
}
