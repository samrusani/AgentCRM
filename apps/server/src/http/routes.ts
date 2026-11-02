import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  abortRemoteRunIfNeeded,
  configureApifyConnector,
  controlRun,
  createActivity,
  createContext,
  createOpportunity,
  createOrganization,
  createPerson,
  createTask,
  decideApproval,
  disconnectApifyConnector,
  getApifyActor,
  moveOpportunityStage,
  parseInput,
  previewCsvFile,
  saveQualificationConfig,
  searchApifyActors,
  stageCsvImport,
  startRun,
  updateOpportunity,
  updateOrganization,
  updatePerson,
  updateTask,
} from '../actions/index.js';
import { respondToMessage } from '../agent/message.js';
import { serverVersion } from '../config.js';
import { displayDatabasePath } from '../paths.js';
import { listActivities } from '../queries/activities.js';
import { listConnectors } from '../queries/connectors.js';
import { getImportDetail } from '../queries/imports.js';
import { getOpportunityDetail, listOpportunities } from '../queries/opportunities.js';
import { getOrganizationDetail, listOrganizations } from '../queries/organizations.js';
import { getPersonDetail, listPeople } from '../queries/people.js';
import { listPipelines } from '../queries/pipelines.js';
import { readQualificationConfig } from '../qualification/config.js';
import { getRunDetail, listApprovals, listRuns, requireApproval } from '../queries/runs.js';
import { searchAll } from '../queries/search.js';
import { listTasks } from '../queries/tasks.js';
import { getToday } from '../queries/today.js';
import { requireWorkspace } from '../queries/workspace.js';
import type { AppOptions } from './app.js';
import { openEventStream } from './events.js';

const pagingQuery = {
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
};

const peopleQuery = z.object({
  q: z.string().optional(),
  organizationId: z.string().optional(),
  sort: z.enum(['name', 'fit']).optional(),
  ...pagingQuery,
});
const organizationsQuery = z.object({ q: z.string().optional(), ...pagingQuery });
const opportunitiesQuery = z.object({
  pipelineId: z.string().optional(),
  stageId: z.string().optional(),
  status: z.enum(['open', 'passed', 'lost', 'nurture']).optional(),
  ...pagingQuery,
});
const tasksQuery = z.object({ filter: z.enum(['today', 'overdue', 'open', 'done']).optional(), ...pagingQuery });
const activitiesQuery = z.object({
  entityType: z.enum(['person', 'organization', 'opportunity']).optional(),
  entityId: z.string().optional(),
  ...pagingQuery,
});
const statusQuery = z.object({ status: z.string().optional(), ...pagingQuery });
const searchQuery = z.object({ q: z.string().default('') });
const messageBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
const idParams = z.object({ id: z.string().min(1) });
const importQuery = z.object({
  status: z.string().optional(),
  withRaw: z.enum(['true', 'false']).optional(),
  ...pagingQuery,
});

