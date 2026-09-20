import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DelegaApiError } from "./delega-client.js";
import { registerHumanRequestTools, type HumanRequestClient } from "./human-request-tools.js";

const TASK_ID = /^[a-f0-9]{32}$/;
const SCOPE_ERROR = "This task is outside the connector's configured task scope.";

class TaskScopeError extends Error {}

/** Host configuration, never an option supplied by a tool caller. */
export function parseHumanRequestTaskIds(value: string | undefined): string[] {
  const taskIds = value?.split(",").map(id => id.trim()) ?? [];
  if (!taskIds.length || taskIds.some(id => !TASK_ID.test(id))) {
    throw new Error("Configure DELEGA_HUMAN_REQUEST_TASK_IDS with comma-separated exact task IDs.");
  }
  return [...new Set(taskIds)];
}

function connectorError(error: unknown): CallToolResult {
  // Do not forward backend response bodies, network causes, URLs, headers, or
  // debug/reveal settings into the originating agent's context or stderr.
  let message = "Delega request failed. The outcome is unknown; inspect status before retrying a mutation.";
  if (error instanceof TaskScopeError) message = SCOPE_ERROR;
  else if (error instanceof DelegaApiError) {
    switch (error.status) {
      case 400: case 422: message = "Delega rejected the input. Check the checklist and version fields."; break;
      case 401: case 403: message = "Delega denied this request. The host operator must check access."; break;
      case 404: message = "The request is unavailable. Check the task and feature activation with the host operator."; break;
      case 409: message = "Delega reported a state conflict. Read current request state; do not change scope or retry blindly."; break;
      case 429: message = "Delega rate limit reached. Defer further calls."; break;
    }
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Four tools only; no network listener, identity provider, or execution loop. */
export function createHumanRequestConnector(options: {
  client: HumanRequestClient;
  taskIds: readonly string[];
  version: string;
}): McpServer {
  if (!options.taskIds.length || options.taskIds.some(id => !TASK_ID.test(id))) {
    throw new Error("The human-request connector requires a nonempty set of exact task IDs.");
  }
  // Copy at startup so later mutation of the configuration array cannot widen it.
  const allowed = new Set(options.taskIds);
  const authorize = (taskId: string) => {
    if (!allowed.has(taskId)) throw new TaskScopeError(SCOPE_ERROR);
  };
  const scoped: HumanRequestClient = {
    async registerHumanRequest(taskId, input) {
      authorize(taskId);
      return options.client.registerHumanRequest(taskId, input);
    },
    async getHumanRequest(taskId, result) {
      authorize(taskId);
      return options.client.getHumanRequest(taskId, result);
    },
    async cancelHumanRequest(taskId, expectedVersion) {
      authorize(taskId);
      return options.client.cancelHumanRequest(taskId, expectedVersion);
    },
  };
  const server = new McpServer({ name: "delega-human-requests", version: options.version });
  registerHumanRequestTools(server, scoped, connectorError);
  return server;
}
