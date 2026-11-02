import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configureModelConnector,
  configureOllamaConnector,
  createPerson,
  decideApproval,
  disconnectModelConnector,
  setModelProvider,
  startRun,
} from '../src/actions/index.js';
import { estimateModelCostUsd } from '../src/providers/presets.js';
import { getRunDetail } from '../src/queries/runs.js';
import {
  blankReply,
  compatDraftFor,
  type CompatKind,
  type CompatStub,
  compatKeys,
  errorReply,
  jsonReply,
  startCompatStub,
  textReply,
  useCompatStub,
} from './openaiCompatStub.js';
import { ollamaDraftFor, type OllamaStub, ollamaText, startOllamaStub } from './ollamaStub.js';
import { createTestEnvironment, driveRunAsync } from './helpers.js';

const env = createTestEnvironment();
const compat = {} as Record<CompatKind, CompatStub>;
let ollama: OllamaStub;
const restores: (() => void)[] = [];
const names = ['Ada Avery', 'Ben Brooks', 'Cara Clarke', 'Dan Dunn', 'Eve Ellis'];

function resetPeople(): string[] {
  for (const table of ['model_call', 'qualification_result', 'job', 'approval', 'run_step', 'run', 'person']) env.db.prepare(`DELETE FROM ${table}`).run();
  env.db.prepare("DELETE FROM activity WHERE kind = 'email_draft'").run();
  return names.map((name) => {
    const [firstName, lastName] = name.split(' ') as [string, string];
    return createPerson(env.ctx, { firstName, lastName, email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`, title: 'Partner' }).id;
  });
}

beforeAll(async () => {
  for (const kind of ['openai', 'deepseek', 'zai'] as const) {
    compat[kind] = await startCompatStub(kind);
    restores.push(useCompatStub(compat[kind]));
    await configureModelConnector(env.ctx, kind, { token: compatKeys[kind] });
  }
  ollama = await startOllamaStub();
  await configureOllamaConnector(env.ctx, { baseUrl: ollama.url, model: 'llama-stub:8b' });
});

beforeEach(() => {
  for (const kind of ['openai', 'deepseek', 'zai'] as const) {
    compat[kind].reset();
    compat[kind].state.fallback = (body) => compatDraftFor(body);
  }
  ollama.reset();
  ollama.state.fallback = (body) => ollamaDraftFor(body);
  resetPeople();
});

afterAll(async () => {
  for (const stub of Object.values(compat)) await stub.close();
  await ollama.close();
  for (const restore of restores) restore();
  env.cleanup();
});

const rows = (runId: string) => env.db.prepare('SELECT * FROM model_call WHERE run_id = ? ORDER BY created_at').all(runId) as any[];

async function draftRun(kind: string, scope: Record<string, unknown>, until = ['waiting_approval', 'partial', 'failed']) {
  setModelProvider(env.ctx, { kind });
  const run = startRun(env.ctx, { kind: 'draft_outreach', scope });
  const status = await driveRunAsync(env, run.id, until);
  return { run, status, detail: getRunDetail(env.db, env.workspaceId, run.id) };
}

describe('drafting with openai (json_schema)', () => {
  it('sends a strict json schema, records the provider and dated estimate, and waits for review', async () => {
    const { run, status, detail } = await draftRun('openai', { maxPeople: 2 });
    expect(status).toBe('waiting_approval');
    expect(detail.scope).toMatchObject({ provider: 'openai', model: 'gpt-5.6-terra' });
    expect(compat.openai.state.chatCalls).toBe(2);
    const body = compat.openai.state.chatBodies[0];
    expect(body.max_completion_tokens).toBe(12000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema).toMatchObject({ name: 'draft', strict: true });
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.response_format.json_schema.schema.required).toEqual(['subject', 'body', 'factsUsed']);
    expect(body.messages[1].content).not.toContain('JSON schema');
    const perCall = estimateModelCostUsd('openai', 'gpt-5.6-terra', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(rows(run.id).every((row) => row.provider === 'openai' && row.model === 'gpt-5.6-terra' && row.estimated_usd === perCall)).toBe(true);
    expect(detail.counts).toMatchObject({ processed: 2, found: 2, flagged: 0 });
    expect(detail.counts.estimatedUsd).toBeCloseTo(perCall * 2, 6);
    expect(detail.steps[0]!.title).toBe('Check the OpenAI connection');
    expect(detail.steps[2]!.detail).toContain('Estimated cost');
    expect(detail.approvals[0]!.payload).toMatchObject({ count: 2 });
  });

  it('stops at the budget exactly as the Anthropic path does', async () => {
    const perCall = estimateModelCostUsd('openai', 'gpt-5.6-terra', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const { detail } = await draftRun('openai', { maxPeople: 5, budgetUsd: perCall * 1.5 });
    expect(compat.openai.state.chatCalls).toBe(1);
    expect(detail.status).toBe('waiting_approval');
    expect(detail.scope.stoppedEarly).toContain('budget limit');
  });

  it('flags a provider rejection per person and carries on', async () => {
    let call = 0;
    compat.openai.state.fallback = (body) => {
      call += 1;
      if (call === 1) return errorReply(400, 'Invalid prompt.');
      return compatDraftFor(body);
    };
    const { detail } = await draftRun('openai', { maxPeople: 2 });
    expect(detail.counts).toMatchObject({ found: 1, flagged: 1 });
    expect((detail.scope.failures as { reason: string }[])[0]!.reason).toContain('OpenAI rejected the request (HTTP 400): Invalid prompt.');
  });
});

describe('drafting with deepseek (json_object)', () => {
  it('puts the word json and the schema text in the prompt and uses json_object mode', async () => {
    const { detail } = await draftRun('deepseek', { maxPeople: 1 });
    expect(detail.status).toBe('waiting_approval');
    const body = compat.deepseek.state.chatBodies[0];
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(12000);
    const prompt = body.messages[1].content as string;
    expect(prompt).toMatch(/json/i);
    expect(prompt).toContain('"required"');
    expect(prompt).toContain('"factsUsed"');
    expect(prompt).toContain('<record>');
    expect(rows(detail.id)[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' });
  });

  it('retries once on blank content and drafts when the second answer is good', async () => {
    let call = 0;
    compat.deepseek.state.fallback = (body) => {
      call += 1;
      return call === 1 ? blankReply() : compatDraftFor(body);
    };
    const { run, detail } = await draftRun('deepseek', { maxPeople: 1 });
    expect(compat.deepseek.state.chatCalls).toBe(2);
    expect(detail.counts).toMatchObject({ found: 1, flagged: 0 });
    // Both responses were paid for, so both are recorded.
    expect(rows(run.id)).toHaveLength(2);
  });

  it('flags the person after a second blank answer, then continues with the next person', async () => {
    let call = 0;
    compat.deepseek.state.fallback = (body) => {
      call += 1;
      return call <= 2 ? blankReply() : compatDraftFor(body);
    };
    const { run, detail } = await draftRun('deepseek', { maxPeople: 2 });
    expect(compat.deepseek.state.chatCalls).toBe(3);
    expect(detail.counts).toMatchObject({ found: 1, flagged: 1 });
    expect((detail.scope.failures as { reason: string }[])[0]!.reason).toContain('DeepSeek sent an empty draft');
    expect(rows(run.id)).toHaveLength(3);
  });

  it('repairs a draft that fails validation once, naming the problem, and keeps the first reply as data', async () => {
    let call = 0;
    compat.deepseek.state.fallback = (body) => {
      call += 1;
      return call === 1 ? jsonReply({ subject: 'Hi', factsUsed: [] }) : compatDraftFor(body);
    };
    const { run, detail } = await draftRun('deepseek', { maxPeople: 1 });
    expect(detail.counts).toMatchObject({ found: 1, flagged: 0 });
    expect(compat.deepseek.state.chatCalls).toBe(2);
    const repair = compat.deepseek.state.chatBodies[1].messages[1].content as string;
    expect(repair).toContain('did not match the required json format');
    expect(repair).toContain('body');
    expect(repair).toContain('<earlier_reply>');
    expect(repair).toContain('"subject":"Hi"');
    expect(rows(run.id)).toHaveLength(2);
  });

  it('repairs a reply that is not json at all', async () => {
    let call = 0;
    compat.deepseek.state.fallback = (body) => {
      call += 1;
      return call === 1 ? textReply('Sure, here is the email you asked for.') : compatDraftFor(body);
    };
    const { detail } = await draftRun('deepseek', { maxPeople: 1 });
    expect(detail.counts).toMatchObject({ found: 1, flagged: 0 });
    expect(compat.deepseek.state.chatBodies[1].messages[1].content).toContain('Sure, here is the email');
  });

  it('flags the person when the repair also fails, after exactly one retry', async () => {
    compat.deepseek.state.fallback = () => jsonReply({ subject: 'Hi' });
    const { detail } = await draftRun('deepseek', { maxPeople: 1 });
    expect(compat.deepseek.state.chatCalls).toBe(2);
    expect(detail.counts).toMatchObject({ found: 0, flagged: 1 });
    expect((detail.scope.failures as { reason: string }[])[0]!.reason).toContain('did not meet the format limits');
  });
});

describe('drafting with zai (json_object)', () => {
  it('sends reasoning effort low and json_object mode', async () => {
    const { detail } = await draftRun('zai', { maxPeople: 1 });
    expect(detail.status).toBe('waiting_approval');
    const body = compat.zai.state.chatBodies[0];
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content).toMatch(/json/i);
    expect(rows(detail.id)[0]).toMatchObject({ provider: 'zai', model: 'glm-5.3' });
  });
});

describe('drafting with ollama', () => {
  it('sends the schema as the native format, records zero cost, and labels the run local', async () => {
    const { run, detail } = await draftRun('ollama', { maxPeople: 2 });
    expect(detail.status).toBe('waiting_approval');
    const body = ollama.state.chatBodies[0];
    expect(body.stream).toBe(false);
    expect(body.format.required).toEqual(['subject', 'body', 'factsUsed']);
    expect(body).not.toHaveProperty('tools');
    expect(detail.scope).toMatchObject({ provider: 'ollama', model: 'llama-stub:8b' });
    expect(detail.steps[0]!.title).toBe('Check the Ollama connection');
    expect(detail.steps[2]!.detail).toContain('No cost (local model)');
    expect(detail.counts).toMatchObject({ found: 2, estimatedUsd: 0 });
    const saved = rows(run.id);
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => row.provider === 'ollama' && row.estimated_usd === 0 && row.input_tokens === 800 && row.output_tokens === 150)).toBe(true);
    expect((detail.approvals[0]!.payload as { estimatedUsd: number }).estimatedUsd).toBe(0);
  });

  it('is not stopped by a budget, because the average cost is zero, and the first draft never divides by zero', async () => {
    const { detail } = await draftRun('ollama', { maxPeople: 5, budgetUsd: 0.000001 });
    expect(detail.status).toBe('waiting_approval');
    expect(detail.counts).toMatchObject({ found: 5, flagged: 0, estimatedUsd: 0 });
    expect(detail.scope.stoppedEarly).toBeNull();
    expect(ollama.state.chatCalls).toBe(5);
  });

  it('skips the default dollar budget for an agent run, records null and says why, and still honours maxPeople and the open run cap', async () => {
    setModelProvider(env.ctx, { kind: 'ollama' });
    const run = startRun(env.ctx, { kind: 'draft_outreach', scope: { maxPeople: 3 } }, { origin: 'agent' });
    expect(run.scope).toMatchObject({ budgetUsd: null, origin: 'agent', provider: 'ollama' });
    expect(run.scope).not.toHaveProperty('budgetDefaulted');
    await driveRunAsync(env, run.id, ['waiting_approval']);
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.counts).toMatchObject({ found: 3 });
    expect(detail.steps[0]!.detail).toContain('No budget limit, because a local model costs nothing.');
    expect(detail.steps[0]!.detail).not.toContain('$');
    expect(() => startRun(env.ctx, { kind: 'draft_outreach', scope: {} }, { origin: 'agent' })).toThrow(/One agent started run/);
  });

  it('keeps an explicit agent budget on an Ollama run and still gives the default to a paid provider', async () => {
    setModelProvider(env.ctx, { kind: 'ollama' });
    const explicit = startRun(env.ctx, { kind: 'draft_outreach', scope: { maxPeople: 1, budgetUsd: 2 } }, { origin: 'agent' });
    expect(explicit.scope).toMatchObject({ budgetUsd: 2 });
    expect(explicit.scope).not.toHaveProperty('budgetDefaulted');
    env.db.prepare("UPDATE run SET status = 'cancelled' WHERE id = ?").run(explicit.id);
    setModelProvider(env.ctx, { kind: 'openai' });
    const paid = startRun(env.ctx, { kind: 'draft_outreach', scope: { maxPeople: 1 } }, { origin: 'agent' });
    expect(paid.scope).toMatchObject({ budgetUsd: 1, budgetDefaulted: true, provider: 'openai' });
  });

  it('says no cost in every step text and carries the provider on the approval', async () => {
    const { detail } = await draftRun('ollama', { maxPeople: 2 });
    for (const step of detail.steps) expect(step.detail ?? '').not.toMatch(/\$|estimated cost/i);
    expect(detail.steps[2]!.detail).toContain('No cost (local model)');
    expect(detail.steps[3]!.detail).toContain('no cost (local model)');
    expect(detail.approvals[0]!.payload).toMatchObject({ provider: 'ollama', estimatedUsd: 0 });
    const paid = await draftRun('openai', { maxPeople: 1 });
    expect(paid.detail.steps[3]!.detail).toContain('estimated cost $');
    expect(paid.detail.approvals[0]!.payload).toMatchObject({ provider: 'openai' });
  });

  it('flags a person whose reply is not valid json and does not call it a cost', async () => {
    ollama.state.fallback = () => ollamaText('not json');
    const { detail } = await draftRun('ollama', { maxPeople: 1 });
    expect(detail.counts).toMatchObject({ found: 0, flagged: 1 });
    expect((detail.scope.failures as { reason: string }[])[0]!.reason).toContain('not valid JSON');
  });

  it('refuses to start without a chosen model and names Settings', async () => {
    await configureOllamaConnector(env.ctx, { baseUrl: ollama.url });
    env.db.prepare("UPDATE connector SET settings = json_set(settings, '$.model', NULL) WHERE kind = 'ollama'").run();
    setModelProvider(env.ctx, { kind: 'ollama' });
    expect(() => startRun(env.ctx, { kind: 'draft_outreach', scope: {} })).toThrow(/Pick an installed model in Settings/);
    await configureOllamaConnector(env.ctx, { model: 'llama-stub:8b' });
  });
});

describe('repeated retryable failures', () => {
  it('stops early as partial when three people in a row end on the same retryable failure', async () => {
    compat.openai.state.fallback = () => errorReply(429, 'Quota exceeded.');
    const { detail, status } = await draftRun('openai', { maxPeople: 5 });
    expect(status).toBe('partial');
    // Three attempts each for three people, and nobody after that.
    expect(compat.openai.state.chatCalls).toBe(9);
    expect((detail.scope.failures as unknown[]).length).toBe(3);
    expect(detail.scope.stoppedEarly).toContain('Stopped after 3 people in a row failed with the same error');
    expect(detail.scope.stoppedEarly).toContain('rate limiting');
    expect(detail.scope.notDrafted).toBe(2);
    expect(detail.steps[2]!.detail).toContain('2 people were not drafted');
    expect(detail.counts).toMatchObject({ processed: 3, found: 0, flagged: 3 });
  });

  it('keeps going when the retryable failures differ or a draft succeeds in between', async () => {
    // People one and three hit 429, person two hits 503 (three attempts each), then everyone is fine.
    compat.openai.state.fallback = (body, call) => (call <= 3 || (call > 6 && call <= 9) ? errorReply(429, 'Slow down.') : call <= 6 ? errorReply(503) : compatDraftFor(body));
    const { detail, status } = await draftRun('openai', { maxPeople: 4 });
    expect(status).toBe('waiting_approval');
    expect(detail.scope.stoppedEarly ?? null).toBeNull();
    expect(detail.counts).toMatchObject({ processed: 4, found: 1, flagged: 3 });
  });
});

describe('provider pinned runs', () => {
  it('does not move or fail a run when the active provider is switched mid run', async () => {
    setModelProvider(env.ctx, { kind: 'openai' });
    const run = startRun(env.ctx, { kind: 'draft_outreach', scope: { maxPeople: 2 } });
    setModelProvider(env.ctx, { kind: 'deepseek' });
    expect(await driveRunAsync(env, run.id, ['waiting_approval', 'failed'])).toBe('waiting_approval');
    expect(compat.openai.state.chatCalls).toBe(2);
    expect(compat.deepseek.state.chatCalls).toBe(0);
    expect(getRunDetail(env.db, env.workspaceId, run.id).scope).toMatchObject({ provider: 'openai' });
  });

  it('sends drafts already written to review when the pinned provider is removed mid run', async () => {
    setModelProvider(env.ctx, { kind: 'openai' });
    const run = startRun(env.ctx, { kind: 'draft_outreach', scope: { maxPeople: 3 } });
    // The provider is removed while the second person is being drafted, so one draft already exists.
    compat.openai.state.fallback = (body, call) => {
      if (call === 2) disconnectModelConnector(env.ctx, 'openai');
      return compatDraftFor(body);
    };
    expect(await driveRunAsync(env, run.id, ['waiting_approval', 'failed'])).toBe('waiting_approval');
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(compat.openai.state.chatCalls).toBe(2);
    expect(detail.scope.stoppedEarly).toContain('OpenAI was disconnected');
    expect(detail.scope.notDrafted).toBe(1);
    expect(detail.approvals[0]!.title).toBe('Save 2 drafts for review');
    const approved = decideApproval(env.ctx, detail.approvals[0]!.id, { decision: 'approve' });
    expect(approved.run.status).toBe('partial');
    await configureModelConnector(env.ctx, 'openai', { token: compatKeys.openai });
  });

  it('still fails a pinned run that has written nothing when its provider is removed without going through Settings', async () => {
    setModelProvider(env.ctx, { kind: 'zai' });
    const run = startRun(env.ctx, { kind: 'draft_outreach', scope: { maxPeople: 2 } });
    env.db.prepare("DELETE FROM connector WHERE kind = 'zai'").run();
    expect(await driveRunAsync(env, run.id, ['failed'])).toBe('failed');
    await configureModelConnector(env.ctx, 'zai', { token: compatKeys.zai });
  });

  it('sends drafts to review when a pinned provider row disappears after drafts exist', async () => {
    setModelProvider(env.ctx, { kind: 'zai' });
    const run = startRun(env.ctx, { kind: 'draft_outreach', scope: { maxPeople: 3 } });
    compat.zai.state.fallback = (body, call) => {
      if (call === 1) env.db.prepare("DELETE FROM connector WHERE kind = 'zai'").run();
      return compatDraftFor(body);
    };
    expect(await driveRunAsync(env, run.id, ['waiting_approval', 'failed'])).toBe('waiting_approval');
    const detail = getRunDetail(env.db, env.workspaceId, run.id);
    expect(detail.approvals[0]!.title).toBe('Save 1 draft for review');
    expect(detail.scope.stoppedEarly).toContain('Z.ai was disconnected');
    await configureModelConnector(env.ctx, 'zai', { token: compatKeys.zai });
  });
});
