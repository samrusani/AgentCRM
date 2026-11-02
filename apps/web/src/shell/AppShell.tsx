import { NavLink, Outlet } from 'react-router-dom';
import { useWorkspace } from '../api/hooks';
import { useServerEvents } from '../api/events';
import { Icon, type IconName } from '../components/Icons';
import { useMediaQuery, useUI } from '../lib/ui';
import { AgentPanel } from './AgentPanel';
import { CommandPalette } from './CommandPalette';

const DESTINATIONS: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/today', label: 'Today', icon: 'today' },
  { to: '/relationships', label: 'Relationships', icon: 'people' },
  { to: '/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { to: '/research', label: 'Research', icon: 'research' },
];

function NavItem({ to, label, icon, collapsed }: { to: string; label: string; icon: IconName; collapsed: boolean }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `nav__link${isActive ? ' is-active' : ''}`}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
    >
      <Icon name={icon} />
      {collapsed ? null : <span>{label}</span>}
    </NavLink>
  );
}

function NavRail() {
  const { navCollapsed, setNavCollapsed } = useUI();
  return (
    <nav className="nav" aria-label="Main" data-collapsed={navCollapsed}>
      <div className="nav__top">
        {navCollapsed ? null : <span className="nav__brand">AgentCRM</span>}
        <button
          type="button"
          className="icon-btn"
          onClick={() => setNavCollapsed(!navCollapsed)}
          aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!navCollapsed}
        >
          <Icon name={navCollapsed ? 'chevronRight' : 'chevronLeft'} />
        </button>
      </div>
      <div className="nav__links">
        {DESTINATIONS.map((item) => (
          <NavItem key={item.to} {...item} collapsed={navCollapsed} />
        ))}
      </div>
      <div className="nav__bottom">
        <NavItem to="/settings" label="Settings" icon="settings" collapsed={navCollapsed} />
      </div>
    </nav>
  );
}

function Header() {
  const workspace = useWorkspace();
  const { setPaletteOpen, panelCollapsed, setPanelCollapsed, panelSheetOpen, setPanelSheetOpen } = useUI();
  const narrow = useMediaQuery('(max-width: 899px)');
  const panelOpen = narrow ? panelSheetOpen : !panelCollapsed;
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  return (
    <header className="header">
      <span className="header__workspace">
        {workspace.data?.name ?? (workspace.isError ? 'Workspace unavailable' : 'Workspace')}
      </span>
      <button
        type="button"
        className="header__search"
        onClick={() => setPaletteOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Icon name="search" />
        <span className="header__search-label">Search people, organizations, deals</span>
        <kbd className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-pressed={panelOpen}
        aria-label={panelOpen ? 'Hide agent panel' : 'Show agent panel'}
        onClick={() => (narrow ? setPanelSheetOpen(!panelSheetOpen) : setPanelCollapsed(!panelCollapsed))}
      >
        <Icon name="panel" />
      </button>
    </header>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useUI();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          <span>{toast.message}</span>
          <button type="button" className="icon-btn" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification">
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AppShell() {
  useServerEvents();
  return (
    <div className="app">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <NavRail />
      <div className="main">
        <Header />
        <main id="content" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <AgentPanel />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
