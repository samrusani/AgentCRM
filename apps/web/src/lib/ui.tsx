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

interface UIState {
  theme: ThemeSetting;
  setTheme: (theme: ThemeSetting) => void;
  toggleAppearance: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  navCollapsed: boolean;
  setNavCollapsed: (collapsed: boolean) => void;
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

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

let toastCounter = 0;

export function UIProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeSetting>(readTheme);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navCollapsed, setNavCollapsedState] = useState(() => readBoolean('agentcrm.nav.collapsed', false));
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

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeState(next);
    writeStorage('agentcrm.theme', next);
  }, []);

  const toggleAppearance = useCallback(() => {
    const effectiveDark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
    setTheme(effectiveDark ? 'light' : 'dark');
  }, [theme, setTheme]);

  const setNavCollapsed = useCallback((collapsed: boolean) => {
    setNavCollapsedState(collapsed);
    writeStorage('agentcrm.nav.collapsed', String(collapsed));
  }, []);

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
      paletteOpen,
      setPaletteOpen,
      navCollapsed,
      setNavCollapsed,
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
      paletteOpen,
      navCollapsed,
      setNavCollapsed,
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
