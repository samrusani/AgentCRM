import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { readBoolean, readNumber, readStorage, writeStorage } from './storage';

export type ThemeSetting = 'system' | 'light' | 'dark';

export const SCHEMES = ['viridian', 'ocean', 'indigo', 'orchid', 'rose', 'ember', 'graphite'] as const;
export type SchemeSetting = (typeof SCHEMES)[number];

export interface SelectedRecord {
  kind: 'person' | 'organization' | 'opportunity';
  id: string;
  label: string;
}

export interface Toast {
  id: number;
  tone: 'info' | 'error';
  message: string;
}

export const PANEL_MIN = 300;
export const PANEL_MAX = 520;
export const PANEL_DEFAULT = 360;
// Below this width the nav rail starts collapsed and the agent panel becomes an overlay sheet.
export const NARROW_QUERY = '(max-width: 899px)';

interface UIState {
  theme: ThemeSetting;
  setTheme: (theme: ThemeSetting) => void;
  toggleAppearance: () => void;
  scheme: SchemeSetting;
  setScheme: (scheme: SchemeSetting) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  // Effective state: below the breakpoint the rail is always collapsed until opened, and then it overlays.
  navCollapsed: boolean;
  setNavCollapsed: (collapsed: boolean) => void;
  navNarrow: boolean;
  panelWidth: number;
  setPanelWidth: (width: number) => void;
  panelCollapsed: boolean;
  setPanelCollapsed: (collapsed: boolean) => void;
  panelSheetOpen: boolean;
  setPanelSheetOpen: (open: boolean) => void;
  selectedRecord: SelectedRecord | null;
  setSelectedRecord: (record: SelectedRecord | null) => void;
  toasts: Toast[];
  pushToast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
}

const UIContext = createContext<UIState | null>(null);

function readTheme(): ThemeSetting {
  const stored = readStorage('agentcrm.theme');
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function readScheme(): SchemeSetting {
  const stored = readStorage('agentcrm.scheme');
  return SCHEMES.find((id) => id === stored) ?? 'viridian';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

let toastCounter = 0;

export function UIProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeSetting>(readTheme);
  const [scheme, setSchemeState] = useState<SchemeSetting>(readScheme);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navNarrow = useMediaQuery(NARROW_QUERY);
  // The stored choice only applies at 900px and wider. Below that the rail starts collapsed on every visit.
  const [navPreference, setNavPreference] = useState(() => readBoolean('agentcrm.nav.collapsed', false));
  const [navNarrowOpen, setNavNarrowOpen] = useState(false);
  const navCollapsed = navNarrow ? !navNarrowOpen : navPreference;
  const [panelWidth, setPanelWidthState] = useState(() =>
    readNumber('agentcrm.panel.width', PANEL_DEFAULT, PANEL_MIN, PANEL_MAX),
  );
  const [panelCollapsed, setPanelCollapsedState] = useState(() => readBoolean('agentcrm.panel.collapsed', false));
  const [panelSheetOpen, setPanelSheetOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<SelectedRecord | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (scheme === 'viridian') root.removeAttribute('data-scheme');
    else root.setAttribute('data-scheme', scheme);
  }, [scheme]);

  const setScheme = useCallback((next: SchemeSetting) => {
    // The attribute reaches the DOM, so only the seven ids may pass, whatever a caller sends.
    if (!SCHEMES.includes(next)) return;
    setSchemeState(next);
    writeStorage('agentcrm.scheme', next);
  }, []);

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeState(next);
    writeStorage('agentcrm.theme', next);
  }, []);

  const toggleAppearance = useCallback(() => {
    const effectiveDark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
    setTheme(effectiveDark ? 'light' : 'dark');
  }, [theme, setTheme]);

  useEffect(() => {
    setNavNarrowOpen(false);
  }, [navNarrow]);

  const setNavCollapsed = useCallback(
    (collapsed: boolean) => {
      if (navNarrow) {
        setNavNarrowOpen(!collapsed);
        return;
      }
      setNavPreference(collapsed);
      writeStorage('agentcrm.nav.collapsed', String(collapsed));
    },
    [navNarrow],
  );

  const setPanelWidth = useCallback((width: number) => {
    const clamped = Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width)));
    setPanelWidthState(clamped);
    writeStorage('agentcrm.panel.width', String(clamped));
  }, []);

  const setPanelCollapsed = useCallback((collapsed: boolean) => {
    setPanelCollapsedState(collapsed);
    writeStorage('agentcrm.panel.collapsed', String(collapsed));
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: Toast['tone'] = 'info') => {
      toastCounter += 1;
      const id = toastCounter;
      setToasts((current) => [...current.slice(-3), { id, tone, message }]);
      if (tone === 'info') window.setTimeout(() => dismissToast(id), 6000);
    },
    [dismissToast],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo<UIState>(
    () => ({
      theme,
      setTheme,
      toggleAppearance,
      scheme,
      setScheme,
      paletteOpen,
      setPaletteOpen,
      navCollapsed,
      setNavCollapsed,
      navNarrow,
      panelWidth,
      setPanelWidth,
      panelCollapsed,
      setPanelCollapsed,
      panelSheetOpen,
      setPanelSheetOpen,
      selectedRecord,
      setSelectedRecord,
      toasts,
      pushToast,
      dismissToast,
    }),
    [
      theme,
      setTheme,
      toggleAppearance,
      scheme,
      setScheme,
      paletteOpen,
      navCollapsed,
      setNavCollapsed,
      navNarrow,
      panelWidth,
      setPanelWidth,
      panelCollapsed,
      setPanelCollapsed,
      panelSheetOpen,
      selectedRecord,
      toasts,
      pushToast,
      dismissToast,
    ],
  );

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUI(): UIState {
  const value = useContext(UIContext);
  if (!value) throw new Error('useUI must be used inside UIProvider');
  return value;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
