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

export function formatTask(t: any): string {
  const lines: string[] = [];
  lines.push(`[#${t.id}] ${t.content}`);
  if (t.description) lines.push(`  Description: ${t.description}`);
  if (t.project?.name ?? t.project_name)
    lines.push(`  Project: ${t.project?.name ?? t.project_name}`);

  const labels = Array.isArray(t.labels)
    ? t.labels
    : typeof t.labels === "string"
      ? (() => {
          try {
            const p = JSON.parse(t.labels);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  if (labels.length) lines.push(`  Labels: ${labels.join(", ")}`);
  if (t.priority) lines.push(`  Priority: ${t.priority}`);
  if (t.due_date) lines.push(`  Due: ${t.due_date}`);

  const assignee = formatAgentRef(t.assigned_to_agent, t.assigned_to_agent_id);
  if (assignee) lines.push(`  Assigned to: ${assignee}`);

  const creator = formatAgentRef(t.created_by_agent, t.created_by_agent_id);
  if (creator) lines.push(`  Created by: ${creator}`);

  lines.push(`  Completed: ${t.completed ? "yes" : "no"}`);

  const completer = formatAgentRef(t.completed_by_agent, t.completed_by_agent_id);
  if (completer && t.completed) lines.push(`  Completed by: ${completer}`);

  if (t.subtasks?.length) {
    lines.push(`  Subtasks:`);
    for (const s of t.subtasks) {
      lines.push(`    [#${s.id}] ${s.content} (${s.completed ? "done" : "pending"})`);
    }
  }
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
