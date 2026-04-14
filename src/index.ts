import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DelegaApiError, DelegaClient } from "./delega-client.js";
import { formatAgent as formatAgentBase, formatProject, formatTask } from "./formatters.js";

// DELEGA_AGENT_KEY authenticates as a specific agent (tracks task ownership)
const client = new DelegaClient(
  process.env.DELEGA_API_URL,
  process.env.DELEGA_AGENT_KEY,
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

// ── Server ──

const server = new McpServer({
  name: "delega-mcp",
  version: "1.0.0",
});

// ── list_tasks ──

server.tool(
  "list_tasks",
  "List tasks from Delega, optionally filtered by project, label, due date, or completion status",
  {
    project_id: z.number().int().optional().describe("Filter by project ID"),
    label: z.string().optional().describe("Filter by label name"),
    due: z
      .enum(["today", "upcoming", "overdue"])
      .optional()
      .describe("Filter by due date category"),
    completed: z.boolean().optional().describe("Filter by completion status"),
  },
  async ({ project_id, label, due, completed }) => {
    try {
      const tasks = await client.listTasks({ project_id, label, due, completed });
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
      return { content: [{ type: "text", text: formatTask(task) }] };
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
    project_id: z.number().int().optional().describe("Project ID to assign to"),
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
        content: [{ type: "text", text: `Task created:\n\n${formatTask(task)}` }],
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
    project_id: z.number().int().optional().describe("Move to project ID"),
    assigned_to_agent_id: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .describe("Assign to agent ID, or null to unassign"),
  },
  async ({ task_id, ...updates }) => {
    try {
      const task = await client.updateTask(task_id, updates);
      return {
        content: [{ type: "text", text: `Task updated:\n\n${formatTask(task)}` }],
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
        content: [{ type: "text", text: `Task ${verb}:\n\n${formatTask(task)}` }],
      };
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
    permissions: z.array(z.string()).optional().describe("Permission scopes (e.g. ['tasks:read', 'tasks:write'])"),
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
  "Create a webhook to receive event notifications (admin only). Events: task.created, task.updated, task.completed, task.deleted, task.assigned, task.commented",
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
          "task.commented",
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
