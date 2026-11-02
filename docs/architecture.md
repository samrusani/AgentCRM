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
| workspace | name, template, settings (JSON: qualification config) |
| person | workspace_id, version, first_name, last_name, email, title, organization_id, location, tags (JSON array), next_action_at, updated_at |
| organization | workspace_id, version, name, domain, kind (fund, company), location, tags (JSON array), updated_at |
| pipeline | workspace_id, name |
| stage | pipeline_id, name, seq |
| opportunity | workspace_id, version, name, pipeline_id, stage_id, organization_id, person_id, amount_target, currency, owner, status (open, passed, lost, nurture), reason, next_action_at, stage_changed_at, updated_at |
| stage_event | opportunity_id, from_stage_id, to_stage_id, at, actor |
| activity | workspace_id, entity_type, entity_id, kind (note, email_draft, stage_change, agent), body, actor |
| task | workspace_id, version, title, entity_type, entity_id, due_at, status (open, done), updated_at |
| field_claim | workspace_id, entity_type, entity_id, field, value, source_url, source_type, observed_at, extraction_method (for apify claims, the actor id), status (imported, extracted, corroborated, human_confirmed) |
| run | workspace_id, kind, title, status, scope (JSON), counts (JSON), started_at, finished_at |
| run_step | run_id, seq, title, status (pending, running, done, skipped, failed), detail, started_at, finished_at |
| approval | workspace_id, run_id, kind, title, payload (JSON), payload_hash, status (pending, approved, rejected), note, decided_at, decided_by |
| job | kind, payload (JSON), run_at, attempts, status (queued, running, done, failed), updated_at |
| audit_event | workspace_id, actor, action, entity_type, entity_id, detail (JSON) |
| connector | workspace_id, kind (apify), settings (JSON, no secrets), secret (API token, never returned by any endpoint), status (connected, error), updated_at |
| import_batch | workspace_id, run_id, source_kind (apify, csv), source_ref (JSON: for apify the actor id, apify run id, dataset id; for csv the file name, row count, delimiter), status (staging, awaiting_review, accepted, rejected, failed), counts (JSON), updated_at |
| qualification_result | workspace_id, person_id (one row per person), run_id, payload (JSON), updated_at |
| import_row | batch_id, seq, raw (JSON), mapped (JSON), status (staged, duplicate, invalid, accepted, rejected), match_entity_type, match_entity_id, reason |

Connector secrets live only in the local database's secret column: they are excluded from every API response (masked to the last four characters), from audit detail, from logs, and from SSE payloads. Id prefixes for the new tables: `con`, `imp`, `row`.

Indexes at minimum: person(workspace_id, last_name), person(workspace_id, email), organization(workspace_id, domain), opportunity(workspace_id, pipeline_id, stage_id), task(workspace_id, status, due_at), activity(workspace_id, entity_type, entity_id, created_at), field_claim(workspace_id, entity_type, entity_id), job(status, run_at), plus expression indexes on lower(email) for person and lower(domain) for organization, which the duplicate checks and import dedupe rely on.

## Run state machine

`queued -> running -> waiting_approval | paused -> running -> succeeded | partial | failed | cancelled`

Rules:

- `waiting_approval` means a pending approval row references the run. Deciding the approval moves the run forward.
- Pause and cancel are user actions. Cancel is final.
- Counts report `{ processed, found, flagged }` and update as steps complete. A run that cannot meet its requested scope finishes as `partial` with honest counts, never with invented results.

## The simulated demo run

No model provider is wired up yet, so `kind: "demo_research"` exists to exercise the machinery honestly. The job worker advances a scripted set of steps (check existing records, search sources, extract candidates, qualify) on a timer, roughly one step per second, generating a handful of synthetic candidate field claims and new person records tagged `demo-candidate`. The final step creates an approval of kind `shortlist` and the run enters `waiting_approval`. Approving creates draft outreach activities (kind `email_draft`, clearly labelled as demo drafts); rejecting finishes the run as `cancelled`. Every UI surface labels these runs as simulated.

## Apify connector

