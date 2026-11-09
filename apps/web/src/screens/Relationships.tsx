import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  useAddListMembers,
  useCreateList,
  useDeleteList,
  useLists,
  useMailProvider,
  useOrganizations,
  usePeople,
  useRemoveListMembers,
  type PeopleSort,
} from '../api/hooks';
import type { Lifecycle, Organization, Person, PersonList } from '../api/types';
import { ActionMenu, EmptyState, ErrorState, Loading, PageHeader, errorMessage, type MenuItem } from '../components/common';
import { Icon, type IconName } from '../components/Icons';
import { createdButNotAdded, ListMenu, useCreateOnce } from '../components/lists';
import { FitCell } from '../components/qualification';
import { VirtualTable, type Column } from '../components/VirtualTable';
import { describeDue, humanize, personName } from '../lib/format';
import { profileHref, profilePath, websiteHref, websiteLabel } from '../lib/links';
import { addedBeforeFailure, addedMessage, removedMessage, withNextStep } from '../lib/lists';
import { useUI } from '../lib/ui';
import { CsvImportSheet } from './CsvImportSheet';
import { MailboxCaptureSheet } from './MailboxCaptureSheet';
import { RenameListSheet } from './ListSheets';
import { NewPersonSheet } from './NewPersonSheet';
import { SavedViews } from '../components/savedViews';
import { peopleConfig, peopleSentence, type PeopleViewState } from '../lib/views';
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

