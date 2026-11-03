import { useEffect, useState } from 'react';
import type { Claim } from '../api/types';
import { useOrganization, usePatchOrganization, usePatchPerson, usePerson } from '../api/hooks';
import { ErrorState, Loading, Sheet } from '../components/common';
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
} from '../components/record';
import { Chip } from '../components/common';
import { PersonFollowupLine } from '../components/followups';
import { QualificationSection } from '../components/qualification';
import { describeDue, formatAgo, humanize, personName } from '../lib/format';
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

  const due = person?.nextActionAt ? describeDue(person.nextActionAt) : null;

  return (
    <Sheet
      title={name}
      subtitle={person ? [person.title, person.organization?.name].filter(Boolean).join(' at ') : undefined}
      onClose={onClose}
    >
      {query.isPending ? <Loading what="person" /> : null}
      {query.isError ? <ErrorState what="this person" error={query.error} onRetry={() => void query.refetch()} /> : null}
      {person ? (
        <>
          <SheetSection title="Fields">
            <dl className="fields">
              <FieldRow label="Title" claims={claimsForField(person.claims, 'title')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue label="Title" field="title" value={person.title} save={saveField('title')} onReload={() => query.refetch()} />
              </FieldRow>
              <FieldRow label="Organization" claims={claimsForField(person.claims, 'organizationId')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                {person.organization ? (
                  <button type="button" className="link link--button" onClick={() => onOpenOrganization(person.organization!.id)}>
                    {person.organization.name}
                  </button>
                ) : (
                  <span className="muted">None</span>
                )}
              </FieldRow>
              <FieldRow label="Email" claims={claimsForField(person.claims, 'email')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <span className={person.email ? '' : 'muted'}>{person.email || 'Not set'}</span>
              </FieldRow>
              <FieldRow label="Location" claims={claimsForField(person.claims, 'location')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue label="Location" field="location" value={person.location} save={saveField('location')} onReload={() => query.refetch()} />
              </FieldRow>
              <FieldRow label="Next action" openClaim={openClaim} onToggleClaim={toggleClaim}>
                <span className={due?.overdue ? 'is-overdue' : due ? '' : 'muted'}>{due ? due.text : 'Not set'}</span>
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
            </dl>
            {typeof person.affiliationsSummary === 'string' && person.affiliationsSummary ? (
              <p className="muted">{person.affiliationsSummary}</p>
            ) : null}
          </SheetSection>

          <QualificationSection result={person.qualification} personUpdatedAt={person.updatedAt} />

          <OtherEvidence
            claims={person.claims}
            shownFields={['title', 'organizationId', 'email', 'location']}
            openClaim={openClaim}
            onToggle={toggleClaim}
          />

          <SheetSection title="Opportunities">
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

          <SheetSection title="Activity">
            <PersonFollowupLine personId={id} />
            <NoteForm entityType="person" entityId={id} />
            <Timeline activities={person.activities} prepareSend />
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

  return (
    <Sheet
      title={organization?.name ?? 'Organization'}
      subtitle={organization ? [humanize(organization.kind), organization.domain].filter(Boolean).join(', ') : undefined}
      onClose={onClose}
    >
      {query.isPending ? <Loading what="organization" /> : null}
      {query.isError ? <ErrorState what="this organization" error={query.error} onRetry={() => void query.refetch()} /> : null}
      {organization ? (
        <>
          <SheetSection title="Fields">
            <dl className="fields">
              <FieldRow label="Kind" openClaim={openClaim} onToggleClaim={toggleClaim}>
                <span>{humanize(organization.kind)}</span>
              </FieldRow>
              <FieldRow label="Domain" claims={claimsForField(organization.claims, 'domain')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <span className={organization.domain ? '' : 'muted'}>{organization.domain || 'Not set'}</span>
              </FieldRow>
              <FieldRow label="Location" claims={claimsForField(organization.claims, 'location')} openClaim={openClaim} onToggleClaim={toggleClaim}>
                <EditableValue label="Location" field="location" value={organization.location} save={saveField('location')} onReload={() => query.refetch()} />
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
            </dl>
          </SheetSection>

          <OtherEvidence
            claims={organization.claims}
            shownFields={['domain', 'location']}
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

          <SheetSection title="Opportunities">
            <OpportunityList opportunities={organization.opportunities} />
          </SheetSection>

          <SheetSection title="Activity">
            <NoteForm entityType="organization" entityId={id} />
            <Timeline activities={organization.activities} />
          </SheetSection>
          <p className="muted sheet__foot">
            Updated {formatAgo(organization.updatedAt)}, version <span className="num">{organization.version}</span>
          </p>
        </>
      ) : null}
    </Sheet>
  );
}
