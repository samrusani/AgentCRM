import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useOrganizations, usePeople, type PeopleSort } from '../api/hooks';
import type { Lifecycle, Organization, Person } from '../api/types';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/common';
import { Icon, type IconName } from '../components/Icons';
import { FitCell } from '../components/qualification';
import { VirtualTable, type Column } from '../components/VirtualTable';
import { describeDue, humanize, personName } from '../lib/format';
import { CsvImportSheet } from './CsvImportSheet';
import { NewPersonSheet } from './NewPersonSheet';
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

// Leads and Relationships are one screen in two framings. The framing sets the title, the muted
// line, the lifecycle filter for the tables, and the empty states. Sheets read their record by id,
// so a sheet opens for either lifecycle on either route and only the tables filter.
interface Framing {
  title: string;
  description: string;
  lifecycle: Lifecycle;
  // Shown when the people table is empty and no search is active.
  emptyPeople: string;
  emptyOrganizations: string;
  // Leads invite an import from the empty people table.
  inviteImport: boolean;
}

const LEADS_FRAMING: Framing = {
  title: 'Leads',
  description: 'People you have imported or captured but not yet talked to.',
  lifecycle: 'lead',
  emptyPeople: 'No leads yet. Import a CSV or capture people from LinkedIn and they will appear here.',
  emptyOrganizations: 'No lead organizations yet. Organizations appear here when you import or capture people who work at them.',
  inviteImport: true,
};

const RELATIONSHIPS_FRAMING: Framing = {
  title: 'Relationships',
  description: 'People you have a real interaction with: they replied, or a deal is moving.',
  lifecycle: 'relationship',
  emptyPeople: 'No relationships yet. Leads graduate here when someone replies or a deal moves.',
  emptyOrganizations: 'No relationship organizations yet. Organizations appear here when a person there replies or a deal moves.',
  inviteImport: false,
};

export function Leads() {
  return <LifecycleScreen framing={LEADS_FRAMING} />;
}

export function Relationships() {
  return <LifecycleScreen framing={RELATIONSHIPS_FRAMING} />;
}

function LifecycleScreen({ framing }: { framing: Framing }) {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'organizations' ? 'organizations' : 'people';
  const personId = params.get('person');
  const orgId = params.get('org');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 200);

  const sort: PeopleSort = params.get('sort') === 'fit' ? 'fit' : 'default';
  const csvOpen = tab === 'people' && params.get('import') === 'csv';
  const navigate = useNavigate();

  const [newPersonOpen, setNewPersonOpen] = useState(false);

  const people = usePeople(q, sort, framing.lifecycle);
  const organizations = useOrganizations(q, tab === 'organizations', framing.lifecycle);

  const setTab = (next: Tab) => {
    const copy = new URLSearchParams(params);
    copy.set('tab', next);
    copy.delete('person');
    copy.delete('org');
    copy.delete('import');
    setParams(copy, { replace: true });
  };

  const toggleSort = useCallback(() => {
    const copy = new URLSearchParams(params);
    if (copy.get('sort') === 'fit') copy.delete('sort');
    else copy.set('sort', 'fit');
    setParams(copy, { replace: true });
  }, [params, setParams]);

  const openCsvImport = () => {
    const copy = new URLSearchParams(params);
    copy.set('tab', 'people');
    copy.set('import', 'csv');
    copy.delete('person');
    copy.delete('org');
    setParams(copy);
  };

  const closeCsvImport = () => {
    const copy = new URLSearchParams(params);
    copy.delete('import');
    setParams(copy, { replace: true });
  };

  const openPerson = useCallback(
    (id: string) => {
      const copy = new URLSearchParams(params);
      copy.set('tab', 'people');
      copy.set('person', id);
      copy.delete('org');
      copy.delete('import');
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
      copy.delete('import');
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
      <PageHeader title={framing.title} description={framing.description}>
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
        {tab === 'people' ? (
          <>
            <button type="button" className="btn" onClick={openCsvImport} aria-haspopup="dialog">
              Import CSV
            </button>
            <button type="button" className="btn" onClick={() => setNewPersonOpen(true)} aria-haspopup="dialog">
              New person
            </button>
          </>
        ) : null}
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
          <PeopleTable
            query={people}
            q={q}
            sort={sort}
            onToggleSort={toggleSort}
            selectedId={personId}
            onOpen={openPerson}
            emptyMessage={framing.emptyPeople}
            onImport={framing.inviteImport ? openCsvImport : undefined}
          />
        ) : (
          <OrganizationsTable
            query={organizations}
            q={q}
            selectedId={orgId}
            onOpen={openOrganization}
            emptyMessage={framing.emptyOrganizations}
          />
        )}
        {newPersonOpen && !csvOpen ? (
          <NewPersonSheet
            onClose={() => setNewPersonOpen(false)}
            onCreated={(id) => {
              setNewPersonOpen(false);
              openPerson(id);
            }}
          />
        ) : null}
        {csvOpen ? (
          <CsvImportSheet
            onClose={closeCsvImport}
            onStaged={(run) => navigate(`/research?run=${encodeURIComponent(run.id)}`)}
          />
        ) : null}
        {!csvOpen && !newPersonOpen && sheetOpen && tab === 'people' && personId ? (
          <PersonSheet id={personId} onClose={closeSheet} onOpenOrganization={openOrganization} />
        ) : null}
        {!csvOpen && !newPersonOpen && sheetOpen && tab === 'organizations' && orgId ? (
          <OrganizationSheet id={orgId} onClose={closeSheet} onOpenPerson={openPerson} />
        ) : null}
      </div>
    </div>
  );
}

