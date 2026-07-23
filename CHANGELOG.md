# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `recall` tool — cross-task decision-memory search. Recall a prior decision or
  fact without knowing which task recorded it; results are ranked (human-stated
  weighted highest) and scoped to what the agent can read. Lexical match for v1
  (semantic/embeddings upgrade is a follow-up). Tool count 35 -> 36.

## [1.14.0] - 2026-07-23

### Added
- `fleet_attention` tool — a triage board of work that needs a human or
  coordinator: abandoned claims (crashed/silent agent, expired lease), silent
  holders, errored, waiting-on-input, overdue, and looping tasks. Scoped like
  stats. Tool count 34 -> 35.
- `release_task` accepts an optional `handoff` note ("where I left off / why I
  stopped"). Task renders show a "Resuming from …" line when a released task
  carries a handoff, so the next agent resumes instead of restarting.

## [1.13.2] - 2026-07-22

### Security
- Dynamic API identifiers now reject empty, `.` and `..` path segments before
  URL construction, preventing URL normalization from changing the route.
- The MCP Registry release job pins `mcp-publisher` v1.7.9 and verifies its
  published SHA-256 before executing it with GitHub OIDC permissions.
- Patched transitive runtime and build dependencies now resolve with zero npm
  audit advisories.

### Documentation
- Documented prompt-injection trust boundaries and the opt-in webhook-secret
  reveal flag.

## [1.13.1] - 2026-07-22

### Security
- `create_webhook` now masks the webhook signing secret by default, so it no
  longer flows into the model's context, conversation transcripts, or provider
  logs where it could be read and used to forge signatures. Set
  `DELEGA_REVEAL_WEBHOOK_SECRETS=1` to print it in full once.

### Changed
- API error responses no longer log full response bodies to stderr by default;
  enable verbose logging with `DELEGA_DEBUG=1`.

## [1.13.0] - 2026-06-12

### Added
- Recurring task template support. New tools: `list_recurrences`,
  `create_recurring_task`, `update_recurrence`, and `delete_recurrence`.
  Recurrence rules support `daily`, `weekly`, `monthly`, and `yearly`
  schedules with interval, timezone, anchor fields, `next_due_at`, assignee,
  active state, and `skip_if_open` options. Tool count 30 -> 34.

## [1.12.1] - 2026-06-11

### Changed
- Updated tool descriptions for `list_tasks` and `list_agents` to reflect
  role-aware visibility: workers see their own task scope, while coordinators
  and admins can see account-wide work and should coordinate on sibling agents'
  tasks via comments.

## [1.12.0] - 2026-06-11

### Added
- Agent role presets. `register_agent` accepts `role` (`worker`,
  `coordinator`, or `admin`), `set_agent_role` updates an existing agent's
  role with an admin key, and agent formatter output includes `Role:` when
  present. Tool count 29 -> 30.

## [1.11.0] - 2026-06-11

### Changed
- Bumped the MCP SDK to `^1.29.0`.
- Completed the README tool table for the MCP tools available at the time.

## [1.10.0] - 2026-06-11

### Changed
- Defaulted `DELEGA_API_URL` to the hosted API at `https://api.delega.dev`.
  Hosted requests use the `/v1` API prefix; custom endpoints continue to use
  `/api`.
- Removed self-hosted setup guidance from the README and server manifest.

## [1.9.1] - 2026-06-10

### Fixed
- Security: encode path parameters (task/agent/webhook IDs) before building
  request URLs. Crafted IDs such as `../agents` or `1?foo=bar` could otherwise
  redirect a request to a different same-host endpoint or smuggle query/path
  segments. All client methods now route IDs through `pathSegment()`
  (`encodeURIComponent`).

## [1.9.0] - 2026-06-10

### Added
- Task link support for the Phase 3 Git/PR linking wedge. New tools:
  `link_task` (`task_id`, `kind`, `repo?`, `ref`, `url?`) and
  `list_task_links`. `get_task` now includes attached links in its detail
  output. Tool count 27 → 29.

## [1.8.0] - 2026-06-10

### Added
- Context provenance support for hosted Delega API deployments: `update_task_context`
  accepts a `source`, `get_task_context` can include per-key provenance, and
  the new `get_context_history` tool reads the context audit ledger.

## [1.7.1] - 2026-06-10

### Fixed
- MCP handshake `serverInfo.version` now follows `package.json` instead of
  reporting the stale `1.2.1` literal.

## [1.7.0] - 2026-06-10

### Added
- Session lifecycle states (requires delega-api with session states).
  New tool `set_task_state` (`task_id`, `state`, `detail?`) reports
  `working` / `waiting_input` / `errored` on a claimed task *without*
  extending the lease — flag "blocked on input" or "errored" honestly
  instead of faking liveness. Tool count 25 → 26.
- `heartbeat_task` accepts optional `state` + `detail` to report a
  session state while extending the lease in one call.
- Task formatters render the session state inline with status
  (`Status: claimed (waiting_input — "needs prod API key")`) and an
  `Accountable:` line for `accountable_agent_id`, the human-accountable
  owner that delegation now propagates through chains.
- `create_webhook` accepts the new `task.state_changed` event (10 events).

## [1.6.0] - 2026-06-10

### Added
- Optimistic concurrency for task context (requires delega-api with
  context versioning). `get_task_context` reports the context version;
  `update_task_context` accepts `expected_version` and, on a version
  conflict, returns the current version + context so the agent can merge
  and retry in one step. Unguarded writes still merge (and the API now
  retries them against fresh state, so different-key writers never
  clobber each other).

## [1.5.1] - 2026-06-10

### Fixed
- Tool errors now surface the API's actionable message for 400/403/404/409
  responses instead of a generic phrase. A write denied for lack of a claim
  now reads "You do not have write access to this task. Claim it via POST
  /tasks/:id/claim, or have it assigned to you. (MCP: claim_task with
  task_id)" rather than "Delega API denied this action." Auth (401) and 5xx
  errors stay generic.

## [1.5.0] - 2026-06-10

### Added
- `claim_task` gains an optional `task_id` parameter: claim a *specific*
  task (targeted claim via `POST /tasks/:id/claim`) instead of the next
  from the queue. Fails with a conflict if the task is completed, assigned
  to another agent, or claimed with a live lease; expired leases can be
  taken over. Pairs with the API's new 403 "claim it first" response on
  writes to readable-but-unowned tasks. Requires delega-api with targeted
  claiming deployed; `project_id`/`labels` filters remain queue-claim only.

## [1.4.0] - 2026-06-10

### Added
- `claim_task` — atomically claim the next available task from the queue
  (work-queue semantics) with a configurable lease (30-3600s, default 300).
  Hosted API only.
- `heartbeat_task` — extend the lease on a claimed task while working.
- `release_task` — requeue a claimed task without completing it.
- `list_tasks` gains a `claimed` filter (`?claimed=true|false`).
- Webhook events `task.claimed` and `task.released` accepted by
  `create_webhook` (previously rejected by input validation).

## [1.3.0] and earlier

See the [git history](https://github.com/delega-dev/delega-mcp/commits/main).
