const DEFAULT_BASE_URL = "https://api.delega.dev";
const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1"]);
const REQUEST_DEADLINE_MS = 35_000;
const MAX_GET_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 125;
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
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

export interface AutomationInput {
  name?: string;
  event?: string;
  conditions?: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
  active?: boolean;
}

export type EvidenceKind = "commit" | "pr" | "ci_check" | "deploy_sha" | "artifact_url" | "command_output";

export interface EvidenceItemInput {
  kind: EvidenceKind;
  ref: string;
  summary?: string;
}

export interface IngressSourceInput {
  name?: string;
  template?: Record<string, unknown>;
  filters?: Array<Record<string, unknown>>;
  default_project_id?: string | null;
  default_assignee_agent_id?: string | null;
  active?: boolean;
  rotate_secret?: boolean;
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

export class DelegaNetworkError extends Error {
  method: string;
  path: string;
  attempts: number;
  code?: string;

  constructor(method: string, url: URL, attempts: number, error: unknown) {
    const rootCause = deepestCause(error);
    const causeName = errorField(rootCause, "name") || "NetworkError";
    const causeCode = errorField(rootCause, "code");
    const causeMessage = errorField(rootCause, "message") || String(rootCause);
    const detail = `${causeName}${causeCode ? ` [${causeCode}]` : ""}: ${causeMessage}`;

    super(
      `Delega API ${method} ${url.pathname} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${detail}`,
      { cause: rootCause instanceof Error ? rootCause : undefined },
    );
    this.name = "DelegaNetworkError";
    this.method = method;
    this.path = url.pathname;
    this.attempts = attempts;
    this.code = causeCode;
  }
}

function errorField(error: unknown, field: "cause" | "code" | "message" | "name"): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

function deepestCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const next = errorCause(current);
    if (next === undefined || next === null) break;
    current = next;
  }

  return current;
}

function isRetryableNetworkError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  let hasCause = false;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = errorField(current, "code");
    const name = errorField(current, "name");
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
    if (name && /(?:Connect|Headers|Body)TimeoutError|SocketError/.test(name)) return true;

    const next = errorCause(current);
    if (next === undefined || next === null) break;
    hasCause = true;
    current = next;
  }

  // Standards-compliant fetch reports network failures as TypeError. Requiring
  // a cause avoids retrying unrelated TypeErrors from request construction or
  // response parsing.
  return error instanceof TypeError && hasCause;
}

function retryDelayMs(completedAttempts: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, completedAttempts - 1);
  return Math.round(exponential * (0.5 + Math.random()));
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

    const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);
    const maxAttempts = method === "GET" ? MAX_GET_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: deadline,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new DelegaApiError(res.status, res.statusText, text);
        }

        if (res.status === 204) {
          return undefined as T;
        }

        return (await res.json()) as T;
      } catch (error) {
        if (error instanceof DelegaApiError) throw error;

        const isNetworkFailure = deadline.aborted || isRetryableNetworkError(error);
        if (!isNetworkFailure) throw error;

        if (method === "GET" && attempt < maxAttempts && !deadline.aborted) {
          try {
            await waitForRetry(retryDelayMs(attempt), deadline);
            continue;
          } catch (deadlineError) {
            throw new DelegaNetworkError(method, url, attempt, deadlineError);
          }
        }

        throw new DelegaNetworkError(method, url, attempt, deadline.aborted ? deadline.reason : error);
      }
    }

    throw new Error("Unreachable Delega request state");
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
    evidence_policy?: "required" | null;
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
      evidence_policy?: "required" | null;
    },
  ) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/tasks/${pathSegment(taskId)}`, data);
  }

  async assignTask(taskId: string | number, agentId: string | number | null) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/tasks/${pathSegment(taskId)}`, {
      assigned_to_agent_id: agentId,
    });
  }

  async completeTask(taskId: string | number, evidence?: EvidenceItemInput[]) {
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/complete`,
      evidence && evidence.length ? { evidence } : undefined,
    );
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

  async releaseTask(taskId: string | number, handoff?: string) {
    this.assertHostedClaiming("release_task");
    return this.request<unknown>(
      "POST",
      `${this.pathPrefix}/tasks/${pathSegment(taskId)}/release`,
      handoff !== undefined ? { handoff } : {},
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

  async getFleetAttention() {
    return this.request<unknown>("GET", `${this.pathPrefix}/fleet/attention`);
  }

  async searchContext(params: {
    q: string; project_id?: string | number; source?: string; key?: string;
    limit?: number; include_superseded?: boolean;
  }) {
    const query: Record<string, string> = { q: params.q };
    if (params.project_id !== undefined) query.project_id = String(params.project_id);
    if (params.source) query.source = params.source;
    if (params.key) query.key = params.key;
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.include_superseded) query.include_superseded = "true";
    return this.request<unknown>("GET", `${this.pathPrefix}/context/search`, undefined, query);
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

  // ── Automations ──

  async listAutomations() {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/automations`);
  }

  async createAutomation(data: AutomationInput) {
    return this.request<unknown>("POST", `${this.pathPrefix}/automations`, data);
  }

  async updateAutomation(automationId: string | number, data: AutomationInput) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/automations/${pathSegment(automationId)}`, data);
  }

  async deleteAutomation(automationId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/automations/${pathSegment(automationId)}`);
  }

  // ── Ingress sources ──

  async listIngressSources() {
    return this.request<unknown[]>("GET", `${this.pathPrefix}/ingress-sources`);
  }

  async createIngressSource(data: IngressSourceInput) {
    return this.request<unknown>("POST", `${this.pathPrefix}/ingress-sources`, data);
  }

  async updateIngressSource(sourceId: string | number, data: IngressSourceInput) {
    return this.request<unknown>("PUT", `${this.pathPrefix}/ingress-sources/${pathSegment(sourceId)}`, data);
  }

  async deleteIngressSource(sourceId: string | number) {
    return this.request<unknown>("DELETE", `${this.pathPrefix}/ingress-sources/${pathSegment(sourceId)}`);
  }
}