export function registerRoutes(app: FastifyInstance, options: AppOptions): void {
  const { db, bus } = options;
  const workspaceId = (): string => requireWorkspace(db).id;
  const context = () => createContext(db, workspaceId(), { bus, actor: 'user', now: options.now });
  const idParam = (params: unknown): string => parseInput(idParams, params).id;

  app.get('/api/health', async () => ({
    ok: true,
    version: serverVersion,
    dbPath: displayDatabasePath(options.databasePath),
  }));

  app.get('/api/workspace', async () => {
    const { id, name, template } = requireWorkspace(db);
    return { id, name, template };
  });

  app.get('/api/today', async () => getToday(db, workspaceId()));

  app.get('/api/people', async (request) =>
    listPeople(db, workspaceId(), parseInput(peopleQuery, request.query)),
  );
  app.get('/api/people/:id', async (request) => getPersonDetail(db, workspaceId(), idParam(request.params)));
  app.post('/api/people', async (request, reply) => {
    reply.status(201);
    return createPerson(context(), request.body);
  });
  app.patch('/api/people/:id', async (request) => updatePerson(context(), idParam(request.params), request.body));

  app.get('/api/organizations', async (request) =>
    listOrganizations(db, workspaceId(), parseInput(organizationsQuery, request.query)),
  );
  app.get('/api/organizations/:id', async (request) =>
    getOrganizationDetail(db, workspaceId(), idParam(request.params)),
  );
  app.post('/api/organizations', async (request, reply) => {
    reply.status(201);
    return createOrganization(context(), request.body);
  });
  app.patch('/api/organizations/:id', async (request) =>
    updateOrganization(context(), idParam(request.params), request.body),
  );

  app.get('/api/pipelines', async () => ({ items: listPipelines(db, workspaceId()), nextCursor: null }));

  app.get('/api/opportunities', async (request) =>
    listOpportunities(db, workspaceId(), parseInput(opportunitiesQuery, request.query)),
  );
  app.get('/api/opportunities/:id', async (request) =>
    getOpportunityDetail(db, workspaceId(), idParam(request.params)),
  );
  app.post('/api/opportunities', async (request, reply) => {
    reply.status(201);
    return createOpportunity(context(), request.body);
  });
  app.post('/api/opportunities/:id/stage', async (request) =>
    moveOpportunityStage(context(), idParam(request.params), request.body),
  );
  app.patch('/api/opportunities/:id', async (request) =>
    updateOpportunity(context(), idParam(request.params), request.body),
  );

  app.get('/api/tasks', async (request) => listTasks(db, workspaceId(), parseInput(tasksQuery, request.query)));
  app.post('/api/tasks', async (request, reply) => {
    reply.status(201);
    return createTask(context(), request.body);
  });
  app.patch('/api/tasks/:id', async (request) => updateTask(context(), idParam(request.params), request.body));

  app.get('/api/activities', async (request) =>
    listActivities(db, workspaceId(), parseInput(activitiesQuery, request.query)),
  );
  app.post('/api/activities', async (request, reply) => {
    const body = parseInput(
      z
        .object({
          entityType: z.enum(['person', 'organization', 'opportunity']),
          entityId: z.string().min(1),
          body: z.string(),
          kind: z.literal('note').optional(),
        })
        .strict(),
      request.body,
    );
    reply.status(201);
    return createActivity(context(), { entityType: body.entityType, entityId: body.entityId, body: body.body, kind: 'note' });
  });

  app.get('/api/runs', async (request) => listRuns(db, workspaceId(), parseInput(statusQuery, request.query)));
  app.post('/api/runs', async (request, reply) => {
    reply.status(201);
    return startRun(context(), request.body, { origin: 'user' });
  });
  app.get('/api/runs/:id', async (request) => getRunDetail(db, workspaceId(), idParam(request.params)));
  app.post('/api/runs/:id/control', async (request) => {
    const ctx = context();
    const id = idParam(request.params);
    const detail = controlRun(ctx, id, request.body);
    if (detail.status !== 'cancelled') return detail;
    // Cancel is already saved. Asking Apify to stop the actor run is best effort and cannot undo it.
    await abortRemoteRunIfNeeded(ctx, id);
    return getRunDetail(db, workspaceId(), id);
  });

  app.get('/api/approvals', async (request) =>
    listApprovals(db, workspaceId(), parseInput(statusQuery, request.query)),
  );
  app.get('/api/approvals/:id', async (request) => requireApproval(db, workspaceId(), idParam(request.params)));
  app.post('/api/approvals/:id/decision', async (request) =>
    decideApproval(context(), idParam(request.params), request.body),
  );

  app.get('/api/connectors', async () => ({ items: listConnectors(db, workspaceId()), nextCursor: null }));
  app.put('/api/connectors/apify', async (request, reply) => {
    const { connector, created } = await configureApifyConnector(context(), request.body);
    reply.status(created ? 201 : 200);
    return connector;
  });
  app.delete('/api/connectors/apify', async (_request, reply) => {
    await disconnectApifyConnector(context());
    return reply.status(204).send();
  });
  app.get('/api/connectors/apify/actors', async (request) => searchApifyActors(context(), request.query));
  app.get('/api/connectors/apify/actors/:id', async (request) => getApifyActor(context(), idParam(request.params)));

  app.get('/api/imports/:id', async (request) => {
    const query = parseInput(importQuery, request.query);
    return getImportDetail(db, workspaceId(), idParam(request.params), {
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
      withRaw: query.withRaw === 'true',
    });
  });

  // The body holds up to 10 MB of file text, and JSON escaping can make it larger than the file.
  const csvBodyLimit = 32 * 1024 * 1024;
  app.post('/api/imports/csv/preview', { bodyLimit: csvBodyLimit }, async (request) => previewCsvFile(request.body));
  app.post('/api/imports/csv', { bodyLimit: csvBodyLimit }, async (request, reply) => {
    const run = stageCsvImport(context(), request.body);
    reply.status(201);
    return run;
  });

  app.get('/api/qualification', async () => readQualificationConfig(db, workspaceId()));
  app.put('/api/qualification', async (request) => saveQualificationConfig(context(), request.body));

  app.get('/api/search', async (request) => {
    const { q } = parseInput(searchQuery, request.query);
    return searchAll(db, workspaceId(), q);
  });

  app.post('/api/agent/message', async (request) => {
    const { text } = parseInput(messageBody, request.body);
    return respondToMessage(db, workspaceId(), text);
  });

  const openStreams = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const close of [...openStreams]) close();
  });
  app.get('/api/events', async (request, reply) => {
    openEventStream(request, reply, bus, openStreams);
    return reply;
  });
}
