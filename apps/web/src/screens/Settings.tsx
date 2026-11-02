import { useHealth, useWorkspace } from '../api/hooks';
import { ErrorState, Loading, PageHeader } from '../components/common';
import { useUI, type ThemeSetting } from '../lib/ui';

const THEMES: Array<{ value: ThemeSetting; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Follow the operating system setting' },
  { value: 'light', label: 'Light', hint: 'Always use the light appearance' },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark appearance' },
];

export function Settings() {
  const { theme, setTheme } = useUI();
  const health = useHealth();
  const workspace = useWorkspace();

  return (
    <div className="screen">
      <PageHeader title="Settings" />
      <div className="settings">
        <section className="section" aria-labelledby="settings-appearance">
          <h2 className="section__title" id="settings-appearance">
            Appearance
          </h2>
          <div className="radio-group" role="radiogroup" aria-label="Appearance">
            {THEMES.map((option) => (
              <label key={option.value} className="radio">
                <input
                  type="radio"
                  name="appearance"
                  checked={theme === option.value}
                  onChange={() => setTheme(option.value)}
                />
                <span>
                  {option.label}
                  <span className="muted"> {option.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="muted">This choice is stored in this browser only.</p>
        </section>

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
              <div className="field">
                <dt className="field__label">Template</dt>
                <dd className="field__value">{workspace.data.template}</dd>
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
          <p className="muted">No model is connected. Agent runs are simulated until you add one.</p>
        </section>
      </div>
    </div>
  );
}
