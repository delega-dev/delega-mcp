import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DelegaClient } from "./delega-client.js";

const taskId = z.string().regex(/^[a-f0-9]{32}$/).describe("Existing task's exact internal ID");
const version = z.number().int().min(0);
const criterion = z.string().min(1).max(65).refine(
  value => !!value.trim() && !/[\r\n]/.test(value) && !value.includes(" / "),
  "Use a short nonblank criterion without line breaks or option delimiters",
);

export type HumanRequestClient = Pick<DelegaClient,
  "registerHumanRequest" | "getHumanRequest" | "cancelHumanRequest">;

export function registerHumanRequestTools(server: McpServer, client: HumanRequestClient,
  onError: (error: unknown) => CallToolResult) {
  const run = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await operation(), null, 2) }] };
    } catch (error) { return onError(error); }
  };
  server.tool("register_human_request",
    "Register one immutable checklist on an existing open, unclaimed, autopilot-hold, evidence-required task assigned to the configured human-request runtime. Recipient is the existing self chat. Equal retries replay; different input conflicts. Registration does not send, run, claim, or grant execution approval. Hosted API must enable this feature.",
    { task_id: taskId, criteria: z.array(criterion).min(1).max(3).refine(values => new Set(values).size === values.length),
      expected_revision: version.describe("Current task revision"),
      timeout_seconds: z.number().int().min(60).max(1200).optional().describe("Bounded run length; default 1200 seconds") },
    async ({ task_id, ...input }) => run(() => client.registerHumanRequest(task_id, input)));
  server.tool("get_human_request",
    "Read a registered human request's immutable scope, phase, version and protected reply evidence. Read-only; never starts a run.",
    { task_id: taskId }, async ({ task_id }) => run(() => client.getHumanRequest(task_id)));
  server.tool("get_human_result",
    "Read the canonical human request result. Result is null until two affirmative task-bound replies and completion by the original executor/claim. Human attestation does not independently verify physical state. No recipient identifiers or bearer capabilities are returned.",
    { task_id: taskId }, async ({ task_id }) => run(() => client.getHumanRequest(task_id, true)));
  server.tool("cancel_human_request",
    "Record cancellation using the request version from get_human_request. Prevents new capabilities, accepted replies and completion; the controller releases its own claim. Does not take ownership or reopen completed work. Repeating an already-recorded cancellation is a no-op.",
    { task_id: taskId, expected_version: version.describe("Current human request version, not the task revision") },
    async ({ task_id, expected_version }) => run(() => client.cancelHumanRequest(task_id, expected_version)));
}
