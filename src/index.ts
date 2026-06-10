import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DelegaApiError, DelegaClient } from "./delega-client.js";
import {
  formatAgent as formatAgentBase,
  formatChain,
  formatDedupResult,
  formatProject,
  formatTask,
  formatTaskDetail,
  formatUsage,
} from "./formatters.js";

// DELEGA_AGENT_KEY authenticates as a specific agent (tracks task ownership).
// DELEGA_API_KEY is accepted as a fallback so the MCP, CLI, and SDK can share
// the same env var — agents configuring multiple Delega surfaces in one shell
// hit less friction.
const client = new DelegaClient(
  process.env.DELEGA_API_URL,
  process.env.DELEGA_AGENT_KEY || process.env.DELEGA_API_KEY,
);

function formatAgent(a: any): string {
  return formatAgentBase(a, {
    revealApiKey: process.env.DELEGA_REVEAL_AGENT_KEYS === "1",
  });
}

function sanitizeToolError(error: unknown): string {
  if (error instanceof DelegaApiError) {
    if (error.responseBody) {
      console.error("Delega API error response:", {
        status: error.status,
        statusText: error.statusText,
        body: error.responseBody,
      });
    }

    if (error.status === 400 || error.status === 422) {
      return "Delega API rejected the request. Check the tool inputs and try again.";
    }
    if (error.status === 401) {
      return "Delega API authentication failed. Check DELEGA_AGENT_KEY.";
    }
    if (error.status === 403) {
      return "Delega API denied this action.";
    }
    if (error.status === 404) {
      return "The requested Delega resource was not found.";
    }
    if (error.status >= 500) {
      return "Delega API returned a server error.";
    }
    return `Delega API request failed (${error.status} ${error.statusText}).`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error";
}

function toolErrorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${sanitizeToolError(error)}` }],
    isError: true,
  };
}

const projectRefSchema = z.union([z.string(), z.number()]);

// ── Server ──

const server = new McpServer({
  name: "delega-mcp",
  version: "1.2.1",
});

// ── list_tasks ──

server.tool(
  "list_tasks",
  "List tasks from Delega, scoped to tasks this agent created, was assigned, or completed. Optionally filtered by project, label, due date, or completion status. To resume work at the start of a session, call with completed:false to see your open tasks, then use get_task_context on each to recover prior decisions and state instead of starting from zero.",
  {
    project_id: projectRefSchema.optional().describe("Filter by project ID"),
    label: z.string().optional().describe("Filter by label name"),
    due: z
      .enum(["today", "upcoming", "overdue"])
      .optional()
      .describe("Filter by due date category"),
    completed: z.boolean().optional().describe("Filter by completion status"),
    claimed: z.boolean().optional().describe("Filter by claim status (true = currently claimed tasks)"),
  },
  async ({ project_id, label, due, completed, claimed }) => {
    try {
      const tasks = await client.listTasks({ project_id, label, due, completed, claimed });
      if (!tasks.length) {
        return { content: [{ type: "text", text: "No tasks found." }] };
      }
      const text = tasks.map(formatTask).join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── get_task ──

server.tool(
  "get_task",
  "Get full details of a specific task including subtasks",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID (use the ID from list_tasks, e.g. '3a7d...')"),
  },
  async ({ task_id }) => {
    try {
      const task = await client.getTask(task_id);
      return { content: [{ type: "text", text: formatTaskDetail(task) }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── create_task ──

server.tool(
  "create_task",
  "Create a new task in Delega",
  {
    content: z.string().describe("Task title / content"),
    description: z.string().optional().describe("Detailed description"),
    project_id: projectRefSchema.optional().describe("Project ID to assign to"),
    labels: z.array(z.string()).optional().describe("Labels to apply"),
    priority: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe("Priority: 1=normal, 2=medium, 3=high, 4=urgent"),
    due_date: z
      .string()
      .optional()
      .describe("Due date in YYYY-MM-DD format"),
  },
  async (params) => {
    try {
      const task = await client.createTask(params);
      return {
        content: [{ type: "text", text: `Task created:\n\n${formatTaskDetail(task)}` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── update_task ──

server.tool(
  "update_task",
  "Update an existing task's fields",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID to update"),
    content: z.string().optional().describe("New task title / content"),
    description: z.string().optional().describe("New description"),
    labels: z.array(z.string()).optional().describe("New labels"),
    priority: z.number().int().optional().describe("New priority (1-4)"),
    due_date: z.string().optional().describe("New due date (YYYY-MM-DD)"),
    project_id: projectRefSchema.optional().describe("Move to project ID"),
    assigned_to_agent_id: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .describe("Assign to agent ID, or null to unassign"),
  },
  async ({ task_id, ...updates }) => {
    try {
      const task = await client.updateTask(task_id, updates);
      return {
        content: [{ type: "text", text: `Task updated:\n\n${formatTaskDetail(task)}` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── assign_task ──

server.tool(
  "assign_task",
  "Assign a task to an agent (or unassign by passing null)",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID to assign"),
    agent_id: z
      .union([z.string(), z.number(), z.null()])
      .describe("Agent ID to assign the task to, or null to unassign"),
  },
  async ({ task_id, agent_id }) => {
    try {
      const task = await client.assignTask(task_id, agent_id);
      const verb = agent_id === null ? "unassigned" : "assigned";
      return {
        content: [{ type: "text", text: `Task ${verb}:\n\n${formatTaskDetail(task)}` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── delegate_task ──

server.tool(
  "delegate_task",
  "Delegate a task: create a child task linked to a parent. The parent's status flips to 'delegated'. Use this (not assign_task) for multi-agent handoffs so the delegation chain is recorded.",
  {
    task_id: z.union([z.string(), z.number()]).describe("Parent task ID to delegate from"),
    content: z.string().describe("Child task title / content"),
    description: z.string().optional().describe("Detailed description"),
    project_id: projectRefSchema.optional().describe("Project ID (admin only for non-self delegations)"),
    labels: z.array(z.string()).optional().describe("Labels to apply"),
    priority: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe("Priority: 1=normal, 2=medium, 3=high, 4=urgent"),
    due_date: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    assigned_to_agent_id: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Agent ID to assign the child task to"),
  },
  async ({ task_id, ...data }) => {
    try {
      const child = await client.delegateTask(task_id, data);
      return {
        content: [{ type: "text", text: `Task delegated:\n\n${formatTaskDetail(child)}` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── get_task_chain ──

server.tool(
  "get_task_chain",
  "Get the full delegation chain for a task (root + all descendants, sorted by depth). Use this to inspect parent/child accountability.",
  {
    task_id: z.union([z.string(), z.number()]).describe("Any task ID in the chain"),
  },
  async ({ task_id }) => {
    try {
      const chain = await client.getTaskChain(task_id);
      return { content: [{ type: "text", text: formatChain(chain) }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── get_task_context ──

server.tool(
  "get_task_context",
  "Read a task's persistent context blob — the shared state, decisions, and notes saved across sessions. Call this when resuming a task to recover what was decided and done before, so work continues instead of restarting. Pair with update_task_context to write state back before a session ends.",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID whose context to read"),
  },
  async ({ task_id }) => {
    try {
      const raw: any = await client.getTaskContext(task_id);
      const context = raw && typeof raw === "object" && "context" in raw ? raw.context : raw;
      const hasKeys = context && typeof context === "object" && Object.keys(context).length > 0;
      const text = hasKeys
        ? `Context for task #${task_id}:\n\n${JSON.stringify(context, null, 2)}`
        : `Task #${task_id} has no saved context yet.`;
      return { content: [{ type: "text", text }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── update_task_context ──

server.tool(
  "update_task_context",
  "Merge keys into a task's persistent context blob. Existing keys are preserved; supplied keys are added or overwritten. Use this to pass shared state between delegated agents instead of re-describing context in task descriptions.",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID whose context to update"),
    context: z
      .record(z.string(), z.unknown())
      .describe("Object whose keys are merged (not replaced) into existing context"),
  },
  async ({ task_id, context }) => {
    try {
      const { context: merged, task } = await client.updateTaskContext(task_id, context);
      const lines = [`Context updated for task #${task_id}.`, ""];
      if (task) {
        lines.push(formatTaskDetail(task));
      } else {
        lines.push("Merged context:");
        const pretty = JSON.stringify(merged, null, 2)
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n");
        lines.push(pretty);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── find_duplicate_tasks ──

server.tool(
  "find_duplicate_tasks",
  "Check whether a proposed task is similar to existing open tasks (TF-IDF + cosine similarity). Call this before create_task to avoid redundant work.",
  {
    content: z.string().describe("Proposed task content to check"),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Similarity threshold 0-1 (default 0.6)"),
  },
  async ({ content, threshold }) => {
    try {
      const result: any = await client.findDuplicateTasks(content, threshold);
      return { content: [{ type: "text", text: formatDedupResult(result) }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── get_usage ──

server.tool(
  "get_usage",
  "Get quota and rate-limit information for the current plan. Hosted API only (api.delega.dev) — self-hosted deployments will receive a clear error.",
  {},
  async () => {
    try {
      const usage: any = await client.getUsage();
      return { content: [{ type: "text", text: formatUsage(usage) }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── complete_task ──

server.tool(
  "complete_task",
  "Mark a task as completed",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID to complete"),
  },
  async ({ task_id }) => {
    try {
      const task: any = await client.completeTask(task_id);
      let text = `Task #${task_id} completed.`;
      if (task?.next_occurrence) {
        text += `\nNext occurrence: ${task.next_occurrence}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── claim_task ──

server.tool(
  "claim_task",
  "Claim a task for exclusive processing (work-queue semantics). Without task_id, atomically picks the highest-priority claimable task from the queue — open, unclaimed, and unassigned or assigned to you. With task_id, claims that specific task (e.g. one you found via list_tasks, or after a write was rejected with 'claim it first'); fails with a conflict if it is completed, assigned to another agent, or claimed with a live lease. Returns the claimed task, or reports an empty queue. The claim is a lease (default 300 seconds): extend it with heartbeat_task while working, requeue with release_task, or finish with complete_task. Hosted API only.",
  {
    task_id: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Claim this specific task instead of the next from the queue"),
    project_id: projectRefSchema.optional().describe("Only claim tasks in this project (queue claim only)"),
    labels: z.array(z.string()).optional().describe("Only claim tasks carrying all of these labels (queue claim only)"),
    lease_seconds: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe("Lease duration in seconds (30-3600, default 300)"),
  },
  async ({ task_id, project_id, labels, lease_seconds }) => {
    try {
      const resp = await client.claimTask({ task_id, project_id, labels, lease_seconds });
      if (!resp.task) {
        return { content: [{ type: "text", text: "No claimable tasks in the queue." }] };
      }
      const t = resp.task as any;
      return {
        content: [{
          type: "text",
          text: `Task claimed (lease expires ${t.lease_expires_at}):\n\n${formatTaskDetail(t)}`,
        }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── heartbeat_task ──

server.tool(
  "heartbeat_task",
  "Extend the lease on a task you have claimed. Call this periodically (before lease_expires_at) while working on a long task so the claim is not reclaimed by another agent. Fails with 409 if you no longer hold an active claim — in that case, claim a task again rather than continuing. Hosted API only.",
  {
    task_id: z.union([z.string(), z.number()]).describe("The claimed task ID"),
    lease_seconds: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe("New lease duration in seconds from now (30-3600, default 300)"),
  },
  async ({ task_id, lease_seconds }) => {
    try {
      const task: any = await client.heartbeatTask(task_id, lease_seconds);
      return {
        content: [{ type: "text", text: `Lease extended until ${task?.lease_expires_at}.` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── release_task ──

server.tool(
  "release_task",
  "Release a task you have claimed back to the queue without completing it. Use when you cannot finish the work or another agent should take over — the task returns to open status and becomes immediately claimable. Hosted API only.",
  {
    task_id: z.union([z.string(), z.number()]).describe("The claimed task ID to release"),
  },
  async ({ task_id }) => {
    try {
      await client.releaseTask(task_id);
      return {
        content: [{ type: "text", text: `Task #${task_id} released back to the queue.` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── delete_task ──

server.tool(
  "delete_task",
  "Delete a task permanently",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID to delete"),
  },
  async ({ task_id }) => {
    try {
      await client.deleteTask(task_id);
      return {
        content: [{ type: "text", text: `Task #${task_id} deleted.` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── add_comment ──

server.tool(
  "add_comment",
  "Add a comment to a task",
  {
    task_id: z.union([z.string(), z.number()]).describe("The task ID to comment on"),
    content: z.string().describe("Comment text"),
    author: z.string().optional().describe("Comment author name"),
  },
  async ({ task_id, content, author }) => {
    try {
      const comment: any = await client.addComment(task_id, { content, author });
      return {
        content: [
          {
            type: "text",
            text: `Comment added to task #${task_id}:\n  "${comment.content ?? content}"${comment.author ? ` — ${comment.author}` : ""}`,
          },
        ],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── list_projects ──

server.tool(
  "list_projects",
  "List all projects in Delega",
  {},
  async () => {
    try {
      const projects = await client.listProjects();
      if (!projects.length) {
        return { content: [{ type: "text", text: "No projects found." }] };
      }
      const text = projects.map(formatProject).join("\n");
      return { content: [{ type: "text", text }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── get_stats ──

server.tool(
  "get_stats",
  "Get task statistics from Delega (totals, completed today, due today, overdue, by project)",
  {},
  async () => {
    try {
      const stats: any = await client.getStats();
      const lines: string[] = ["Task Statistics:"];
      if (stats.total !== undefined) lines.push(`  Total tasks: ${stats.total}`);
      if (stats.completed_today !== undefined) lines.push(`  Completed today: ${stats.completed_today}`);
      if (stats.due_today !== undefined) lines.push(`  Due today: ${stats.due_today}`);
      if (stats.overdue !== undefined) lines.push(`  Overdue: ${stats.overdue}`);
      if (stats.by_project) {
        lines.push("  By project:");
        for (const [name, count] of Object.entries(stats.by_project)) {
          lines.push(`    ${name}: ${count}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── list_agents ──

server.tool(
  "list_agents",
  "List all registered agents in Delega",
  {},
  async () => {
    try {
      const agents = await client.listAgents();
      if (!agents.length) {
        return { content: [{ type: "text", text: "No agents registered." }] };
      }
      const text = agents.map(formatAgent).join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── register_agent ──

server.tool(
  "register_agent",
  "Register a new agent in Delega. Returns the API key (shown only at creation — save it!)",
  {
    name: z.string().describe("Unique agent name (e.g. 'coordinator', 'researcher')"),
    display_name: z.string().optional().describe("Human-readable name (e.g. 'Research Bot')"),
    description: z.string().optional().describe("What this agent does"),
    permissions: z.array(z.string()).optional().describe("Permission scopes, currently only ['tasks.read_all']"),
  },
  async (params) => {
    try {
      const agent = await client.registerAgent(params);
      const warning = process.env.DELEGA_REVEAL_AGENT_KEYS === "1"
        ? "\n\n⚠️ Save the API key — it won't be shown again."
        : "\n\nAPI keys are redacted by default in MCP output. Set DELEGA_REVEAL_AGENT_KEYS=1 to reveal them.";
      return {
        content: [{ type: "text", text: `Agent registered:\n\n${formatAgent(agent)}${warning}` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── delete_agent ──

server.tool(
  "delete_agent",
  "Delete an agent. The API may refuse if the agent has active tasks or is the last active agent.",
  {
    agent_id: z.union([z.string(), z.number()]).describe("Agent ID to delete"),
  },
  async ({ agent_id }) => {
    try {
      await client.deleteAgent(agent_id);
      return {
        content: [{ type: "text", text: `Agent #${agent_id} deleted.` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── list_webhooks ──

server.tool(
  "list_webhooks",
  "List all webhooks configured for your account (admin only)",
  {},
  async () => {
    try {
      const webhooks = await client.listWebhooks();
      if (!webhooks.length) {
        return { content: [{ type: "text", text: "No webhooks configured." }] };
      }
      const text = webhooks
        .map((w: any) =>
          `[#${w.id}] ${w.url}\n  Events: ${Array.isArray(w.events) ? w.events.join(", ") : w.events}\n  Active: ${w.active !== false ? "yes" : "no"}`,
        )
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── create_webhook ──

server.tool(
  "create_webhook",
  "Create a webhook to receive event notifications (admin only). Events: task.created, task.updated, task.completed, task.deleted, task.assigned, task.delegated, task.commented, task.claimed, task.released",
  {
    url: z.string().url().describe("HTTPS URL to receive webhook POST requests"),
    events: z
      .array(
        z.enum([
          "task.created",
          "task.updated",
          "task.completed",
          "task.deleted",
          "task.assigned",
          "task.delegated",
          "task.commented",
          "task.claimed",
          "task.released",
        ]),
      )
      .min(1)
      .describe("Events to subscribe to"),
  },
  async (params) => {
    try {
      const webhook = await client.createWebhook(params);
      const w = webhook as any;
      const lines = [
        `Webhook created:`,
        `  ID: ${w.id}`,
        `  URL: ${w.url}`,
        `  Events: ${Array.isArray(w.events) ? w.events.join(", ") : w.events}`,
      ];
      if (w.secret) {
        lines.push(`  Secret: ${w.secret}`);
        lines.push(`\n⚠️ Save the secret — it won't be shown again. Use it to verify webhook signatures.`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── delete_webhook ──

server.tool(
  "delete_webhook",
  "Delete a webhook by ID (admin only)",
  {
    webhook_id: z.union([z.string(), z.number()]).describe("Webhook ID to delete"),
  },
  async (params) => {
    try {
      await client.deleteWebhook(params.webhook_id);
      return {
        content: [{ type: "text", text: `Webhook #${params.webhook_id} deleted.` }],
      };
    } catch (error: unknown) {
      return toolErrorResult(error);
    }
  },
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
