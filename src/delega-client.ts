const DEFAULT_BASE_URL = "http://127.0.0.1:18890";

export class DelegaClient {
  private baseUrl: string;
  private agentKey?: string;

  constructor(baseUrl?: string, agentKey?: string) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.agentKey = agentKey;
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
      throw new Error(
        `Delega API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  // ── Tasks ──

  async listTasks(params: {
    project_id?: number;
    label?: string;
    due?: "today" | "upcoming" | "overdue";
    completed?: boolean;
  }) {
    const query: Record<string, string> = {};
    if (params.project_id !== undefined) query.project_id = String(params.project_id);
    if (params.label !== undefined) query.label = params.label;
    if (params.due !== undefined) query.due = params.due;
    if (params.completed !== undefined) query.completed = String(params.completed);

    return this.request<unknown[]>("GET", "/api/tasks", undefined, query);
  }

  async getTask(taskId: number) {
    return this.request<unknown>("GET", `/api/tasks/${taskId}`);
  }

  async createTask(data: {
    content: string;
    description?: string;
    project_id?: number;
    labels?: string[];
    priority?: number;
    due_date?: string;
  }) {
    return this.request<unknown>("POST", "/api/tasks", data);
  }

  async updateTask(
    taskId: number,
    data: {
      content?: string;
      description?: string;
      labels?: string[];
      priority?: number;
      due_date?: string;
      project_id?: number;
    },
  ) {
    return this.request<unknown>("PUT", `/api/tasks/${taskId}`, data);
  }

  async completeTask(taskId: number) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/complete`);
  }

  async deleteTask(taskId: number) {
    return this.request<unknown>("DELETE", `/api/tasks/${taskId}`);
  }

  // ── Comments ──

  async addComment(
    taskId: number,
    data: { content: string; author?: string },
  ) {
    return this.request<unknown>(
      "POST",
      `/api/tasks/${taskId}/comments`,
      data,
    );
  }

  // ── Projects ──

  async listProjects() {
    return this.request<unknown[]>("GET", "/api/projects");
  }

  // ── Stats ──

  async getStats() {
    return this.request<unknown>("GET", "/api/stats");
  }

  // ── Agents ──

  async listAgents() {
    return this.request<unknown[]>("GET", "/api/agents");
  }

  async registerAgent(data: { name: string; display_name?: string; description?: string; permissions?: string[] }) {
    return this.request<unknown>("POST", "/api/agents", data);
  }
}
