import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  abortRemoteRunIfNeeded,
  acceptEnrichmentSuggestion,
  addSuppression,
  bearerToken,
  capturePerson,
  lookupCapture,
  configureAgentmailConnector,
  configureAnthropicConnector,
  completeGmailOAuth,
  completeMicrosoftOAuth,
  configureImapConnector,
  disconnectImapConnector,
  configureApifyConnector,
  configureGmailConnector,
  configureMicrosoftConnector,
  configureModelConnector,
  configureOllamaConnector,
  controlRun,
  controlSendIntent,
  createActivity,
  createAgentmailInbox,
  createContext,
  createOpportunity,
  createOrganization,
  createPerson,
  createTask,
  decideApproval,
  disconnectAgentmailConnector,
  disconnectAnthropicConnector,
  disconnectApifyConnector,
  disconnectGmailConnector,
  disconnectMicrosoftConnector,
  disconnectModelConnector,
  dismissEnrichment,
  generateCaptureToken,
  getApifyActor,
  getCaptureSettings,
  getEnrichment,
  getMailProvider,
  getModelProvider,
  liftSuppression,
  listTemplates,
  listAgentmailInboxes,
  listOllamaModels,
  moveOpportunityStage,
  parseInput,
  prepareSendIntents,
  removeCaptureToken,
  previewCsvFile,
  saveQualificationConfig,
  searchApifyActors,
  setMailProvider,
  setModelProvider,
  stopFollowupRule,
  startGmailOAuth,
  startMicrosoftOAuth,
  stageCsvImport,
  startRun,
  switchTemplate,
  updateOpportunity,
  updateOrganization,
  updatePerson,
  updateTask,
  verifyCaptureToken,
} from '../actions/index.js';
import { respondToMessage } from '../agent/message.js';
import { maxHistoryTurnCharacters, maxHistoryTurns, respondWithModel } from '../agent/modelChat.js';
import { serverVersion } from '../config.js';
import { displayDatabasePath } from '../paths.js';
import { listActivities } from '../queries/activities.js';
import { providerCatalog } from '../providers/presets.js';
import { listConnectors } from '../queries/connectors.js';
import { listFollowupRules } from '../queries/followupRules.js';
import { getActiveModelConnector } from '../queries/modelProvider.js';
import { getImportDetail } from '../queries/imports.js';
import { getOpportunityDetail, listOpportunities } from '../queries/opportunities.js';
import { getOrganizationDetail, listOrganizations } from '../queries/organizations.js';
import { getPersonDetail, listPeople } from '../queries/people.js';
import { listPipelines } from '../queries/pipelines.js';
import { readQualificationConfig } from '../qualification/config.js';
import { getRunDetail, listApprovals, listRuns, requireApproval } from '../queries/runs.js';
import { searchAll } from '../queries/search.js';
import { getMailSummary, listSendIntents, listSuppressions } from '../queries/sendIntents.js';
import { listTasks } from '../queries/tasks.js';
import { getToday } from '../queries/today.js';
import { requireWorkspace } from '../queries/workspace.js';
import type { AppOptions } from './app.js';
import { openEventStream } from './events.js';
import { registerImapFakeRoutes } from './imapFakeRoutes.js';
import { getFakeMailTransport } from '../providers/mailTransportFactory.js';

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
const followupRulesQuery = z.object({ status: z.string().optional(), personId: z.string().optional(), ...pagingQuery });
const searchQuery = z.object({ q: z.string().default('') });
const messageBody = z
  .object({
    text: z.string().trim().min(1).max(2000),
    // A long model reply must not block later messages, so over-long turns are cut instead of rejected.
    history: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).transform((text) => text.slice(0, maxHistoryTurnCharacters)) })
          .strict(),
      )
      .max(maxHistoryTurns)
      .default([]),
    context: z
      .object({
        entityType: z.enum(['person', 'organization', 'opportunity']),
        entityId: z.string().trim().min(1).max(64),
      })
      .strict()
      .optional(),
  })
  .strict();
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
    const { id, name, template, version } = requireWorkspace(db);
    return { id, name, template, version };
  });

  app.get('/api/templates', async () => ({ items: listTemplates(db, workspaceId()), nextCursor: null }));
  app.post('/api/workspace/template', async (request) => switchTemplate(context(), request.body));

  // The capture routes (verify, lookup, capture) are the only ones that need a token. The guard runs before the body is parsed.
  const captureGuard = async (request: FastifyRequest): Promise<void> => {
    verifyCaptureToken(db, workspaceId(), bearerToken(request.headers.authorization));
  };
  app.get('/api/capture/settings', async () => getCaptureSettings({ db, workspaceId: workspaceId() }));
  app.post('/api/capture/token', async (_request, reply) => {
    reply.status(201);
    return generateCaptureToken(context());
  });
  app.delete('/api/capture/token', async (_request, reply) => {
    removeCaptureToken(context());
    return reply.status(204).send();
  });
  app.post('/api/capture/verify', { onRequest: captureGuard }, async () => ({ ok: true, workspace: requireWorkspace(db).name }));
  app.post('/api/capture/lookup', { onRequest: captureGuard }, async (request) =>
    lookupCapture({ db, workspaceId: workspaceId() }, request.body),
  );
  app.post('/api/capture', { onRequest: captureGuard }, async (request, reply) => {
    const result = capturePerson(context(), request.body);
    reply.status(result.outcome === 'created' ? 201 : 200);
    return result;
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
  app.get('/api/people/:id/enrichment', async (request) =>
    getEnrichment({ db, workspaceId: workspaceId() }, idParam(request.params)),
  );
  app.post('/api/people/:id/enrichment', async (request) =>
    acceptEnrichmentSuggestion(context(), idParam(request.params), request.body),
  );
  app.delete('/api/people/:id/enrichment', async (request, reply) => {
    const { runId } = parseInput(z.object({ runId: z.string().min(1) }), request.query);
    dismissEnrichment(context(), idParam(request.params), runId);
    return reply.status(204).send();
  });

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
  app.put('/api/connectors/anthropic', async (request, reply) => {
    const { connector, created } = await configureAnthropicConnector(context(), request.body);
    reply.status(created ? 201 : 200);
    return connector;
  });
  app.delete('/api/connectors/anthropic', async (_request, reply) => {
    disconnectAnthropicConnector(context());
    return reply.status(204).send();
  });
  for (const kind of ['openai', 'deepseek', 'zai'] as const) {
    app.put(`/api/connectors/${kind}`, async (request, reply) => {
      const { connector, created } = await configureModelConnector(context(), kind, request.body);
      reply.status(created ? 201 : 200);
      return connector;
    });
    app.delete(`/api/connectors/${kind}`, async (_request, reply) => {
      disconnectModelConnector(context(), kind);
      return reply.status(204).send();
    });
  }
  app.put('/api/connectors/ollama', async (request, reply) => {
    const { connector, created } = await configureOllamaConnector(context(), request.body);
    reply.status(created ? 201 : 200);
    return connector;
  });
  app.delete('/api/connectors/ollama', async (_request, reply) => {
    disconnectModelConnector(context(), 'ollama');
    return reply.status(204).send();
  });
  app.get('/api/connectors/ollama/models', async () => listOllamaModels(context()));
  app.get('/api/model-provider', async (_request, reply) => {
    const active = getModelProvider(context());
    return reply.send(active ?? null);
  });
  app.put('/api/model-provider', async (request) => setModelProvider(context(), request.body));
  app.get('/api/model-providers', async () => ({ items: providerCatalog(), nextCursor: null }));
  app.put('/api/connectors/agentmail', async (request, reply) => {
    const { connector, created } = await configureAgentmailConnector(context(), request.body);
    reply.status(created ? 201 : 200);
    return connector;
  });
  app.delete('/api/connectors/agentmail', async (_request, reply) => {
    disconnectAgentmailConnector(context());
    return reply.status(204).send();
  });
  app.get('/api/connectors/agentmail/inboxes', async () => listAgentmailInboxes(context()));
  app.post('/api/connectors/agentmail/inboxes', async (request, reply) => {
    const inbox = await createAgentmailInbox(context(), request.body);
    reply.status(201);
    return inbox;
  });

  app.put('/api/connectors/gmail', async (request, reply) => {
    const { connector, created } = configureGmailConnector(context(), request.body);
    reply.status(created ? 201 : 200);
    return connector;
  });
  app.delete('/api/connectors/gmail', async (_request, reply) => {
    disconnectGmailConnector(context());
    return reply.status(204).send();
  });
  // Returns the Google consent URL. The browser opens it; Google sends it back to the callback below.
  app.post('/api/connectors/gmail/oauth/start', async (request) => {
    const origin = request.headers.origin;
    return startGmailOAuth(context(), { returnOrigin: typeof origin === 'string' ? origin : null });
  });
  app.get('/api/connectors/gmail/oauth/callback', async (request, reply) => {
    const query = parseInput(
      z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).passthrough(),
      request.query,
    );
    const outcome = await completeGmailOAuth(context(), { code: query.code, state: query.state, error: query.error });
    return reply.redirect(outcome.redirect, 303);
  });
  app.put('/api/connectors/microsoft', async (request, reply) => {
    const { connector, created } = configureMicrosoftConnector(context(), request.body);
    reply.status(created ? 201 : 200);
    return connector;
  });
  app.delete('/api/connectors/microsoft', async (_request, reply) => {
    disconnectMicrosoftConnector(context());
    return reply.status(204).send();
  });
  // Returns the Microsoft consent URL. The browser opens it; Microsoft sends it back to the callback below.
  app.post('/api/connectors/microsoft/oauth/start', async (request) => {
    const origin = request.headers.origin;
    return startMicrosoftOAuth(context(), { returnOrigin: typeof origin === 'string' ? origin : null });
  });
  app.get('/api/connectors/microsoft/oauth/callback', async (request, reply) => {
    const query = parseInput(
      z
        .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() })
        .passthrough(),
      request.query,
    );
    const outcome = await completeMicrosoftOAuth(context(), {
      code: query.code,
      state: query.state,
      error: query.error,
      errorDescription: query.error_description,
    });
    return reply.redirect(outcome.redirect, 303);
  });
  // The IMAP and SMTP connector. A failed check is not an HTTP error: the connector comes back with status "error" and the
  // sentence for the failing step. Only invalid input is refused.
  app.put('/api/connectors/imap', async (request, reply) => {
    const { connector, created } = await configureImapConnector(context(), request.body);
    reply.status(created ? 201 : 200);
    return connector;
  });
  app.delete('/api/connectors/imap', async (_request, reply) => {
    disconnectImapConnector(context());
    return reply.status(204).send();
  });
  // Only with AGENTCRM_IMAP_FAKE=1: routes to drive the in process fake mail server.
  const fakeMail = getFakeMailTransport();
  if (fakeMail) registerImapFakeRoutes(app, fakeMail);
  app.get('/api/mail-provider', async (_request, reply) => reply.send(getMailProvider(context()) ?? null));
  app.post('/api/mail-provider', async (request) => setMailProvider(context(), request.body));
  app.put('/api/mail-provider', async (request) => setMailProvider(context(), request.body));

  app.post('/api/send-intents', async (request, reply) => {
    const result = prepareSendIntents(context(), request.body);
    reply.status(result.approval ? 201 : 200);
    return result;
  });
  app.get('/api/send-intents', async (request) =>
    listSendIntents(db, workspaceId(), parseInput(statusQuery, request.query)),
  );
  app.post('/api/send-intents/:id/control', async (request) =>
    controlSendIntent(context(), idParam(request.params), request.body),
  );
  app.get('/api/followup-rules', async (request) =>
    listFollowupRules(db, workspaceId(), parseInput(followupRulesQuery, request.query)),
  );
  app.post('/api/followup-rules/:id/stop', async (request) => ({ rule: stopFollowupRule(context(), idParam(request.params)) }));
  app.get('/api/suppressions', async (request) => listSuppressions(db, workspaceId(), parseInput(z.object(pagingQuery), request.query)));
  app.post('/api/suppressions', async (request, reply) => {
    const suppression = addSuppression(context(), request.body);
    reply.status(201);
    return suppression;
  });
  app.delete('/api/suppressions/:id', async (request, reply) => {
    liftSuppression(context(), idParam(request.params));
    return reply.status(204).send();
  });
  app.get('/api/mail/summary', async () => getMailSummary(db, workspaceId(), (options.now ?? (() => new Date().toISOString()))()));

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
    const { text, history, context: recordContext } = parseInput(messageBody, request.body);
    const id = workspaceId();
    // A configured model provider means the model answers. Without one, the rule based helper answers as before.
    if (getActiveModelConnector(db, id)) {
      return respondWithModel(context(), { text, history, context: recordContext });
    }
    return respondToMessage(db, id, text);
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
