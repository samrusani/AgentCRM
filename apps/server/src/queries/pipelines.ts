import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import type { Row } from '../records.js';

export interface StageRecord {
  id: string;
  pipelineId: string;
  name: string;
  seq: number;
}

export interface PipelineRecord {
  id: string;
  workspaceId: string;
  name: string;
  template: string;
  version: number;
  stages: StageRecord[];
}

export function listPipelines(db: Db, workspaceId: string): PipelineRecord[] {
  const pipelines = db
    .prepare('SELECT * FROM pipeline WHERE workspace_id = ? ORDER BY created_at, id')
    .all(workspaceId) as Row[];
  const stages = db
    .prepare(
      'SELECT s.* FROM stage s JOIN pipeline p ON p.id = s.pipeline_id WHERE p.workspace_id = ? ORDER BY s.seq, s.id',
    )
    .all(workspaceId) as Row[];
  return pipelines.map((pipeline) => ({
    id: String(pipeline.id),
    workspaceId: String(pipeline.workspace_id),
    name: String(pipeline.name),
    template: String(pipeline.template),
    version: Number(pipeline.version),
    stages: stages
      .filter((stage) => stage.pipeline_id === pipeline.id)
      .map(
        (stage): StageRecord => ({
          id: String(stage.id),
          pipelineId: String(stage.pipeline_id),
          name: String(stage.name),
          seq: Number(stage.seq),
        }),
      ),
  }));
}

export function requireStage(db: Db, workspaceId: string, stageId: string): StageRecord {
  const row = db
    .prepare(
      'SELECT s.* FROM stage s JOIN pipeline p ON p.id = s.pipeline_id WHERE p.workspace_id = ? AND s.id = ?',
    )
    .get(workspaceId, stageId) as Row | undefined;
  if (!row) throw notFound('Stage');
  return { id: String(row.id), pipelineId: String(row.pipeline_id), name: String(row.name), seq: Number(row.seq) };
}

export function getPipeline(db: Db, workspaceId: string, pipelineId: string): PipelineRecord | null {
  return listPipelines(db, workspaceId).find((pipeline) => pipeline.id === pipelineId) ?? null;
}

export function requirePipeline(db: Db, workspaceId: string, pipelineId: string): PipelineRecord {
  const pipeline = getPipeline(db, workspaceId, pipelineId);
  if (!pipeline) throw notFound('Pipeline');
  return pipeline;
}
