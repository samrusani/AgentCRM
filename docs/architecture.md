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
| activity | workspace_id, entity_type, entity_id, kind (note, email_draft, email_out, email_in, stage_change, agent), body, actor |
| task | workspace_id, version, title, entity_type, entity_id, due_at, status (open, done), updated_at |
| field_claim | workspace_id, entity_type, entity_id, field, value, source_url, source_type, observed_at, extraction_method (for apify claims, the actor id), status (imported, extracted, corroborated, human_confirmed) |
| run | workspace_id, kind, title, status, scope (JSON), counts (JSON), started_at, finished_at |
| run_step | run_id, seq, title, status (pending, running, done, skipped, failed), detail, started_at, finished_at |
| approval | workspace_id, run_id, kind, title, payload (JSON), payload_hash, status (pending, approved, rejected), note, decided_at, decided_by |
| job | kind, payload (JSON), run_at, attempts, status (queued, running, done, failed), updated_at |
| audit_event | workspace_id, actor, action, entity_type, entity_id, detail (JSON) |
| connector | workspace_id, kind (apify, anthropic, openai, deepseek, zai, ollama, agentmail), settings (JSON, no secrets), secret (API token; empty for ollama; never returned by any endpoint), status (connected, error), updated_at |
| email_message | workspace_id, provider_message_id (unique), provider_thread_id, direction (in, out), person_id (nullable), from_email, to (JSON array), subject, preview, body_text (nullable until fetched), labels (JSON), provider_timestamp, created_at |
| send_intent | workspace_id, person_id, draft_activity_id, inbox_id, to_email, subject, body, payload_hash, status (awaiting_approval, approved, queued, submitting, accepted, failed, unknown, blocked, cancelled, replied, bounced), approval_id, provider_message_id, provider_thread_id, error, submitted_at, updated_at. The intent id doubles as the provider idempotency key |
| suppression | workspace_id, email (unique, normalized lowercase), reason (bounce, opt_out, manual, demo_address), source, created_at |
| model_call | workspace_id, run_id (nullable), purpose (chat, draft), provider, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, estimated_usd, pending (a row written before the provider call and finalized after, so a crash leaves a visible possibly billed record), subject_id, created_at |
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

## LinkedIn lead capture

Paste a LinkedIn post URL and the agent captures leads from it through the user's own Apify account: who engaged with the post (reactions and comments), and the people and organizations named in the post text itself, because posts are often lists of angels, family offices, or funds. Captured people are staged, the new ones optionally enriched with profile details through one more Apify actor run, and one import review gates everything. The feature composes four store actors, configurable per workspace with these defaults (store prices noted as of their stated date, charged by Apify to the user's account):

| Role | Default actor | Default input shape | Price hint |
| --- | --- | --- | --- |
| Post text | `apimaestro/linkedin-post-detail` | `{ post_urls: [postUrl] }` | from 5.00 per 1,000 results (2026-11-03) |
| Reactions | `harvestapi/linkedin-post-reactions` | `{ posts: [postUrl], maxItems }` | from 1.50 per 1,000 results (2026-11-02) |
| Comments | `harvestapi/linkedin-post-comments` | `{ posts: [postUrl], maxItems }` | from 1.50 per 1,000 results (2026-11-02) |
| Profile enrichment | `harvestapi/linkedin-profile-scraper` | `{ queries: urls, profileUrls: urls, usernames: urls }` | from 4.00 per 1,000 profiles (2026-11-02) |