Apify is the first real external provider. The user connects their own Apify account with an API token in Settings; AgentCRM then lets them run any Actor from the Apify store, with the results staged for review before anything enters the CRM. Apify charges the user's own account. Every run passes `maxItems` and a timeout to Apify as platform side caps, but Apify enforces `maxItems` only for pay per result actors, so for other pricing models the timeout is the effective limit. AgentCRM cannot hard cap spend for every pricing model and the UI says so rather than promising otherwise.

Flow for a run of kind `apify_scrape`:

1. Validate the connector, the actor id, and the input. The run stores `{ actorId, input, maxItems }` in its scope.
2. Mark the start attempt in the run scope, then start the actor run through the Apify API and record the Apify run id in the run scope, so polling survives a worker restart. If a start attempt's outcome is unknown (lost response, unparseable body, or a crash before the id was saved), the run fails and tells the user to check their Apify console; a retry never sends a second billed start.
3. Poll the Apify run until it finishes, with a configurable timeout (default 10 minutes). Elapsed time shows in the step detail.
4. Fetch dataset items up to `maxItems` (default 100, hard max 1000) and stage them as import rows with the raw item preserved.
5. Map common lead fields heuristically (name parts, email, company, domain, website, title, location, LinkedIn URL). Rows with neither a name nor an email are marked invalid with a reason. Unmapped keys stay in the raw column.
6. Dedupe against existing people (normalized email, then name plus organization) and organizations (domain, then name). Matches are marked duplicate, never merged silently.
7. Create an approval of kind `import_review` with honest counts (fetched, staged, duplicates, invalid) and a sample, and enter `waiting_approval`.
8. Approve: accepted rows create people and organizations plus field claims (source_type `apify`, source URL pointing at the Apify run, extraction method recording the actor id), all tagged `apify` and `via-<runId>`. Reject: the batch is rejected and nothing is created. Either way the run finishes with honest counts; a failed or aborted Apify run finishes `failed` (or `partial` when rows were already staged), and a run with nothing left to review finishes `partial` with no approval. The run never fabricates rows. Cancelling, timing out, or failing for good also makes a best effort request to abort the remote actor run; pausing stops local processing while the remote run continues, and the UI says so.

Policy: configuring connectors and deciding approvals are human actions through the UI. Runs started through MCP or the agent endpoint may only use actor ids on the connector's allowlist (a settings array edited in the UI), and at most one agent started Apify run may be active at a time. Runs started by the user in the UI can use any actor they pick. The Apify API token is sent only to api.apify.com, never to a model or a page.

The Apify base URL is `https://api.apify.com`, overridable with `AGENTCRM_APIFY_BASE` for tests. Key Apify endpoints used: `GET /v2/users/me` (token check), `GET /v2/store?search=` (actor search), `GET /v2/acts/:actorId` (actor detail, example input when present), `POST /v2/acts/:actorId/runs` (start), `GET /v2/actor-runs/:runId` (poll), `GET /v2/datasets/:datasetId/items` (results). Actor ids in the `username~actor-name` form are URL encoded.

## CSV import

CSV import reuses the staging, dedupe, review, and accept machinery that Apify uses, so a spreadsheet and a scrape get identical honesty guarantees.

- `POST /api/imports/csv/preview` takes `{ fileName, content }` (UTF-8 text, 10 MB cap) and returns `{ headers, delimiter, rowCount, suggestedMapping, sample }` without persisting anything. Parsing uses csv-parse with delimiter sniffing (comma, semicolon, tab), BOM stripping, and quoted fields. Hard caps: 10 MB and 20,000 rows; beyond them the request fails with `validation`.
- `POST /api/imports/csv` takes `{ fileName, content, mapping }` where mapping assigns each header to one of firstName, lastName, name, email, company, domain, title, location, linkedinUrl, tags, or ignore. At least email or a name field must be mapped. Location may span several columns (joined with a comma) and tags columns are merged; every other field takes the first non empty value when assigned more than once. Content must be valid UTF-8 text; files that decode with replacement characters are rejected rather than staged as mojibake. The route parses and stages the batch and rows synchronously (source_kind `csv`, raw row preserved), creates a run of kind `csv_import` with scope `{ batchId, fileName }`, and returns the run with 201. The run's ledger has four steps, and the first, parse and stage, is already done at creation because staging is synchronous; the worker then validates rows (no name and no email is invalid, with a reason), dedupes with the same rules as Apify, and requests the same `import_review` approval, whose payload carries `fileName` where the Apify payload carries `actorId`. Approve and reject behave exactly as for Apify batches, including per field claims (source_type `import`, source_url null, extraction method `csv:<fileName>`) and tags `csv-import` and `via-<runId>`.
- A `tags` column is split on commas or semicolons and merged into the created record's tags.

