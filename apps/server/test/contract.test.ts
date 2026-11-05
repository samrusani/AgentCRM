import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { processAllJobs, processJobs } from '../src/jobs/worker.js';
import { seedDatabase } from '../src/seed/seed.js';
import { type ApifyStub, startApifyStub, stubToken, useStub } from './apifyStub.js';
import { type AnthropicStub, draftFor, startAnthropicStub, stubApiKey, textReply, useAnthropicStub } from './anthropicStub.js';
import { type AgentmailStub, startAgentmailStub, stubAgentmailKey, stubInboxId, useAgentmailStub } from './agentmailStub.js';
import { createContext } from '../src/actions/index.js';
import { compatKeys, type CompatStub, startCompatStub, useCompatStub } from './openaiCompatStub.js';
import { type OllamaStub, startOllamaStub } from './ollamaStub.js';
import { requireWorkspace } from '../src/queries/workspace.js';
import { createTestEnvironment } from './helpers.js';
import { commentItems, commentsActorId, postUrl, profileActorId, profileItems, reactionItems, reactionsActorId } from './leadCaptureFixtures.js';

// One success case for every route the web client calls, against a temporary database and no live server.
const env = createTestEnvironment();
let app: FastifyInstance;
let stub: ApifyStub;
let restoreEnvironment: () => void;
let anthropic: AnthropicStub;
let restoreAnthropic: () => void;
let openai: CompatStub;
let restoreOpenai: () => void;
let ollama: OllamaStub;
let agentmail: AgentmailStub;
let restoreAgentmail: () => void;

beforeAll(async () => {
  stub = await startApifyStub();
  restoreEnvironment = useStub(stub);
  anthropic = await startAnthropicStub();
  restoreAnthropic = useAnthropicStub(anthropic);
  openai = await startCompatStub('openai');
  restoreOpenai = useCompatStub(openai);
  ollama = await startOllamaStub();
  agentmail = await startAgentmailStub();
  restoreAgentmail = useAgentmailStub(agentmail);
  seedDatabase(env.db, { now: new Date('2026-03-01T12:00:00.000Z') });
  app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath, logLevel: 'silent', now: env.ctx.now });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await stub.close();
  await anthropic.close();
  await agentmail.close();
  await openai.close();
  await ollama.close();
  restoreOpenai();
  restoreAgentmail();
  restoreAnthropic();
  restoreEnvironment();
  env.cleanup();
});

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { host: 'localhost:5173' },
  });
  return { status: response.statusCode, body: response.body ? response.json() : null };
}

