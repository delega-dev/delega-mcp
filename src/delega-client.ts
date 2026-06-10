const DEFAULT_BASE_URL = "http://127.0.0.1:18890";
const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1"]);
type ProjectRef = string | number;

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

export class DelegaClient {
  private baseUrl: string;
  private agentKey?: string;
  private pathPrefix: string;

  constructor(baseUrl?: string, agentKey?: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl || DEFAULT_BASE_URL);
    this.agentKey = agentKey;
    // Hosted API (api.delega.dev) uses /v1/ prefix, self-hosted uses /api/
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
    return this.request<unknown>("GET", `${this.pathPrefix}/tasks/${taskId}`);
  }

  async getTaskContext(taskId: string | number) {
    return this.request<unknown>("GET", `${this.pathPrefix}/tasks/${taskId}/context`);
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
    return this.request<unknown>("PUT", `${this.pathPrefix}/tasks/${taskId}`, data);
  }

  async assignTask(taskId: string | number, agentId: string | number | null) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/tasks/${taskId}`, {
      assigned_to_agent_id: agentId,
    });
  }

  async completeTask(taskId: string | number) {
    return this.request<unknown>("POST", `${this.pathPrefix}/tasks/${taskId}/complete`);
  }

  async deleteTask(taskId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/tasks/${taskId}`);
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
      `${this.pathPrefix}/tasks/${parentId}/delegate`,
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
      `${this.pathPrefix}/tasks/${taskId}/chain`,
    );
    // Hosted returns { root_id, chain, ... }; self-hosted returns { root: Task, chain, ... }.
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
  ): Promise<{ context: Record<string, unknown>; task?: any }> {
    const resp: any = await this.request<unknown>(
      "PATCH",
      `${this.pathPrefix}/tasks/${taskId}/context`,
      context,
    );
    // Self-hosted returns the full task; hosted returns the bare merged context dict.
    if (resp && typeof resp === "object" && typeof resp.content === "string" && "id" in resp) {
      return { task: resp, context: resp.context ?? {} };
    }
    return { context: (resp ?? {}) as Record<string, unknown> };
  }

  async findDuplicateTasks(content: string, threshold?: number) {
    const body: { content: string; threshold?: number } = { content };
    if (threshold !== undefined) body.threshold = threshold;
    return this.request<unknown>("POST", `${this.pathPrefix}/tasks/dedup`, body);
  }

  async getUsage() {
    if (this.pathPrefix !== "/v1") {
      throw new Error(
        "get_usage is only available on the hosted Delega API (api.delega.dev). Self-hosted deployments do not expose a usage endpoint.",
      );
    }
    return this.request<unknown>("GET", `${this.pathPrefix}/usage`);
  }

  // ── Claiming (hosted API only) ──

  private assertHostedClaiming(operation: string): void {
    if (this.pathPrefix !== "/v1") {
      throw new Error(
        `${operation} is only available on the hosted Delega API (api.delega.dev). Self-hosted deployments do not expose task-claiming endpoints yet.`,
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
        `${this.pathPrefix}/tasks/${params.task_id}/claim`,
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

  async heartbeatTask(taskId: string | number, leaseSeconds?: number) {
    this.assertHostedClaiming("heartbeat_task");
    const body: Record<string, unknown> = {};
    if (leaseSeconds !== undefined) body.lease_seconds = leaseSeconds;
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${taskId}/heartbeat`,
      body,
    );
  }

  async releaseTask(taskId: string | number) {
    this.assertHostedClaiming("release_task");
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${taskId}/release`,
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
      `${this.pathPrefix}/tasks/${taskId}/comments`,
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

  async registerAgent(data: { name: string; display_name?: string; description?: string; permissions?: string[] }) {
    return this.request<unknown>("POST", `${this.pathPrefix}/agents`, data);
  }

  async deleteAgent(agentId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/agents/${agentId}`);
  }

  // ── Webhooks ──

  async listWebhooks() {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/webhooks`);
  }

  async createWebhook(data: { url: string; events: string[]; secret?: string }) {
    return this.request<unknown>("POST", `${this.pathPrefix}/webhooks`, data);
  }

  async deleteWebhook(webhookId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/webhooks/${webhookId}`);
  }
}
