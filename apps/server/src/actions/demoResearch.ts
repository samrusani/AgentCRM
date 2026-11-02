import { createHash } from 'node:crypto';
import { getRun, listRunSteps } from '../queries/runs.js';
import { stepIntervalMilliseconds } from '../config.js';
import type { Row, RunCounts } from '../records.js';
import { type ActionContext, emitRecord, mutate, type Tx, withTxActor } from './context.js';
import { createActivityIn, createFieldClaimIn, createPersonIn } from './crud.js';
import { enqueueJobIn } from './jobs.js';

export const demoActor = 'agent:demo_research';
export const demoStepTitles = [
  'Check existing records',
  'Search sources (simulated)',
  'Extract candidates (simulated)',
  'Qualify candidates and prepare shortlist',
] as const;

export const defaultTargetCount = 5;
export const maxTargetCount = 10;

const firstNames = ['Aldous', 'Brisa', 'Corvin', 'Dessa', 'Emeric', 'Fiora', 'Garrick', 'Halina', 'Ivor', 'Junia', 'Kellan', 'Lucette'];
const lastNames = [
  'Voxhall', 'Peverell-Ames', 'Quillon', 'Thrushwick', 'Marbleton', 'Dunsany-Roe', 'Orrelby', 'Fenchurch-Lowe',
  'Hallowmere', 'Tiverton-Shaw', 'Ravensdale', 'Bellweather',
];
const titles = ['Partner', 'Principal', 'Associate', 'Venture partner', 'Platform lead'];
const firms = [
  'Lanternfold Capital (demo)',
  'Quietwater Ventures (demo)',
  'Harrowgate Partners (demo)',
  'Mistral Row Fund (demo)',
  'Thornbeck Capital (demo)',
];
const locations = ['Remote', 'Northvale', 'Eastmarsh', 'Port Alder'];

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Every email address the scripted name pool can produce. Tests use it to exhaust the pool.
export function demoCandidateEmails(): string[] {
  return lastNames.flatMap((lastName) =>
    firstNames.map((firstName) => `${slug(firstName)}.${slug(lastName)}@demo-candidates.example.com`),
  );
}

export function hashPayload(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex');
}

export function demoRunTag(runId: string): string {
  return `via-${runId}`;
}

interface Candidate {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  title: string;
  firm: string;
}

function createCandidates(tx: Tx, runId: string, wanted: number): Candidate[] {
  const created: Candidate[] = [];
  const total = firstNames.length * lastNames.length;
  for (let index = 0; index < total && created.length < wanted; index += 1) {
    const firstName = firstNames[index % firstNames.length]!;
    const lastName = lastNames[Math.floor(index / firstNames.length)]!;
    const email = `${slug(firstName)}.${slug(lastName)}@demo-candidates.example.com`;
    const taken = tx.db
      .prepare('SELECT 1 FROM person WHERE workspace_id = ? AND lower(email) = ?')
      .get(tx.workspaceId, email);
    if (taken) continue;
    const position = created.length;
    const title = titles[(index + position) % titles.length]!;
    const firm = firms[(index + position) % firms.length]!;
    const person = createPersonIn(tx, {
      firstName,
      lastName,
      email,
      title,
      organizationId: null,
      location: locations[position % locations.length]!,
      tags: ['demo-candidate', demoRunTag(runId)],
      nextActionAt: null,
    });
    const personSlug = slug(`${firstName}-${lastName}`);
    const observedAt = tx.now();
    const claims: [string, string, string, string][] = [
      ['email', email, `https://example.com/demo-sources/directory/${personSlug}`, 'simulated_directory'],
      ['title', title, `https://example.org/demo-sources/profiles/${personSlug}`, 'simulated_profile'],
      ['firm', firm, `https://example.org/demo-sources/profiles/${personSlug}`, 'simulated_profile'],
    ];
    for (const [field, value, sourceUrl, sourceType] of claims) {
      createFieldClaimIn(tx, {
        entityType: 'person',
        entityId: person.id,
        field,
        value,
        sourceUrl,
        sourceType,
        observedAt,
        status: 'extracted',
      });
    }
    createActivityIn(tx, {
      entityType: 'person',
      entityId: person.id,
      kind: 'agent',
      body: 'Synthetic candidate created by a simulated research run. This is not a real person.',
    });
    created.push({ id: person.id, firstName, lastName, name: person.name, email, title, firm });
  }
  return created;
}

