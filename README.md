# delega-mcp

MCP server for [Delega](https://delega.dev) — task infrastructure for AI agents.

Connect any MCP-compatible client (Claude Code, Cursor, Codex, etc.) to your Delega instance and manage tasks, projects, and agents through natural language.

## Install

```bash
npm install -g @delega-dev/mcp
```

## Configure

Add to your MCP client config (e.g. Claude Code `claude_code_config.json`):

```json
{
  "mcpServers": {
    "delega": {
      "command": "npx",
      "args": ["-y", "@delega-dev/mcp"],
      "env": {
        "DELEGA_API_URL": "http://127.0.0.1:18890",
        "DELEGA_AGENT_KEY": "dlg_your_agent_key_here"
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DELEGA_API_URL` | `http://127.0.0.1:18890` | Delega API endpoint |
| `DELEGA_AGENT_KEY` | (none) | Agent API key for authenticated requests |
| `DELEGA_REVEAL_AGENT_KEYS` | `0` | **⚠️ Development only.** Set to `1` to print full API keys in tool output. Never enable in production: a prompt-injected agent could exfiltrate keys from `create_agent` or `list_agents` responses. |

For the hosted tier, use `https://api.delega.dev` as the URL.

## Security Notes

- Non-local `DELEGA_API_URL` values must use `https://`.
- Agent keys are passed through environment variables rather than command-line arguments, which avoids process-list leakage.
- MCP tool output redacts full agent API keys by default.
- **Do not set `DELEGA_REVEAL_AGENT_KEYS=1` in production.** This flag exists for initial setup only. In production, a prompt-injected agent could exfiltrate keys from `create_agent` or `list_agents` tool output. Keys are returned once at creation time; use `rotate_agent_key` if you need a new one.

## Tools

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks, filter by project, label, due date, completion |
| `get_task` | Get full task details including subtasks |
| `create_task` | Create a new task |
| `update_task` | Update task fields |
| `complete_task` | Mark a task as completed |
| `delete_task` | Delete a task permanently |
| `add_comment` | Add a comment to a task |
| `list_projects` | List all projects |
| `get_stats` | Get task statistics |
| `list_agents` | List registered agents |
| `register_agent` | Register a new agent (returns API key) |
| `list_webhooks` | List all webhooks (admin only) |
| `create_webhook` | Create a webhook for event notifications (admin only) |
| `delete_webhook` | Delete a webhook by ID (admin only) |

## Self-Hosted vs Hosted

**Self-hosted (free):** Run your own Delega instance, point `DELEGA_API_URL` at it.

**Hosted:** Use `https://api.delega.dev` — free up to 1,000 tasks/month.

## Links

- [Delega](https://delega.dev) — Main site
- [GitHub](https://github.com/delega-dev/delega-mcp) — Source code
- [API Docs](https://delega.dev/docs) — REST API reference

## License

MIT

## Hosted deployment

A hosted deployment is available on [Fronteir AI](https://fronteir.ai/mcp/delega-dev-delega-mcp).

