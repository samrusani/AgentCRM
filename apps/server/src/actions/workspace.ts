import type { Db } from '../db.js';
import { findWorkspace } from '../queries/workspace.js';
import { type IdPrefix, randomId } from '../ids.js';

export const defaultWorkspaceName = 'Demo workspace';
export const defaultTemplate = 'startup-fundraising';
export const pipelineName = 'Fundraising';
export const stageNames = [
  'Research',
  'Qualified',
  'Introduction or outreach',
  'Meeting',
  'Diligence',
  'Commitment',
  'Closed',
] as const;

export interface BootstrapOptions {
  now?: () => string;
  newId?: (prefix: IdPrefix) => string;
}

// Creates the single workspace and its pipeline on first start. Later calls return the existing workspace.
export function ensureWorkspace(db: Db, options: BootstrapOptions = {}) {
  const existing = findWorkspace(db);
  if (existing) return existing;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomId;
  db.transaction(() => {
    const timestamp = now();
    const workspaceId = newId('wsp');
    db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(
      workspaceId,
      timestamp,
      defaultWorkspaceName,
      defaultTemplate,
    );
    const pipelineId = newId('pip');
    db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run(
      pipelineId,
      timestamp,
      workspaceId,
      pipelineName,
    );
    stageNames.forEach((name, index) => {
      db.prepare('INSERT INTO stage (id, created_at, pipeline_id, name, seq) VALUES (?, ?, ?, ?, ?)').run(
        newId('stg'),
        timestamp,
        pipelineId,
        name,
        index + 1,
      );
    });
    db.prepare(
      'INSERT INTO audit_event (id, created_at, workspace_id, actor, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(newId('aud'), timestamp, workspaceId, 'system', 'workspace.create', 'workspace', workspaceId, '{}');
  }).immediate();
  return findWorkspace(db)!;
}

// Used by "crm seed --reset". Deletes every row except the migration log.
export function resetAllData(db: Db): void {
  const tables = [
    'audit_event',
    'model_call',
    'qualification_result',
    'import_row',
    'import_batch',
    'connector',
    'send_intent',
    'email_message',
    'suppression',
    'job',
    'approval',
    'run_step',
    'run',
    'field_claim',
    'task',
    'activity',
    'stage_event',
    'opportunity',
    'stage',
    'pipeline',
    'person',
    'organization',
    'workspace',
  ];
  db.transaction(() => {
    for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
  }).immediate();
}
