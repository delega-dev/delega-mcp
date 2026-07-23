const DEFAULT_BASE_URL = "https://api.delega.dev";
const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1"]);
type ProjectRef = string | number;
export type ContextSource = "human_stated" | "agent_inferred" | "agent_observed" | "imported";
export type TaskLinkKind = "branch" | "commit" | "pr" | "url";
export type RecurrenceRuleType = "daily" | "weekly" | "monthly" | "yearly";

export interface TaskLinkInput {
  kind: TaskLinkKind;
  repo?: string | null;
  ref: string;
  url?: string | null;
}

export interface RecurrenceInput {
  content?: string;
  description?: string | null;
  project_id?: ProjectRef | null;
  labels?: string[];
  priority?: number;
  assigned_to_agent_id?: string | number | null;
  rule_type?: RecurrenceRuleType;
  interval?: number;
  timezone?: string;
  anchor_day?: number | null;
  anchor_month?: number | null;
  anchor_weekday?: number | null;
  next_due_at?: string | null;
  active?: boolean;
  skip_if_open?: boolean;
}

export class DelegaApiError extends Error {
  status: number;
  statusText: string;
  responseBody: string;

  constructor(status: number, statusText: string, responseBody: string) {
    super(`Delega API request failed (${status} ${statusText})`);
    this.name = "DelegaApiError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
  }
}

function normalizeBaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && !LOCAL_API_HOSTS.has(parsed.hostname)) {
    throw new Error("Delega API URL must use HTTPS unless it points to localhost");
  }
  return rawUrl.replace(/\/+$/, "");
}

function pathSegment(value: string | number): string {
  const raw = String(value);
  // URL normalizers collapse literal dot segments even though
  // encodeURIComponent leaves them unchanged.
  if (raw === "" || raw === "." || raw === "..") {
    throw new Error(`Refusing to build an API path from unsafe id: ${JSON.stringify(raw)}`);
  }
  return encodeURIComponent(raw);
}

export class DelegaClient {
  private baseUrl: string;
  private agentKey?: string;
  private pathPrefix: string;

