import { useEffect, useState } from 'react';
import {
  useModelConnector,
  useOllamaModels,
  useRemoveModelConnector,
  useSaveModelConnector,
  useSetModelProvider,
} from '../api/hooks';
import type { Connector, ModelProviderKind, ModelProviderSelection } from '../api/types';
import { Chip, errorMessage } from '../components/common';
import { RemoveControl, TokenForm, TokenLine } from '../components/connector';
import {
  OLLAMA_DEFAULT_BASE_URL,
  localModelHint,
  modelHint,
  modelName,
  providerName,
  type ProviderPreset,
} from '../lib/models';

interface CardProps {
  preset: ProviderPreset;
  connector: Connector | null;
  active: ModelProviderSelection | null;
}

function CardHeader({ name, connector }: { name: string; connector: Connector | null }) {
  const hasError = connector?.status === 'error';
  return (
    <header className="connector__header">
      <h3 className="connector__name">{name}</h3>
      {connector ? (
        hasError ? <Chip tone="danger">Error</Chip> : <Chip tone="neutral">Connected</Chip>
      ) : (
        <Chip tone="neutral">Not connected</Chip>
      )}
    </header>
  );
}

// Exactly one configured provider is in use. The active card says so in text, others offer a quiet switch.
function UseProvider({ preset, connector, active }: CardProps) {
  const setProvider = useSetModelProvider();
  if (!connector) return null;
  if (active?.kind === preset.kind) {
    return <p className="connector__use">In use</p>;
  }
  if (connector.status === 'error') return null;
  return (
    <div className="connector__use">
      <button
        type="button"
        className="btn btn--quiet"
        disabled={setProvider.isPending}
        aria-label={`Use this provider, ${preset.name}`}
        onClick={() => setProvider.mutate(preset.kind)}
      >
        {setProvider.isPending ? 'Switching...' : 'Use this provider'}
      </button>
      {setProvider.isError ? (
        <p className="inline-error" role="alert">
          {errorMessage(setProvider.error)} The provider in use did not change.
        </p>
      ) : null}
    </div>
  );
}

function removeWarning(preset: ProviderPreset, active: ModelProviderSelection | null, noun: string): string {
  const stored = preset.keyed ? `delete the stored ${noun}` : 'forget the server address';
  // Whether this provider has pinned draft runs is not known here, so every removal carries the warning.
  const pinned = `Draft runs pinned to ${preset.name} will stop; drafts already written go to review.`;
  if (active?.kind === preset.kind) {
    return `Remove ${preset.name} and ${stored}? It is the provider in use, so chat goes back to rule based replies unless another provider is connected and chosen, and draft outreach cannot start until one is. ${pinned} Runs waiting for review and finished runs stay, and waiting drafts can still be saved.`;
  }
  const inUse = active ? ` Chat and drafting keep using ${providerName(active.kind)}.` : '';
  return `Remove ${preset.name} and ${stored}?${inUse} ${pinned} Runs waiting for review and finished runs stay.`;
}

