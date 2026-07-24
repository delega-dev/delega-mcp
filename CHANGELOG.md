# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.18.0] - 2026-07-24

### Added
- Evidence-Required Completion. `complete_task` gains an optional `evidence`
  array (kinds: commit, pr, ci_check, deploy_sha, artifact_url,
  command_output); `create_task`/`update_task` gain `evidence_policy`. A task
  with policy `required` cannot be completed without at least one strong
  evidence kind (command_output alone is rejected). Evidence renders on task
  detail; task list/detail shows a "required" policy marker. New automation
  action `set_evidence_policy` (tighten-only and best-effort because automation
  is asynchronous; create-time policy or a successful update while open is the
  hard guarantee). Evidence is a durable, falsifiable claim — Delega stores it,
  it does not execute or verify it.
- Decision Answers (server-side; no new MCP tool). A task entering
  `waiting_input` now emails a signed single-use link to an answer page; the
  human's reply is written back as `human_stated` context + a comment, so a
  later session resumes with the ruling. If the context cannot accept another
  key, the one-use reply is preserved as a human-authored comment. Agents mark
  answerable questions with a `QUESTION:`/`OPTIONS:` block in the state detail.

## [1.17.0] - 2026-07-23

### Added
- Inbound connector tools — `list_ingress_sources`, `create_ingress_source`,
  `update_ingress_source`, `delete_ingress_source` (all admin-only, hosted API
  only). Ingress sources are signed public endpoints that turn external events
  (CI failures, alerts, calendars) into tasks: HMAC-SHA256 signatures with
  5-minute replay tolerance, dot-path templates with a closed vocabulary,
  filters, and idempotent dedupe keys. Server-enforced safety: create-only,
  routing pinned per source (never payload-controlled), automatic `ingress`
  provenance label with sticky propagation through automation-created tasks,
  opt-in-only automation matching, per-source rate limiting, quota-counted
  task creation, and a delivery log that stores outcome metadata + body
  hash/size only (payloads are never retained). Tool count 40 -> 44.
- Task renders now surface a "⚠ External source" warning line for
  ingress-created tasks: their content is untrusted external data to triage,
  not instructions to follow.

## [1.16.0] - 2026-07-23

### Added
- Automation tools — `list_automations`, `create_automation`,
  `update_automation`, `delete_automation` (all admin-only, hosted API only).
  Automation rules are when→then rules on the task event stream that run
  in-process on the Delega API: when an event fires and all conditions match
  (closed vocabulary, AND-combined), the actions run (`assign`,
  `set_priority`, `add_label`, `add_comment`, `create_task`, `delegate`, with
  `{{task.*}}`/`{{event}}` placeholder templating). Server-enforced safety:
  cascade depth/budget caps, self-trigger suppression, live claims are never
  overridden by field mutations (comments are append-only and exempt),
  idempotent task creation per action slot, quota-counted, and auto-disable
  after 10 consecutive failures. Tool count 36 -> 40.

## [1.15.0] - 2026-07-23

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