## Qualification

Qualification turns the template's criteria into visible, per criterion verdicts. It never writes to records: results live in `qualification_result`, one row per person, so it is a Maintain level action with no approval, and it is audited like every write.

- Config lives in `workspace.settings.qualification` as `{ exclusions, criteria }`, both arrays of Criterion: `{ id, label, target: "person" | "organization", field: title | location | tags | email | name | kind | domain, operator: contains | equals | in | exists, values: string[], enabled }`. Person rules accept title, location, tags, email, name; organization rules accept kind, domain, location, tags, name. `GET /api/qualification` returns it, with `defaulted: true` until a config is saved; `PUT /api/qualification` replaces it after validation and returns the saved config, keeping client supplied ids.
- Evaluation per person: exclusions first; any matching exclusion marks the person excluded with the reason, and the criteria are still computed for transparency. Each criterion returns `matched`, `not_matched`, or `unknown`. A missing field or record is always `unknown`, never a match. Matching is case insensitive, and `contains` matches substrings, including inside tags; the settings UI says so.
- Evidence: when the newest field claim for that field exists, the reason cites its status and age; otherwise the record value is cited as record data with no claim. Fit (matched of total) and completeness (unknown count) are reported separately and never combined into one hidden score.
- `POST /api/runs` kind `qualify` with scope `{}` or `{ tag }` evaluates people in chunks of 200 per transaction with ledger steps (load criteria, evaluate, write results), snapshotting the criteria in the run scope so a config edit mid run cannot mix rule versions. Counts: `processed` people evaluated, `found` people matching every enabled criterion (this can overlap with `excluded`), `flagged` people with at least one unknown, plus `excluded`. Agent origin may start qualify runs without an allowlist, because the run writes only qualification results.
- Results are a snapshot: `computedAt` says when, and editing a person afterwards does not recompute or mark the result stale yet. This is a known limitation; the UI shows the age rather than implying freshness.
- `GET /api/people` gains `sort=fit` (matched desc, then fewer unknowns, excluded and never qualified last) and each list item carries `qualification: { matched, total, unknown, excluded, computedAt } | null`; the UI marks a result "out of date" when the person changed after `computedAt`. `GET /api/people/:id` carries the full result payload: `{ computedAt, excluded, excludedReasons, matched, total, unknown, criteria: [{ id, label, outcome, reason, evidence }] }`.
- The startup fundraising template seeds editable defaults: an exclusion on tags containing do-not-contact, and criteria for organization kind equals fund, title containing partner, principal, scout, or head of, and tags containing seed.

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
| POST `/api/runs` | `{ kind, title?, scope? }`, returns the queued run immediately. Kinds: `demo_research` (scope optional JSON), `apify_scrape` (scope requires `actorId` and `input`, optional `maxItems` 1 to 1000 defaulting to 100), and `qualify` (scope `{}` or `{ tag }`). `csv_import` runs are created only through the CSV import route |
| GET `/api/runs/:id` | Run with ordered steps and any linked approvals |
| POST `/api/runs/:id/control` | `{ action: "pause" | "resume" | "cancel" }` |
| GET `/api/approvals?status=` | Approvals with run titles |
| GET `/api/approvals/:id` | One approval |
| POST `/api/approvals/:id/decision` | `{ decision: "approve" | "reject", note? }`. Returns `{ approval, run, alreadyDecided }`. Repeating the same decision is idempotent; the opposite decision returns 409 `conflict` |
| GET `/api/search?q=` | `{ people, organizations, opportunities }`, up to 8 each, for the command palette |
| GET `/api/connectors` | Configured connectors with masked settings, never the secret |
| PUT `/api/connectors/apify` | `{ token?, allowlist? }`. With a token: validates it against the Apify API and stores it. Without a token: updates the allowlist of an existing connector (error if none exists). Returns the masked connector (`tokenMasked`, `status`, `statusMessage` when status is error, `settings.allowlist`) |
| DELETE `/api/connectors/apify` | Remove the connector and its token. Queued, running, or paused Apify runs are failed first and Apify is asked to abort them while the token still exists; runs waiting for approval are left to the user |
| GET `/api/connectors/apify/actors?q=` | Proxied Apify store search: id, name, title, description, stats, pricing hint |
| GET `/api/connectors/apify/actors/:id` | Actor detail including `exampleRunInput` when Apify provides one, returned verbatim with no key case conversion because input keys belong to the actor |
| GET `/api/imports/:id?cursor=&limit=&status=` | Import batch with counts and paged rows; `withRaw=true` includes each row's raw item |
| POST `/api/imports/csv/preview` | Stateless parse: headers, delimiter, row count, suggested mapping, sample rows |
| POST `/api/imports/csv` | Stage a CSV with a confirmed mapping; returns the `csv_import` run, 201 |
| GET `/api/qualification` | The workspace's qualification config |
| PUT `/api/qualification` | Replace the qualification config after validation |
| POST `/api/agent/message` | `{ text }` returns `{ reply, actions, modelConnected }`. Deterministic and rule based. Actions are `{ id, label, kind, entityType?, entityId? }` with kinds `start_demo_run`, `open_record`, and `start_apify_import` (the UI opens the import setup; the server never starts the scrape itself) |
| GET `/api/events` | Server sent events. Frames: `run_updated` `{type,runId}`, `approval_updated` `{type,approvalId,runId}`, `record_updated` `{type,entityType,entityId}`, plus an initial `ready` event and a 15 second keep alive comment. The web app refetches on these signals |

