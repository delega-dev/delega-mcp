# Human-request connector preparation

This source build adds `delega-human-requests-mcp`, a separate stdio entrypoint
with four existing human-request tools and a host-configured task allowlist.
It is a preparation artifact for connector integration and local conformance
testing. It has not been published to npm, installed in Muse, or validated with
Muse. The normal `delega-mcp` entrypoint is unchanged.

## Muse contract status — September 20, 2026

[Muse's platform page](https://muse.ai/platform) describes product submission,
functional/security/legal review, end-to-end testing, and directory approval.
The retrieved public page does not specify connector transport, authentication,
account linking, private testing, asynchronous result retrieval, or cancellation.
Those details remain unverified. This package does not assert that Muse accepts
stdio, MCP, arbitrary headers, polling, callbacks, or background chat resumption.
Directory approval would not itself establish working result return or demand.

## Available contract

| Tool | Delega endpoint | Behavior |
| --- | --- | --- |
| `register_human_request` | `POST /v1/tasks/:id/human-request` | Register an immutable checklist on a prepared task; does not run it |
| `get_human_request` | `GET /v1/tasks/:id/human-request` | Read current phase, versions, and protected reply evidence |
| `get_human_result` | `GET /v1/tasks/:id/human-request/result` | Read canonical result; null until protected completion |
| `cancel_human_request` | `POST /v1/tasks/:id/human-request/cancel` | Record cancellation using the current request version |

The operator supplies an existing open, unclaimed task assigned to the configured
human executor, with `autopilot-hold`, required evidence, and its current revision.
The connector cannot discover, create, assign, claim, complete, or delete tasks,
write task context, create identities, issue answer capabilities, or send messages.
It cannot start the controller. Registration still requires API activation;
delivery requires a separately prepared controller run. One to three short
criteria, the existing self recipient, two prompts, and a 60–1200 second run
remain the API's supported scope. No worker or polling loop is added here.

## Local source setup

Run `npm ci`, `npm test`, and `npm run build`. Use a trusted local MCP host to
start `node /absolute/path/to/dist/human-request-stdio.js`. The host's approved
credential integration supplies the following environment variables in memory:

| Variable | Requirement |
| --- | --- |
| `DELEGA_HUMAN_REQUEST_TASK_IDS` | Required comma-separated exact 32-character task IDs; no wildcard or empty scope |
| `DELEGA_AGENT_KEY` | Existing host agent credential; `DELEGA_API_KEY` is the fallback alias |
| `DELEGA_API_URL` | Defaults to the existing private API; existing hosted staging is also supported |
| `DELEGA_CF_ACCESS_CLIENT_ID`, `DELEGA_CF_ACCESS_CLIENT_SECRET` | Both or neither, according to the protected deployment |

Do not put credentials in arguments, this document, a manifest, or a submission.
The allowlist is copied at startup and checked on every operation before API I/O.
Changing scope requires a new host configuration and process. Backend permission
checks remain authoritative. This task allowlist is not per-user OAuth or a
multi-tenant isolation design. Do not expose this process as a public service or
forward an owner credential to Muse. A future remote adapter needs Muse's actual
identity contract and authenticated account-to-task binding first.

This entrypoint ignores debug/reveal flags and returns fixed error explanations.
It does not forward backend error bodies or arbitrary exception details.
The existing client's request deadline and retry rules apply: GET may retry
transient transport failures; mutations make one attempt. After an uncertain
registration response, read the same task before retrying the same input. Never
create another task as a retry. After cancellation conflict, read the current
request version; do not substitute the task revision.

## Result handling

The connector passes through the canonical API snapshot without inventing a
success state or rewriting human replies. `completion_pending` is not completed.
`incomplete`, `declined`, `expired`, `cancelled`, and `needs_review` remain visible;
cancellation may first be `cancellation_pending` while the executor releases its
claim. A completed result is `human_attested` and explicitly says physical state
was not independently verified. A negative checklist reply does not identify
which individual criterion is unfinished. Result retrieval does not initiate a
new run or cause a callback into the originating conversation.

## Validation and next integration step

`test/human-request-connector.test.ts` uses real MCP sessions and synthetic API
responses to check the four-tool surface, all-operation task isolation, immutable
scope, exact request/version forwarding, phase preservation, negative replies,
error redaction, mutation non-retry, and actual stdio startup. Existing API tests
own transactional receipt/claim/completion correctness. These connector tests do
not prove a live API registration, Telegram delivery, or Muse compatibility.

Before a real Muse demonstration, obtain its developer contract and confirm:

1. Supported transport and a private development/test installation path.
2. Authenticated account linking and revocation, with host-held Delega credentials.
3. Supported delayed-result behavior: polling or callback, including cancellation
   and whether returning to the originating conversation is actually supported.
4. A reviewed fresh task and controller activation, with the scope/time/recipient
   bound before delivery. Preserve every earlier task and manifest.

Then implement only the required platform adapter around these existing tools,
validate account isolation and revocation, and run the actual originating-agent
round trip. No existing API feature flag or service is changed by this package.
