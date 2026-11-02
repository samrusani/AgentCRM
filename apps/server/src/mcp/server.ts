import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  applyChanges,
  createContext,
  ensureWorkspace,
  proposeChanges,
  startRun,
} from '../actions/index.js';
import { serverVersion } from '../config.js';
import { openDatabase } from '../db.js';
import { AppError, validationError } from '../errors.js';
import { startWorker } from '../jobs/worker.js';
import { getOpportunityDetail } from '../queries/opportunities.js';
import { getOrganizationDetail } from '../queries/organizations.js';
import { getPersonDetail } from '../queries/people.js';
import { getRunDetail } from '../queries/runs.js';
import { searchAll } from '../queries/search.js';
import { getCounts } from '../queries/workspace.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): ToolResult {
  if (error instanceof AppError) {
    const body = { error: { code: error.code, message: error.message, ...(error.current !== undefined ? { current: error.current } : {}) } };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
  }
  const message = error instanceof Error ? error.message : 'The tool failed.';
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'internal', message } }) }], isError: true };
}

function guarded(work: () => unknown): ToolResult {
  try {
    return ok(work());
  } catch (error) {
    return failure(error);
  }
}

const changeShape = z.object({
  entityType: z.enum(['person', 'organization', 'opportunity', 'task']),
  id: z.string(),
  expectedVersion: z.number().int().optional(),
  fields: z.record(z.unknown()),
});

