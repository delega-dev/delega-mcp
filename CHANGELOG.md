# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