function candidatesForRun(tx: Tx, runId: string): Candidate[] {
  const rows = tx.db
    .prepare(
      `SELECT p.* FROM person p WHERE p.workspace_id = ?
       AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value = ?) ORDER BY p.created_at, p.id`,
    )
    .all(tx.workspaceId, demoRunTag(runId)) as Row[];
  return rows.map((row) => {
    const firm = tx.db
      .prepare("SELECT value FROM field_claim WHERE entity_type = 'person' AND entity_id = ? AND field = 'firm' LIMIT 1")
      .get(String(row.id)) as { value: string } | undefined;
    return {
      id: String(row.id),
      firstName: String(row.first_name),
      lastName: String(row.last_name),
      name: `${String(row.first_name)} ${String(row.last_name)}`.trim(),
      email: String(row.email),
      title: String(row.title ?? ''),
      firm: firm?.value ?? '',
    };
  });
}

function setCounts(tx: Tx, runId: string, counts: RunCounts): void {
  tx.db.prepare('UPDATE run SET counts = ? WHERE id = ?').run(JSON.stringify(counts), runId);
}

// Each step transition writes an audit row so other processes can relay step progress to the browser.
function finishStep(tx: Tx, runId: string, step: { id: string; seq: number }, detail: string): void {
  tx.db
    .prepare("UPDATE run_step SET status = 'done', detail = ?, finished_at = ? WHERE id = ?")
    .run(detail, tx.now(), step.id);
  tx.audit('run.step_done', 'run', runId, { seq: step.seq });
}

