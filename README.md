# delega-mcp

MCP server for [Delega](https://delega.dev) — task infrastructure for AI agents.

Connect any MCP-compatible client (Claude Desktop, Cursor, Windsurf, etc.) to your Delega instance and manage tasks, projects, and agents through natural language.

## Install

```bash
npm install -g delega-mcp
```

## Configure

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "delega": {
      "command": "delega-mcp",
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

For the hosted tier, use `https://api.delega.dev` as the URL.

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

## Self-Hosted vs Hosted

**Self-hosted (free):** Run your own Delega instance, point `DELEGA_API_URL` at it.

**Hosted:** Use `https://api.delega.dev` — free up to 1,000 tasks/month.

## Links

- [Delega](https://delega.dev) — Main site
- [GitHub](https://github.com/delega-dev/delega-mcp) — Source code
- [API Docs](https://delega.dev/docs) — REST API reference

## License

MIT
