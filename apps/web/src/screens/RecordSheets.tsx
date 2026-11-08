import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, isVersionConflict } from '../api/client';
import type { Claim, Lifecycle, PersonInteraction } from '../api/types';
import { useCreateOrganization, useOrganization, usePatchOrganization, usePatchPerson, usePerson } from '../api/hooks';
import { ErrorState, Loading, Sheet, errorMessage } from '../components/common';
import { AttributeRows } from '../components/attributes';
import { TaskRow } from '../components/TaskRow';
import {
  EditableValue,
  FieldRow,
  NoteForm,
  OpportunityList,
  SheetSection,
  Timeline,
  claimsForField,
  ClaimDetail,
  EvidenceChips,
  DomainLink,
  ProfileLink,
} from '../components/record';
import { Chip } from '../components/common';
import { EnrichControl, EnrichmentSuggestions, OrganizationEnrichControl, OrganizationEnrichmentSuggestions } from '../components/enrichment';
import { PersonFollowupLine } from '../components/followups';
import { Icon } from '../components/Icons';
import { PersonLists } from '../components/lists';
import { QualificationSection } from '../components/qualification';
import { RecordPicker, type PickedRecord } from '../components/RecordPicker';
import { NewOpportunitySheet } from './NewOpportunitySheet';
import { birthdayProximity, describeDue, formatAgo, formatBirthday, formatDaysAgo, humanize, personName } from '../lib/format';
import { useUI, type SelectedRecord } from '../lib/ui';

