import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DelegaClient } from "./delega-client.js";

// Support both DELEGA_API_URL and legacy DELEGA_API_URL
// DELEGA_AGENT_KEY authenticates as a specific agent (tracks task ownership)
const client = new DelegaClient(
  process.env.DELEGA_API_URL || process.env.DELEGA_API_URL,
  process.env.DELEGA_AGENT_KEY,
);

// ── Formatting helpers ──

function formatTask(t: any): string {
  const lines: string[] = [];
  lines.push(`[#${t.id}] ${t.content}`);
  if (t.description) lines.push(`  Description: ${t.description}`);
  if (t.project?.name ?? t.project_name)
    lines.push(`  Project: ${t.project?.name ?? t.project_name}`);
  if (t.labels?.length) lines.push(`  Labels: ${t.labels.join(", ")}`);
  if (t.priority) lines.push(`  Priority: ${t.priority}`);
  if (t.due_date) lines.push(`  Due: ${t.due_date}`);
  lines.push(`  Completed: ${t.completed ? "yes" : "no"}`);
  if (t.subtasks?.length) {
    lines.push(`  Subtasks:`);
    for (const s of t.subtasks) {
      lines.push(`    [#${s.id}] ${s.content} (${s.completed ? "done" : "pending"})`);
    }
  }
  return lines.join("\n");
}

function formatProject(p: any): string {
  return `[#${p.id}] ${p.name}`;
}

function formatAgent(a: any): string {
  const lines: string[] = [];
  lines.push(`[#${a.id}] ${a.name}${a.display_name ? ` (${a.display_name})` : ""}`);
  if (a.description) lines.push(`  Description: ${a.description}`);
  if (a.api_key) lines.push(`  API Key: ${a.api_key}`);
  if (a.permissions?.length) lines.push(`  Permissions: ${a.permissions.join(", ")}`);
  if (a.active !== undefined) lines.push(`  Active: ${a.active ? "yes" : "no"}`);
  return lines.join("\n");
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── get_task ──

server.tool(
  "get_task",
  "Get full details of a specific task including subtasks",
  {
    task_id: z.number().int().describe("The task ID"),
  },
  async ({ task_id }) => {
    try {
      const task = await client.getTask(task_id);
      return { content: [{ type: "text", text: formatTask(task) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── update_task ──

server.tool(
  "update_task",
  "Update an existing task's fields",
  {
    task_id: z.number().int().describe("The task ID to update"),
    content: z.string().optional().describe("New task title / content"),
    description: z.string().optional().describe("New description"),
    labels: z.array(z.string()).optional().describe("New labels"),
    priority: z.number().int().optional().describe("New priority (1-4)"),
    due_date: z.string().optional().describe("New due date (YYYY-MM-DD)"),
    project_id: z.number().int().optional().describe("Move to project ID"),
  },
  async ({ task_id, ...updates }) => {
    try {
      const task = await client.updateTask(task_id, updates);
      return {
        content: [{ type: "text", text: `Task updated:\n\n${formatTask(task)}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── complete_task ──

server.tool(
  "complete_task",
  "Mark a task as completed",
  {
    task_id: z.number().int().describe("The task ID to complete"),
  },
  async ({ task_id }) => {
    try {
      const task: any = await client.completeTask(task_id);
      let text = `Task #${task_id} completed.`;
      if (task?.next_occurrence) {
        text += `\nNext occurrence: ${task.next_occurrence}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── delete_task ──

server.tool(
  "delete_task",
  "Delete a task permanently",
  {
    task_id: z.number().int().describe("The task ID to delete"),
  },
  async ({ task_id }) => {
    try {
      await client.deleteTask(task_id);
      return {
        content: [{ type: "text", text: `Task #${task_id} deleted.` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ── add_comment ──

server.tool(
  "add_comment",
  "Add a comment to a task",
  {
    task_id: z.number().int().describe("The task ID to comment on"),
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
      return {
        content: [{ type: "text", text: `Agent registered:\n\n${formatAgent(agent)}\n\n⚠️ Save the API key — it won't be shown again.` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
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