  constructor(baseUrl?: string, agentKey?: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl || DEFAULT_BASE_URL);
    this.agentKey = agentKey;
    // Hosted API (api.delega.dev) uses /v1/ prefix, custom /api-style endpoints use /api/
    this.pathPrefix = new URL(this.baseUrl).hostname === "api.delega.dev" ? "/v1" : "/api";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.agentKey) {
      headers["X-Agent-Key"] = this.agentKey;
    }

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DelegaApiError(res.status, res.statusText, text);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  // ── Tasks ──

  async listTasks(params: {
    project_id?: ProjectRef;
    label?: string;
    due?: "today" | "upcoming" | "overdue";
    completed?: boolean;
    claimed?: boolean;
  }) {
    const query: Record<string, string> = {};
    if (params.project_id !== undefined) query.project_id = String(params.project_id);
    if (params.label !== undefined) query.label = params.label;
    if (params.due !== undefined) query.due = params.due;
    if (params.completed !== undefined) query.completed = String(params.completed);
    if (params.claimed !== undefined) query.claimed = String(params.claimed);

    return this.request<unknown[]>("GET", `${this.pathPrefix}/tasks`, undefined, query);
  }

  async getTask(taskId: string | number) {
    return this.request<unknown>("GET", `${this.pathPrefix}/tasks/${pathSegment(taskId)}`);
  }

  async listTaskLinks(taskId: string | number) {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/tasks/${pathSegment(taskId)}/links`);
  }

  async linkTask(taskId: string | number, link: TaskLinkInput) {
    return this.request<unknown>("POST", `${this.pathPrefix}/tasks/${pathSegment(taskId)}/links`, link);
  }

  async getTaskContext(taskId: string | number, includeProvenance?: boolean) {
    const query = includeProvenance ? { include: "provenance" } : undefined;
    return this.request<unknown>("GET", `${this.pathPrefix}/tasks/${pathSegment(taskId)}/context`, undefined, query);
  }

  async createTask(data: {
    content: string;
    description?: string;
    project_id?: ProjectRef;
    labels?: string[];
    priority?: number;
    due_date?: string;
  }) {
    return this.request<unknown>("POST", `${this.pathPrefix}/tasks`, data);
  }

  async updateTask(
    taskId: string | number,
    data: {
      content?: string;
      description?: string;
      labels?: string[];
      priority?: number;
      due_date?: string;
      project_id?: ProjectRef;
      assigned_to_agent_id?: string | number | null;
    },
  ) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/tasks/${pathSegment(taskId)}`, data);
  }

  async assignTask(taskId: string | number, agentId: string | number | null) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/tasks/${pathSegment(taskId)}`, {
      assigned_to_agent_id: agentId,
    });
  }

  async completeTask(taskId: string | number) {
    return this.request<unknown>("POST", `${this.pathPrefix}/tasks/${pathSegment(taskId)}/complete`);
  }

  async deleteTask(taskId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/tasks/${pathSegment(taskId)}`);
  }

  // ── Recurrences ──

  async listRecurrences() {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/recurrences`);
  }

  async createRecurrence(data: Required<Pick<RecurrenceInput, "content" | "rule_type">> & RecurrenceInput) {
    return this.request<unknown>("POST", `${this.pathPrefix}/recurrences`, data);
  }

  async updateRecurrence(recurrenceId: string | number, data: RecurrenceInput) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/recurrences/${pathSegment(recurrenceId)}`, data);
  }

  async deleteRecurrence(recurrenceId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/recurrences/${pathSegment(recurrenceId)}`);
  }

  // ── Delegation / coordination ──

  async delegateTask(
    parentId: string | number,
    data: {
      content: string;
      description?: string;
      project_id?: ProjectRef;
      labels?: string[];
      priority?: number;
      due_date?: string;
      assigned_to_agent_id?: string | number;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${pathSegment(parentId)}/delegate`,
      data,
    );
  }

  async getTaskChain(taskId: string | number): Promise<{
    root_id: string | number;
    chain: any[];
    depth: number;
    completed_count: number;
    total_count: number;
  }> {
    const resp: any = await this.request<unknown>(
      "GET",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/chain`,
    );
    // Hosted returns { root_id, chain, ... }; custom /api endpoints return { root: Task, chain, ... }.
    // Normalize so the formatter only handles one shape.
    if (resp && typeof resp === "object") {
      if (resp.root && typeof resp.root === "object" && resp.root_id === undefined) {
        return { ...resp, root_id: resp.root.id };
      }
    }
    return resp;
  }

  async updateTaskContext(
    taskId: string | number,
    context: Record<string, unknown>,
    expectedVersion?: number,
    source?: ContextSource,
  ): Promise<{ context: Record<string, unknown>; version?: number; task?: any }> {
    const query: Record<string, string> = {};
    if (expectedVersion !== undefined) query.expected_version = String(expectedVersion);
    if (source !== undefined) query.source = source;
    const resp: any = await this.request<unknown>(
      "PATCH",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/context`,
      context,
      query,
    );
    // Self-hosted returns the full task; hosted returns { context, version }
    // (older hosted deployments returned the bare merged context dict).
    if (resp && typeof resp === "object" && typeof resp.content === "string" && "id" in resp) {
      return { task: resp, context: resp.context ?? {} };
    }
    if (resp && typeof resp === "object" && "context" in resp && typeof resp.version === "number") {
      return { context: (resp.context ?? {}) as Record<string, unknown>, version: resp.version };
    }
    return { context: (resp ?? {}) as Record<string, unknown> };
  }

  async getContextHistory(taskId: string | number, key?: string) {
    const query: Record<string, string> = {};
    if (key !== undefined) query.key = key;
    return this.request<unknown>(
      "GET",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/context/history`,
      undefined,
      query,
    );
  }

  async findDuplicateTasks(content: string, threshold?: number) {
    const body: { content: string; threshold?: number } = { content };
    if (threshold !== undefined) body.threshold = threshold;
    return this.request<unknown>("POST", `${this.pathPrefix}/tasks/dedup`, body);
  }

  async getUsage() {
    if (this.pathPrefix !== "/v1") {
      throw new Error(
        "get_usage is only available on the Delega API (api.delega.dev). Custom endpoints do not expose a usage endpoint.",
      );
    }
    return this.request<unknown>("GET", `${this.pathPrefix}/usage`);
  }

  // ── Claiming (hosted API only) ──

  private assertHostedClaiming(operation: string): void {
    if (this.pathPrefix !== "/v1") {
      throw new Error(
        `${operation} is only available on the Delega API (api.delega.dev). Custom endpoints do not expose task-claiming endpoints.`,
      );
    }
  }

  async claimTask(params: {
    task_id?: string | number;
    project_id?: ProjectRef;
    labels?: string[];
    lease_seconds?: number;
  }) {
    this.assertHostedClaiming("claim_task");
    const body: Record<string, unknown> = {};
    if (params.lease_seconds !== undefined) body.lease_seconds = params.lease_seconds;
    // Targeted claim: take one specific task by id (409 if not claimable).
    // project_id/labels filters only apply to the queue claim.
    if (params.task_id !== undefined) {
      return this.request<{ task: unknown | null }>(
        "POST",
        `${this.pathPrefix}/tasks/${pathSegment(params.task_id)}/claim`,
        body,
      );
    }
    if (params.project_id !== undefined) body.project_id = String(params.project_id);
    if (params.labels?.length) body.labels = params.labels;
    return this.request<{ task: unknown | null }>(
      "POST",
      `${this.pathPrefix}/tasks/claim`,
      body,
    );
  }

  async heartbeatTask(taskId: string | number, leaseSeconds?: number, state?: string, detail?: string) {
    this.assertHostedClaiming("heartbeat_task");
    const body: Record<string, unknown> = {};
    if (leaseSeconds !== undefined) body.lease_seconds = leaseSeconds;
    if (state !== undefined) body.state = state;
    if (detail !== undefined) body.detail = detail;
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/heartbeat`,
      body,
    );
  }

  async setTaskState(taskId: string | number, state: string, detail?: string) {
    this.assertHostedClaiming("set_task_state");
    const body: Record<string, unknown> = { state };
    if (detail !== undefined) body.detail = detail;
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/state`,
      body,
    );
  }

  async releaseTask(taskId: string | number) {
    this.assertHostedClaiming("release_task");
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/release`,
      {},
    );
  }

  // ── Comments ──

  async addComment(
    taskId: string | number,
    data: { content: string; author?: string },
  ) {
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/comments`,
      data,
    );
  }

  // ── Projects ──

  async listProjects() {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/projects`);
  }

  // ── Stats ──

  async getStats() {
    return this.request<unknown>("GET", `${this.pathPrefix}/stats`);
  }

  // ── Agents ──

  async listAgents() {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/agents`);
  }

  async registerAgent(data: { name: string; display_name?: string; description?: string; permissions?: string[]; role?: string }) {
    return this.request<unknown>("POST", `${this.pathPrefix}/agents`, data);
  }

  async setAgentRole(agentId: string | number, role: string) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/agents/${pathSegment(agentId)}`, { role });
  }

  async deleteAgent(agentId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/agents/${pathSegment(agentId)}`);
  }

  // ── Webhooks ──

  async listWebhooks() {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/webhooks`);
  }

  async createWebhook(data: { url: string; events: string[]; secret?: string }) {
    return this.request<unknown>("POST", `${this.pathPrefix}/webhooks`, data);
  }

  async deleteWebhook(webhookId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/webhooks/${pathSegment(webhookId)}`);
  }
}