function PeopleTable({
  query,
  q,
  sort,
  onToggleSort,
  selectedId,
  onOpen,
  emptyMessage,
  onImport,
}: {
  query: ReturnType<typeof usePeople>;
  q: string;
  sort: PeopleSort;
  onToggleSort: () => void;
  selectedId: string | null;
  onOpen: (id: string) => void;
  emptyMessage: string;
  onImport?: () => void;
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
        key: 'fit',
        header: 'Fit',
        width: 'minmax(150px, 1fr)',
        ariaSort: sort === 'fit' ? 'descending' : 'none',
        headerContent: (
          <button
            type="button"
            className={`vtable__sort${sort === 'fit' ? ' is-active' : ''}`}
            onClick={onToggleSort}
            aria-pressed={sort === 'fit'}
            title={sort === 'fit' ? 'Sorted by fit. Select to return to the default order.' : 'Sort by fit'}
          >
            Fit
            {sort === 'fit' ? <Icon name="chevronDown" /> : null}
            <span className="sr-only">{sort === 'fit' ? ', sorted best first. Select to use the default order.' : ', select to sort best first.'}</span>
          </button>
        ),
        render: (row) => <FitCell qualification={row.qualification} personUpdatedAt={row.updatedAt} />,
      },
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
    [organizationNames, sort, onToggleSort],
  );

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return (
    <TableStates
      query={query}
      what="people"
      count={rows.length}
      icon={q ? 'search' : 'people'}
      emptyMessage={q ? `No people match "${q}". Check the spelling or search by email or organization.` : emptyMessage}
      actionLabel={!q && onImport ? 'Import CSV' : undefined}
      onAction={!q ? onImport : undefined}
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
  emptyMessage,
}: {
  query: ReturnType<typeof useOrganizations>;
  q: string;
  selectedId: string | null;
  onOpen: (id: string) => void;
  emptyMessage: string;
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
      icon={q ? 'search' : 'building'}
      emptyMessage={q ? `No organizations match "${q}". Check the spelling or search by domain.` : emptyMessage}
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
  icon,
  actionLabel,
  onAction,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  what: string;
  count: number;
  emptyMessage: string;
  icon: IconName;
  actionLabel?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  if (query.isPending) return <Loading what={what} />;
  if (query.isError && count === 0) {
    return <ErrorState what={what} error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (count === 0) return <EmptyState framed icon={icon} message={emptyMessage} actionLabel={actionLabel} onAction={onAction} />;
  return <>{children}</>;
}
