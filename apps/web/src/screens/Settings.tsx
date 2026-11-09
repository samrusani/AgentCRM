import { Link, NavLink, Outlet } from 'react-router-dom';
import {
  useConnectors,
  useHealth,
  useImportSettings,
  useModelProvider,
  useSaveImportSettings,
  useWorkspace,
} from '../api/hooks';
import { ErrorState, Loading, PageHeader, errorMessage } from '../components/common';
import { isLocalProvider, modelName, providerAttention, providerName } from '../lib/models';
import { useUI, type SchemeSetting, type ThemeSetting } from '../lib/ui';
import { AttributesSection } from './AttributeSettings';
import { AutomationsSection } from './AutomationSettings';
import { SequencesSection } from './SequenceSettings';

const THEMES: Array<{ value: ThemeSetting; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Follow the operating system setting' },
  { value: 'light', label: 'Light', hint: 'Always use the light appearance' },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark appearance' },
];

const SCHEME_OPTIONS: Array<{ value: SchemeSetting; label: string }> = [
  { value: 'viridian', label: 'Viridian' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'indigo', label: 'Indigo' },
  { value: 'orchid', label: 'Orchid' },
  { value: 'rose', label: 'Rose' },
  { value: 'ember', label: 'Ember' },
  { value: 'graphite', label: 'Graphite' },
];

const SECTIONS: Array<{ to: string; label: string }> = [
  { to: 'general', label: 'General' },
  { to: 'models', label: 'Model providers' },
  { to: 'connectors', label: 'Connectors' },
  { to: 'qualification', label: 'Qualification' },
  { to: 'suppressions', label: 'Suppressions' },
];

export function Settings() {
  const provider = useModelProvider();
  const connectors = useConnectors();
  const active = provider.data ?? null;
  const modelAttention = Boolean(active && providerAttention(active));
  const connectorAttention = Boolean(
    connectors.data?.some(
      (entry) => (entry.kind === 'apify' || entry.kind === 'agentmail' || entry.kind === 'gmail' || entry.kind === 'microsoft' || entry.kind === 'imap') && entry.status === 'error',
    ),
  );

  return (
    <div className="screen">
      <PageHeader title="Settings" />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((section) => {
            const attention =
              (section.to === 'models' && modelAttention) || (section.to === 'connectors' && connectorAttention);
            return (
              <NavLink
                key={section.to}
                to={section.to}
                className={({ isActive }) => `settings-nav__link${isActive ? ' is-active' : ''}`}
              >
                <span>{section.label}</span>
                {attention ? <span className="settings-nav__dot" role="img" aria-label="Needs attention" /> : null}
              </NavLink>
            );
          })}
        </nav>
        <div className="settings">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function ImportsSection() {
  const settings = useImportSettings();
  const save = useSaveImportSettings();
  const enabled = settings.data?.autoAccept === true;

  return (
    <section className="section" aria-labelledby="settings-imports">
      <h2 className="section__title" id="settings-imports">
        Imports
      </h2>
      {settings.isPending ? <Loading what="import settings" /> : null}
      {settings.isError ? (
        <ErrorState what="import settings" error={settings.error} onRetry={() => void settings.refetch()} />
      ) : null}
      {settings.data ? (
        <>
          <label className="toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={save.isPending}
              aria-describedby="settings-imports-note"
              onChange={(event) => save.mutate({ autoAccept: event.target.checked })}
            />
            <span>Auto accept imports</span>
          </label>
          <p className="muted" id="settings-imports-note">
            Staged rows from Apify imports, CSV files, and lead capture are saved without review. Duplicates and invalid
            rows are still skipped. Runs started by the agent, and mailbox scans, always wait for your review.
          </p>
          {save.isError ? (
            <p className="inline-error" role="alert">
              {errorMessage(save.error)} The setting did not change.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function GeneralSettings() {
  const { theme, setTheme, scheme, setScheme } = useUI();
  const health = useHealth();
  const workspace = useWorkspace();
  const modelProvider = useModelProvider();
  const activeProvider = modelProvider.data ?? null;
  const attention = activeProvider ? providerAttention(activeProvider) : null;

  return (
    <>
      <section className="section" aria-labelledby="settings-appearance">
        <h2 className="section__title" id="settings-appearance">
          Appearance
        </h2>
        <div className="segmented" role="radiogroup" aria-label="Appearance">
          {THEMES.map((option) => (
            <label key={option.value} className="segmented__option">
              <input
                type="radio"
                name="appearance"
                checked={theme === option.value}
                onChange={() => setTheme(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <div className="scheme-group" role="radiogroup" aria-label="Color">
          {SCHEME_OPTIONS.map((option) => (
            <label key={option.value} className="scheme-option">
              <input
                type="radio"
                name="color-scheme"
                checked={scheme === option.value}
                onChange={() => setScheme(option.value)}
              />
              <span className={`scheme-option__swatch scheme-option__swatch--${option.value}`} aria-hidden="true" />
              <span className="scheme-option__name">{option.label}</span>
            </label>
          ))}
        </div>
        <p className="muted">
          {THEMES.find((option) => option.value === theme)?.hint}. This choice is stored in this browser only.
        </p>
      </section>

      <ImportsSection />

      <AttributesSection />

      <AutomationsSection />

      <SequencesSection />

      <section className="section" aria-labelledby="settings-workspace">
        <h2 className="section__title" id="settings-workspace">
          Workspace
        </h2>
        {workspace.isPending ? <Loading what="workspace" /> : null}
        {workspace.isError ? (
          <ErrorState what="the workspace" error={workspace.error} onRetry={() => void workspace.refetch()} />
        ) : null}
        {workspace.data ? (
          <dl className="fields">
            <div className="field">
              <dt className="field__label">Name</dt>
              <dd className="field__value">{workspace.data.name}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="section" aria-labelledby="settings-server">
        <h2 className="section__title" id="settings-server">
          Server
        </h2>
        {health.isPending ? <Loading what="server status" /> : null}
        {health.isError ? <ErrorState what="server status" error={health.error} onRetry={() => void health.refetch()} /> : null}
        {health.data ? (
          <dl className="fields">
            <div className="field">
              <dt className="field__label">Status</dt>
              <dd className="field__value">{health.data.ok ? 'Running' : 'Reporting a problem'}</dd>
            </div>
            <div className="field">
              <dt className="field__label">Version</dt>
              <dd className="field__value num">{health.data.version}</dd>
            </div>
            <div className="field">
              <dt className="field__label">Database</dt>
              <dd className="field__value">{health.data.dbPath}</dd>
            </div>
          </dl>
        ) : null}
        <p className="muted">
          {modelProvider.isPending ? (
            'Checking the model provider...'
          ) : modelProvider.isError ? (
            <>
              Could not check the model provider. See{' '}
              <Link className="link" to="/settings/models">
                Model providers
              </Link>
              .
            </>
          ) : attention ? (
            <>
              {attention} Fix it in{' '}
              <Link className="link" to="/settings/models">
                Model providers
              </Link>
              .
            </>
          ) : activeProvider ? (
            `Model: connected (${providerName(activeProvider.kind)}${activeProvider.model ? `, ${modelName(activeProvider.model)}` : ''}). ${
              isLocalProvider(activeProvider.kind)
                ? 'Chat and draft outreach use it. It runs on this computer, so there is no cost.'
                : 'Chat and draft outreach use it, and costs shown are estimates.'
            }`
          ) : (
            'No model is connected. Agent runs are simulated until you add one.'
          )}
        </p>
      </section>
    </>
  );
}