const MAILBOX_DISABLED_REASON = 'Connect a mail provider in Settings first.';

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
  // The search rides the URL (?q=) so a saved view can carry it. Typing writes it back after a short pause; a q that did
  // not come from this box (a view applied, a link) replaces what is typed.
  const urlQ = params.get('q') ?? '';
  const [search, setSearch] = useState(urlQ);
  const q = useDebouncedValue(search.trim(), 200);
  const writtenQ = useRef(urlQ.trim());

  const sort: PeopleSort = params.get('sort') === 'fit' ? 'fit' : 'default';
  const csvOpen = tab === 'people' && params.get('import') === 'csv';
  const mailboxOpen = tab === 'people' && params.get('import') === 'mailbox';
  // Scanning needs a mail provider that is ready; it reads only the mail already stored.
  const mailProvider = useMailProvider();
  const mailConnected = Boolean(mailProvider.data?.ready);
  const navigate = useNavigate();
  const { pushToast } = useUI();

  const [newPersonOpen, setNewPersonOpen] = useState(false);
  const [renamingList, setRenamingList] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // People ticked in the table, by id. It holds loaded rows only and resets whenever the rows' filter changes.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // The list filter rides the URL. Once the lists have loaded, an unknown id falls back to All lists.
  const lists = useLists();
  const requestedListId = params.get('list');
  const activeList: PersonList | undefined = lists.data?.find((list) => list.id === requestedListId);
  // The filter is in force (the table is filtered) but the lists cannot be read: the select must not claim All lists.
  const listUnavailable = Boolean(requestedListId) && !lists.data && lists.isError;
  const listFilter = requestedListId && (!lists.data || activeList) ? requestedListId : undefined;

  useEffect(() => {
    if (urlQ.trim() === writtenQ.current) return;
    writtenQ.current = urlQ.trim();
    setSearch(urlQ);
  }, [urlQ]);
  useEffect(() => {
    if (q === writtenQ.current) return;
    writtenQ.current = q;
    const copy = new URLSearchParams(params);
    if (q) copy.set('q', q.slice(0, 256));
    else copy.delete('q');
    setParams(copy, { replace: true });
    // Only a changed search writes the address; other parameters are read fresh from the address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const people = usePeople(q, sort, framing.lifecycle, listFilter);
  const organizations = useOrganizations(q, tab === 'organizations', framing.lifecycle);
  const peopleRows = useMemo(() => people.data?.pages.flatMap((page) => page.items) ?? [], [people.data]);

  const addMembers = useAddListMembers();
  const createList = useCreateList();
  const createOnce = useCreateOnce(createList);
  const removeMembers = useRemoveListMembers();
  const deleteList = useDeleteList();

  // A new filter shows different rows, and a selection never carries across them.
  useEffect(() => {
    setSelected(new Set());
  }, [q, listFilter, tab]);

  // Rows that left the table (removed from the open list, or no longer matching) leave the selection with them.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const present = new Set(peopleRows.map((row) => row.id));
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [peopleRows]);

  // An open delete confirm belongs to one list, so it closes whenever the filter changes underneath it.
  const resetDelete = deleteList.reset;
  useEffect(() => {
    setConfirmingDelete(false);
    resetDelete();
  }, [listFilter, resetDelete]);

  const toggleRow = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePage = useCallback(() => {
    setSelected((current) => {
      const everyone = peopleRows.length > 0 && peopleRows.every((row) => current.has(row.id));
      return everyone ? new Set() : new Set(peopleRows.map((row) => row.id));
    });
  }, [peopleRows]);

  const selectList = (id: string) => {
    const copy = new URLSearchParams(params);
    if (id) copy.set('list', id);
    else copy.delete('list');
    setParams(copy, { replace: true });
  };

  const addSelectedTo = async (list: PersonList) => {
    try {
      const result = await addMembers.mutateAsync({ listId: list.id, personIds: [...selected] });
      pushToast(addedMessage(result, list.name));
      setSelected(new Set());
    } catch (error) {
      throw new Error(withNextStep(error, `${addedBeforeFailure(error)} Try again.`.trim()));
    }
  };

  const addSelectedToNewList = async (name: string) => {
    let created: PersonList;
    try {
      created = await createOnce.ensure(name);
    } catch (error) {
      throw new Error(withNextStep(error, 'The list was not created. Fix the name and try again.'));
    }
    try {
      const result = await addMembers.mutateAsync({ listId: created.id, personIds: [...selected] });
      createOnce.forget();
      pushToast(`Created ${created.name}. ${addedMessage(result, created.name)}`);
      setSelected(new Set());
    } catch (error) {
      throw new Error(createdButNotAdded(error, created.name, 'nobody'));
    }
  };

  const removeSelectedFromList = async () => {
    if (!activeList) return;
    const personIds = [...selected];
    const { removed, failed } = await removeMembers.mutateAsync({ listId: activeList.id, personIds });
    pushToast(removedMessage(removed.length, personIds.length, activeList.name), failed.length > 0 ? 'error' : 'info');
    setSelected(new Set(failed));
  };

  const confirmDeleteList = () => {
    if (!activeList) return;
    const removed = activeList;
    deleteList.mutate(removed.id, {
      onSuccess: () => {
        setConfirmingDelete(false);
        selectList('');
        pushToast(`Deleted ${removed.name}. Its members were not deleted.`);
      },
    });
  };

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

  const openMailboxCapture = () => {
    const copy = new URLSearchParams(params);
    copy.set('tab', 'people');
    copy.set('import', 'mailbox');
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

  const listActions: MenuItem[] = [
    { key: 'rename', label: 'Rename list', onSelect: () => setRenamingList(true) },
    {
      key: 'delete',
      label: 'Delete list',
      onSelect: () => {
        resetDelete();
        setConfirmingDelete(true);
      },
    },
  ];
  const sheetOpen = tab === 'people' ? Boolean(personId) : Boolean(orgId);
  const selecting = tab === 'people' && selected.size > 0;
  const description = activeList && tab === 'people' ? `${framing.description} Showing members of ${activeList.name}.` : framing.description;

  const viewState: PeopleViewState = {
    tab,
    q: search,
    list: activeList ? { id: activeList.id, name: activeList.name } : null,
    sort,
  };

  return (
    <div className="screen screen--table">
      <PageHeader title={framing.title} description={description}>
        <SavedViews
          screen={framing.lifecycle === 'lead' ? 'leads' : 'relationships'}
          config={peopleConfig(viewState)}
          sentence={peopleSentence(framing.title, viewState)}
        />
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
            <label className="sr-only" htmlFor="relationships-list">
              List
            </label>
            <select
              id="relationships-list"
              className="input input--select"
              value={activeList?.id ?? (listUnavailable ? (requestedListId ?? '') : '')}
              onChange={(event) => selectList(event.target.value)}
            >
              <option value="">All lists</option>
              {listUnavailable ? (
                <option value={requestedListId ?? ''} disabled>
                  Unavailable list
                </option>
              ) : null}
              {(lists.data ?? []).map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({list.memberCount})
                </option>
              ))}
            </select>
            {lists.isError ? (
              <button type="button" className="btn btn--quiet" onClick={() => void lists.refetch()}>
                Retry lists
              </button>
            ) : null}
            {activeList ? <ActionMenu label="List actions" items={listActions} /> : null}
          </>
        ) : null}
        {confirmingDelete && activeList ? (
          <span className="lift__confirm" role="alert">
            Delete {activeList.name}? Its {activeList.memberCount === 1 ? 'member is' : `${activeList.memberCount} members are`} not
            deleted, only the list.
            <button type="button" className="btn btn--danger" disabled={deleteList.isPending} onClick={confirmDeleteList}>
              {deleteList.isPending ? 'Deleting...' : 'Delete list'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={deleteList.isPending}
              onClick={() => {
                setConfirmingDelete(false);
                deleteList.reset();
              }}
            >
              Keep list
            </button>
          </span>
        ) : null}
        {deleteList.isError ? (
          <span className="inline-error" role="alert">
            {errorMessage(deleteList.error)} The list was not deleted. Try again.
          </span>
        ) : null}
        {selecting ? (
          <>
            <span className="selection-count" role="status">
              {selected.size} selected
            </span>
            <ListMenu
              label="Add to list"
              lists={lists.data ?? []}
              onPick={addSelectedTo}
              onCreate={addSelectedToNewList}
            />
            {activeList ? (
              <button
                type="button"
                className="btn btn--quiet"
                disabled={removeMembers.isPending}
                onClick={() => void removeSelectedFromList()}
              >
                Remove from list
              </button>
            ) : null}
            <button type="button" className="btn btn--quiet" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </>
        ) : tab === 'people' ? (
          <>
            <button type="button" className="btn" onClick={openCsvImport} aria-haspopup="dialog">
              Import CSV
            </button>
            <button
              type="button"
              className="btn"
              onClick={openMailboxCapture}
              aria-haspopup="dialog"
              disabled={!mailConnected}
              aria-describedby={mailConnected || mailProvider.isPending ? undefined : 'scan-mailbox-reason'}
              title={mailConnected || mailProvider.isPending ? undefined : MAILBOX_DISABLED_REASON}
            >
              Scan mailbox
            </button>
            {mailConnected || mailProvider.isPending ? null : (
              <span className="sr-only" id="scan-mailbox-reason">
                {MAILBOX_DISABLED_REASON}
              </span>
            )}
            <button type="button" className="btn" onClick={() => navigate('/duplicates')}>
              Find duplicates
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
            rows={peopleRows}
            selectedIds={selected}
            onToggleRow={toggleRow}
            onTogglePage={togglePage}
            q={q}
            sort={sort}
            onToggleSort={toggleSort}
            selectedId={personId}
            onOpen={openPerson}
            emptyMessage={
              activeList
                ? `Nobody on ${activeList.name} shows under ${framing.title}. People you add to the list appear on the screen that matches their stage, so check the other one too.`
                : framing.emptyPeople
            }
            onImport={framing.inviteImport && !activeList ? openCsvImport : undefined}
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
        {renamingList && activeList ? (
          <RenameListSheet list={activeList} onClose={() => setRenamingList(false)} onRenamed={() => setRenamingList(false)} />
        ) : null}
        {newPersonOpen && !csvOpen && !mailboxOpen ? (
          <NewPersonSheet
            onClose={() => setNewPersonOpen(false)}
            onCreated={(id) => {
              setNewPersonOpen(false);
              openPerson(id);
            }}
          />
        ) : null}
        {mailboxOpen ? (
          <MailboxCaptureSheet
            onClose={closeCsvImport}
            onStaged={(run) => navigate(`/research?run=${encodeURIComponent(run.id)}`)}
          />
        ) : null}
        {csvOpen ? (
          <CsvImportSheet
            onClose={closeCsvImport}
            onStaged={(run) => navigate(`/research?run=${encodeURIComponent(run.id)}`)}
          />
        ) : null}
        {!csvOpen && !mailboxOpen && !newPersonOpen && !renamingList && sheetOpen && tab === 'people' && personId ? (
          <PersonSheet id={personId} onClose={closeSheet} onOpenOrganization={openOrganization} />
        ) : null}
        {!csvOpen && !mailboxOpen && !newPersonOpen && !renamingList && sheetOpen && tab === 'organizations' && orgId ? (
          <OrganizationSheet id={orgId} onClose={closeSheet} onOpenPerson={openPerson} />
        ) : null}
      </div>
    </div>
  );
}

function PeopleTable({
  query,
  rows,
  selectedIds,
  onToggleRow,
  onTogglePage,
  q,
  sort,
  onToggleSort,
  selectedId,
  onOpen,
  emptyMessage,
  onImport,
}: {
  query: ReturnType<typeof usePeople>;
  rows: Person[];
  selectedIds: ReadonlySet<string>;
  onToggleRow: (id: string) => void;
  onTogglePage: () => void;
  q: string;
  sort: PeopleSort;
  onToggleSort: () => void;
  selectedId: string | null;
  onOpen: (id: string) => void;
  emptyMessage: string;
  onImport?: () => void;
}) {
  const needsNames = rows.some((row) => row.organizationId && !row.organizationName);
  const organizations = useOrganizations('', needsNames);
  const organizationNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const page of organizations.data?.pages ?? []) for (const item of page.items) map.set(item.id, item.name);
    return map;
  }, [organizations.data]);

  const pageSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));
  const someSelected = rows.some((row) => selectedIds.has(row.id));

  const columns = useMemo<Column<Person>[]>(
    () => [
      {
        key: 'select',
        header: 'Select',
        width: '40px',
        headerContent: (
          <SelectBox
            label="Select all people on this page"
            checked={pageSelected}
            indeterminate={someSelected && !pageSelected}
            onChange={onTogglePage}
          />
        ),
        render: (row, state) => (
          <SelectBox
            label={`Select ${personName(row)}`}
            checked={selectedIds.has(row.id)}
            tabbable={state.active}
            onChange={() => onToggleRow(row.id)}
          />
        ),
      },
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
    [organizationNames, sort, onToggleSort, selectedIds, pageSelected, someSelected, onToggleRow, onTogglePage],
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

// A row checkbox. Clicks and keys stay on the box, so they never open the row's sheet. Only the active row's box is a tab
// stop, which keeps the grid one tab stop per row like before.
function SelectBox({
  label,
  checked,
  indeterminate,
  tabbable = true,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  tabbable?: boolean;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      className="select-box"
      aria-label={label}
      checked={checked}
      tabIndex={tabbable ? 0 : -1}
      ref={(element) => {
        if (element) element.indeterminate = Boolean(indeterminate);
      }}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Space toggles the box. The row's own keys (arrows, Enter) still reach the row handler.
        if (event.key === ' ') event.stopPropagation();
      }}
    />
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
      {
        key: 'linkedin',
        header: 'LinkedIn',
        width: 'minmax(140px, 1.2fr)',
        // The path form as a link; a click opens the page, never the row's sheet. A value that does not
        // parse as a profile URL renders as plain text, so a hostile stored value never links anywhere.
        render: (row) => {
          const href = profileHref(row.linkedinUrl);
          const label = profilePath(row.linkedinUrl);
          if (!label) return <span className="cell-text" />;
          return href ? (
            <a className="link cell-text" href={href} title={row.linkedinUrl ?? undefined} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
              {label}
            </a>
          ) : (
            <span className="cell-text" title={row.linkedinUrl ?? undefined}>{label}</span>
          );
        },
      },
      {
        key: 'website',
        header: 'Website',
        width: 'minmax(140px, 1.2fr)',
        // Host plus path as a link to the stored URL; a click opens the page, never the row's sheet. A value that
        // does not parse as an http or https URL renders as plain text.
        render: (row) => {
          const label = websiteLabel(row.website);
          if (!label) return <span className="cell-text" />;
          const href = websiteHref(row.website);
          return href ? (
            <a className="link cell-text" href={href} title={row.website ?? undefined} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
              {label}
            </a>
          ) : (
            <span className="cell-text" title={row.website ?? undefined}>{label}</span>
          );
        },
      },
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