function ModelSelect({
  kind,
  value,
  options,
  placeholder,
  busy,
  onChange,
}: {
  kind: ModelProviderKind;
  value: string;
  options: Array<{ id: string; label: string }>;
  placeholder?: string;
  busy: boolean;
  onChange: (id: string) => void;
}) {
  // A model the server reports that this build does not list is still shown, by its id.
  const known = value === '' || options.some((option) => option.id === value);
  return (
    <div className="connector__form">
      <label className="connector__label" htmlFor={`${kind}-model`}>
        Model
      </label>
      <select
        id={`${kind}-model`}
        className="input"
        value={value}
        disabled={busy || (options.length === 0 && value === '')}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === '' ? <option value="">{placeholder ?? 'Choose a model'}</option> : null}
        {known ? null : <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ModelSaveStatus({
  pending,
  successModel,
  error,
  keyNote,
}: {
  pending: boolean;
  successModel: string | null;
  error: unknown;
  keyNote: string;
}) {
  return (
    <>
      <p className="muted" role="status">
        {pending ? 'Saving the model...' : successModel ? `Model set to ${modelName(successModel)}. ${keyNote}` : null}
      </p>
      {error ? (
        <p className="inline-error" role="alert">
          {errorMessage(error)} The model did not change.
        </p>
      ) : null}
    </>
  );
}

export function KeyedProviderCard({ preset, connector, active }: CardProps) {
  const connect = useSaveModelConnector(preset.kind);
  const switchModel = useSaveModelConnector(preset.kind);
  const remove = useRemoveModelConnector(preset.kind);
  const defaultModel = preset.defaultModelId ?? preset.models[0]?.id ?? '';
  const [chosen, setChosen] = useState(defaultModel);

  const hasError = connector?.status === 'error';
  const savedModel = connector?.model ?? defaultModel;
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

  const options = preset.models.map((model) => ({
    id: model.id,
    label: `${modelHint(model)}${model.id === preset.defaultModelId ? ' (default)' : ''}`,
  }));

  return (
    <article className="connector" aria-label={`${preset.name} connector`}>
      <CardHeader name={preset.name} connector={connector} />

      {connector ? (
        <>
          <TokenLine connector={connector} noun="key" />
          <p>
            Model <span className="cell-name">{modelName(savedModel)}</span>
          </p>
          <UseProvider preset={preset} connector={connector} active={active} />
        </>
      ) : (
        <p className="muted">{preset.introduction}</p>
      )}
      <p className="muted">
        Chat and drafting send record contents (people, organizations, claims, notes) to {preset.name}.
      </p>

      {hasError ? (
        <p className="inline-error" role="alert">
          {connector?.statusMessage ?? 'The last check of this key failed. Reconnect with a valid key.'}
        </p>
      ) : null}

      <ModelSelect
        kind={preset.kind}
        value={shownModel}
        options={options}
        busy={switchModel.isPending}
        onChange={changeModel}
      />
      {preset.priceNote ? <p className="muted">{preset.priceNote}</p> : null}
      <ModelSaveStatus
        pending={switchModel.isPending}
        successModel={switchModel.isSuccess ? (switchModel.variables?.model ?? null) : null}
        error={switchModel.isError ? switchModel.error : null}
        keyNote="The key was not changed."
      />

      <TokenForm
        idPrefix={preset.kind}
        provider={preset.name}
        connected={Boolean(connector)}
        busy={connect.isPending}
        error={connect.isError ? connect.error : null}
        onSubmit={submitToken}
        noun="key"
        destination={preset.destination}
      />

      {connector ? (
        <RemoveControl
          provider={preset.name}
          mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
          warning={removeWarning(preset, active, 'key')}
        />
      ) : null}
    </article>
  );
}

export function OllamaCard({ preset, connector, active }: CardProps) {
  const save = useSaveModelConnector('ollama');
  const switchModel = useSaveModelConnector('ollama');
  const remove = useRemoveModelConnector('ollama');
  const hasError = connector?.status === 'error';
  const models = useOllamaModels(Boolean(connector) && !hasError);
  const [baseUrl, setBaseUrl] = useState(connector?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
  const savedUrl = connector?.baseUrl ?? null;

  useEffect(() => {
    if (savedUrl) setBaseUrl(savedUrl);
  }, [savedUrl]);

  const address = baseUrl.trim() || OLLAMA_DEFAULT_BASE_URL;
  const checking = save.isPending || models.isFetching;
  const installed = models.data?.map((entry) => entry.name) ?? null;
  const savedModel = connector?.model ?? '';
  const shownModel = switchModel.isPending && switchModel.variables?.model ? switchModel.variables.model : savedModel;

  const checkConnection = async () => {
    // A new or changed address is saved first, which also makes the server validate it.
    if (!connector || savedUrl !== address) {
      try {
        await save.mutateAsync({ baseUrl: address });
      } catch {
        return;
      }
    }
    await models.refetch();
  };

  const options = (installed ?? []).map((name) => ({ id: name, label: localModelHint(name) }));
  const modelMissing = installed !== null && shownModel !== '' && !installed.includes(shownModel);
  if (modelMissing) options.push({ id: shownModel, label: `${shownModel} (not found on the server)` });

  const changeModel = (id: string) => {
    if (id === '' || id === savedModel) return;
    switchModel.mutate({ model: id });
  };

  const disclosureAddress = savedUrl ?? address;

  return (
    <article className="connector" aria-label={`${preset.name} connector`}>
      <CardHeader name={preset.name} connector={connector} />

      {connector ? (
        <>
          <p className="connector__token">
            Server <span className="num">{savedUrl ?? 'address not reported'}</span>
          </p>
          <p>
            Model{' '}
            <span className="cell-name">{connector.model ? modelName(connector.model) : 'none chosen yet'}</span>
          </p>
          <UseProvider preset={preset} connector={connector} active={active} />
        </>
      ) : (
        <p className="muted">{preset.introduction}</p>
      )}
      <p className="muted">
        Chat and drafting send record contents (people, organizations, claims, notes) to the Ollama server at{' '}
        <span className="num">{disclosureAddress}</span>.
      </p>

      {hasError ? (
        <p className="inline-error" role="alert">
          {connector?.statusMessage ?? 'The last check of this server failed. Start Ollama, then check the connection.'}
        </p>
      ) : null}

      <form
        className="connector__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!checking) void checkConnection();
        }}
      >
        <label className="connector__label" htmlFor="ollama-base-url">
          Base URL
        </label>
        <div className="connector__row">
          <input
            id="ollama-base-url"
            className="input num"
            type="url"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            aria-describedby="ollama-base-url-note"
          />
          <button type="submit" className={connector ? 'btn' : 'btn btn--primary'} disabled={checking}>
            {checking ? 'Checking...' : 'Check connection'}
          </button>
        </div>
        <p className="muted" id="ollama-base-url-note">
          Defaults to the local server at <span className="num">{OLLAMA_DEFAULT_BASE_URL}</span>. No key is used. Records
          go to the server at this address, so change it only to a machine you trust.
        </p>
        {save.isError ? (
          <p className="inline-error" role="alert">
            {errorMessage(save.error)}
          </p>
        ) : null}
        {models.isError ? (
          <p className="inline-error" role="alert">
            Could not load installed models. {errorMessage(models.error)}
          </p>
        ) : null}
      </form>

      {connector ? (
        <>
          <ModelSelect
            kind="ollama"
            value={shownModel}
            options={options}
            placeholder={installed ? 'Choose a model' : 'Check the connection to list models'}
            busy={switchModel.isPending}
            onChange={changeModel}
          />
          {installed && installed.length === 0 ? (
            <p className="muted">
              The server answered but has no models installed. Pull one with <span className="num">ollama pull</span>,
              then check the connection again.
            </p>
          ) : (
            <p className="muted">Models listed here are installed on that server. Runs on them are local, no cost.</p>
          )}
          <ModelSaveStatus
            pending={switchModel.isPending}
            successModel={switchModel.isSuccess ? (switchModel.variables?.model ?? null) : null}
            error={switchModel.isError ? switchModel.error : null}
            keyNote="The address was not changed."
          />
          <RemoveControl
            provider={preset.name}
            mutation={{ isPending: remove.isPending, isError: remove.isError, error: remove.error, mutate: () => remove.mutate() }}
            warning={removeWarning(preset, active, 'address')}
          />
        </>
      ) : null}
    </article>
  );
}

// Looks up the connector for a preset so the section stays a plain list.
export function ProviderCard({ preset, active }: { preset: ProviderPreset; active: ModelProviderSelection | null }) {
  const { connector } = useModelConnector(preset.kind);
  return preset.keyed ? (
    <KeyedProviderCard preset={preset} connector={connector} active={active} />
  ) : (
    <OllamaCard preset={preset} connector={connector} active={active} />
  );
}
