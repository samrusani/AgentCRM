import {
  type ActionContext,
  createActivity,
  createContext,
  createFieldClaim,
  createOpportunity,
  createOrganization,
  createPerson,
  createTask,
  decideApproval,
  ensureWorkspace,
  moveOpportunityStage,
  resetAllData,
  startRun,
  updateOpportunity,
  updateTask,
} from '../actions/index.js';
import type { Db } from '../db.js';
import { AppError } from '../errors.js';
import { EventBus } from '../events.js';
import { seededIdFactory } from '../ids.js';
import { processJobs } from '../jobs/worker.js';
import { listPipelines } from '../queries/pipelines.js';
import { getRun, listApprovals } from '../queries/runs.js';
import { getCounts } from '../queries/workspace.js';
import {
  companyTitles,
  firstNames,
  fundTitles,
  lastNames,
  lostReason,
  noteTemplates,
  nurtureReasons,
  organizations,
  owners,
  passReasons,
  personTags,
  taskTemplates,
} from './data.js';

export interface SeedOptions {
  reset?: boolean;
  // Dates are relative to this moment. The default is the current time.
  now?: Date;
}

const personCount = 55;
const stageTargets = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6];
const claimStatuses = ['imported', 'extracted', 'corroborated', 'human_confirmed'] as const;
const dayMilliseconds = 86_400_000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedDatabase(db: Db, options: SeedOptions = {}) {
  const before = ensureWorkspace(db);
  const populated = getCounts(db, before.id);
  if (!options.reset && populated.people + populated.organizations + populated.opportunities + populated.tasksOpen + populated.runs > 0) {
    throw new AppError('conflict', 'The database already has records. Run "crm seed --reset" to replace them.');
  }
  // An empty database is rebuilt too, so the seeded ids are the same on every machine.
  resetAllData(db);

  const random = mulberry32(7);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const base = new Date(options.now ?? new Date());
  base.setHours(0, 0, 0, 0);
  // Each timestamp request advances one millisecond so rows created in sequence sort in sequence.
  let clock = base.getTime();
  const at = (days: number, hour = 10): void => {
    clock = base.getTime() + days * dayMilliseconds + hour * 3_600_000;
  };
  const now = (): string => {
    clock += 1;
    return new Date(clock).toISOString();
  };
  const newId = seededIdFactory(42);

  const workspace = ensureWorkspace(db, { now, newId });
  const ctx: ActionContext = createContext(db, workspace.id, { bus: new EventBus(), actor: 'seed', now, newId });
  const slugify = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

  // Organizations
  const orgRecords = organizations.map((seed, index) => {
    at(-70 + index, 9);
    const domain = `${seed.slug}.${index % 3 === 2 ? 'example.org' : 'example.com'}`;
    const record = createOrganization(ctx, {
      name: seed.name,
      domain,
      kind: seed.kind,
      location: seed.location,
      tags: seed.kind === 'fund' ? ['investor'] : ['company'],
    });
    return { ...record, seed, domain };
  });
  const funds = orgRecords.filter((org) => org.kind === 'fund');

  // People
  const people = [];
  for (let index = 0; index < personCount; index += 1) {
    at(-65 + Math.floor(index / 2), 9 + (index % 6));
    const firstName = firstNames[index % firstNames.length]!;
    const lastName = lastNames[index]!;
    const org = index % 11 === 0 && index >= 30 ? null : orgRecords[index < 30 ? index : Math.floor(random() * orgRecords.length)]!;
    const email = org
      ? `${slugify(firstName)}.${slugify(lastName)}@${org.domain}`
      : `${slugify(firstName)}.${slugify(lastName)}@independent.example.com`;
    const tags = [pick(personTags)];
    if (random() > 0.6) tags.push(pick(personTags));
    const person = createPerson(ctx, {
      firstName,
      lastName,
      email,
      title: org ? pick(org.kind === 'fund' ? fundTitles : companyTitles) : 'Independent angel',
      organizationId: org ? org.id : null,
      location: org ? org.location : pick(['Remote', 'Austin', 'Dublin']),
      tags,
      nextActionAt: index % 5 === 0 ? new Date(base.getTime() + (index % 9) * dayMilliseconds + 9 * 3_600_000).toISOString() : null,
    });
    people.push({ ...person, org });
  }

  // Field claims with sources
  people.forEach((person, index) => {
    at(-40 + (index % 30), 11);
    const slug = slugify(person.name);
    const host = index % 2 === 0 ? 'https://example.com/people' : 'https://example.org/directory';
    createFieldClaim(ctx, {
      entityType: 'person',
      entityId: person.id,
      field: 'email',
      value: person.email,
      sourceUrl: `${host}/${slug}`,
      sourceType: index % 4 === 0 ? 'import' : 'web_page',
      observedAt: new Date(clock - (index % 20) * dayMilliseconds).toISOString(),
      status: claimStatuses[index % 4]!,
    });
    createFieldClaim(ctx, {
      entityType: 'person',
      entityId: person.id,
      field: 'title',
      value: person.title ?? 'Independent angel',
      sourceUrl: `${host}/${slug}/profile`,
      sourceType: index % 3 === 0 ? 'directory' : 'web_page',
      observedAt: new Date(clock - (index % 15) * dayMilliseconds).toISOString(),
      status: claimStatuses[(index + 1) % 4]!,
    });
    if (index % 3 === 0 && person.location) {
      createFieldClaim(ctx, {
        entityType: 'person',
        entityId: person.id,
        field: 'location',
        value: person.location,
        sourceUrl: null,
        sourceType: 'manual',
        status: 'human_confirmed',
      });
    }
  });
  orgRecords.forEach((org, index) => {
    at(-45 + index, 12);
    createFieldClaim(ctx, {
      entityType: 'organization',
      entityId: org.id,
      field: 'website',
      value: `https://${org.domain}`,
      sourceUrl: `https://example.com/directory/${org.seed.slug}`,
      sourceType: 'directory',
      status: claimStatuses[index % 4]!,
    });
    createFieldClaim(ctx, {
      entityType: 'organization',
      entityId: org.id,
      field: org.kind === 'fund' ? 'focus' : 'industry',
      value: org.seed.focus,
      sourceUrl: `https://example.org/profiles/${org.seed.slug}`,
      sourceType: 'web_page',
      status: claimStatuses[(index + 2) % 4]!,
    });
    if (org.kind === 'fund') {
      createFieldClaim(ctx, {
        entityType: 'organization',
        entityId: org.id,
        field: 'check_size',
        value: `$${100 + (index % 5) * 100}k to $${1 + (index % 3)}M`,
        sourceUrl: `https://example.org/profiles/${org.seed.slug}/terms`,
        sourceType: 'web_page',
        status: claimStatuses[(index + 1) % 4]!,
      });
    }
  });

  // Opportunities
  const pipeline = listPipelines(db, workspace.id)[0]!;
  const stages = pipeline.stages;
  const opportunities = [];
  for (let index = 0; index < stageTargets.length; index += 1) {
    const fund = funds[index % funds.length]!;
    const contact = people.find((person) => person.org?.id === fund.id) ?? null;
    const targetStage = stageTargets[index]!;
    const startDay = -50 + index;
    at(startDay, 10);
    let opportunity = createOpportunity(ctx, {
      name: index < funds.length ? `${fund.name} seed round` : `${fund.name} extension`,
      pipelineId: pipeline.id,
      organizationId: fund.id,
      personId: contact?.id ?? null,
      amountTarget: (4 + Math.floor(random() * 96)) * 25_000,
      currency: 'USD',
      owner: owners[index % owners.length]!,
      nextActionAt: index % 3 === 0 ? new Date(base.getTime() + ((index % 7) + 1) * dayMilliseconds + 10 * 3_600_000).toISOString() : null,
    });
    for (let stageIndex = 1; stageIndex <= targetStage; stageIndex += 1) {
      at(startDay + stageIndex * 4, 15);
      opportunity = moveOpportunityStage(ctx, opportunity.id, {
        stageId: stages[stageIndex]!.id,
        expectedVersion: opportunity.version,
      });
    }
    const statusPlan: Record<number, [string, string]> = {
      3: ['passed', passReasons[0]!],
      8: ['passed', passReasons[1]!],
      12: ['lost', lostReason],
      17: ['nurture', nurtureReasons[0]!],
      22: ['nurture', nurtureReasons[1]!],
    };
    const plan = statusPlan[index];
    if (plan) {
      at(-2 - (index % 5), 16);
      opportunity = updateOpportunity(ctx, opportunity.id, {
        expectedVersion: opportunity.version,
        fields: { status: plan[0], reason: plan[1] },
      });
    }
    opportunities.push(opportunity);
  }

  // Activities
  let noteIndex = 0;
  opportunities.forEach((opportunity, index) => {
    if (index % 2 === 1) return;
    at(-20 + index, 14);
    createActivity(ctx, {
      entityType: 'opportunity',
      entityId: opportunity.id,
      body: noteTemplates[noteIndex % noteTemplates.length]!,
    });
    noteIndex += 1;
  });
  people.forEach((person, index) => {
    if (index % 4 !== 0) return;
    at(-30 + index, 13);
    createActivity(ctx, {
      entityType: 'person',
      entityId: person.id,
      body: noteTemplates[noteIndex % noteTemplates.length]!,
    });
    noteIndex += 1;
  });
  funds.forEach((fund, index) => {
    if (index % 2 !== 0) return;
    at(-25 + index, 11);
    createActivity(ctx, {
      entityType: 'organization',
      entityId: fund.id,
      body: noteTemplates[noteIndex % noteTemplates.length]!,
    });
    noteIndex += 1;
  });

  // Tasks
  const dueOffsets: (number | null)[] = [-6, -3, -2, -1, 0, 0, 0, 1, 2, 3, 5, 8, null, -4, -1];
  for (let index = 0; index < dueOffsets.length; index += 1) {
    const offset = dueOffsets[index] ?? null;
    const opportunity = opportunities[(index * 2) % opportunities.length]!;
    const person = opportunity.personId ? people.find((entry) => entry.id === opportunity.personId) : undefined;
    const label = person ? person.name : opportunity.organizationName ?? opportunity.name;
    at(-10 + index, 9);
    const task = createTask(ctx, {
      title: taskTemplates[index % taskTemplates.length]!.replace('{name}', label),
      entityType: index % 3 === 0 && person ? 'person' : 'opportunity',
      entityId: index % 3 === 0 && person ? person.id : opportunity.id,
      dueAt: offset === null ? null : new Date(base.getTime() + offset * dayMilliseconds + (9 + (index % 8)) * 3_600_000).toISOString(),
    });
    if (index >= 13) {
      at(offset ?? -1, 17);
      updateTask(ctx, task.id, { expectedVersion: task.version, fields: { status: 'done' } });
    }
  }

  // One finished simulated research run, produced by the same machinery the app uses.
  at(-2, 14);
  const run = startRun(ctx, {
    kind: 'demo_research',
    title: 'Simulated research: climate seed investors',
    scope: { targetCount: 5, query: 'climate seed investors' },
  });
  for (let tick = 0; tick < 30; tick += 1) {
    clock += 1000;
    processJobs(ctx);
    if (getRun(db, workspace.id, run.id)?.status === 'waiting_approval') break;
  }
  const approval = listApprovals(db, workspace.id, { status: 'pending' }).items.find((entry) => entry.runId === run.id);
  if (approval) {
    clock += 60_000;
    decideApproval({ ...ctx, actor: 'user' }, approval.id, { decision: 'approve', note: 'Looks right for a demo.' });
  }

  return getCounts(db, workspace.id);
}