describe('web client contract', () => {
  it('serves every read route the client calls', async () => {
    expect((await call('GET', '/api/workspace')).status).toBe(200);
    const today = await call('GET', '/api/today');
    expect(today.status).toBe(200);
    expect(today.body).toHaveProperty('tasksDue');
    expect(today.body).toHaveProperty('approvalsPending');
    expect(today.body).toHaveProperty('runsActive');
    expect(today.body).toHaveProperty('counts');

    const people = await call('GET', '/api/people?limit=5');
    expect(people.status).toBe(200);
    expect(people.body.items.length).toBeGreaterThan(0);
    const person = people.body.items[0];
    expect((await call('GET', `/api/people/${person.id}`)).body.id).toBe(person.id);

    const organizations = await call('GET', '/api/organizations?limit=5');
    expect(organizations.status).toBe(200);
    const organization = organizations.body.items[0];
    expect((await call('GET', `/api/organizations/${organization.id}`)).body.id).toBe(organization.id);

    const pipelines = await call('GET', '/api/pipelines');
    expect(pipelines.status).toBe(200);
    expect(pipelines.body.items[0].stages.length).toBeGreaterThan(0);

    const opportunities = await call('GET', '/api/opportunities?status=open&limit=5');
    expect(opportunities.status).toBe(200);
    const opportunity = opportunities.body.items[0];
    expect((await call('GET', `/api/opportunities/${opportunity.id}`)).body.id).toBe(opportunity.id);

    expect((await call('GET', '/api/tasks?filter=open')).status).toBe(200);
    const activities = await call('GET', `/api/activities?entityType=person&entityId=${person.id}`);
    expect(activities.status).toBe(200);
    expect(Array.isArray(activities.body.items)).toBe(true);
    expect((await call('GET', '/api/runs')).status).toBe(200);
    expect((await call('GET', '/api/approvals?status=pending')).status).toBe(200);
    expect((await call('GET', '/api/search?q=lanternrow')).body).toHaveProperty('people');

    const message = await call('POST', '/api/agent/message', { text: 'hello' });
    expect(message.status).toBe(200);
    expect(message.body.modelConnected).toBe(false);
    expect(Array.isArray(message.body.actions)).toBe(true);
  });

  it('accepts every write route the client calls', async () => {
    const person = (await call('GET', '/api/people?limit=1')).body.items[0];

    const note = await call('POST', '/api/activities', {
      entityType: 'person',
      entityId: person.id,
      kind: 'note',
      body: 'Contract test note.',
    });
    expect(note.status).toBe(201);
    expect(note.body.kind).toBe('note');

    const task = await call('POST', '/api/tasks', { title: 'Contract test task', dueAt: '2026-03-02T09:00:00.000Z' });
    expect(task.status).toBe(201);

    const patched = await call('PATCH', `/api/people/${person.id}`, {
      expectedVersion: person.version,
      fields: { title: 'Contract tester' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Contract tester');

    const pipeline = (await call('GET', '/api/pipelines')).body.items[0];
    const opportunity = (await call('GET', `/api/opportunities?stageId=${pipeline.stages[0].id}&limit=1`)).body.items[0];
    const moved = await call('POST', `/api/opportunities/${opportunity.id}/stage`, {
      stageId: pipeline.stages[1].id,
      expectedVersion: opportunity.version,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.stageId).toBe(pipeline.stages[1].id);

    const run = await call('POST', '/api/runs', { kind: 'demo_research', title: 'Contract run' });
    expect(run.status).toBe(201);
    for (let tick = 0; tick < 30; tick += 1) {
      env.advance(1000);
      processJobs(env.ctx);
      if ((await call('GET', `/api/runs/${run.body.id}`)).body.status === 'waiting_approval') break;
    }
    const detail = await call('GET', `/api/runs/${run.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('waiting_approval');

    const approvals = (await call('GET', '/api/approvals?status=pending')).body.items;
    const approval = approvals.find((item: { runId: string }) => item.runId === run.body.id);
    const decided = await call('POST', `/api/approvals/${approval.id}/decision`, { decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(decided.body.run.status).toBe('succeeded');
  });

  it('serves the connector, store, and import routes', async () => {
    expect((await call('GET', '/api/connectors')).body.items).toEqual([]);
    expect((await call('GET', '/api/connectors/apify/actors?q=lead')).status).toBe(409);

    const saved = await call('PUT', '/api/connectors/apify', { token: stubToken });
    expect(saved.status).toBe(201);
    const connectors = await call('GET', '/api/connectors');
    expect(connectors.body.items[0]).toMatchObject({ kind: 'apify', status: 'connected', tokenMasked: '****1234' });
    expect(JSON.stringify(connectors.body)).not.toContain(stubToken);

    const search = await call('GET', '/api/connectors/apify/actors?q=lead');
    expect(search.status).toBe(200);
    expect(search.body.items[0].id).toBe('tester~lead-scraper');
    const detail = await call('GET', '/api/connectors/apify/actors/tester~lead-scraper');
    expect(detail.body.exampleRunInput).toEqual({ queries: ['fintech'], max_results: 10 });

    stub.state.items = [{ name: 'Contract Lead', email: 'contract.lead@example.com' }];
    const run = await call('POST', '/api/runs', {
      kind: 'apify_scrape',
      title: 'Apify import: Lead scraper',
      scope: { actorId: 'tester~lead-scraper', input: {}, maxItems: 10 },
    });
    expect(run.status).toBe(201);
    for (let tick = 0; tick < 60; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
      if ((await call('GET', `/api/runs/${run.body.id}`)).body.status === 'waiting_approval') break;
    }
    const approval = (await call('GET', `/api/runs/${run.body.id}`)).body.approvals[0];
    expect(approval.kind).toBe('import_review');
    const imported = await call('GET', `/api/imports/${approval.payload.batchId}?limit=50`);
    expect(imported.status).toBe(200);
    expect(imported.body.status).toBe('awaiting_review');
    expect(imported.body.counts).toMatchObject({ fetched: 1, staged: 1, duplicates: 0, invalid: 0 });
    expect(imported.body.items[0]).toMatchObject({ seq: 1, status: 'staged', reason: null, matchEntityType: null, matchEntityId: null });
    expect(imported.body.items[0].mapped.email).toBe('contract.lead@example.com');
    expect(imported.body.nextCursor).toBeNull();
    expect((await call('GET', '/api/imports/imp_000000000000')).status).toBe(404);

    expect((await call('DELETE', '/api/connectors/apify')).status).toBe(204);
  });
  it('serves the lead capture settings, run, import, and approval shapes', async () => {
    expect((await call('PUT', '/api/connectors/apify', { token: stubToken })).status).toBe(201);
    try {
      const defaults = ['harvestapi/linkedin-post-reactions', 'harvestapi/linkedin-post-comments', 'harvestapi/linkedin-profile-scraper'];
      const defaultPost = 'apimaestro/linkedin-post-detail';
      const defaultCompany = 'harvestapi/linkedin-company';
      const initial = (await call('GET', '/api/connectors')).body.items[0];
      expect(initial.settings.leadCapture).toEqual({
        postActor: defaultPost,
        reactionsActor: defaults[0],
        commentsActor: defaults[1],
        profileActor: defaults[2],
        companyActor: defaultCompany,
      });

      // The web sends only leadCapture, with single fields and empty strings for resets.
      const edited = await call('PUT', '/api/connectors/apify', { leadCapture: { reactionsActor: 'harvestapi~linkedin-post-reactions', profileActor: 'Custom/Profile' } });
      expect(edited.status).toBe(200);
      expect(edited.body.settings.leadCapture).toEqual({
        postActor: defaultPost,
        reactionsActor: 'harvestapi~linkedin-post-reactions',
        commentsActor: defaults[1],
        profileActor: 'custom~profile',
        companyActor: defaultCompany,
      });
      expect(edited.body.tokenMasked).toBe('****1234');
      const single = await call('PUT', '/api/connectors/apify', { leadCapture: { profileActor: '' } });
      expect(single.body.settings.leadCapture.profileActor).toBe(defaults[2]);
      expect((await call('GET', '/api/connectors')).body.items[0].settings.leadCapture.reactionsActor).toBe('harvestapi~linkedin-post-reactions');
      expect((await call('PUT', '/api/connectors/apify', { leadCapture: { commentsActor: '..' } })).status).toBe(400);
      const post = await call('PUT', '/api/connectors/apify', { leadCapture: { postActor: 'Custom/Post-Actor' } });
      expect(post.body.settings.leadCapture.postActor).toBe('custom~post-actor');
      const postReset = await call('PUT', '/api/connectors/apify', { leadCapture: { postActor: '' } });
      expect(postReset.body.settings.leadCapture).toEqual({
        postActor: defaultPost,
        reactionsActor: 'harvestapi~linkedin-post-reactions',
        commentsActor: defaults[1],
        profileActor: defaults[2],
        companyActor: defaultCompany,
      });
      // The post source needs a ready model provider, and the message names the fix.
      const noProvider = await call('POST', '/api/runs', { kind: 'lead_capture', scope: { postUrl, sources: ['post', 'reactions', 'comments'] } });
      expect(noProvider.status).toBe(400);
      expect(noProvider.body.error.code).toBe('validation');
      expect(noProvider.body.error.message).toContain('Connect a provider in Settings, Model providers');
      expect((await call('PUT', '/api/connectors/apify', {})).status).toBe(400);

      stub.state.actorItems[reactionsActorId] = reactionItems;
      stub.state.actorItems[commentsActorId] = commentItems;
      stub.state.actorItems[profileActorId] = profileItems;
      expect((await call('POST', '/api/runs', { kind: 'lead_capture', scope: { postUrl: 'https://example.com/post' } })).status).toBe(400);
      expect((await call('POST', '/api/runs', { kind: 'lead_capture', scope: { postUrl, sources: [] } })).status).toBe(400);

      // enrich false and enrichLimit omitted, exactly as the web sends it.
      const run = await call('POST', '/api/runs', {
        kind: 'lead_capture',
        scope: { postUrl, sources: ['reactions', 'comments'], maxPeople: 50, enrich: false },
      });
      expect(run.status).toBe(201);
      expect(run.body).toMatchObject({
        kind: 'lead_capture',
        status: 'queued',
        simulated: false,
        scope: { postUrl, sources: ['reactions', 'comments'], maxPeople: 50, enrich: false, enrichLimit: 25, calls: {} },
      });
      expect(run.body.steps).toHaveLength(10);
      for (let tick = 0; tick < 60; tick += 1) {
        env.advance(1000);
        await processAllJobs(env.ctx);
        if ((await call('GET', `/api/runs/${run.body.id}`)).body.status === 'waiting_approval') break;
      }
      const detail = (await call('GET', `/api/runs/${run.body.id}`)).body;
      expect(detail.status).toBe('waiting_approval');
      expect(detail.steps.map((step: { title: string; status: string }) => [step.title, step.status])).toEqual([
        ['Validate connector, post URL, and limits', 'done'],
        ['Read the post through Apify', 'done'],
        ['Scrape reactions through Apify', 'done'],
        ['Scrape comments through Apify', 'done'],
        ['Extract people named in the post', 'done'],
        ['Stage people from the post', 'done'],
        ['Check for duplicates', 'done'],
        ['Enrich new profiles through Apify', 'done'],
        ['Merge enriched details', 'done'],
        ['Request import review', 'done'],
      ]);
      expect(detail.steps[7].detail).toContain('Skipped');
      expect(detail.scope.batchId).toMatch(/^imp_/);
      expect(detail.scope.actors).toEqual({
        post: defaultPost,
        reactions: 'harvestapi~linkedin-post-reactions',
        comments: defaults[1],
        profile: defaults[2],
      });
      const approval = detail.approvals[0];
      expect(approval.kind).toBe('import_review');
      expect(approval.payload.postUrl).toBe(postUrl);
      expect(approval.payload.actors).toEqual({ reactions: 'harvestapi~linkedin-post-reactions', comments: defaults[1] });
      expect(approval.payload.batchId).toBe(detail.scope.batchId);
      const imported = await call('GET', `/api/imports/${detail.scope.batchId}?limit=50&withRaw=true`);
      expect(imported.status).toBe(200);
      expect(imported.body.sourceKind).toBe('lead_capture');
      expect(imported.body.sourceRef.postUrl).toBe(postUrl);
      expect(imported.body.sourceRef.apifyRunIds).toEqual({ reactions: expect.stringMatching(/^run_/), comments: expect.stringMatching(/^run_/) });
      expect(imported.body.counts).toMatchObject({ fetched: 7, staged: 6, invalid: 1 });
      expect(imported.body.items[0].raw.sources[0]).toEqual({ kind: 'reaction', reactionType: 'LIKE' });
      expect((await call('POST', `/api/runs/${run.body.id}/control`, { action: 'cancel' })).body.status).toBe('cancelled');
    } finally {
      await call('DELETE', '/api/connectors/apify');
    }
  });

  it('serves the anthropic connector, model backed chat, and draft run shapes', async () => {
    expect((await call('PUT', '/api/connectors/anthropic', { token: 'sk-ant-wrong-0000' })).status).toBe(400);
    const saved = await call('PUT', '/api/connectors/anthropic', { token: stubApiKey });
    expect(saved.status).toBe(201);
    expect(Object.keys(saved.body).sort()).toEqual(['createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'tokenMasked', 'updatedAt', 'workspaceId']);
    expect(saved.body).toMatchObject({ kind: 'anthropic', status: 'connected', statusMessage: null, tokenMasked: '****1234', settings: { model: 'claude-opus-5-5' } });
    const switched = await call('PUT', '/api/connectors/anthropic', { model: 'claude-haiku-5-5' });
    expect(switched.status).toBe(200);
    expect(switched.body.settings).toEqual({ model: 'claude-haiku-5-5' });
    expect((await call('PUT', '/api/connectors/anthropic', { model: 'gpt-4' })).status).toBe(400);
    const connectors = await call('GET', '/api/connectors');
    expect(connectors.body.items.map((item: { kind: string }) => item.kind)).toEqual(['anthropic']);
    expect(JSON.stringify(connectors.body)).not.toContain(stubApiKey);

    anthropic.state.fallback = () => textReply('There are people in this workspace.');
    const chat = await call('POST', '/api/agent/message', {
      text: 'How is the pipeline?',
      history: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi, ask me about your records.' }],
      context: { entityType: 'person', entityId: 'per_000000000000' },
    });
    expect(chat.status).toBe(200);
    expect(Object.keys(chat.body).sort()).toEqual(['actions', 'model', 'modelConnected', 'provider', 'reply', 'usage']);
    expect(chat.body).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(chat.body).toMatchObject({ reply: 'There are people in this workspace.', modelConnected: true, usage: { inputTokens: 1000, outputTokens: 200 } });
    expect(Object.keys(chat.body.usage).sort()).toEqual(['estimatedUsd', 'inputTokens', 'outputTokens']);
    expect(typeof chat.body.usage.estimatedUsd).toBe('number');

    anthropic.state.fallback = (body) => draftFor(body);
    const run = await call('POST', '/api/runs', { kind: 'draft_outreach', scope: { maxPeople: 2, instructions: 'Be brief.', budgetUsd: 5 } });
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ kind: 'draft_outreach', status: 'queued', simulated: false, counts: { processed: 0, found: 0, flagged: 0 } });
    for (let tick = 0; tick < 60; tick += 1) {
      env.advance(1000);
      await processAllJobs(env.ctx);
      if ((await call('GET', `/api/runs/${run.body.id}`)).body.status === 'waiting_approval') break;
    }
    const waiting = await call('GET', `/api/runs/${run.body.id}`);
    expect(waiting.body.status).toBe('waiting_approval');
    expect(waiting.body.counts).toMatchObject({ processed: 2, found: 2, flagged: 0 });
    expect(typeof waiting.body.counts.estimatedUsd).toBe('number');
    const approval = waiting.body.approvals[0];
    expect(approval).toMatchObject({ kind: 'draft_review', title: 'Save 2 drafts for review', status: 'pending' });
    expect(Object.keys(approval.payload).sort()).toEqual(['count', 'drafts', 'estimatedUsd', 'provider', 'sample']);
    expect(approval.payload.drafts).toHaveLength(2);
    expect(Object.keys(approval.payload.drafts[0]).sort()).toEqual(['body', 'factsUsed', 'personId', 'personName', 'subject']);
    expect(approval.payload.sample).toHaveLength(2);
    expect(Object.keys(approval.payload.sample[0]).sort()).toEqual(['personName', 'subject']);
    // The runs list leaves the bulky draft arrays out. The detail and the approval keep them.
    const listed = (await call('GET', '/api/runs?limit=50')).body.items.find((item: { id: string }) => item.id === run.body.id);
    expect(listed.scope).not.toHaveProperty('drafts');
    expect(listed.scope).not.toHaveProperty('audienceIds');
    expect(listed.scope).toMatchObject({ maxPeople: 2, budgetUsd: 5 });
    expect(typeof listed.scope.model).toBe('string');
    expect(waiting.body.scope.drafts).toHaveLength(2);
    const decided = await call('POST', `/api/approvals/${approval.id}/decision`, { decision: 'approve' });
    expect(decided.body.run.status).toBe('succeeded');
    const drafted = (await call('GET', '/api/activities?entityType=person&limit=200')).body.items.filter((item: { kind: string; actor: string }) => item.kind === 'email_draft' && item.actor === 'agent:draft_outreach');
    expect(drafted).toHaveLength(2);
    expect(drafted[0].body.startsWith('Draft, not sent.')).toBe(true);

    expect((await call('DELETE', '/api/connectors/anthropic')).status).toBe(204);
    expect((await call('POST', '/api/runs', { kind: 'draft_outreach', scope: {} })).status).toBe(409);
    const plain = await call('POST', '/api/agent/message', { text: 'hello' });
    expect(plain.body.modelConnected).toBe(false);
    expect(plain.body).not.toHaveProperty('usage');
  });

  it('serves the csv import and qualification routes', async () => {
    const content = 'Name,Email,Company\nCora Vale,cora.vale@contract-csv.example.com,Contract CSV Fund\n';
    const preview = await call('POST', '/api/imports/csv/preview', { fileName: 'contract.csv', content });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      headers: ['Name', 'Email', 'Company'],
      delimiter: ',',
      rowCount: 1,
      suggestedMapping: { Name: 'name', Email: 'email', Company: 'company' },
    });
    expect(preview.body.sample).toEqual([{ Name: 'Cora Vale', Email: 'cora.vale@contract-csv.example.com', Company: 'Contract CSV Fund' }]);
    expect((await call('POST', '/api/imports/csv/preview', { fileName: 'contract.csv' })).status).toBe(400);

    expect((await call('POST', '/api/imports/csv', { fileName: 'contract.csv', content, mapping: { Company: 'company' } })).status).toBe(400);
    const staged = await call('POST', '/api/imports/csv', { fileName: 'contract.csv', content, mapping: preview.body.suggestedMapping });
    expect(staged.status).toBe(201);
    expect(staged.body).toMatchObject({ kind: 'csv_import', status: 'queued', scope: { fileName: 'contract.csv' } });
    for (let tick = 0; tick < 30; tick += 1) {
      env.advance(1000);
      processJobs(env.ctx);
      if ((await call('GET', `/api/runs/${staged.body.id}`)).body.status === 'waiting_approval') break;
    }
    const waiting = await call('GET', `/api/runs/${staged.body.id}`);
    expect(waiting.body.approvals[0]).toMatchObject({ kind: 'import_review', status: 'pending' });
    const batch = await call('GET', `/api/imports/${staged.body.scope.batchId}`);
    expect(batch.body).toMatchObject({ sourceKind: 'csv', status: 'awaiting_review', counts: { fetched: 1, staged: 1 } });
    const decided = await call('POST', `/api/approvals/${waiting.body.approvals[0].id}/decision`, { decision: 'approve' });
    expect(decided.body.run.status).toBe('succeeded');

    const config = await call('GET', '/api/qualification');
    expect(config.status).toBe(200);
    expect(config.body.criteria).toHaveLength(3);
    expect(config.body.exclusions).toHaveLength(1);
    expect(config.body.defaulted).toBeUndefined();
    const replaced = await call('PUT', '/api/qualification', { exclusions: config.body.exclusions, criteria: config.body.criteria });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({ exclusions: config.body.exclusions, criteria: config.body.criteria });
    expect((await call('PUT', '/api/qualification', { exclusions: [], criteria: [{ id: 'x' }] })).status).toBe(400);

    const before = await call('GET', '/api/people?sort=fit&limit=5');
    expect(before.status).toBe(200);
    expect(before.body.items[0]).toHaveProperty('qualification', null);

    const qualify = await call('POST', '/api/runs', { kind: 'qualify', scope: {} });
    expect(qualify.status).toBe(201);
    for (let tick = 0; tick < 60; tick += 1) {
      env.advance(1000);
      processJobs(env.ctx);
      if ((await call('GET', `/api/runs/${qualify.body.id}`)).body.status === 'succeeded') break;
    }
    const finished = await call('GET', `/api/runs/${qualify.body.id}`);
    expect(finished.body.status).toBe('succeeded');
    expect(finished.body.counts.processed).toBeGreaterThan(50);
    expect(finished.body.counts).toHaveProperty('excluded');

    const fit = await call('GET', '/api/people?sort=fit&limit=5');
    const top = fit.body.items[0];
    expect(top.qualification).toMatchObject({ total: 3, excluded: false });
    expect(top.qualification.matched).toBeGreaterThanOrEqual(fit.body.items[4].qualification.matched);
    expect(fit.body.nextCursor).not.toBeNull();
    const second = await call('GET', `/api/people?sort=fit&limit=5&cursor=${fit.body.nextCursor}`);
    expect(second.status).toBe(200);
    const detail = await call('GET', `/api/people/${top.id}`);
    expect(detail.body.qualification).toMatchObject({ total: 3, excluded: false, excludedReasons: [] });
    expect(detail.body.qualification.criteria[0]).toHaveProperty('evidence');
    expect(['matched', 'not_matched', 'unknown']).toContain(detail.body.qualification.criteria[0].outcome);
  });

  it('serves the model provider routes for the other providers', async () => {
    expect((await call('GET', '/api/model-provider')).body).toBeNull();
    expect((await call('GET', '/api/connectors/ollama/models')).status).toBe(409);
    expect((await call('PUT', '/api/model-provider', { kind: 'openai' })).status).toBe(409);

    const saved = await call('PUT', '/api/connectors/openai', { token: compatKeys.openai });
    expect(saved.status).toBe(201);
    expect(Object.keys(saved.body).sort()).toEqual(['createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'tokenMasked', 'updatedAt', 'workspaceId']);
    expect(saved.body).toMatchObject({ kind: 'openai', tokenMasked: '****ab12', settings: { model: 'gpt-5.6-terra' } });
    expect(JSON.stringify(saved.body)).not.toContain(compatKeys.openai);
    expect((await call('PUT', '/api/connectors/openai', { model: 'gpt-6-astra' })).status).toBe(400);
    expect((await call('GET', '/api/model-provider')).body).toEqual({ kind: 'openai', model: 'gpt-5.6-terra', status: 'connected', statusMessage: null, ready: true });

    const connected = await call('PUT', '/api/connectors/ollama', { baseUrl: ollama.url });
    expect(connected.status).toBe(201);
    expect(Object.keys(connected.body).sort()).toEqual(['createdAt', 'id', 'kind', 'settings', 'status', 'statusMessage', 'updatedAt', 'workspaceId']);
    expect(connected.body.settings).toEqual({ baseUrl: ollama.url, model: null });
    const models = await call('GET', '/api/connectors/ollama/models');
    expect(models.body.items.map((item: { name: string }) => item.name)).toEqual(['llama-stub:8b', 'qwen-stub:4b']);
    expect(Object.keys(models.body).sort()).toEqual(['items', 'nextCursor']);
    expect((await call('PUT', '/api/connectors/ollama', { model: 'qwen-stub:4b' })).body.settings.model).toBe('qwen-stub:4b');

    const switched = await call('PUT', '/api/model-provider', { kind: 'ollama' });
    expect(switched.status).toBe(200);
    expect((await call('GET', '/api/model-provider')).body).toEqual({ kind: 'ollama', model: 'qwen-stub:4b', status: 'connected', statusMessage: null, ready: true });
    const catalog = await call('GET', '/api/model-providers');
    expect(catalog.body.items.map((item: { kind: string }) => item.kind)).toEqual(['anthropic', 'openai', 'deepseek', 'zai', 'ollama']);
    expect(Object.keys(catalog.body.items[1]).sort()).toEqual(['defaultModel', 'kind', 'label', 'models', 'pricesAsOf']);

    expect((await call('DELETE', '/api/connectors/ollama')).status).toBe(204);
    expect((await call('GET', '/api/model-provider')).body).toEqual({ kind: 'openai', model: 'gpt-5.6-terra', status: 'connected', statusMessage: null, ready: true });
    expect((await call('DELETE', '/api/connectors/openai')).status).toBe(204);
    expect((await call('GET', '/api/model-provider')).body).toBeNull();
    for (const kind of ['deepseek', 'zai']) expect((await call('DELETE', `/api/connectors/${kind}`)).status).toBe(404);
  });
  it('serves the agentmail connector, send intent, suppression, and mail summary routes', async () => {
    const ctx = createContext(env.db, requireWorkspace(env.db).id, { bus: env.bus, now: env.ctx.now });

    const connected = await call('PUT', '/api/connectors/agentmail', { token: stubAgentmailKey });
    expect(connected.status).toBe(201);
    expect(connected.body.kind).toBe('agentmail');
    const inboxes = await call('GET', '/api/connectors/agentmail/inboxes');
    expect(inboxes.status).toBe(200);
    expect(inboxes.body).toEqual({ items: [{ id: stubInboxId, email: stubInboxId }], nextCursor: null });
    const created = await call('POST', '/api/connectors/agentmail/inboxes', { username: 'contract' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: 'contract@stub-mail.invalid', email: 'contract@stub-mail.invalid' });
    const selected = await call('PUT', '/api/connectors/agentmail', { inboxId: stubInboxId });
    expect(selected.status).toBe(200);
    expect(selected.body.settings.inboxId).toBe(stubInboxId);

    const empty = await call('GET', '/api/mail/summary');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      dailyCap: 50,
      remainingDailyCap: 50,
      lastSyncAt: null,
      repliesNeedingAttention: { count: 0, items: [] },
    });
    expect(Object.keys(empty.body.counts).sort()).toEqual(
      ['accepted', 'approved', 'awaiting_approval', 'blocked', 'bounced', 'cancelled', 'failed', 'queued', 'replied', 'submitting', 'unknown'],
    );

    const person = await call('POST', '/api/people', { firstName: 'Contract', lastName: 'Sender', email: 'contract.sender@lanternrow.invalid' });
    expect(person.status).toBe(201);
    const seeded = (await call('GET', '/api/people?limit=1')).body.items[0];
    const addDraft = (personId: string, subject: string): string => {
      const id = ctx.newId('act');
      env.db
        .prepare("INSERT INTO activity (id, created_at, workspace_id, entity_type, entity_id, kind, body, actor) VALUES (?, ?, ?, 'person', ?, 'email_draft', ?, 'user')")
        .run(id, ctx.now(), ctx.workspaceId, personId, `Draft, not sent.\n\nSubject: ${subject}\n\nBody for ${subject}.`);
      return id;
    };

    const demo = await call('POST', '/api/send-intents', { draftActivityIds: [addDraft(seeded.id, 'Demo')] });
    expect(demo.status).toBe(200);
    expect(demo.body).toMatchObject({ approval: null, intents: [], excluded: [{ reason: 'demo_address' }] });
    expect((await call('POST', '/api/send-intents', {})).status).toBe(400);
    expect((await call('POST', '/api/send-intents', { draftActivityIds: ['act_000000000000'] })).status).toBe(404);

    const staged = await call('POST', '/api/send-intents', { draftActivityIds: [addDraft(person.body.id, 'Contract hello')] });
    expect(staged.status).toBe(201);
    expect(staged.body.approval).toMatchObject({ kind: 'send_review', status: 'pending' });
    expect(staged.body.approval.payload.messages[0]).toMatchObject({
      personName: 'Contract Sender',
      to: 'contract.sender@lanternrow.invalid',
      subject: 'Contract hello',
      inboxEmail: stubInboxId,
    });
    expect(staged.body.approval.payload.remainingDailyCap).toBe(49);
    expect(staged.body.excluded).toEqual([]);
    const intentId = staged.body.intents[0].id;

    const waiting = await call('GET', '/api/send-intents?status=awaiting_approval');
    expect(waiting.status).toBe(200);
    expect(waiting.body.items[0]).toMatchObject({
      id: intentId,
      personName: 'Contract Sender',
      to: 'contract.sender@lanternrow.invalid',
      status: 'awaiting_approval',
      error: null,
      providerMessageId: null,
      submittedAt: null,
    });
    expect(waiting.body.items[0]).toHaveProperty('updatedAt');
    expect(waiting.body.nextCursor).toBeNull();
    expect((await call('GET', '/api/send-intents?status=delivered')).status).toBe(400);

    const decided = await call('POST', `/api/approvals/${staged.body.approval.id}/decision`, { decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ queued: 1, skipped: [], alreadyDecided: false });
    await processAllJobs(ctx);
    const accepted = await call('GET', '/api/send-intents?status=accepted,failed');
    expect(accepted.body.items[0]).toMatchObject({ id: intentId, status: 'accepted' });
    expect(accepted.body.items[0].providerMessageId).toMatch(/^msg_stub_/);
    expect(accepted.body.items[0].submittedAt).not.toBeNull();
    expect((await call('POST', `/api/send-intents/${intentId}/control`, { action: 'cancel' })).status).toBe(409);
    expect((await call('POST', `/api/send-intents/${intentId}/control`, { action: 'explode' })).status).toBe(400);
    expect((await call('POST', '/api/send-intents/snd_000000000000/control', { action: 'cancel' })).status).toBe(404);

    const another = await call('POST', '/api/send-intents', { draftActivityIds: [addDraft(person.body.id, 'Second hello')] });
    const cancelled = await call('POST', `/api/send-intents/${another.body.intents[0].id}/control`, { action: 'cancel' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', personName: 'Contract Sender' });

    const summary = await call('GET', '/api/mail/summary');
    expect(summary.body.counts.accepted).toBe(1);
    expect(summary.body.remainingDailyCap).toBe(49);
    expect(summary.body.inbox).toMatchObject({ connected: true, inboxEmail: stubInboxId });

    const added = await call('POST', '/api/suppressions', { email: 'Muted@Lanternrow.invalid', reason: 'manual' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ email: 'muted@lanternrow.invalid', reason: 'manual' });
    expect((await call('POST', '/api/suppressions', { email: 'muted@lanternrow.invalid' })).status).toBe(409);
    expect((await call('POST', '/api/suppressions', { email: 'nope' })).status).toBe(400);
    const list = await call('GET', '/api/suppressions');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.nextCursor).toBeNull();
    expect((await call('DELETE', `/api/suppressions/${added.body.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/suppressions/${added.body.id}`)).status).toBe(404);

    expect((await call('DELETE', '/api/connectors/agentmail')).status).toBe(204);
  });

  it('lists templates and switches the workspace template', async () => {
    const workspace = await call('GET', '/api/workspace');
    expect(Object.keys(workspace.body).sort()).toEqual(['id', 'name', 'template', 'version']);
    const templatesResponse = await call('GET', '/api/templates');
    expect(templatesResponse.status).toBe(200);
    expect(templatesResponse.body.items.map((item: { id: string; current: boolean }) => [item.id, item.current])).toEqual([
      ['startup-fundraising', true],
      ['fund-lp', false],
      ['client-sales', false],
    ]);
    const pipelines = await call('GET', '/api/pipelines');
    const stageNames = ['Research', 'Qualified', 'Outreach', 'Discovery', 'Proposal', 'Negotiation', 'Closed'];
    const stageMapping = Object.fromEntries(
      pipelines.body.items[0].stages.map((stage: { id: string; seq: number }) => [stage.id, stageNames[stage.seq - 1]]),
    );
    const switched = await call('POST', '/api/workspace/template', {
      template: 'client-sales',
      stageMapping,
      replaceQualification: true,
      expectedVersion: workspace.body.version,
    });
    expect(switched.status).toBe(200);
    expect(switched.body).toEqual({ ...workspace.body, template: 'client-sales', version: workspace.body.version + 1 });
    const after = await call('GET', '/api/pipelines');
    expect(after.body.items[0].name).toBe('Sales');
    expect(after.body.items[0].stages.map((stage: { name: string }) => stage.name)).toEqual(stageNames);
    const conflict = await call('POST', '/api/workspace/template', {
      template: 'fund-lp',
      stageMapping: {},
      replaceQualification: false,
      expectedVersion: workspace.body.version,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'version_conflict', current: switched.body });
  });
});
