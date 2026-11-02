import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useOrganizations, usePeople } from '../api/hooks';
import type { Organization, Person } from '../api/types';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/common';
import { VirtualTable, type Column } from '../components/VirtualTable';
import { describeDue, humanize, personName } from '../lib/format';
import { OrganizationSheet, PersonSheet } from './RecordSheets';

type Tab = 'people' | 'organizations';

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function Relationships() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'organizations' ? 'organizations' : 'people';
  const personId = params.get('person');
  const orgId = params.get('org');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 200);

  const people = usePeople(q);
  const organizations = useOrganizations(q, tab === 'organizations');

  const setTab = (next: Tab) => {
    const copy = new URLSearchParams(params);
    copy.set('tab', next);
    copy.delete('person');
    copy.delete('org');
    setParams(copy, { replace: true });
  };

  const openPerson = useCallback(
    (id: string) => {
      const copy = new URLSearchParams(params);
      copy.set('tab', 'people');
      copy.set('person', id);
      copy.delete('org');
      setParams(copy);
    },
    [params, setParams],
  );

  const openOrganization = useCallback(
    (id: string) => {
      const copy = new URLSearchParams(params);
      copy.set('tab', 'organizations');
      copy.set('org', id);
      copy.delete('person');
      setParams(copy);
    },
    [params, setParams],
  );

  const closeSheet = useCallback(() => {
    const copy = new URLSearchParams(params);
    copy.delete('person');
    copy.delete('org');
    setParams(copy, { replace: true });
  }, [params, setParams]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next: Tab = tab === 'people' ? 'organizations' : 'people';
      setTab(next);
      window.requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
    }
  };

  const sheetOpen = tab === 'people' ? Boolean(personId) : Boolean(orgId);

  return (
    <div className="screen screen--table">
      <PageHeader title="Relationships">
        <div className="search-box">
          <label className="sr-only" htmlFor="relationships-search">
            Search {tab === 'people' ? 'people' : 'organizations'}
          </label>
          <input
            id="relationships-search"
            className="input"
            type="search"
            placeholder={tab === 'people' ? 'Search name, email, organization' : 'Search name, domain'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </PageHeader>

      <div className="tabs" role="tablist" aria-label="Relationship type" onKeyDown={onTabKeyDown}>
        {(['people', 'organizations'] as Tab[]).map((value) => (
          <button
            key={value}
            id={`tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls="relationships-panel"
            tabIndex={tab === value ? 0 : -1}
            className={`tabs__tab${tab === value ? ' is-active' : ''}`}
            onClick={() => setTab(value)}
          >
            {value === 'people' ? 'People' : 'Organizations'}
          </button>
        ))}
      </div>

      <div className="table-region" id="relationships-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'people' ? (
          <PeopleTable query={people} q={q} selectedId={personId} onOpen={openPerson} />
        ) : (
          <OrganizationsTable query={organizations} q={q} selectedId={orgId} onOpen={openOrganization} />
        )}
        {sheetOpen && tab === 'people' && personId ? (
          <PersonSheet id={personId} onClose={closeSheet} onOpenOrganization={openOrganization} />
        ) : null}
        {sheetOpen && tab === 'organizations' && orgId ? (
          <OrganizationSheet id={orgId} onClose={closeSheet} onOpenPerson={openPerson} />
        ) : null}
      </div>
    </div>
  );
}

function PeopleTable({
  query,
  q,
  selectedId,
  onOpen,
}: {
  query: ReturnType<typeof usePeople>;
  q: string;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const needsNames = rows.some((row) => row.organizationId && !row.organizationName);
  const organizations = useOrganizations('', needsNames);
  const organizationNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const page of organizations.data?.pages ?? []) for (const item of page.items) map.set(item.id, item.name);
    return map;
  }, [organizations.data]);

  const columns = useMemo<Column<Person>[]>(
    () => [
      { key: 'name', header: 'Name', width: 'minmax(160px, 1.3fr)', render: (row) => <span className="cell-name">{personName(row)}</span> },
      { key: 'title', header: 'Title', width: 'minmax(120px, 1.2fr)', render: (row) => <span className="cell-text">{row.title}</span> },
      {
        key: 'organization',
        header: 'Organization',
        width: 'minmax(120px, 1.2fr)',
        render: (row) => (
          <span className="cell-text">
            {row.organizationName ?? (row.organizationId ? organizationNames.get(row.organizationId) : '') ?? ''}
          </span>
        ),
      },
      { key: 'email', header: 'Email', width: 'minmax(140px, 1.3fr)', render: (row) => <span className="cell-text">{row.email}</span> },
      { key: 'location', header: 'Location', width: 'minmax(100px, 1fr)', render: (row) => <span className="cell-text">{row.location}</span> },
      {
        key: 'next',
        header: 'Next action',
        width: '112px',
        numeric: true,
        render: (row) => {
          if (!row.nextActionAt) return <span className="muted">None</span>;
          const due = describeDue(row.nextActionAt);
          return <span className={`num${due.overdue ? ' is-overdue' : ''}`}>{due.text}</span>;
        },
      },
    ],
    [organizationNames],
  );

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return (
    <TableStates
      query={query}
      what="people"
      count={rows.length}
      emptyMessage={
        q
          ? `No people match "${q}". Check the spelling or search by email or organization.`
          : 'No people yet. Add people through the API or the CLI, or load the seeded demo data.'
      }
    >
      <VirtualTable
        label="People"
        columns={columns}
        rows={rows}
        getKey={(row) => row.id}
        selectedKey={selectedId}
        onOpen={(row) => onOpen(row.id)}
        onNearEnd={loadMore}
      />
    </TableStates>
  );
}

function OrganizationsTable({
  query,
  q,
  selectedId,
  onOpen,
}: {
  query: ReturnType<typeof useOrganizations>;
  q: string;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const columns = useMemo<Column<Organization>[]>(
    () => [
      { key: 'name', header: 'Name', width: 'minmax(180px, 1.5fr)', render: (row) => <span className="cell-name">{row.name}</span> },
      { key: 'kind', header: 'Kind', width: '110px', render: (row) => <span className="cell-text">{humanize(row.kind)}</span> },
      { key: 'domain', header: 'Domain', width: 'minmax(140px, 1.2fr)', render: (row) => <span className="cell-text">{row.domain}</span> },
      { key: 'location', header: 'Location', width: 'minmax(120px, 1fr)', render: (row) => <span className="cell-text">{row.location}</span> },
    ],
    [],
  );
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return (
    <TableStates
      query={query}
      what="organizations"
      count={rows.length}
      emptyMessage={
        q
          ? `No organizations match "${q}". Check the spelling or search by domain.`
          : 'No organizations yet. Add organizations through the API or the CLI, or load the seeded demo data.'
      }
    >
      <VirtualTable
        label="Organizations"
        columns={columns}
        rows={rows}
        getKey={(row) => row.id}
        selectedKey={selectedId}
        onOpen={(row) => onOpen(row.id)}
        onNearEnd={loadMore}
      />
    </TableStates>
  );
}

function TableStates({
  query,
  what,
  count,
  emptyMessage,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  what: string;
  count: number;
  emptyMessage: string;
  children: ReactNode;
}) {
  if (query.isPending) return <Loading what={what} />;
  if (query.isError && count === 0) {
    return <ErrorState what={what} error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (count === 0) return <EmptyState message={emptyMessage} />;
  return <>{children}</>;
}
