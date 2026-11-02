import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useWorkspace } from '../api/hooks';
import { useServerEvents } from '../api/events';
import { Icon, type IconName } from '../components/Icons';
import { NARROW_QUERY, useMediaQuery, useUI } from '../lib/ui';
import { AgentPanel } from './AgentPanel';
import { CommandPalette } from './CommandPalette';

const DESTINATIONS: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/today', label: 'Today', icon: 'today' },
  { to: '/relationships', label: 'Relationships', icon: 'people' },
  { to: '/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { to: '/research', label: 'Research', icon: 'research' },
];

function NavItem({
  to,
  label,
  icon,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: IconName;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `nav__link${isActive ? ' is-active' : ''}`}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      onClick={onNavigate}
    >
      <Icon name={icon} />
      {collapsed ? null : <span>{label}</span>}
    </NavLink>
  );
}

function NavRail() {
  const { navCollapsed, setNavCollapsed, navNarrow } = useUI();
  const overlay = navNarrow && !navCollapsed;
  // After picking a destination in the overlay, put the rail away so the content is visible.
  const closeOverlay = overlay ? () => setNavCollapsed(true) : undefined;

  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setNavCollapsed(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [overlay, setNavCollapsed]);

  return (
    <div className="nav-slot">
      {overlay ? <div className="scrim scrim--nav" onClick={() => setNavCollapsed(true)} aria-hidden="true" /> : null}
      <nav className="nav" aria-label="Main" data-collapsed={navCollapsed} data-overlay={overlay}>
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
            <NavItem key={item.to} {...item} collapsed={navCollapsed} onNavigate={closeOverlay} />
          ))}
        </div>
        <div className="nav__bottom">
          <NavItem to="/settings" label="Settings" icon="settings" collapsed={navCollapsed} onNavigate={closeOverlay} />
        </div>
      </nav>
    </div>
  );
}

function Header() {
  const workspace = useWorkspace();
  const { setPaletteOpen, panelCollapsed, setPanelCollapsed, panelSheetOpen, setPanelSheetOpen } = useUI();
  const narrow = useMediaQuery(NARROW_QUERY);
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
