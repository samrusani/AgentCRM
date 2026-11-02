# Architecture

AgentCRM runs as two local processes over one SQLite file.

- `apps/server`: a Fastify API on http://127.0.0.1:4720, an in-process job worker, a CLI, and an MCP server over stdio. The API server is the primary writer. The MCP server runs as a separate local process against the same SQLite file and runs its own worker tick, so runs it starts advance even when the API server is down; both writers use short immediate transactions through the same action service. The API server watches SQLite's data_version and relays commits from the MCP process as server sent events.
- `apps/web`: a React app served by Vite on http://127.0.0.1:5173 in development, proxying `/api` to the server.

The database lives at `data/agentcrm.db` relative to the repository root, in WAL mode. The `data/` folder is created on demand and never committed.

## The action service

All mutations flow through one module layer, `apps/server/src/actions/`. A route handler, a job, a CLI command, and an MCP tool all call the same action functions. An action:

1. Validates input with zod.
2. Checks workspace scope.
3. Checks `expectedVersion` on versioned records and fails with `version_conflict` on mismatch.
4. Applies the change in a short transaction.
5. Writes an `audit_event` row in the same transaction.

Reads can use shared query helpers directly. Writes never bypass actions.

## Data model

IDs are prefixed strings, for example `per_a1b2c3`, generated from random bytes. Prefixes: `wsp` workspace, `per` person, `org` organization, `pip` pipeline, `stg` stage, `opp` opportunity, `act` activity, `tsk` task, `clm` field claim, `run` run, `stp` run step, `apr` approval, `job` job, `aud` audit event, `evt` stage event. Timestamps are ISO 8601 UTC strings.

| Table | Columns (beyond id, created_at) |
| --- | --- |
| workspace | name, template |
| person | workspace_id, version, first_name, last_name, email, title, organization_id, location, tags (JSON array), next_action_at, updated_at |
| organization | workspace_id, version, name, domain, kind (fund, company), location, tags (JSON array), updated_at |
| pipeline | workspace_id, name |
| stage | pipeline_id, name, seq |
| opportunity | workspace_id, version, name, pipeline_id, stage_id, organization_id, person_id, amount_target, currency, owner, status (open, passed, lost, nurture), reason, next_action_at, stage_changed_at, updated_at |
| stage_event | opportunity_id, from_stage_id, to_stage_id, at, actor |
| activity | workspace_id, entity_type, entity_id, kind (note, email_draft, stage_change, agent), body, actor |
| task | workspace_id, version, title, entity_type, entity_id, due_at, status (open, done), updated_at |
| field_claim | workspace_id, entity_type, entity_id, field, value, source_url, source_type, observed_at, status (imported, extracted, corroborated, human_confirmed) |
| run | workspace_id, kind, title, status, scope (JSON), counts (JSON), started_at, finished_at |
| run_step | run_id, seq, title, status (pending, running, done, skipped, failed), detail, started_at, finished_at |
| approval | workspace_id, run_id, kind, title, payload (JSON), payload_hash, status (pending, approved, rejected), note, decided_at, decided_by |
| job | kind, payload (JSON), run_at, attempts, status (queued, running, done, failed), updated_at |
| audit_event | workspace_id, actor, action, entity_type, entity_id, detail (JSON) |

Indexes at minimum: person(workspace_id, last_name), person(workspace_id, email), organization(workspace_id, domain), opportunity(workspace_id, pipeline_id, stage_id), task(workspace_id, status, due_at), activity(workspace_id, entity_type, entity_id, created_at), field_claim(workspace_id, entity_type, entity_id), job(status, run_at).

## Run state machine

`queued -> running -> waiting_approval | paused -> running -> succeeded | partial | failed | cancelled`

Rules:

- `waiting_approval` means a pending approval row references the run. Deciding the approval moves the run forward.
- Pause and cancel are user actions. Cancel is final.
- Counts report `{ processed, found, flagged }` and update as steps complete. A run that cannot meet its requested scope finishes as `partial` with honest counts, never with invented results.

## The simulated demo run

No model provider is wired up yet, so `kind: "demo_research"` exists to exercise the machinery honestly. The job worker advances a scripted set of steps (check existing records, search sources, extract candidates, qualify) on a timer, roughly one step per second, generating a handful of synthetic candidate field claims and new person records tagged `demo-candidate`. The final step creates an approval of kind `shortlist` and the run enters `waiting_approval`. Approving creates draft outreach activities (kind `email_draft`, clearly labelled as demo drafts); rejecting finishes the run as `cancelled`. Every UI surface labels these runs as simulated.

## API contract

Base path `/api`. Responses are JSON with camelCase keys (`firstName`, `expectedVersion`); database columns stay snake_case. List endpoints accept `limit` (default 50, max 200) and an opaque `cursor` (base64url of the last row id, keyset ordered), and return `{ items, nextCursor }` where `nextCursor` is null on the last page. Successful creates return 201. Errors use HTTP status plus `{ "error": { "code", "message" } }`. Codes: `validation`, `not_found`, `version_conflict` (409, with the current record at `error.current`), `conflict`, `internal`. Duplicate person emails and organization domains return 409 `conflict`.