function startStep(tx: Tx, runId: string, step: { id: string; seq: number }): void {
  tx.db.prepare("UPDATE run_step SET status = 'running', started_at = ? WHERE id = ?").run(tx.now(), step.id);
  tx.audit('run.step_start', 'run', runId, { seq: step.seq });
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

export interface AdvanceResult {
  nextRunAt: string | null;
}

// Moves one scripted step forward. Each call runs in a single transaction, so a crash leaves the run consistent.
export function advanceDemoRun(ctx: ActionContext, runId: string): AdvanceResult {
  return mutate(ctx, (rawTx) => {
    const tx = withTxActor(rawTx, demoActor);
    const run = getRun(tx.db, tx.workspaceId, runId);
    if (!run || run.kind !== 'demo_research') return { nextRunAt: null };
    const nextRunAt = addMilliseconds(tx.now(), stepIntervalMilliseconds());
    const steps = listRunSteps(tx.db, runId);

    if (run.status === 'queued') {
      tx.db.prepare("UPDATE run SET status = 'running', started_at = ? WHERE id = ?").run(tx.now(), runId);
      const first = steps[0];
      if (first) startStep(tx, runId, first);
      tx.audit('run.start', 'run', runId, { kind: run.kind });
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt };
    }
    if (run.status !== 'running') return { nextRunAt: null };

    const active = steps.find((step) => step.status === 'running');
    if (!active) {
      const pending = steps.find((step) => step.status === 'pending');
      if (!pending) return { nextRunAt: null };
      startStep(tx, runId, pending);
      tx.emit({ type: 'run_updated', runId });
      return { nextRunAt };
    }

    const counts = { ...run.counts };
    const targetCount = Number(run.scope.targetCount ?? defaultTargetCount);
    let detail = '';
    let waitForApproval = false;
    let finishEmpty = false;

    if (active.seq === 1) {
      const existing = Number(
        (tx.db.prepare('SELECT COUNT(*) AS n FROM person WHERE workspace_id = ?').get(tx.workspaceId) as { n: number }).n,
      );
      counts.processed += existing;
      detail = `Checked ${existing} existing people so the run does not create duplicates.`;
    } else if (active.seq === 2) {
      detail = 'Read 3 scripted sources. This run is simulated and makes no network requests.';
    } else if (active.seq === 3) {
      const created = createCandidates(tx, runId, targetCount);
      counts.found = created.length;
      detail =
        created.length === targetCount
          ? `Created ${created.length} synthetic candidates tagged demo-candidate.`
          : `Created ${created.length} of ${targetCount} requested candidates. The scripted name pool has no unused names left.`;
    } else {
      const candidates = candidatesForRun(tx, runId);
      const shortlist: Candidate[] = [];
      const flagged: { personId: string; name: string; reason: string }[] = [];
      candidates.forEach((candidate, index) => {
        if (index % 4 === 3) {
          const reason = 'Only one simulated source supports the email address.';
          flagged.push({ personId: candidate.id, name: candidate.name, reason });
          createActivityIn(tx, {
            entityType: 'person',
            entityId: candidate.id,
            kind: 'agent',
            body: `Flagged for review: ${reason}`,
          });
        } else {
          createFieldClaimIn(tx, {
            entityType: 'person',
            entityId: candidate.id,
            field: 'email',
            value: candidate.email,
            sourceUrl: `https://example.org/demo-sources/crosscheck/${slug(candidate.name)}`,
            sourceType: 'simulated_crosscheck',
            status: 'corroborated',
          });
          shortlist.push(candidate);
        }
      });
      counts.processed += candidates.length;
      counts.flagged = flagged.length;
      detail = `Qualified ${candidates.length} candidates: ${shortlist.length} on the shortlist, ${flagged.length} flagged for review.`;
      if (candidates.length === 0) {
        finishEmpty = true;
        detail = 'No candidates were created, so there is nothing to approve.';
      } else {
        const payload = {
          simulated: true,
          note: 'Approving creates demo email drafts only. Nothing is sent and no email connector is configured.',
          requestedCount: targetCount,
          foundCount: candidates.length,
          shortlist: shortlist.map((candidate) => ({
            personId: candidate.id,
            name: candidate.name,
            title: candidate.title,
            email: candidate.email,
            firm: candidate.firm,
          })),
          flagged,
        };
        const serialized = JSON.stringify(payload);
        const approvalId = tx.newId('apr');
        tx.db
          .prepare(
            `INSERT INTO approval (id, created_at, workspace_id, run_id, kind, title, payload, payload_hash, status)
             VALUES (?, ?, ?, ?, 'shortlist', ?, ?, ?, 'pending')`,
          )
          .run(
            approvalId,
            tx.now(),
            tx.workspaceId,
            runId,
            `Review shortlist of ${shortlist.length} (simulated)`,
            serialized,
            hashPayload(serialized),
          );
        tx.audit('approval.create', 'approval', approvalId, { runId, kind: 'shortlist' });
        tx.emit({ type: 'approval_updated', approvalId, runId });
        waitForApproval = true;
      }
    }

    finishStep(tx, runId, active, detail);
    setCounts(tx, runId, counts);
    const next = steps.find((step) => step.seq > active.seq && step.status === 'pending');
    if (next) startStep(tx, runId, next);

    if (waitForApproval) {
      tx.db.prepare("UPDATE run SET status = 'waiting_approval' WHERE id = ?").run(runId);
      tx.audit('run.waiting_approval', 'run', runId);
    } else if (finishEmpty) {
      tx.db.prepare("UPDATE run SET status = 'partial', finished_at = ? WHERE id = ?").run(tx.now(), runId);
      tx.audit('run.partial', 'run', runId, { reason: 'no_candidates' });
    }
    tx.emit({ type: 'run_updated', runId });
    return { nextRunAt: waitForApproval || finishEmpty ? null : nextRunAt };
  });
}

export function scheduleDemoRun(tx: Tx, runId: string, runAt: string): void {
  enqueueJobIn(tx, 'demo_run_step', { runId, workspaceId: tx.workspaceId }, runAt);
}

// Applied inside the approval transaction. Creates labelled draft activities and nothing else.
export function applyShortlist(tx: Tx, runId: string, payload: unknown): number {
  const shortlist = ((payload as { shortlist?: { personId: string; name: string; email: string }[] }).shortlist ?? []);
  for (const entry of shortlist) {
    const firstName = entry.name.split(' ')[0] ?? entry.name;
    createActivityIn(withTxActor(tx, demoActor), {
      entityType: 'person',
      entityId: entry.personId,
      kind: 'email_draft',
      body: [
        'Demo draft (simulated, not sent)',
        '',
        `To: ${entry.email}`,
        'Subject: Introduction',
        '',
        `Hello ${firstName},`,
        '',
        'This placeholder was written by a simulated research run. No email connector is configured, so nothing was sent.',
      ].join('\n'),
    });
    emitRecord(tx, 'person', entry.personId);
  }
  tx.audit('run.drafts_created', 'run', runId, { count: shortlist.length });
  return shortlist.length;
}
