import { useConnectors, useModelProvider } from '../api/hooks';
import { ErrorState, Loading } from '../components/common';
import { PROVIDERS, activeProviderSentence, providerAttention } from '../lib/models';
import { ProviderCard } from './ModelProviderCards';

export function ModelProviderSettings() {
  const connectors = useConnectors();
  const provider = useModelProvider();
  const active = provider.data ?? null;
  const attention = active ? providerAttention(active) : null;
  const anyConfigured = PROVIDERS.some((preset) =>
    connectors.data?.some((entry) => entry.kind === preset.kind),
  );

  return (
    <section className="section" aria-labelledby="settings-model-providers">
      <h2 className="section__title" id="settings-model-providers">
        Model providers
      </h2>

      <div aria-live="polite">
        {provider.isPending ? <Loading what="the model provider in use" /> : null}
        {provider.isError ? (
          <ErrorState what="the model provider in use" error={provider.error} onRetry={() => void provider.refetch()} />
        ) : null}
        {provider.isSuccess ? (
          active ? (
            attention ? (
              <>
                <p className="provider-summary">
                  {attention}
                </p>
                <p className="muted">Chat uses the rule based helper and drafting cannot start until this is fixed.</p>
              </>
            ) : (
              <p className="provider-summary">{activeProviderSentence(active.kind, active.model)}</p>
            )
          ) : (
            <>
              <p className="provider-summary">
                {anyConfigured && connectors.isSuccess
                  ? 'No model provider is in use. Choose one below.'
                  : 'No model provider is connected.'}
              </p>
              <p className="muted">Chat stays rule based and research runs stay simulated until a provider is in use.</p>
            </>
          )
        ) : null}
      </div>

      {connectors.isPending ? <Loading what="model providers" /> : null}
      {connectors.isError ? (
        <ErrorState what="model providers" error={connectors.error} onRetry={() => void connectors.refetch()} />
      ) : null}
      {connectors.isSuccess ? (
        <div className="connector-list">
          {PROVIDERS.map((preset) => (
            <ProviderCard key={preset.kind} preset={preset} active={active} />
          ))}
        </div>
      ) : null}
      <p className="muted">Costs shown are estimates from list prices as of November 2026, not invoices.</p>
    </section>
  );
}
