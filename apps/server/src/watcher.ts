import type { Db } from './db.js';
import type { DomainEvent, EventBus } from './events.js';

interface AuditRow {
  rowid: number;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: string;
}

function maxRowid(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_event').get() as { n: number }).n;
}

// SQLite reports data_version changes only for commits made by other connections, such as the MCP process.
// The server turns those commits into the same events its own actions emit.
export function startExternalWatcher(db: Db, bus: EventBus, intervalMilliseconds = 500): () => void {
  let version = db.pragma('data_version', { simple: true }) as number;
  let lastRowid = maxRowid(db);
  let relaying = false;

  // This process already emitted events for its own audit rows, so move the cursor past them.
  // Otherwise the first external commit would replay every own row written since startup.
  const unsubscribe = bus.subscribe(() => {
    if (relaying) return;
    lastRowid = Math.max(lastRowid, maxRowid(db));
  });

  const emit = (event: DomainEvent): void => {
    relaying = true;
    try {
      bus.emit(event);
    } finally {
      relaying = false;
    }
  };

  const timer = setInterval(() => {
    // After "crm seed --reset" the table is empty and rowids restart at 1. Follow it back down
    // and tell open clients to refetch everything.
    const newest = maxRowid(db);
    if (newest < lastRowid) {
      lastRowid = newest;
      version = db.pragma('data_version', { simple: true }) as number;
      emit({ type: 'run_updated', runId: '' });
      emit({ type: 'record_updated', entityType: 'workspace', entityId: '' });
      return;
    }
    const current = db.pragma('data_version', { simple: true }) as number;
    if (current === version) return;
    version = current;
    const rows = db
      .prepare('SELECT rowid, action, entity_type, entity_id, detail FROM audit_event WHERE rowid > ? ORDER BY rowid')
      .all(lastRowid) as AuditRow[];
    for (const row of rows) {
      lastRowid = row.rowid;
      if (row.entity_type === 'run') {
        emit({ type: 'run_updated', runId: row.entity_id });
      } else if (row.entity_type === 'approval') {
        let runId = '';
        try {
          runId = String((JSON.parse(row.detail) as { runId?: string }).runId ?? '');
        } catch {
          runId = '';
        }
        emit({ type: 'approval_updated', approvalId: row.entity_id, runId });
      } else {
        emit({ type: 'record_updated', entityType: row.entity_type, entityId: row.entity_id });
        // A merge row names the survivor; the deleted record's id lives in the detail. Never guess it.
        if (row.action === 'person.merge' || row.action === 'organization.merge') {
          let otherId: unknown;
          try {
            otherId = (JSON.parse(row.detail) as { otherId?: unknown } | null)?.otherId;
          } catch {
            otherId = undefined;
          }
          if (typeof otherId === 'string' && otherId !== '') {
            emit({
              type: 'record_deleted',
              entityType: row.action === 'person.merge' ? 'person' : 'organization',
              entityId: otherId,
            });
          }
        }
      }
    }
  }, intervalMilliseconds);
  timer.unref();
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