function useSelectedRecord(record: SelectedRecord | null) {
  const { setSelectedRecord } = useUI();
  const key = record ? `${record.kind}:${record.id}:${record.label}` : '';
  useEffect(() => {
    setSelectedRecord(record);
    return () => setSelectedRecord(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// The quiet action beside an Opportunities title. It opens the creation sheet in place of the record sheet.
function NewOpportunityAction({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn--quiet" onClick={onClick} aria-haspopup="dialog">
      New opportunity
    </button>
  );
}

function OtherEvidence({
  claims,
  shownFields,
  openClaim,
  onToggle,
}: {
  claims: Claim[];
  shownFields: string[];
  openClaim: string | null;
  onToggle: (id: string) => void;
}) {
  const rest = claims.filter((claim) => !shownFields.includes(claimField(claim.field)));
  if (rest.length === 0) return null;
  const open = rest.find((claim) => claim.id === openClaim);
  return (
    <SheetSection title="More evidence">
      <ul className="plain-list">
        {rest.map((claim) => (
          <li key={claim.id} className="plain-list__row">
            <span>{humanize(claim.field)}</span>
            <span className="muted">{claim.value}</span>
            <EvidenceChips claims={[claim]} openId={openClaim} onToggle={onToggle} />
          </li>
        ))}
      </ul>
      {open ? <ClaimDetail claim={open} /> : null}
    </SheetSection>
  );
}

function claimField(field: string): string {
  return field.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

// Two short sentences and the message counts in muted text. Shown only for a person with linked mail.
function InteractionLine({ interaction }: { interaction: PersonInteraction }) {
  const wrote = interaction.lastInboundAt ? `They last wrote ${formatDaysAgo(interaction.lastInboundAt)}.` : 'They have not written.';
  const youWrote = interaction.lastOutboundAt ? `You last wrote ${formatDaysAgo(interaction.lastOutboundAt)}.` : 'You have not written.';
  return (
    <span>
      {wrote} {youWrote}{' '}
      <span className="muted num">
        {interaction.inbound} in, {interaction.outbound} out.
      </span>
    </span>
  );
}

function LifecycleValue({
  lifecycle,
  busy,
  problem,
  onChange,
}: {
  lifecycle: Lifecycle;
  busy: boolean;
  problem: string | null;
  onChange: (next: Lifecycle) => void;
}) {
  const isLead = lifecycle === 'lead';
  return (
    <>
      <span className="lifecycle">
        <span>{isLead ? 'Lead' : 'Relationship'}</span>
        <button
          type="button"
          className="link link--button"
          disabled={busy}
          onClick={() => onChange(isLead ? 'relationship' : 'lead')}
        >
          {isLead ? 'Mark as relationship' : 'Move to leads'}
        </button>
      </span>
      {problem ? (
        <p className="muted" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}

interface OrganizationProblem {
  kind: 'conflict' | 'error';
  message: string;
}

// The person's Organization row. It reads like the other editable fields, but editing swaps in the record picker.
// Choosing an organization saves at once. Escape or a click outside cancels without saving.
function OrganizationValue({
  organization,
  save,
  onOpen,
  onReload,
}: {
  organization: { id: string; name: string } | null;
  save: (organizationId: string | null) => Promise<void>;
  onOpen: (id: string) => void;
  onReload: () => Promise<unknown>;
}) {
  const createOrganization = useCreateOrganization();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<OrganizationProblem | null>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // The organization a create just made. If the link that follows fails, the failure names it.
  const createdRef = useRef<PickedRecord | null>(null);
  // A create or a save in flight owns the row, so cancelling waits for it.
  const working = saving || createOrganization.isPending;

  useEffect(() => {
    if (wasEditing.current && !editing) pencilRef.current?.focus();
    wasEditing.current = editing;
    if (!editing) createdRef.current = null;
  }, [editing]);

  const stopEditing = () => {
    setEditing(false);
    setProblem(null);
  };

  useEffect(() => {
    if (!editing || working) return;
    const onMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !editRef.current?.contains(event.target)) stopEditing();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [editing, working]);

  // While editing, Escape never reaches the sheet, whatever holds focus: the disabled input during a create, the
  // "Saving..." text, or the page body after a click on the note. The picker's own handler closes its open list first.
  // Otherwise Escape cancels the edit, or does nothing while a create or save is in flight.
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      const row = editRef.current;
      const pickerListOpen =
        target instanceof HTMLInputElement &&
        target.getAttribute('role') === 'combobox' &&
        Boolean(row?.contains(target) && row.querySelector('[role="listbox"]'));
      if (pickerListOpen) return;
      event.preventDefault();
      event.stopPropagation();
      if (!working) stopEditing();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [editing, working]);

  const commit = async (organizationId: string | null) => {
    setSaving(true);
    setProblem(null);
    try {
      await save(organizationId);
      createdRef.current = null;
      setEditing(false);
    } catch (error) {
      const created = createdRef.current;
      if (isVersionConflict(error)) {
        // Refetch so a second pick without Reload carries the current version.
        void onReload();
        const current = (error.current ?? {}) as Record<string, unknown>;
        const currentName = current.organizationName;
        setProblem({
          kind: 'conflict',
          message: `The organization changed since you opened this record. ${
            typeof currentName === 'string' && currentName
              ? `It is now "${currentName}".`
              : 'The current value is different from the one you saw.'
          } Your change was not saved.`,
        });
      } else if (created && created.id === organizationId) {
        setProblem({
          kind: 'error',
          message: `"${created.name}" was added but not linked. Search for it and pick it to finish linking.`,
        });
      } else {
        setProblem({ kind: 'error', message: `${errorMessage(error)} The organization was not changed.` });
      }
    } finally {
      setSaving(false);
    }
  };

  // The create resolves to a picked record, so a new organization saves through the same path as an existing one.
  const create = async (name: string): Promise<PickedRecord> => {
    const created = await createOrganization.mutateAsync({ name });
    createdRef.current = { id: created.id, name: created.name };
    return { id: created.id, name: created.name };
  };

  const reload = async () => {
    await onReload();
    stopEditing();
  };

  if (!editing) {
    return (
      <div className="editable">
        {organization ? (
          <button type="button" className="link link--button" onClick={() => onOpen(organization.id)}>
            {organization.name}
          </button>
        ) : (
          <span className="muted">None</span>
        )}
        <button
          ref={pencilRef}
          type="button"
          className="icon-btn icon-btn--small"
          aria-label="Edit organization"
          onClick={() => {
            setProblem(null);
            setEditing(true);
          }}
        >
          <Icon name="pencil" />
        </button>
      </div>
    );
  }

  return (
    <div className="editable" ref={editRef}>
      {saving ? (
        <span className="muted" role="status">
          Saving...
        </span>
      ) : (
        <div className="editable__input">
          <RecordPicker
            kind="organization"
            label="Organization"
            hideLabel
            autoFocus
            value={null}
            onChange={(record) => {
              if (record) void commit(record.id);
            }}
            onCreate={create}
          />
        </div>
      )}
      {organization && !saving && !createOrganization.isPending ? (
        <button
          type="button"
          className="btn btn--quiet"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void commit(null)}
        >
          Remove organization
        </button>
      ) : null}
      {problem?.kind === 'conflict' ? (
        <div className="conflict" role="alert">
          <p>{problem.message}</p>
          <div className="conflict__actions">
            <button type="button" className="btn" onMouseDown={(event) => event.preventDefault()} onClick={() => void reload()}>
              Reload record
            </button>
          </div>
        </div>
      ) : null}
      {problem?.kind === 'error' ? (
        <p className="muted" role="alert">
          {problem.message}
        </p>
      ) : null}
    </div>
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'not_found';
}

// The record is gone, usually merged into another one. No retry: asking again cannot bring it back.
function DeletedRecord({ onClose }: { onClose: () => void }) {
  return (
    <div className="state">
      <p className="state__body">This record was deleted, usually because it was merged into another record.</p>
      <button type="button" className="btn" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export function PersonSheet({
  id,
  onClose,
  onOpenOrganization,
}: {
  id: string;
  onClose: () => void;
  onOpenOrganization: (id: string) => void;
}) {
  const query = usePerson(id);
  const patch = usePatchPerson();
  const navigate = useNavigate();
  // Only one sheet shows at a time, so creating a deal replaces this sheet and Cancel brings it back.
  const [creatingOpportunity, setCreatingOpportunity] = useState(false);
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const person = query.data;
  const name = person ? personName(person) : 'Person';
  useSelectedRecord(person ? { kind: 'person', id, label: name } : null);

  const toggleClaim = (claimId: string) => setOpenClaim((current) => (current === claimId ? null : claimId));

  const saveField = (field: string) => async (value: string, versionOverride?: number) => {
    if (!person) return;
    await patch.mutateAsync({
      id,
      expectedVersion: versionOverride ?? person.version,
      fields: { [field]: value === '' ? null : value },
    });
    await query.refetch();
  };

  // A custom attribute is an ordinary field in the envelope, addressed as attr:<key>.
  const saveAttribute = async (key: string, value: unknown, versionOverride?: number) => {
    if (!person) return;
    await patch.mutateAsync({ id, expectedVersion: versionOverride ?? person.version, fields: { [`attr:${key}`]: value } });
    await query.refetch();
  };

  // An organization id links the person; null removes the link. The server checks that the organization exists.
  const saveOrganization = async (organizationId: string | null) => {
    if (!person) return;
    await patch.mutateAsync({ id, expectedVersion: person.version, fields: { organizationId } });
    await query.refetch();
  };

  const [lifecycleProblem, setLifecycleProblem] = useState<string | null>(null);

  // Either direction is allowed whatever caused the current value. A conflict refetches so the next try carries the current version.
  const changeLifecycle = async (next: Lifecycle) => {
    if (!person) return;
    setLifecycleProblem(null);
    try {
      await patch.mutateAsync({ id, expectedVersion: person.version, fields: { lifecycle: next } });
    } catch (error) {
      setLifecycleProblem(
        isVersionConflict(error)
          ? 'This person changed since you opened the record. The latest version is loaded. Try again.'
          : `${errorMessage(error)} The lifecycle was not changed.`,
      );
    }
    await query.refetch();
  };

  const due = person?.nextActionAt ? describeDue(person.nextActionAt) : null;

  if (creatingOpportunity && person) {
    return (
      <NewOpportunitySheet
        prefill={{
          person: { id, name },
          organization: person.organization ? { id: person.organization.id, name: person.organization.name } : null,
        }}
        onClose={() => setCreatingOpportunity(false)}
        onCreated={(opportunityId) => navigate(`/pipeline?opportunity=${encodeURIComponent(opportunityId)}`)}
      />
    );
  }

  return (
    <Sheet
      title={name}
      subtitle={person ? [person.title, person.organization?.name].filter(Boolean).join(' at ') : undefined}
      onClose={onClose}
    >
      {query.isPending ? <Loading what="person" /> : null}
      {query.isError && isNotFound(query.error) ? <DeletedRecord onClose={onClose} /> : null}
      {query.isError && !isNotFound(query.error) ? (
        <ErrorState what="this person" error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {person ? (
        <>
          <SheetSection title="Fields" headerItems={<EnrichControl personId={id} linkedinUrl={person.linkedinUrl} />}>
            <dl className="fields">
              <FieldRow label="Title" claims={claimsForField(person.claims, 'title')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue label="Title" field="title" value={person.title} save={saveField('title')} onReload={() => query.refetch()} />
              </FieldRow>
              <FieldRow label="Organization" claims={claimsForField(person.claims, 'organizationId')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <OrganizationValue
                  organization={person.organization ? { id: person.organization.id, name: person.organization.name } : null}
                  save={saveOrganization}
                  onOpen={onOpenOrganization}
                  onReload={() => query.refetch()}
                />
              </FieldRow>
              <FieldRow label="Email" claims={claimsForField(person.claims, 'email')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <span className={person.email ? '' : 'muted'}>{person.email || 'Not set'}</span>
              </FieldRow>
              <FieldRow label="Location" claims={claimsForField(person.claims, 'location')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue label="Location" field="location" value={person.location} save={saveField('location')} onReload={() => query.refetch()} />
              </FieldRow>
              <FieldRow label="LinkedIn" claims={claimsForField(person.claims, 'linkedinUrl')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue
                  label="LinkedIn"
                  field="linkedinUrl"
                  value={person.linkedinUrl ?? null}
                  save={saveField('linkedinUrl')}
                  onReload={() => query.refetch()}
                  renderValue={(value) => <ProfileLink value={value} />}
                />
              </FieldRow>
              <FieldRow label="X" claims={claimsForField(person.claims, 'xUrl')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue
                  label="X"
                  field="xUrl"
                  value={person.xUrl ?? null}
                  save={saveField('xUrl')}
                  onReload={() => query.refetch()}
                  renderValue={(value) => <ProfileLink value={value} />}
                />
              </FieldRow>
              <FieldRow label="Lifecycle" openClaim={openClaim} onToggleClaim={toggleClaim}>
                <LifecycleValue
                  lifecycle={person.lifecycle ?? 'lead'}
                  busy={patch.isPending}
                  problem={lifecycleProblem}
                  onChange={changeLifecycle}
                />
              </FieldRow>
              {person.interaction ? (
                <FieldRow label="Interaction" openClaim={openClaim} onToggleClaim={toggleClaim}>
                  <InteractionLine interaction={person.interaction} />
                </FieldRow>
              ) : null}
              <FieldRow label="Next action" openClaim={openClaim} onToggleClaim={toggleClaim}>
                <span className={due?.overdue ? 'is-overdue' : due ? '' : 'muted'}>{due ? due.text : 'Not set'}</span>
              </FieldRow>
              <FieldRow label="Birthday" openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue
                  label="Birthday"
                  field="birthday"
                  value={person.birthday ?? null}
                  save={saveField('birthday')}
                  onReload={() => query.refetch()}
                  renderValue={(value) => {
                    const note = birthdayProximity(value);
                    return (
                      <span>
                        {formatBirthday(value)}
                        {note ? <span className="muted"> {note}</span> : null}
                      </span>
                    );
                  }}
                />
              </FieldRow>
              <FieldRow label="Tags" openClaim={openClaim} onToggleClaim={toggleClaim}>
                {person.tags.length > 0 ? (
                  <span className="tag-row">
                    {person.tags.map((tag) => (
                      <Chip key={tag}>{tag}</Chip>
                    ))}
                  </span>
                ) : (
                  <span className="muted">None</span>
                )}
              </FieldRow>
              <FieldRow label="Lists" openClaim={openClaim} onToggleClaim={toggleClaim}>
                <PersonLists personId={id} lists={person.lists} />
              </FieldRow>
              <AttributeRows
                attributes={person.attributes}
                save={saveAttribute}
                onReload={() => query.refetch()}
                openClaim={openClaim}
                onToggleClaim={toggleClaim}
              />
            </dl>
            {typeof person.affiliationsSummary === 'string' && person.affiliationsSummary ? (
              <p className="muted">{person.affiliationsSummary}</p>
            ) : null}
          </SheetSection>

          <EnrichmentSuggestions personId={id} version={person.version} />

          <QualificationSection result={person.qualification} personUpdatedAt={person.updatedAt} />

          <OtherEvidence
            claims={person.claims}
            shownFields={['title', 'organizationId', 'email', 'location', 'linkedinUrl', 'xUrl']}
            openClaim={openClaim}
            onToggle={toggleClaim}
          />

          <SheetSection title="Notes and activity">
            <NoteForm entityType="person" entityId={id} />
            <PersonFollowupLine personId={id} />
            <Timeline activities={person.activities} prepareSend />
          </SheetSection>

          <SheetSection title="Opportunities" headerItems={<NewOpportunityAction onClick={() => setCreatingOpportunity(true)} />}>
            <OpportunityList opportunities={person.opportunities} />
          </SheetSection>

          <SheetSection title="Tasks">
            {person.tasks.length === 0 ? (
              <p className="muted">No tasks for this person.</p>
            ) : (
              <ul className="task-list">
                {person.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            )}
          </SheetSection>
          <p className="muted sheet__foot">Updated {formatAgo(person.updatedAt)}, version <span className="num">{person.version}</span></p>
        </>
      ) : null}
    </Sheet>
  );
}

export function OrganizationSheet({
  id,
  onClose,
  onOpenPerson,
}: {
  id: string;
  onClose: () => void;
  onOpenPerson: (id: string) => void;
}) {
  const query = useOrganization(id);
  const patch = usePatchOrganization();
  const navigate = useNavigate();
  const [creatingOpportunity, setCreatingOpportunity] = useState(false);
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const organization = query.data;
  useSelectedRecord(organization ? { kind: 'organization', id, label: organization.name } : null);

  const toggleClaim = (claimId: string) => setOpenClaim((current) => (current === claimId ? null : claimId));

  const saveField = (field: string) => async (value: string, versionOverride?: number) => {
    if (!organization) return;
    await patch.mutateAsync({
      id,
      expectedVersion: versionOverride ?? organization.version,
      fields: { [field]: value === '' ? null : value },
    });
    await query.refetch();
  };

  const saveAttribute = async (key: string, value: unknown, versionOverride?: number) => {
    if (!organization) return;
    await patch.mutateAsync({ id, expectedVersion: versionOverride ?? organization.version, fields: { [`attr:${key}`]: value } });
    await query.refetch();
  };

  if (creatingOpportunity && organization) {
    return (
      <NewOpportunitySheet
        prefill={{ organization: { id, name: organization.name } }}
        onClose={() => setCreatingOpportunity(false)}
        onCreated={(opportunityId) => navigate(`/pipeline?opportunity=${encodeURIComponent(opportunityId)}`)}
      />
    );
  }

  return (
    <Sheet
      title={organization?.name ?? 'Organization'}
      subtitle={organization ? [humanize(organization.kind), organization.domain].filter(Boolean).join(', ') : undefined}
      onClose={onClose}
    >
      {query.isPending ? <Loading what="organization" /> : null}
      {query.isError && isNotFound(query.error) ? <DeletedRecord onClose={onClose} /> : null}
      {query.isError && !isNotFound(query.error) ? (
        <ErrorState what="this organization" error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {organization ? (
        <>
          <SheetSection title="Fields" headerItems={<OrganizationEnrichControl organizationId={id} />}>
            <dl className="fields">
              <FieldRow label="Kind" openClaim={openClaim} onToggleClaim={toggleClaim}>
                <span>{humanize(organization.kind)}</span>
              </FieldRow>
              <FieldRow label="Domain" claims={claimsForField(organization.claims, 'domain')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue
                  label="Domain"
                  field="domain"
                  value={organization.domain ?? null}
                  save={saveField('domain')}
                  onReload={() => query.refetch()}
                  renderValue={(value) => <DomainLink value={value} />}
                />
              </FieldRow>
              <FieldRow label="Location" claims={claimsForField(organization.claims, 'location')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue label="Location" field="location" value={organization.location} save={saveField('location')} onReload={() => query.refetch()} />
              </FieldRow>
              <FieldRow label="LinkedIn" claims={claimsForField(organization.claims, 'linkedinUrl')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue
                  label="LinkedIn"
                  field="linkedinUrl"
                  value={organization.linkedinUrl ?? null}
                  save={saveField('linkedinUrl')}
                  onReload={() => query.refetch()}
                  renderValue={(value) => <ProfileLink value={value} />}
                />
              </FieldRow>
              <FieldRow label="Tags" openClaim={openClaim} onToggleClaim={toggleClaim}>
                {organization.tags.length > 0 ? (
                  <span className="tag-row">
                    {organization.tags.map((tag) => (
                      <Chip key={tag}>{tag}</Chip>
                    ))}
                  </span>
                ) : (
                  <span className="muted">None</span>
                )}
              </FieldRow>
              <AttributeRows
                attributes={organization.attributes}
                save={saveAttribute}
                onReload={() => query.refetch()}
                openClaim={openClaim}
                onToggleClaim={toggleClaim}
              />
            </dl>
          </SheetSection>

          <OrganizationEnrichmentSuggestions organizationId={id} version={organization.version} />

          <OtherEvidence
            claims={organization.claims}
            shownFields={['domain', 'location', 'linkedinUrl']}
            openClaim={openClaim}
            onToggle={toggleClaim}
          />

          <SheetSection title="People">
            {organization.people.length === 0 ? (
              <p className="muted">No people are linked to this organization.</p>
            ) : (
              <ul className="plain-list">
                {organization.people.map((person) => (
                  <li key={person.id} className="plain-list__row">
                    <button type="button" className="link link--button" onClick={() => onOpenPerson(person.id)}>
                      {personName(person)}
                    </button>
                    <span className="muted">{person.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </SheetSection>

          <SheetSection title="Notes and activity">
            <NoteForm entityType="organization" entityId={id} />
            <Timeline activities={organization.activities} />
          </SheetSection>

          <SheetSection title="Opportunities" headerItems={<NewOpportunityAction onClick={() => setCreatingOpportunity(true)} />}>
            <OpportunityList opportunities={organization.opportunities} />
          </SheetSection>
          <p className="muted sheet__foot">
            Updated {formatAgo(organization.updatedAt)}, version <span className="num">{organization.version}</span>
          </p>
        </>
      ) : null}
    </Sheet>
  );
}