| Method and path | Purpose |
| --- | --- |
| GET `/api/health` | `{ ok, version, dbPath }` with dbPath relative to repo root |
| GET `/api/workspace` | The single demo workspace `{ id, name, template }` |
| GET `/api/today` | `{ tasksDue, approvalsPending, runsActive, counts, dayStart, dayEnd }` for the Today screen |
| GET `/api/people?q=&cursor=&limit=` | Search by name, email, organization name |
| GET `/api/people/:id` | Person plus `organization`, `affiliationsSummary`, `claims`, `activities`, `tasks`, `opportunities` |
| POST `/api/people` | Create person |
| PATCH `/api/people/:id` | `{ expectedVersion, fields }`, partial update |
| GET `/api/organizations?q=&cursor=&limit=` | Search by name, domain |
| GET `/api/organizations/:id` | Organization plus `people`, `claims`, `activities`, `opportunities` |
| PATCH `/api/organizations/:id` | `{ expectedVersion, fields }` |
| GET `/api/pipelines` | Pipelines with ordered stages |
| GET `/api/opportunities?pipelineId=&stageId=&status=` | Opportunities with joined `organizationName` and `personName` |
| GET `/api/opportunities/:id` | Opportunity plus `stageEvents`, `claims`, `activities`, `tasks` |
| POST `/api/opportunities` | Create opportunity |
| POST `/api/organizations` | Create organization |
| POST `/api/opportunities/:id/stage` | `{ stageId, expectedVersion }`, records a stage_event and an activity |
| PATCH `/api/opportunities/:id` | `{ expectedVersion, fields }` including status and reason |
| GET `/api/tasks?filter=today|overdue|open|done` | Tasks with joined entity names |
| POST `/api/tasks` | Create task |
| PATCH `/api/tasks/:id` | `{ expectedVersion, fields }`, completing sets status done |
| GET `/api/activities?entityType=&entityId=` | Timeline for a record, newest first |
| POST `/api/activities` | Create a note. `kind` is optional and only accepts `note` |
| GET `/api/runs?status=` | Runs, newest first. `status` accepts one value, a comma list, or `active`. Simulated runs carry `simulated: true` |
| POST `/api/runs` | `{ kind: "demo_research", title?, scope? }` where scope is optional JSON stored with the run; returns the queued run immediately |
| GET `/api/runs/:id` | Run with ordered steps and any linked approvals |
| POST `/api/runs/:id/control` | `{ action: "pause" | "resume" | "cancel" }` |
| GET `/api/approvals?status=` | Approvals with run titles |
| GET `/api/approvals/:id` | One approval |
| POST `/api/approvals/:id/decision` | `{ decision: "approve" | "reject", note? }`. Returns `{ approval, run, alreadyDecided }`. Repeating the same decision is idempotent; the opposite decision returns 409 `conflict` |
| GET `/api/search?q=` | `{ people, organizations, opportunities }`, up to 8 each, for the command palette |
| POST `/api/agent/message` | `{ text }` returns `{ reply, actions, modelConnected }`. Deterministic and rule based. Actions are `{ id, label, kind, entityType?, entityId? }` with kinds `start_demo_run` and `open_record` |
| GET `/api/events` | Server sent events. Frames: `run_updated` `{type,runId}`, `approval_updated` `{type,approvalId,runId}`, `record_updated` `{type,entityType,entityId}`, plus an initial `ready` event and a 15 second keep alive comment. The web app refetches on these signals |

## MCP server

`npm run --silent mcp --prefix apps/server` (and CLI `crm mcp`) starts an MCP server over stdio using the official TypeScript SDK. The `--silent` flag matters: without it npm prints its script banner to stdout and corrupts the protocol stream. Tools, all workspace scoped and read mostly:

- `crm_describe`: capabilities, template, counts, allowed actions
- `crm_search`: query with type filter, bounded results
- `crm_get_record`: person, organization, or opportunity by id, with evidence
- `crm_propose_changes`: validate a batch of field changes, return a preview, write nothing
- `crm_apply_changes`: apply a previously validated proposal with expected versions
- `crm_start_research`: start a demo research run, returns run id
- `crm_get_run`: run status, steps, counts

MCP tools call the same actions as the HTTP routes. No tool can decide an approval.

## CLI

Binary name `crm`, implemented in the server workspace, JSON output with `--json`.

```
crm doctor
crm seed [--reset]
crm serve
crm search <query> [--json]
crm runs list [--json]
crm runs get <id> [--json]
crm mcp
```

Exit codes: 0 success, 1 expected failure with a printed reason, 2 usage error.

## Conventions

- Loopback only. The server binds 127.0.0.1 and additionally rejects requests whose Host header is not 127.0.0.1, localhost, or [::1] (any port) with 403, as a DNS rebinding guard.
- Environment overrides: `AGENTCRM_DB` (database path), `AGENTCRM_PORT`, `AGENTCRM_LOG_LEVEL`, `AGENTCRM_STEP_MS` (demo run step interval).
- Known limitation: keyset cursors compare against the cursor row's sort keys at read time, so a record edited between pages can shift page boundaries for name, date, or recency ordered lists. A composite cursor that freezes the sort key is planned.
- All server code TypeScript, ESM, strict mode.
- Tests with vitest cover the action service: version conflicts, workspace scoping, approval decisions, run transitions.