## MCP server

`npm run --silent mcp --prefix apps/server` (and CLI `crm mcp`) starts an MCP server over stdio using the official TypeScript SDK. The `--silent` flag matters: without it npm prints its script banner to stdout and corrupts the protocol stream. Tools, all workspace scoped and read mostly:

- `crm_describe`: capabilities, template, counts, allowed actions
- `crm_search`: query with type filter, bounded results
- `crm_get_record`: person, organization, or opportunity by id, with evidence
- `crm_propose_changes`: validate a batch of field changes, return a preview, write nothing
- `crm_apply_changes`: apply a previously validated proposal with expected versions
- `crm_start_research`: start a run and return its id: `demo_research`, `qualify`, or `apify_scrape` for an allowlisted actor
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
crm import <file.csv> [--preview] [--json]
crm approvals list [--json]
crm approvals decide <id> approve|reject [--note <text>] [--json]
crm mcp
```

`crm import` with `--preview` prints the parse result and suggested mapping without staging; without it, the suggested mapping is used to stage the file and the command prints the run and batch ids. The CLI runs as the local user, so `crm approvals decide` is a human decision, unlike MCP tools, which can never decide approvals.

Exit codes: 0 success, 1 expected failure with a printed reason, 2 usage error.

## Conventions

- Loopback only. The server binds 127.0.0.1 and additionally rejects requests whose Host header is not 127.0.0.1, localhost, or [::1] (any port) with 403, as a DNS rebinding guard.
- Environment overrides: `AGENTCRM_DB` (database path), `AGENTCRM_PORT`, `AGENTCRM_LOG_LEVEL`, `AGENTCRM_STEP_MS` (demo run step interval), `AGENTCRM_APIFY_BASE` (provider base URL, for tests), `AGENTCRM_APIFY_TIMEOUT_MS` (poll timeout, default 600000), `AGENTCRM_APIFY_POLL_MS` (poll interval, default 3000).
- Known limitation: keyset cursors compare against the cursor row's sort keys at read time, so a record edited between pages can shift page boundaries for name, date, or recency ordered lists. A composite cursor that freezes the sort key is planned.
- All server code TypeScript, ESM, strict mode.
- Tests with vitest cover the action service: version conflicts, workspace scoping, approval decisions, run transitions.