The post text actor documents `/posts/` URLs and bare activity ids as input; for a `/feed/update/urn:li:activity:<digits>` URL the server sends the bare numeric id instead, and other urn forms go as given (an actor that rejects them ends the post step with the actor's own message). Reading the names out of the post text is model work: it uses the workspace's active model provider through the normal adapter, so it needs a ready provider and records a `model_call` row like chat and drafting do, with the estimated cost synced into the run counts. The post text is untrusted content and is handled as data end to end: it is sanitized (zero width characters stripped, NFKC normalized, fence lookalike tags replaced), wrapped in a fenced block with instructions-are-data framing, and the extraction call has no tools. The model must answer only the JSON schema `{ entries: [{ kind: 'person' | 'organization', orgKind?, name, title?, company?, location?, linkedinUrl?, quote }] }` (quote is a verbatim snippet of at most 200 characters; `orgKind` 'fund' or 'company' sorts funds, venture firms, and family offices from operating companies). The answer is zod validated; providers that only offer `json_object` get one repair retry, schema capable providers do not. Every entry is then verified against the post text actually sent: an entry whose name, quote, or stated profile URL does not occur in the text is dropped and counted, so a hallucinated or injected lead is never staged or enriched, and a person link that is not an `/in/` profile path is removed from the entry. Post text is cut at 15,000 characters with a note. Verified entries are capped at `maxPeople` with a note. Once staging has consumed them, the extracted entries are removed from the run scope (and on any earlier terminal state), the scope key is excluded from run list reads, and `crm_get_run` never returns extracted text, so post content reaches no model or agent facing surface; it lives on only in the import rows the human reviews. The post author, which the post actor returns structured, is staged as one more person row without model work.

The enrichment input carries the url list under three field names at once (`queries`, `profileUrls`, `usernames`) so the common store actors accept it without per actor configuration; actors ignore fields they do not define. A custom actor id that rejects this shape ends the enrich step with the actor's own message in the ledger, and the run still goes to review. The actor ids live in the Apify connector settings as `leadCapture: { postActor, reactionsActor, commentsActor, profileActor }`, editable in the Apify card, and `PUT /api/connectors/apify` accepts a `leadCapture` object alongside `token` and `allowlist`, or alone. Each field is optional and per field: a sent id is normalized like an allowlist entry and stored, an empty string resets that field to its default, and a field left out keeps its value.

Run kind `lead_capture`, scope `{ postUrl, sources, maxPeople, enrich, enrichLimit, actors, calls, batchId? }`:

- `postUrl`: must start with `http://` or `https://` on `linkedin.com` or a subdomain and match a post shape: `/posts/<slug>-activity-<digits>`, `-ugcPost-<digits>`, or `-share-<digits>` (with optional suffix and query), or `/feed/update/urn:li:activity:<digits>`, `urn:li:ugcPost:<digits>`, or `urn:li:share:<digits>`. Anything else is rejected with a sentence naming the accepted shapes. Max 500 characters. The URL is passed to the actors as given (the web form prepends `https://` to a schemeless paste before sending).
- `sources`: non empty subset of `['post', 'reactions', 'comments']`. Default for user started runs: all three when a ready model provider is active, otherwise reactions and comments. Agent started runs default to reactions and comments only; the post source, which spends extra actor and model money, must be asked for explicitly. Starting a run with `post` in the sources requires a ready model provider; the validate step re-checks it, drops the post source with an honest detail when the provider stopped being ready, and names the provider and model in the detail when the active model changed since start.
- `maxPeople`: per source cap passed to each engagement actor as `maxItems`, default 50, hard max 500.
- `enrich`: boolean, default true. `enrichLimit`: how many new people may be enriched, default 25, hard max 200.
- `actors`: the three resolved actor ids, frozen into the scope at start so a settings edit mid run changes nothing.
- `calls`: per actor call state, keyed `post`, `reactions`, `comments`, `enrich`. Each call carries `{ actorId, startAttemptedAt?, apifyRunId?, datasetId?, startedAt?, finished?, abortRequested?, itemCount? }` and follows the exact money discipline of `apify_scrape`: the start attempt is marked in its own transaction before the request leaves the process, and that transaction re-reads the scope and backs off when another tick already marked it; an unknown start outcome is never retried; a restart polls the saved run id instead of starting again; rate limited before start clears the marker and retries; every terminal path, `partial` included, makes a best effort abort request for every unfinished remote call. An unknown outcome on an engagement call fails the run; on the enrich call it is soft (see step 6).

Steps:

1. Validate the connector, the URL, the sources, and the limits, including a ready model provider when `post` is selected (when it stopped being ready since start, the post source is dropped with an honest detail instead of failing the run, and the other sources continue).
2. Read the post through Apify (when `post` is not in `sources`, the step completes with a detail saying it was skipped and why; a failure here is soft like enrichment: the engagement sources continue and the detail says what was lost).
3. Scrape reactions through Apify (same skip rule; a failure here fails the run when reactions was the only source, otherwise it is soft).
4. Scrape comments through Apify (same rules as reactions).
5. Extract people named in the post: one fenced model call over the post text as described above (skipped without `post`). A model failure, refusal, or unreadable post dataset is soft while another selected source is still healthy: the step completes with what happened and the engagement people still go to review. When the post is the only selected source (or every other source already failed), a post that cannot be read fails the run. Pausing mid call never repeats the billed call: the outcome is saved whatever the run state and resumed from. The verified entries are kept in the run scope only until staging consumes them; each entry keeps its `quote`, shown to the reviewer in the batch rows.
6. Stage people from the post: one import row per unique person across all sources, merged only by normalized profile URL (host lowercased, the `/in/<id>` segment kept as is, query and trailing slash stripped). An item without a profile URL becomes its own row and never merges with anything, so two same named people stay two visible rows. Engagement mapping reads every person field from the item's `actor` object when it exists, else every field from the `author` object (`name`, `headline`, `profile_url`), never mixing the two; a profile URL is kept only when it parses as http or https on linkedin.com or a subdomain (extracted linkedinUrl values pass the same check). The post author becomes a row mapped from the post item's `author` object. Extracted `organization` entries become organization rows: `mapped.kind` is `organization`, the name goes to `company`, and they are valid without a person name. The raw column keeps the source items plus a `sources` array (`{ kind: 'reaction', reactionType }`, `{ kind: 'comment', commentary }`, `{ kind: 'post_author' }`, and `{ kind: 'post', quote }` with text cut to 200 characters). A person row with neither a name nor a profile URL is invalid with a reason, and an organization row without a company name is invalid. When a source's item count equals `maxPeople`, the step detail says the cap was reached and more engagement may exist. An engagement dataset that cannot be read at this step is soft when another source produced something: what exists is staged and the detail says what was lost. `fetched` counts unique rows, not items; the per source item counts live in the step detail and in `calls.*.itemCount`, and `requested` is `maxPeople` times the number of sources, plus one for the author when the post is a source. Batch `source_kind` is `lead_capture` (migration 010 widens the CHECK with the usual in place rebuild), `source_ref` is `{ postUrl, actors, apifyRunIds }`.
7. Check for duplicates before any enrichment money is spent: the Apify import rules, plus a match against existing people's `linkedinUrl` claims, plus a match against rows staged in another pending import of the same workspace (a batch still staging or awaiting review whose run is still open), each with its reason on the row. Organization rows dedupe against existing organizations by domain, then normalized name. A person the capture cannot identify by profile URL or email, such as a hand created person with neither, is not caught here; the step detail states the rule rather than overpromising.
8. Enrich new profiles through Apify (completes as skipped when `enrich` is false, or when no staged, non duplicate person row has a profile URL; organization rows are never enriched). Takes the first `enrichLimit` staged person rows with profile URLs, one batched actor run for all of them, never one run per person. An enrichment failure is soft: a permanent provider error, timeout, failed remote run, or unknown start outcome completes the step with the honest sentence (including the check your console sentence for unknown outcomes), requests the remote abort, and the staged rows still go to review without enrichment data.
9. Merge enriched details: an output item that carries a profile URL or `publicIdentifier` matches only by that key; the normalized name fallback applies only to items with neither, so a lookalike profile cannot attach its email to the wrong person. Enrichment fills empty mapped fields only (title, company, location, email, name split), reading flat fields heuristically plus the nested shapes `location.linkedinText`, `currentPosition[0].companyName`, and `headline`; the domain comes only from explicit company domain or company website fields, never from a personal website. The enrichment item is kept in the row's raw under `enrichment`. Unmatched output items are counted in the step detail and dropped. Dedupe runs once more, including against other pending imports, because an enriched email can reveal an existing or already staged person. Person rows still without a name and an email are marked invalid.
10. Request one `import_review` approval with the same counts as other imports; the payload carries `postUrl` and `actors`, and its sample rows include name, email, company, title, profile URL, and the row kind, so organization entries are visible as organizations. Approve: accepted rows create people, organizations (an organization row creates or matches just the organization), and field claims with source_type `apify`, source URL set to the post URL stripped of query and fragment, extraction method per claim naming what produced that field: `lead_capture:<actorId>` for actor sourced fields and `lead_capture:model:<provider>:<model>` for fields read out of the post text. Tags `linkedin-leads` and `via-<runId>`; rows whose email or LinkedIn profile now matches a person added after staging are skipped as duplicates at accept time. Reject: nothing is created.

Policy, matching the Apify section: a run started by the user in the UI may use the configured actor ids as they are. A run started through MCP or the agent endpoint requires every involved actor id (the selected sources plus enrichment when on) to be on the Apify allowlist, and counts against the same one active agent started Apify run limit. MCP gains the tool `start_lead_capture` taking `{ postUrl, sources?, maxPeople?, enrich?, enrichLimit? }`, subject to those rules. `POST /api/runs` accepts kind `lead_capture` with the same scope fields.

The run never promises a spend cap it cannot enforce: `maxItems` caps pay per result actors and the run timeout caps the rest, and the UI repeats the Apify section's sentence about that. Prices shown anywhere are store listing hints dated 2026-11-02, not invoices.

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

## Model adapter

The model adapter brings real intelligence to chat and drafting while keeping every honesty rule. Users bring their own model access; the product ships none, and everything except model calls keeps working without it. Five providers are supported, each its own connector kind with the same secret rules: `anthropic` (the reference implementation below), `openai`, `deepseek`, `zai` (GLM), and `ollama` (a local server, no key). Exactly one configured provider is active at a time, chosen in Settings and stored in `workspace.settings.modelProvider`; chat and drafting use the active one, and every `model_call` row records the provider and model.

Provider presets (API facts read from each provider's live documentation on 2026-11-02; prices are list prices per million tokens and every cost shown is an estimate labelled with that date):

| Kind | Base URL (env override for tests) | Auth | Models offered (default first) | Tools | JSON output |
| --- | --- | --- | --- | --- | --- |
| openai | https://api.openai.com/v1 (`AGENTCRM_OPENAI_BASE`) | Bearer key | gpt-5.6-terra (2.00 in / 12.00 out, cached 0.20), gpt-5.6-sol (4.00 / 20.00, cached 0.40), gpt-6-luna (0.10 / 0.50, cached 0.01) | Chat Completions tools with `strict: true`. The gpt-6-astra and gpt-6.1-sol flagships need the Responses API for tools, so they are not offered | `response_format` json_schema (strict) |
| deepseek | https://api.deepseek.com (`AGENTCRM_DEEPSEEK_BASE`) | Bearer key | deepseek-flash (0.30 in / 1.20 out peak, cache hit 0.006), deepseek-v4-pro (1.32 / 3.96 peak, cache hit 0.044) | Tools, non strict (strict needs their beta base, not used) | `json_object` only: the schema goes in the prompt, the word json must appear, blank content means retry once then flag |
| zai | https://api.z.ai/api/paas/v4 (`AGENTCRM_ZAI_BASE`) | Bearer key | glm-5.3 (1.40 / 4.40, cached 0.26), glm-4.7 (0.60 / 2.20, cached 0.11) | Tools, `tool_choice` auto only; `function.arguments` may arrive as an object or a string, parse both | `json_object` only, text models only (flash vision models are not offered) |
| ollama | http://127.0.0.1:11434, user editable in settings | None locally | Installed models from `GET /api/tags`, user picks | Native `/api/chat` tools; a model that rejects tools degrades per the rules below | Native `format` accepts a full JSON schema |

- The four OpenAI compatible providers share one adapter parameterized by these presets; Ollama uses its native API (`/api/chat` with `stream: false`, usage from `prompt_eval_count` and `eval_count`, cost shown as "local, no cost"). OpenAI uses `max_completion_tokens`, not the deprecated `max_tokens`. zai requests send `reasoning_effort: "low"` because glm-5.3 always reasons and defaults to max. DeepSeek estimates use peak prices (off peak is half, and the estimate says so).
- Capability degradation is explicit, never silent: a provider or model without tool support answers chat from the visible context alone and the reply says lookups were unavailable; a provider without json_schema gets the schema embedded in the drafting prompt with `json_object` mode, zod validation unchanged, and one repair retry before the person is flagged.
- Key validation: openai and deepseek via their models list endpoint, zai via a one token completion on the free glm-4.7-flash, ollama via `GET /api/tags` (which also fills the model list).
- Everything else in this section (budgets, pending model_call rows, checkpoints, approval binding, inbound text fencing, disclosure lines) applies identically to every provider; disclosure names the configured provider instead of Anthropic, and the Ollama card says records go to the local server at the configured address.

- Connector kind `anthropic`: `PUT /api/connectors/anthropic` takes `{ token?, model? }`, validates the token against the models endpoint, and stores it with the same secret rules as Apify (local secret column, masked to last four, never in logs, audit, SSE, errors, or MCP). Settings hold the chosen `model`. `DELETE` removes it. The provider base URL is `https://api.anthropic.com`, overridable with `AGENTCRM_ANTHROPIC_BASE` for tests.
- Supported models with their current list prices per million tokens (a static map in code, used only for estimates and labelled as estimates): `claude-opus-5-5` (default, input 4.00, output 20.00), `claude-sonnet-5-5` (2.00, 10.00), `claude-haiku-5-5` (0.10, 0.50 up to 100K prompts). The default model is Opus 5.5.
- Every model call writes a `model_call` row: a pending row goes in before the provider call and is finalized with real usage after, so a crash mid call leaves a visible "outcome unknown, possibly billed" record and that person is never silently re billed. Estimates use the price map including cache writes at 1.25 times input and cache reads at a tenth; costs shown in the UI always say estimated.
- Chat and drafting send record contents (people, organizations, claims, notes) to Anthropic; the connector card and the draft sheet say so plainly.
- Agent origin draft runs with no budget get a default budget of 1.00 dollars. Draft calls run with SDK retries off (the worker owns the 3 attempts), and a run stops early as partial after three consecutive identical non retryable rejections.

Chat with a model connected: `POST /api/agent/message` accepts `{ text, history?, context? }` where history is up to the last 10 `{ role, text }` turns and context is an optional `{ entityType, entityId }`. The server runs a bounded tool loop (at most 5 tool rounds, 30 second provider timeout) with read only, strict schema tools: `search_crm`, `get_record`, `today_summary`. The model never gets a tool that writes. CRM content enters prompts as data with an explicit instruction that it is not instructions. The reply returns `{ reply, actions, modelConnected: true, usage: { inputTokens, outputTokens, estimatedUsd } }`; suggested actions always come from the server's rule based code, never from model text. A provider failure returns the deterministic reply with `modelFailed: true` and a plain note. With no key configured, the deterministic replies remain exactly as they are.

Run kind `draft_outreach`: scope `{ personIds?, tag?, instructions?, maxPeople (default 10, cap 25), budgetUsd? }`.

1. Load the audience: people with an email, not excluded by qualification, never tagged do-not-contact. Skipped people are counted with reasons.
2. Draft one person per model call with structured output (subject, body, factsUsed citing the record fields and claims the draft used). The system prompt carries the user's instructions and voice, marks CRM content as data, and is cache stable across the batch. Progress checkpoints in the run scope so a restart never redrafts paid work.
3. A refusal or per person failure marks that person flagged with the reason and continues. The budget is checked between drafts: when the spend so far plus the average cost per call would cross `budgetUsd`, the run stops drafting and finishes `partial` with honest counts. The first draft always runs, and a costlier than average draft can push the total past the budget; the UI says so.
4. Final step creates an approval of kind `draft_review` whose payload carries the full drafts (person, subject, body, factsUsed) plus the count and estimated cost, so the approval hash binds exactly what the user read to what gets applied. The UI renders every draft for reading before the decision; facts are labelled as reported by the model, with a server check marking any fact value not found in the record. The run enters `waiting_approval`. The run enters `waiting_approval`. Approving writes one `email_draft` activity per draft, labelled as a draft that was not sent (no email connector exists). Rejecting cancels the run. Nothing is ever sent. Removing the connector fails queued, running, or paused draft runs with a clear step detail before the key is deleted; runs already waiting for review stay decidable.

Counts for draft runs: `processed`, `found` (drafted), `flagged` (skipped or failed, with reasons), plus `estimatedUsd` observed. Agent origin may start `draft_outreach` under the same one active agent run rule as Apify; drafting spends the user's model budget, so the cap applies.

API facts the implementation must follow (current as of this writing): thinking is always on for these models, so the `thinking` parameter is omitted; depth is controlled with `output_config.effort` (`low` for chat, `medium` for drafting). Forced `tool_choice` `any` or `tool` returns a 400 on these models; tools use `auto` with `strict: true` schemas. Structured outputs use `output_config.format`. Refusals surface as HTTP 200 with `stop_reason: "refusal"`; server side fallbacks are enabled with `fallbacks: "default"` plus the beta header `server-side-fallback-2026-07-01`. The stable system prompt carries a `cache_control` breakpoint so batch drafting reuses the prompt cache.

## Email: the AgentMail connector and sending

Email is the only place AgentCRM touches the outside world on the user's behalf, so it carries the strictest rules in the product. Nothing is ever submitted to the provider without a human approving the exact frozen message, and an unknown outcome is surfaced, never resolved by guessing.

Connector kind `agentmail`: API key (`am_...`), validated against the API, stored under the same secret rules as the other connectors. Settings hold the selected inbox (`inboxId`, `email`) and sync cursors. The user picks an existing inbox from a list or explicitly creates one (optional username; creation uses the provider's `client_id` idempotency). Base URL `https://api.agentmail.to/v0`, overridable with `AGENTCRM_AGENTMAIL_BASE` for tests. Provider facts the implementation relies on: Bearer auth; `POST /v0/inboxes/{inboxId}/messages/send` with an `Idempotency-Key` header where a retry with the same key returns the original `message_id` and `thread_id` and sends no second email, and the same key with a different payload returns 409; `GET /v0/inboxes/{inboxId}/messages` with `after` plus `ascending=true` and `page_token` for inbound sync, message direction read from the `received` and `sent` labels; `GET /v0/inboxes/{inboxId}/messages/{messageId}` for full bodies; `GET /v0/inboxes/{inboxId}/events` (label.added, label.removed, newest first, no after filter, so the poller pages until it meets a seen event id) for bounce evidence via the `bounced` label. List response shapes are not fully documented, so the adapter parses defensively. No public webhook is used; everything is outbound polling, every poll interval default 60 seconds (`AGENTCRM_MAIL_POLL_MS`).

The send intent state machine, per the product spec:

- "Prepare to send" on a saved draft (one person) or on a draft run's detail (all its drafts) creates a run of kind `send_outreach` holding the intents in `awaiting_approval` plus one approval of kind `send_review` whose hashed payload is `{ messages: [{ intentId, personName, to, subject, body, inboxEmail }], excluded: [{ personName, toEmail, reason }], remainingDailyCap, runId? }`. Exclusion and block reasons use the codes suppressed, demo_address, invalid_recipient, duplicate_open_intent, no_inbox, daily_cap, reply_received, and connector_removed. Preflight at creation excludes, with listed reasons: suppressed addresses, demo addresses (example.com, example.org, example.net and subdomains are blocked with reason demo_address so synthetic data can never generate real mail), missing or invalid recipient, an already open intent for the same person and subject, no connected inbox, and no room in the daily cap.
- Approving moves the intents to `queued`. Editing anything invalidates the approval (hash mismatch refuses the decision). Cancelling a single intent before the decision is subtraction only: approve then queues only the intents still awaiting whose message matches the approved payload and reports the cancelled ones as skipped; approving when everything was cancelled resolves as a rejection with a note. Rejecting cancels them all.
- The worker submits queued intents one at a time per inbox. Immediately before each submit it rechecks: payload hash against the approval, suppression, a reply arrived from that person since approval (blocks with reason), connector still configured, daily cap. A failed recheck moves the intent to `blocked` with the reason; blocked intents need a fresh human decision, never an automatic retry. A queued intent whose approval is more than a day old is blocked the same way ("Approved more than a day ago. Review and approve again."), and the `send_outreach` run stays running until every intent settles, then resolves honestly (partial when anything failed, bounced, blocked, or stayed unknown).
- Submit uses the intent id as the `Idempotency-Key`. Success stores `provider_message_id` and `provider_thread_id`, sets `accepted`, and writes an activity on the person that says provider accepted, which is not delivery. A definitive 4xx sets `failed` with the reason. A timeout, network failure, or 409 sets `unknown`; reconciliation retries the same request with the same key on a backoff schedule, which the provider's duplicate protection makes safe for about a day after the attempt. Past that window the intent is never retried: it stays `unknown` with a task telling the user to check the provider's sent mail. An intent that is `unknown` never becomes `failed`, and nothing is ever resent with a new key.
- Daily cap: 50 accepted sends per inbox per day (server local day), checked at preflight and at submit, with the remaining budget shown in the UI. 25 intents per approval at most.

Inbound sync: the poller fetches new messages after the cursor, dedupes by provider message id, stores them, links them to people by sender address, and fetches full text for inbound messages. A message on an accepted intent's thread (or from a person with open intents) marks that intent `replied`, creates a task to respond, and blocks any queued or approved intents to that person. Inbound text matching opt out wording (unsubscribe, stop, opt out, remove me) creates a suppression row with reason opt_out plus a review task; the suppression applies immediately and a human can lift it. The events poller maps a `bounced` label to the intent (`bounced`), writes a suppression row with reason bounce, and creates a task. Open tracking is off: `track_opens` is never sent, and opened labels are ignored.

Agents never touch sending: MCP and the chat endpoint cannot create, approve, or submit send intents, and the CLI refuses to decide send_review approvals because it cannot show the full messages. Sending is a human flow through the UI, enforced by the backend. Inbound email content is excluded from every model facing surface (draft prompts, chat tools, MCP record reads); it appears only in the human UI.

Email endpoints:

| Method and path | Purpose |
| --- | --- |
| PUT `/api/connectors/agentmail` | `{ token?, inboxId?, inboxEmail? }`: token validates and stores the key; inbox fields select the inbox. Masked shape like the other connectors |
| DELETE `/api/connectors/agentmail` | Remove the connector and key. Queued and approved intents become blocked with the reason; nothing in flight is abandoned silently |
| GET `/api/connectors/agentmail/inboxes` | Proxied inbox list (id, email), defensively parsed |
| POST `/api/connectors/agentmail/inboxes` | Explicitly create an inbox `{ username? }`, idempotent via client_id |
| POST `/api/send-intents` | `{ draftActivityIds?: string[], runId? }`: stage intents plus the send_review approval; returns the approval and the excluded list with reasons |
| GET `/api/send-intents?status=` | Intents with person names, newest first |
| POST `/api/send-intents/:id/control` | `{ action: "cancel" }` for intents not yet submitting; a human acknowledgement action `{ action: "acknowledge" }` clears surfaced unknown or blocked intents into cancelled |
| GET `/api/suppressions` | Suppression list |
| POST `/api/suppressions` | `{ email, reason: "manual" }` add one |
| DELETE `/api/suppressions/:id` | Lift a suppression (human action, audited) |
| GET `/api/mail/summary` | `{ counts (by status, snake keys), dailyCap, remainingDailyCap, lastSyncAt, repliesNeedingAttention: { count, items: [{ personId, personName, fromEmail, subject, snippet, receivedAt, taskTitle, optOut? }] } }` |

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
| GET `/api/runs?status=` | Runs, newest first. `status` accepts one value, a comma list, or `active`. Simulated runs carry `simulated: true`. Bulky scope arrays such as drafts are stripped from the list response and live on the run detail |
| POST `/api/runs` | `{ kind, title?, scope? }`, returns the queued run immediately. Kinds: `demo_research` (scope optional JSON), `apify_scrape` (scope requires `actorId` and `input`, optional `maxItems` 1 to 1000 defaulting to 100), and `qualify` (scope `{}` or `{ tag }`), and `draft_outreach` (scope per the model adapter section, requires the Anthropic connector). `csv_import` runs are created only through the CSV import route |
| GET `/api/runs/:id` | Run with ordered steps and any linked approvals |
| POST `/api/runs/:id/control` | `{ action: "pause" | "resume" | "cancel" }` |
| GET `/api/approvals?status=` | Approvals with run titles |
| GET `/api/approvals/:id` | One approval |
| POST `/api/approvals/:id/decision` | `{ decision: "approve" | "reject", note? }`. Returns `{ approval, run, alreadyDecided }`. Repeating the same decision is idempotent; the opposite decision returns 409 `conflict` |
| GET `/api/search?q=` | `{ people, organizations, opportunities }`, up to 8 each, for the command palette |
| GET `/api/connectors` | Configured connectors with masked settings, never the secret |
| PUT `/api/connectors/anthropic` | `{ token?, model? }`. With a token: validates and stores it. Without: updates the model choice. Same masked shape as Apify. The same route shape exists for `openai`, `deepseek`, and `zai`; `ollama` takes `{ baseUrl?, model? }` and no token: a base URL alone saves and validates the connection with the model unset, and the model is chosen afterwards |
| DELETE `/api/connectors/anthropic` | Remove the connector and its key (same for the other model provider kinds) |
| GET `/api/connectors/ollama/models` | Installed models from the configured Ollama server's tags endpoint |
| GET `/api/model-providers` | The preset catalog: kind, label, default model, models with dated price hints |
| PUT `/api/model-provider` | `{ kind }`: set the active model provider among configured ones; GET returns `{ kind, model, status, statusMessage, ready }` or null, where ready means connected, no error, and for ollama a model chosen; every surface treats ready, not selection, as "a model is available". Connecting the first model provider activates it automatically; removing the active one reassigns to another configured provider or null, and only removing the active provider stops draft runs |
| PUT `/api/connectors/apify` | `{ token?, allowlist? }`. With a token: validates it against the Apify API and stores it. Without a token: updates the allowlist of an existing connector (error if none exists). Returns the masked connector (`tokenMasked`, `status`, `statusMessage` when status is error, `settings.allowlist`) |
| DELETE `/api/connectors/apify` | Remove the connector and its token. Queued, running, or paused Apify runs are failed first and Apify is asked to abort them while the token still exists; runs waiting for approval are left to the user |
| GET `/api/connectors/apify/actors?q=` | Proxied Apify store search: id, name, title, description, stats, pricing hint |
| GET `/api/connectors/apify/actors/:id` | Actor detail including `exampleRunInput` when Apify provides one, returned verbatim with no key case conversion because input keys belong to the actor |
| GET `/api/imports/:id?cursor=&limit=&status=` | Import batch with counts and paged rows; `withRaw=true` includes each row's raw item |
| POST `/api/imports/csv/preview` | Stateless parse: headers, delimiter, row count, suggested mapping, sample rows |
| POST `/api/imports/csv` | Stage a CSV with a confirmed mapping; returns the `csv_import` run, 201 |
| GET `/api/qualification` | The workspace's qualification config |
| PUT `/api/qualification` | Replace the qualification config after validation |
| POST `/api/agent/message` | `{ text, history?, context? }` returns `{ reply, actions, modelConnected, usage?, provider?, model? }`. Model backed with a bounded read only tool loop when the active model provider is ready; deterministic and rule based otherwise. Actions are `{ id, label, kind, entityType?, entityId? }` with kinds `start_demo_run`, `open_record`, and `start_apify_import` (the UI opens the import setup; the server never starts the scrape itself) |
| GET `/api/events` | Server sent events. Frames: `run_updated` `{type,runId}`, `approval_updated` `{type,approvalId,runId}`, `record_updated` `{type,entityType,entityId}`, plus an initial `ready` event and a 15 second keep alive comment. The web app refetches on these signals |

## MCP server

`npm run --silent mcp --prefix apps/server` (and CLI `crm mcp`) starts an MCP server over stdio using the official TypeScript SDK. The `--silent` flag matters: without it npm prints its script banner to stdout and corrupts the protocol stream. Tools, all workspace scoped and read mostly:

- `crm_describe`: capabilities, template, counts, allowed actions, and `modelProvider: { configured, kind, status, model }`, never a key
- `crm_search`: query with type filter, bounded results
- `crm_get_record`: person, organization, or opportunity by id, with evidence
- `crm_propose_changes`: validate a batch of field changes, return a preview, write nothing
- `crm_apply_changes`: apply a previously validated proposal with expected versions
- `crm_start_research`: start a run and return its id: `demo_research`, `qualify`, `apify_scrape` for an allowlisted actor, or `draft_outreach` (one active agent started run at a time)
- `start_lead_capture`: start a `lead_capture` run from a LinkedIn post URL; every involved actor must be on the allowlist, and it shares the one active agent started run limit
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
- Environment overrides: `AGENTCRM_DB` (database path), `AGENTCRM_PORT`, `AGENTCRM_LOG_LEVEL`, `AGENTCRM_STEP_MS` (demo run step interval), `AGENTCRM_APIFY_BASE` (provider base URL, for tests), `AGENTCRM_APIFY_TIMEOUT_MS` (poll timeout, default 600000), `AGENTCRM_APIFY_POLL_MS` (poll interval, default 3000), `AGENTCRM_ANTHROPIC_BASE` (provider base URL, for tests), `AGENTCRM_ANTHROPIC_RETRIES` (SDK retry count, default 2), `AGENTCRM_AGENTMAIL_BASE` and `AGENTCRM_AGENTMAIL_TIMEOUT_MS` (mail provider, for tests), `AGENTCRM_MAIL_POLL_MS` (inbound poll, default 60000, min 5000), `AGENTCRM_MAIL_RECONCILE_MS` (reconcile schedule override), `AGENTCRM_OPENAI_BASE`, `AGENTCRM_DEEPSEEK_BASE`, and `AGENTCRM_ZAI_BASE` (provider base URLs, for tests; Ollama's address lives in its connector settings).
- Known limitation: keyset cursors compare against the cursor row's sort keys at read time, so a record edited between pages can shift page boundaries for name, date, or recency ordered lists. A composite cursor that freezes the sort key is planned.
- All server code TypeScript, ESM, strict mode.
- Tests with vitest cover the action service: version conflicts, workspace scoping, approval decisions, run transitions.
