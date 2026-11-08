import { EventEmitter } from 'node:events';

export type EntityType = 'person' | 'organization' | 'opportunity';

export type DomainEvent =
  | { type: 'run_updated'; runId: string }
  | { type: 'approval_updated'; approvalId: string; runId: string }
  | { type: 'record_updated'; entityType: string; entityId: string }
  | { type: 'record_deleted'; entityType: string; entityId: string }
  | { type: 'followup_updated'; ruleId: string; personId: string };

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: DomainEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}
