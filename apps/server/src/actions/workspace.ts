import type { Db } from '../db.js';
import { findWorkspace } from '../queries/workspace.js';
import { type IdPrefix, randomId } from '../ids.js';
import { defaultTemplate, requireTemplate } from '../templates.js';

export { defaultTemplate };
export const defaultWorkspaceName = 'Demo workspace';
export const pipelineName = requireTemplate(defaultTemplate).pipelineName;
export const stageNames = requireTemplate(defaultTemplate).stageNames;

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
  const template = requireTemplate(defaultTemplate);
  db.transaction(() => {
    const timestamp = now();
    const workspaceId = newId('wsp');
    db.prepare('INSERT INTO workspace (id, created_at, name, template) VALUES (?, ?, ?, ?)').run(
      workspaceId,
      timestamp,
      defaultWorkspaceName,
      template.id,
    );
    const pipelineId = newId('pip');
    db.prepare('INSERT INTO pipeline (id, created_at, workspace_id, name) VALUES (?, ?, ?, ?)').run(
      pipelineId,
      timestamp,
      workspaceId,
      template.pipelineName,
    );
    template.stageNames.forEach((name, index) => {
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

// Record tables in delete order. Configuration rows (workspace, pipeline, stage, connector) are not here.
const recordTables = [
  'audit_event',
  'model_call',
  'qualification_result',
  'import_row',
  'import_batch',
  'followup_rule',
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
  'person',
  'organization',
];

// Used by "crm seed". Deletes records and leaves configuration in place: the workspace row with its
// settings (the capture token hash included), the pipeline and stages, and connectors all survive.
export function resetRecordData(db: Db): void {
  db.transaction(() => {
    // followup_rule.intent_id points at send_intent and send_intent.followup_rule_id points back, so the loop is broken
    // first: clear the intents' references, then the rules go before the intents.
    db.prepare('UPDATE send_intent SET followup_rule_id = NULL, followup_step = NULL, followup_reply_to = NULL').run();
    for (const table of recordTables) db.prepare(`DELETE FROM ${table}`).run();
  }).immediate();
}

// Deletes every row except the migration log. A full wipe, configuration included; the seed does not use it.
export function resetAllData(db: Db): void {
  const tables = [...recordTables, 'connector', 'stage', 'pipeline', 'workspace'];
  db.transaction(() => {
    // followup_rule.intent_id points at send_intent and send_intent.followup_rule_id points back, so the loop is broken
    // first: clear the intents' references, then the rules go before the intents.
    db.prepare('UPDATE send_intent SET followup_rule_id = NULL, followup_step = NULL, followup_reply_to = NULL').run();
    for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
  }).immediate();
}
