import type { ViewScreen } from '../api/types';

// A saved view stores whitelisted URL state only. These helpers are the one place that knows the whitelist on the web
// side: they turn the current screen state into a config, a config into a URL, and a config into a plain sentence.
// The server enforces the same whitelist at save and re-filters at read.

export const MAX_VIEW_QUERY = 256;
const MAX_ID = 64;

const ENUMS: Record<string, readonly string[]> = {
  tab: ['people', 'organizations'],
  sort: ['fit'],
  status: ['open', 'nurture', 'passed', 'lost', 'all'],
  view: ['board', 'table'],
};

const KEYS: Record<ViewScreen, readonly string[]> = {
  leads: ['tab', 'q', 'list', 'sort'],
  relationships: ['tab', 'q', 'list', 'sort'],
  pipeline: ['pipeline', 'status', 'view'],
};

const PATHS: Record<ViewScreen, string> = { leads: '/leads', relationships: '/relationships', pipeline: '/pipeline' };

function allowed(key: string, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (key === 'q') return value.length <= MAX_VIEW_QUERY;
  if (key === 'list' || key === 'pipeline') return value.length >= 1 && value.length <= MAX_ID;
  return ENUMS[key]?.includes(value) ?? false;
}

// The URL a view opens: built only from whitelisted keys with valid values, so a stored config can never inject
// another parameter (an open record, an import sheet) into the address.
export function viewUrl(screen: ViewScreen, config: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const key of KEYS[screen]) {
    const value = config[key];
    if (allowed(key, value) && (key !== 'q' || value !== '')) params.set(key, value);
  }
  const search = params.toString();
  return `${PATHS[screen]}${search ? `?${search}` : ''}`;
}

export interface PeopleViewState {
  tab: 'people' | 'organizations';
  q: string;
  // Only a list that exists right now: saving never captures an unknown id from the address.
  list: { id: string; name: string } | null;
  sort: 'fit' | 'default';
}

export function peopleConfig(state: PeopleViewState): Record<string, string> {
  const config: Record<string, string> = {};
  const q = state.q.trim().slice(0, MAX_VIEW_QUERY);
  if (state.tab === 'organizations') config.tab = 'organizations';
  if (q) config.q = q;
  if (state.tab === 'people') {
    if (state.list) config.list = state.list.id;
    if (state.sort === 'fit') config.sort = 'fit';
  }
  return config;
}

export function peopleSentence(screenTitle: string, state: PeopleViewState): string {
  const config = peopleConfig(state);
  if (Object.keys(config).length === 0) return `Opens the plain ${screenTitle} screen.`;
  const parts = [state.tab === 'organizations' ? 'Organizations tab' : 'People tab'];
  if (config.q) parts.push(`search '${config.q}'`);
  if (config.list && state.list) parts.push(`filtered to ${state.list.name}`);
  if (config.sort) parts.push('sorted by fit');
  return `${parts.join(', ')}.`;
}

export interface PipelineViewState {
  pipeline: { id: string; name: string } | null;
  status: string;
  view: string;
}

export function pipelineConfig(state: PipelineViewState): Record<string, string> {
  const config: Record<string, string> = {};
  if (state.pipeline) config.pipeline = state.pipeline.id;
  if (allowed('status', state.status)) config.status = state.status;
  if (allowed('view', state.view)) config.view = state.view;
  return config;
}

const STATUS_PHRASE: Record<string, string> = {
  open: 'open deals',
  nurture: 'nurture deals',
  passed: 'passed deals',
  lost: 'lost deals',
  all: 'all statuses',
};

export function pipelineSentence(state: PipelineViewState): string {
  const config = pipelineConfig(state);
  if (Object.keys(config).length === 0) return 'Opens the plain Pipeline screen.';
  const parts: string[] = [];
  if (config.pipeline && state.pipeline) parts.push(state.pipeline.name);
  if (config.status) parts.push(STATUS_PHRASE[config.status] ?? config.status);
  if (config.view) parts.push(`${config.view} view`);
  return `${parts.join(', ')}.`;
}
