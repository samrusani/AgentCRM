import { z } from 'zod';
import { conflict } from '../errors.js';
import { modelProviderKinds } from '../providers/modelTypes.js';
import { readSettings } from '../qualification/config.js';
import {
  type ActiveModelProvider,
  listModelConnectors,
  readActiveModelProvider,
} from '../queries/modelProvider.js';
import { connectorLabel, type ModelConnectorKind } from '../queries/connectors.js';
import { type ActionContext, mutate, parseInput, type Tx } from './context.js';
import { getConnector } from '../queries/connectors.js';

export const noModelProviderMessage =
  'Anthropic is not connected, and no other model provider is connected either. Connect one in Settings first.';

function writeChoiceIn(tx: Tx, kind: ModelConnectorKind | null): void {
  const settings = { ...readSettings(tx.db, tx.workspaceId) };
  if (kind === null) delete settings.modelProvider;
  else settings.modelProvider = kind;
  tx.db.prepare('UPDATE workspace SET settings = ? WHERE id = ?').run(JSON.stringify(settings), tx.workspaceId);
  tx.audit('model_provider.set', 'workspace', tx.workspaceId, { kind });
  tx.emit({ type: 'record_updated', entityType: 'model_provider', entityId: tx.workspaceId });
}

// Called after a model connector is first saved. The first provider connected becomes the active one.
export function activateIfFirstIn(tx: Tx, kind: ModelConnectorKind): void {
  const others = listModelConnectors(tx.db, tx.workspaceId).filter((connector) => connector.kind !== kind);
  if (others.length === 0) writeChoiceIn(tx, kind);
}

// Called after a model connector row is deleted. Only the active provider's removal moves the choice.
export function reassignAfterRemovalIn(tx: Tx, wasActive: boolean): void {
  if (!wasActive) return;
  const remaining = listModelConnectors(tx.db, tx.workspaceId);
  writeChoiceIn(tx, remaining[0]?.kind ?? null);
}

export function getModelProvider(ctx: ActionContext): ActiveModelProvider | null {
  return readActiveModelProvider(ctx.db, ctx.workspaceId);
}

const setProviderSchema = z.object({ kind: z.enum(modelProviderKinds) }).strict();

export function setModelProvider(ctx: ActionContext, input: unknown): ActiveModelProvider {
  const { kind } = parseInput(setProviderSchema, input);
  mutate(ctx, (tx) => {
    if (!getConnector(tx.db, tx.workspaceId, kind)) {
      throw conflict(`${connectorLabel(kind)} is not connected. Connect it in Settings before making it the active provider.`);
    }
    writeChoiceIn(tx, kind);
  });
  return getModelProvider(ctx)!;
}