export async function startMcpServer(): Promise<void> {
  const db = openDatabase();
  const workspace = ensureWorkspace(db);
  const ctx = createContext(db, workspace.id, { actor: 'agent:mcp' });
  // Runs started here must advance even when the API server is not running.
  const worker = startWorker(ctx, (error) => console.error(error), { recover: false });
  const server = new McpServer({ name: 'agentcrm', version: serverVersion });

  server.registerTool(
    'crm_describe',
    {
      title: 'Describe the CRM',
      description: 'Returns the workspace, template, record counts, and the actions these tools allow.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(() => ({
        workspace: { id: workspace.id, name: workspace.name, template: workspace.template },
        counts: getCounts(db, workspace.id),
        modelConnected: false,
        allowedActions: [
          'Search people, organizations, and opportunities.',
          'Read a record with its field claims and activity.',
          'Propose field changes and read a preview. Nothing is written.',
          'Apply a proposal with expected versions. A stale version fails the whole batch.',
          'Start a simulated research run and read its progress.',
          'Start an Apify import run for an actor on the connector allowlist. Results wait for a person to approve them in the app.',
          'Start a qualify run, optionally limited to one tag. It writes per criterion verdicts to qualification results, needs no approval, and changes no records.',
        ],
        notAllowed: ['Approving or rejecting an approval. Only a person can decide, in the app.'],
        notes:
          'demo_research runs are simulated and make no network requests. apify_scrape runs call the real Apify API with the connected account, only for allowlisted actor ids, and stage rows for human review. qualify runs evaluate people against the qualification criteria in Settings, make no network requests, and need no approval. CSV imports are started by a person in the app or with the crm import command.',
      })),
  );

  server.registerTool(
    'crm_search',
    {
      title: 'Search records',
      description: 'Searches people, organizations, and opportunities by name, email, or domain.',
      inputSchema: {
        query: z.string().min(1).max(200),
        type: z.enum(['all', 'people', 'organizations', 'opportunities']).default('all'),
        limit: z.number().int().min(1).max(20).default(8),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, type, limit }) =>
      guarded(() => {
        const found = searchAll(db, workspace.id, query, limit);
        if (type === 'all') return found;
        return { [type]: found[type] };
      }),
  );

  server.registerTool(
    'crm_get_record',
    {
      title: 'Get a record',
      description:
        'Returns a person, organization, or opportunity by id, with its field claims (evidence), activity, and linked records.',
      inputSchema: { id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      guarded(() => {
        if (id.startsWith('per_')) return { entityType: 'person', record: getPersonDetail(db, workspace.id, id) };
        if (id.startsWith('org_')) return { entityType: 'organization', record: getOrganizationDetail(db, workspace.id, id) };
        if (id.startsWith('opp_')) return { entityType: 'opportunity', record: getOpportunityDetail(db, workspace.id, id) };
        throw validationError('The id must start with per_, org_, or opp_.');
      }),
  );

  server.registerTool(
    'crm_propose_changes',
    {
      title: 'Propose changes',
      description:
        'Validates a batch of field changes and returns a preview with a proposalHash. Nothing is written. Fields use the same names as the REST API.',
      inputSchema: { changes: z.array(changeShape).min(1).max(50) },
      annotations: { readOnlyHint: true },
    },
    async ({ changes }) => guarded(() => proposeChanges(ctx, { changes })),
  );

  server.registerTool(
    'crm_apply_changes',
    {
      title: 'Apply changes',
      description:
        'Applies a proposal returned by crm_propose_changes. Send the same changes with expectedVersion on each and the proposalHash. The batch is atomic.',
      inputSchema: {
        proposalHash: z.string().length(64),
        changes: z.array(changeShape.extend({ expectedVersion: z.number().int() })).min(1).max(50),
      },
    },
    async ({ proposalHash, changes }) => guarded(() => applyChanges(ctx, { proposalHash, changes })),
  );

  server.registerTool(
    'crm_start_research',
    {
      title: 'Start a research run',
      description:
        'Starts a run and returns its id. kind demo_research (default) is simulated: scripted steps, synthetic candidates. kind apify_scrape runs a real Apify actor with the scope { actorId, input, maxItems } and works only for actor ids on the Apify allowlist set in Settings. Both of those kinds wait for a person to approve in the app. kind qualify evaluates people against the qualification criteria (optional tag limits it to people with that tag), writes results, and needs no approval.',
      inputSchema: {
        kind: z.enum(['demo_research', 'apify_scrape', 'qualify']).default('demo_research'),
        tag: z.string().min(1).max(60).optional(),
        title: z.string().min(1).max(200).optional(),
        query: z.string().max(200).optional(),
        targetCount: z.number().int().min(1).max(10).optional(),
        scope: z
          .object({
            actorId: z.string().min(1).max(200),
            input: z.record(z.unknown()),
            maxItems: z.number().int().min(1).max(1000).optional(),
          })
          .optional(),
      },
    },
    async ({ kind, title, query, targetCount, scope, tag }) =>
      guarded(() => {
        if (kind === 'qualify') {
          const run = startRun(ctx, { kind, ...(title ? { title } : {}), scope: tag ? { tag } : {} }, { origin: 'agent' });
          return {
            runId: run.id,
            status: run.status,
            simulated: false,
            note: 'A worker in this process or in the API server advances this run. Read progress with crm_get_run. No approval is needed because it writes only qualification results.',
          };
        }
        if (kind === 'apify_scrape') {
          if (!scope) throw validationError('scope: apify_scrape needs a scope with actorId and input.');
          const run = startRun(ctx, { kind, ...(title ? { title } : {}), scope }, { origin: 'agent' });
          return {
            runId: run.id,
            status: run.status,
            simulated: false,
            note: 'A worker in this process or in the API server advances this run and calls Apify. Read progress with crm_get_run. Only a person can approve the import.',
          };
        }
        const run = startRun(
          ctx,
          {
            kind: 'demo_research',
            ...(title ? { title } : {}),
            scope: { ...(query ? { query } : {}), ...(targetCount ? { targetCount } : {}) },
          },
          { origin: 'agent' },
        );
        return {
          runId: run.id,
          status: run.status,
          simulated: true,
          note: 'A worker in this process or in the API server advances this run. Read progress with crm_get_run. Only a person can approve the shortlist.',
        };
      }),
  );

  server.registerTool(
    'crm_get_run',
    {
      title: 'Get a run',
      description: 'Returns a run with its status, counts, ordered steps, and linked approvals.',
      inputSchema: { runId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => guarded(() => getRunDetail(db, workspace.id, runId)),
  );

  const shutdown = (): void => {
    worker.stop();
    db.close();
    process.exit(0);
  };
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  await server.connect(new StdioServerTransport());
  console.error('AgentCRM MCP server is running on stdio.');
}
