import { useState } from 'react';
import { useRemoveAnthropicConnector, useSaveAnthropicConnector } from '../api/hooks';
import type { Connector } from '../api/types';
import { Chip, errorMessage } from '../components/common';
import { RemoveControl, TokenForm, TokenLine } from '../components/connector';
import { DEFAULT_MODEL_ID, MODELS, findModel, modelHint, modelName } from '../lib/models';

function ModelSelect({
  value,
  busy,
  onChange,
}: {
  value: string;
  busy: boolean;
  onChange: (id: string) => void;
}) {
  // A model the server reports that this build does not know is still shown, by its id.
  const known = findModel(value) !== null;
  return (
    <div className="connector__form">
      <label className="connector__label" htmlFor="anthropic-model">
        Model
      </label>
      <select
        id="anthropic-model"
        className="input"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      >
        {known ? null : <option value={value}>{value}</option>}
        {MODELS.map((model) => (
          <option key={model.id} value={model.id}>
            {modelHint(model)}
            {model.id === DEFAULT_MODEL_ID ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AnthropicConnectorCard({ connector }: { connector: Connector | null }) {
  const connect = useSaveAnthropicConnector();
  const switchModel = useSaveAnthropicConnector();
  const remove = useRemoveAnthropicConnector();
  const [chosen, setChosen] = useState(DEFAULT_MODEL_ID);

  const hasError = connector?.status === 'error';
  const savedModel = connector?.model ?? DEFAULT_MODEL_ID;
  // While a switch is in flight the select shows the requested model, and it falls back to the saved one on failure.
  const shownModel = connector
    ? switchModel.isPending && switchModel.variables?.model
      ? switchModel.variables.model
      : savedModel
    : chosen;

  const submitToken = async (token: string): Promise<boolean> => {
    try {
      await connect.mutateAsync({ token, model: connector ? savedModel : chosen });
      return true;
    } catch {
      return false;
    }
  };

  const changeModel = (id: string) => {
    if (!connector) {
      setChosen(id);
      return;
    }
    if (id === savedModel) return;
    switchModel.mutate({ model: id });
  };

  return (
    <article className="connector" aria-label="Anthropic connector">
      <header className="connector__header">
        <h3 className="connector__name">Anthropic</h3>
        {connector ? (
          hasError ? (
            <Chip tone="danger">Error</Chip>
          ) : (
            <Chip tone="neutral">Connected</Chip>
          )
        ) : (
          <Chip tone="neutral">Not connected</Chip>
        )}
      </header>

      {connector ? (
        <>
          <TokenLine connector={connector} noun="key" />
          <p>
            Model <span className="cell-name">{modelName(savedModel)}</span>
          </p>
        </>
      ) : (
        <p className="muted">
          Connect your own Anthropic API key so chat can answer from your records and the agent can draft outreach.
          Without one, chat stays rule based and research runs stay simulated.
        </p>
      )}
      <p className="muted">
        Chat and drafting send record contents (people, organizations, claims, notes) to Anthropic.
      </p>

      {hasError ? (
        <p className="inline-error" role="alert">
          {connector?.statusMessage ?? 'The last check of this key failed. Reconnect with a valid key.'}
        </p>
      ) : null}

      <ModelSelect value={shownModel} busy={switchModel.isPending} onChange={changeModel} />
      <p className="muted">Costs shown in this app are estimates from list prices, not your Anthropic invoice.</p>
      <p className="muted" role="status">
        {switchModel.isPending
          ? 'Saving the model...'
          : switchModel.isSuccess && switchModel.variables?.model
            ? `Model set to ${modelName(switchModel.variables.model)}. The key was not changed.`
            : null}
      </p>
      {switchModel.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(switchModel.error)} The model did not change.
        </p>
      ) : null}

      <TokenForm
        idPrefix="anthropic"
        provider="Anthropic"
        connected={Boolean(connector)}
        busy={connect.isPending}
        error={connect.isError ? connect.error : null}
        onSubmit={submitToken}
        noun="key"
        destination="the configured Anthropic endpoint"
      />

      {connector ? (
        <RemoveControl
          provider="Anthropic"
          mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
          warning="Remove Anthropic and delete the stored key? Chat goes back to rule based replies, and draft outreach cannot start until you connect again. Draft runs that are queued, running, or paused will be stopped. Runs waiting for review and finished runs stay, and waiting drafts can still be saved."
        />
      ) : null}
    </article>
  );
}
