import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAgentMessage, useAnthropicConnector, useRun, useStartRun, useToday } from '../api/hooks';
import type { AgentAction, AgentUsage, ChatTurn } from '../api/types';
import { ApprovalCard, useSettledApprovals } from '../components/approvals';
import { errorMessage } from '../components/common';
import { Icon } from '../components/Icons';
import { LiveRun } from '../components/ledger';
import { isRunActive } from '../lib/format';
import { formatUsd, modelName } from '../lib/models';
import { PANEL_MAX, PANEL_MIN, useMediaQuery, useUI } from '../lib/ui';

interface ChatItem {
  id: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  actions?: AgentAction[];
  usage?: AgentUsage;
}

const HISTORY_TURNS = 10;
// The server keeps the first 4,000 characters of a turn. Cutting here keeps one long reply from growing every later request.
const HISTORY_TURN_CHARACTERS = 4000;

// The last turns of the visible conversation, as the server expects them. Job notes and error notes are not
// turns. A message that never got a reply leaves two user turns in a row, so same role neighbours are joined.
function toHistory(items: ChatItem[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const item of items) {
    if (item.role === 'system') continue;
    const role = item.role === 'user' ? 'user' : 'assistant';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n\n${item.text}`;
    else turns.push({ role, text: item.text });
  }
  const recent = turns.slice(-HISTORY_TURNS).map((turn) => ({ ...turn, text: turn.text.slice(0, HISTORY_TURN_CHARACTERS) }));
  while (recent.length > 0 && recent[0].role !== 'user') recent.shift();
  return recent;
}

const SCREEN_LABELS: Record<string, string> = {
  '/today': 'Today',
  '/relationships': 'Relationships',
  '/pipeline': 'Pipeline',
  '/research': 'Research',
  '/settings': 'Settings',
};

const KIND_LABELS = {
  person: 'Person',
  organization: 'Organization',
  opportunity: 'Opportunity',
} as const;

function PanelRun({ id, tracked, onDismiss }: { id: string; tracked: boolean; onDismiss: () => void }) {
  const query = useRun(id);
  if (!query.data) return <p className="muted">Loading run...</p>;
  const active = isRunActive(query.data.status);
  if (!active && !tracked) return null;
  return (
    <div>
      <LiveRun run={query.data} />
      {!active ? (
        <button type="button" className="btn btn--quiet" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

function PanelBody({ onCollapse }: { onCollapse: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedRecord, pushToast, setPanelSheetOpen } = useUI();
  const today = useToday();
  const startRun = useStartRun();
  const message = useAgentMessage();
  const { query: connectorsQuery, connector: anthropic } = useAnthropicConnector();
  const [replyModelConnected, setReplyModelConnected] = useState<boolean | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState('');
  const [tracked, setTracked] = useState<string[]>([]);
  const [usedActions, setUsedActions] = useState<Record<string, boolean>>({});
  const counter = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const settled = useSettledApprovals();

  const nextId = () => {
    counter.current += 1;
    return counter.current;
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items, message.isPending]);

  const runIds = useMemo(() => {
    const ids = (today.data?.runsActive ?? []).map((run) => run.id);
    for (const id of tracked) if (!ids.includes(id)) ids.push(id);
    return ids;
  }, [today.data, tracked]);

  // The connectors list is the live source. A reply flag covers the time before it loads.
  const modelConnected = connectorsQuery.isSuccess ? anthropic?.status === 'connected' : replyModelConnected === true;

  const screen = SCREEN_LABELS[`/${location.pathname.split('/')[1] ?? ''}`] ?? 'AgentCRM';
  const contextText = selectedRecord
    ? `${KIND_LABELS[selectedRecord.kind]}: ${selectedRecord.label}`
    : `Screen: ${screen}`;

  const send = () => {
    const text = draft.trim();
    if (!text || message.isPending) return;
    setItems((current) => [...current, { id: nextId(), role: 'user', text }]);
    setDraft('');
    message.mutate(
      {
        text,
        history: toHistory(items),
        context: selectedRecord ? { entityType: selectedRecord.kind, entityId: selectedRecord.id } : undefined,
      },
      {
        onSuccess: (reply) => {
          setReplyModelConnected(reply.modelConnected === true);
          setItems((current) => [
            ...current,
            {
              id: nextId(),
              role: 'agent',
              text: reply.reply,
              actions: reply.actions,
              usage: reply.usage,
            },
          ]);
        },
        onError: (error) =>
          setItems((current) => [
            ...current,
            {
              id: nextId(),
              role: 'system',
              text: `No reply. ${errorMessage(error)}`,
            },
          ]),
      },
    );
  };

  const openRecord = (action: AgentAction) => {
    const id = action.entityId ? encodeURIComponent(action.entityId) : '';
    if (!id) return;
    if (action.entityType === 'person') navigate(`/relationships?tab=people&person=${id}`);
    else if (action.entityType === 'organization') navigate(`/relationships?tab=organizations&org=${id}`);
    else if (action.entityType === 'opportunity') navigate(`/pipeline?opportunity=${id}`);
  };

  const runAction = (itemId: number, action: AgentAction) => {
    if (action.kind === 'open_record') {
      openRecord(action);
      return;
    }
    if (action.kind === 'start_apify_import') {
      setPanelSheetOpen(false);
      navigate('/research?import=new');
      return;
    }
    if (action.kind !== 'start_demo_run') return;
    const key = `${itemId}:${action.id}`;
    setUsedActions((current) => ({ ...current, [key]: true }));
    startRun.mutate(undefined, {
      onSuccess: (run) => {
        setTracked((current) => (current.includes(run.id) ? current : [...current, run.id]));
        setItems((current) => [
          ...current,
          {
            id: nextId(),
            role: 'system',
            text: 'Queued a simulated research run. The job is separate from this chat. Its live ledger is above.',
          },
        ]);
      },
      onError: (error) => {
        setUsedActions((current) => ({ ...current, [key]: false }));
        pushToast(`Could not start the run. ${errorMessage(error)}`, 'error');
      },
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const approvals = settled.merge(today.data?.approvalsPending ?? []);

  return (
    <>
      <header className="panel__header">
        <h2 className="panel__title">Agent</h2>
        <button type="button" className="icon-btn" onClick={onCollapse} aria-label="Collapse agent panel">
          <Icon name="chevronRight" />
        </button>
      </header>
      <div className="panel__context">
        <span className="chip chip--accent" title="What the agent panel is looking at">
          {contextText}
        </span>
        {modelConnected ? (
          <span
            className="panel__model"
            title={anthropic?.model ? `Chat uses ${modelName(anthropic.model)}` : undefined}
          >
            Model: connected
          </span>
        ) : null}
      </div>
      <div className="panel__scroll">
        {today.isError ? (
          <p className="inline-error" role="alert">
            Could not load runs and approvals. {errorMessage(today.error)}
          </p>
        ) : null}

        {approvals.length > 0 ? (
          <section className="panel__section" aria-label="Approvals waiting">
            <h3 className="panel__heading">Waiting for you</h3>
            {approvals.map(({ approval, settled: entry }) => (
              <ApprovalCard key={approval.id} approval={approval} settled={entry} compact onDecided={settled.record} />
            ))}
          </section>
        ) : null}

        {runIds.length > 0 ? (
          <section className="panel__section" aria-label="Running jobs">
            <h3 className="panel__heading">Running jobs</h3>
            {runIds.map((id) => (
              <PanelRun
                key={id}
                id={id}
                tracked={tracked.includes(id)}
                onDismiss={() => setTracked((current) => current.filter((value) => value !== id))}
              />
            ))}
          </section>
        ) : null}

        <section className="panel__section" aria-label="Chat">
          <h3 className="panel__heading">Chat</h3>
          {items.length === 0 ? (
            <p className="muted">
              Ask what the agent can do. It replies in text and offers actions you choose. A reply never changes a
              record.
            </p>
          ) : null}
          <ul className="chat" aria-live="polite">
            {items.map((item) => (
              <li key={item.id} className={`chat__item chat__item--${item.role}`}>
                <span className="chat__who">
                  {item.role === 'user' ? 'You' : item.role === 'agent' ? 'Agent reply' : 'Job'}
                </span>
                <p className="chat__text">{item.text}</p>
                {item.usage ? (
                  <p className="chat__usage">
                    {item.usage.inputTokens.toLocaleString()} in / {item.usage.outputTokens.toLocaleString()} out, about{' '}
                    {formatUsd(item.usage.estimatedUsd)}, estimate
                  </p>
                ) : null}
                {item.actions && item.actions.length > 0 ? (
                  <div className="chat__actions">
                    {item.actions.map((action) => {
                      const canOpen =
                        action.kind === 'open_record' && Boolean(action.entityId) && Boolean(action.entityType);
                      const supported =
                        action.kind === 'start_demo_run' || action.kind === 'start_apify_import' || canOpen;
                      const used = usedActions[`${item.id}:${action.id}`];
                      return (
                        <button
                          key={action.id}
                          type="button"
                          className="btn"
                          disabled={!supported || used || (action.kind === 'start_demo_run' && startRun.isPending)}
                          title={supported ? undefined : 'This action is not available in this version.'}
                          onClick={() => runAction(item.id, action)}
                        >
                          {action.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            ))}
            {message.isPending ? (
              <li className="chat__item chat__item--agent">
                <span className="chat__who">Agent reply</span>
                <p className="chat__text muted" role="status">
                  Writing a reply. No job is running.
                </p>
              </li>
            ) : null}
          </ul>
          <div ref={endRef} />
        </section>
      </div>
      <form
        className="panel__composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor="agent-input">
          Message the agent
        </label>
        <textarea
          id="agent-input"
          className="input panel__input"
          rows={2}
          value={draft}
          placeholder="Ask the agent"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <div className="panel__composer-row">
          <span className="muted panel__hint">Enter sends. Shift Enter adds a line.</span>
          <button type="submit" className="btn btn--primary" disabled={!draft.trim() || message.isPending}>
            Send message
          </button>
        </div>
      </form>
    </>
  );
}

function StatusDot() {
  const today = useToday();
  const approvals = today.data?.approvalsPending.length ?? 0;
  const runs = today.data?.runsActive.length ?? 0;
  const state = approvals > 0 ? 'attention' : runs > 0 ? 'active' : 'idle';
  const text =
    state === 'attention'
      ? `${approvals} approval${approvals === 1 ? '' : 's'} waiting`
      : state === 'active'
        ? `${runs} run${runs === 1 ? '' : 's'} active`
        : 'Idle';
  return (
    <>
      <span className={`status-dot status-dot--${state}`} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </>
  );
}

export function AgentPanel() {
  const narrow = useMediaQuery('(max-width: 899px)');
  const { panelWidth, setPanelWidth, panelCollapsed, setPanelCollapsed, panelSheetOpen, setPanelSheetOpen } = useUI();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (!narrow || !panelSheetOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setPanelSheetOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [narrow, panelSheetOpen, setPanelSheetOpen]);

  if (narrow) {
    if (!panelSheetOpen) return null;
    return (
      <>
        <div className="scrim" onClick={() => setPanelSheetOpen(false)} aria-hidden="true" />
        <aside className="panel panel--overlay" aria-label="Agent panel">
          <PanelBody onCollapse={() => setPanelSheetOpen(false)} />
        </aside>
      </>
    );
  }

  if (panelCollapsed) {
    return (
      <button
        type="button"
        className="panel-tab"
        onClick={() => setPanelCollapsed(false)}
        aria-label="Open agent panel"
      >
        <StatusDot />
        <Icon name="chevronLeft" />
        <span className="panel-tab__label" aria-hidden="true">
          Agent
        </span>
      </button>
    );
  }

  const width = dragWidth ?? panelWidth;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    setDragWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, window.innerWidth - event.clientX)));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragWidth !== null) setPanelWidth(dragWidth);
    setDragWidth(null);
  };
  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setPanelWidth(panelWidth + 16);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setPanelWidth(panelWidth - 16);
    }
  };

  return (
    <aside className="panel" style={{ width }} aria-label="Agent panel">
      <div
        className="panel__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize agent panel"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onHandleKeyDown}
      />
      <PanelBody onCollapse={() => setPanelCollapsed(true)} />
    </aside>
  );
}
