import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, api, type NewOpportunityInput, type NewPersonInput } from './client';
import { useEventConnection } from './events';
import type {
  MergeInput,
  AttributeEntityType,
  AutomationFields,
  AutomationInput,
  SequenceFields,
  SequenceInput,
  ViewScreen,
  AttributeKind,
  Lifecycle,
  AcceptEnrichmentInput,
  AcceptOrganizationEnrichmentInput,
  AgentMessageInput,
  ApifyConnectorInput,
  ApifyRunInput,
  CsvImportInput,
  MailboxCaptureInput,
  MeetingFilters,
  NewMeetingInput,
  TranscriptCaptureInput,
  DraftOutreachInput,
  GmailCredentialsInput,
  ImportSettings,
  MicrosoftCredentialsInput,
  ImapConnectorInput,
  LeadCaptureInput,
  MailProviderKind,
  ModelProviderInput,
  ModelProviderKind,
  Opportunity,
  QualificationConfig,
  StageSendInput,
  TemplateSwitchInput,
} from './types';
import { isRunActive } from '../lib/format';
import { mailProviderName } from '../lib/mail';
import { useUI } from '../lib/ui';

const PAGE_SIZE = 200;

export function useWorkspace() {
  return useQuery({ queryKey: ['workspace'], queryFn: api.workspace, staleTime: 60_000 });
}

export function useTemplates() {
  return useQuery({ queryKey: ['templates'], queryFn: api.templates, staleTime: 60_000 });
}

// Opportunity counts per stage id for one pipeline, across every status.
export function useStageCounts(pipelineId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['stage-counts', pipelineId ?? ''],
    queryFn: () => api.opportunities.countByStage(pipelineId as string),
    enabled: enabled && Boolean(pipelineId),
    staleTime: 0,
  });
}

const PIPELINE_KEYS = ['pipelines', 'opportunities', 'stage-counts'];

function invalidateKeys(queryClient: ReturnType<typeof useQueryClient>, keys: string[]) {
  for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
}

export function useCreatePipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; template: string }) => api.createPipeline(input),
    // Waiting for the reload lets the caller switch the board to the new pipeline once it is in the cache.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
  });
}

export function useRenamePipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; name: string }) =>
      api.renamePipeline(input.id, input.expectedVersion, input.name),
    onSuccess: () => invalidateKeys(queryClient, PIPELINE_KEYS),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'version_conflict') invalidateKeys(queryClient, ['pipelines']);
    },
  });
}

export function useDeletePipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePipeline(id),
    onSuccess: () => invalidateKeys(queryClient, PIPELINE_KEYS),
    // A refused delete usually means the deal count moved, so the counts reload.
    onError: () => invalidateKeys(queryClient, ['pipelines', 'stage-counts']),
  });
}

export function useSwitchTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TemplateSwitchInput) => api.switchTemplate(input),
    onSuccess: () => {
      invalidateKeys(queryClient, [
        'pipelines',
        'opportunities',
        'stage-counts',
        'qualification',
        'activities',
        'people',
        'person',
        'today',
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        invalidateKeys(queryClient, ['pipelines', 'opportunities', 'stage-counts']);
      }
    },
  });
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.health });
}

// Reports are computed live on the server and never written to, so there is nothing to invalidate. A short stale
// time keeps a period switch back and forth from refetching.
export function useReports(days: number | null, pipelineId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['reports', days, pipelineId ?? ''],
    queryFn: () => api.reports(days, pipelineId),
    enabled,
    staleTime: 15_000,
  });
}

export function useToday() {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['today'],
    queryFn: api.today,
    refetchInterval: connection === 'open' ? false : 5000,
  });
}

export type PeopleSort = 'default' | 'fit';

export function usePeople(q: string, sort: PeopleSort = 'default', lifecycle?: Lifecycle, list?: string) {
  return useInfiniteQuery({
    queryKey: ['people', q, sort, lifecycle ?? 'all', list ?? 'all'],
    queryFn: ({ pageParam }) =>
      api.people.list({ q, sort: sort === 'fit' ? 'fit' : undefined, lifecycle, list, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function useOrganizations(q: string, enabled = true, lifecycle?: Lifecycle) {
  return useInfiniteQuery({
    queryKey: ['organizations', q, lifecycle ?? 'all'],
    queryFn: ({ pageParam }) => api.organizations.list({ q, lifecycle, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function usePerson(id: string | null) {
  return useQuery({
    queryKey: ['person', id],
    queryFn: () => api.people.get(id as string),
    enabled: Boolean(id),
  });
}

// The person's newest enrich run and its pending suggestions. Server events refetch it; a dropped
// event stream falls back to polling while a run is open.
export function usePersonEnrichment(id: string | null) {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['enrichment', id],
    queryFn: () => api.people.enrichment(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return connection !== 'open' && status && isRunActive(status) ? 5000 : false;
    },
  });
}

export function useStartEnrichPerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personId: string) => api.runs.startEnrichPerson(personId),
    // Returning the enrichment refetch keeps the mutation pending until the next enrichment read lands,
    // so the Enrich button stays disabled from the click until the open run shows up.
    onSuccess: (run, personId) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
      return queryClient.invalidateQueries({ queryKey: ['enrichment', personId] });
    },
  });
}

export function useAcceptEnrichment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptEnrichmentInput) =>
      api.people.acceptEnrichment(input.personId, { runId: input.runId, field: input.field, expectedVersion: input.expectedVersion }),
    // Returning the refetches keeps the mutation pending until the person and enrichment reads land, so a
    // fast second Accept cannot send the old expectedVersion.
    onSettled: async (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['person', input.personId] }),
        queryClient.invalidateQueries({ queryKey: ['enrichment', input.personId] }),
      ]);
    },
  });
}

export function useDismissEnrichment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { personId: string; runId: string }) => api.people.dismissEnrichment(input.personId, input.runId),
    onSettled: async (_data, _error, input) => {
      await queryClient.invalidateQueries({ queryKey: ['enrichment', input.personId] });
    },
  });
}

// The organization's newest enrich run and its pending suggestions, refetched like the person one.
// The key carries 'organization' so a person id and an organization id can never share a cache entry.
export function useOrganizationEnrichment(id: string | null) {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['enrichment', 'organization', id],
    queryFn: () => api.organizations.enrichment(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return connection !== 'open' && status && isRunActive(status) ? 5000 : false;
    },
  });
}

export function useStartEnrichOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) => api.runs.startEnrichOrganization(organizationId),
    // Same as the person one: the mutation stays pending until the next enrichment read lands.
    onSuccess: (run, organizationId) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
      return queryClient.invalidateQueries({ queryKey: ['enrichment', 'organization', organizationId] });
    },
  });
}

export function useAcceptOrganizationEnrichment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptOrganizationEnrichmentInput) =>
      api.organizations.acceptEnrichment(input.organizationId, { runId: input.runId, field: input.field, expectedVersion: input.expectedVersion }),
    // Returning the refetches keeps the mutation pending until the organization and enrichment reads land.
    onSettled: async (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['organization', input.organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['enrichment', 'organization', input.organizationId] }),
      ]);
    },
  });
}

export function useDismissOrganizationEnrichment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { organizationId: string; runId: string }) =>
      api.organizations.dismissEnrichment(input.organizationId, input.runId),
    onSettled: async (_data, _error, input) => {
      await queryClient.invalidateQueries({ queryKey: ['enrichment', 'organization', input.organizationId] });
    },
  });
}

export function useOrganization(id: string | null) {
  return useQuery({
    queryKey: ['organization', id],
    queryFn: () => api.organizations.get(id as string),
    enabled: Boolean(id),
  });
}

export function usePipelines() {
  return useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
}

export function useAttributeDefs(entityType: AttributeEntityType) {
  return useQuery({ queryKey: ['attributes', entityType], queryFn: () => api.attributes.list(entityType) });
}

// Definition changes show in Settings and on every open sheet (a rename shows in the row label, a delete removes the row).
const ATTRIBUTE_KEYS = ['attributes', 'person', 'organization'];

export function useCreateAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityType: AttributeEntityType; label: string; kind: AttributeKind; description?: string }) =>
      api.attributes.create(input),
    onSuccess: () => invalidateKeys(queryClient, ATTRIBUTE_KEYS),
  });
}

export function useUpdateAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; fields: { label?: string; description?: string | null } }) =>
      api.attributes.update(input.id, input.expectedVersion, input.fields),
    onSuccess: () => invalidateKeys(queryClient, ATTRIBUTE_KEYS),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'version_conflict') invalidateKeys(queryClient, ['attributes']);
    },
  });
}

export function useDeleteAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.attributes.remove(id),
    onSuccess: () => invalidateKeys(queryClient, ATTRIBUTE_KEYS),
    // A refused delete usually means the definition changed underneath, so the list reloads.
    onError: () => invalidateKeys(queryClient, ['attributes']),
  });
}

export function useSequences() {
  return useQuery({ queryKey: ['sequences'], queryFn: api.sequences.list });
}

export function useCreateSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SequenceInput) => api.sequences.create(input),
    onSuccess: () => invalidateKeys(queryClient, ['sequences']),
  });
}

export function useUpdateSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; fields: SequenceFields }) =>
      api.sequences.update(input.id, input.expectedVersion, input.fields),
    onSuccess: () => invalidateKeys(queryClient, ['sequences']),
    onError: () => invalidateKeys(queryClient, ['sequences']),
  });
}

export function useDeleteSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.sequences.remove(id),
    onSuccess: () => invalidateKeys(queryClient, ['sequences']),
    onError: () => invalidateKeys(queryClient, ['sequences']),
  });
}

export function useViews(screen: ViewScreen) {
  return useQuery({ queryKey: ['views', screen], queryFn: () => api.views.list(screen) });
}

export function useCreateView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; screen: ViewScreen; config: Record<string, string> }) => api.views.create(input),
    onSuccess: () => invalidateKeys(queryClient, ['views']),
  });
}

export function useRenameView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; name: string }) =>
      api.views.update(input.id, input.expectedVersion, { name: input.name }),
    onSuccess: () => invalidateKeys(queryClient, ['views']),
    onError: () => invalidateKeys(queryClient, ['views']),
  });
}

export function useDeleteView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.views.remove(id),
    onSuccess: () => invalidateKeys(queryClient, ['views']),
    onError: () => invalidateKeys(queryClient, ['views']),
  });
}

export function useAutomations() {
  return useQuery({ queryKey: ['automations'], queryFn: api.automations.list });
}

// A rule's tasks arrive through the usual task refetch on record_updated, so only the list itself reloads here.
export function useCreateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomationInput) => api.automations.create(input),
    onSuccess: () => invalidateKeys(queryClient, ['automations']),
  });
}

export function useUpdateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; fields: AutomationFields }) =>
      api.automations.update(input.id, input.expectedVersion, input.fields),
    onSuccess: () => invalidateKeys(queryClient, ['automations']),
    onError: () => invalidateKeys(queryClient, ['automations']),
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.automations.remove(id),
    onSuccess: () => invalidateKeys(queryClient, ['automations']),
    onError: () => invalidateKeys(queryClient, ['automations']),
  });
}

export function useDuplicates() {
  return useQuery({ queryKey: ['duplicates'], queryFn: api.duplicates.list });
}

export function useDismissDuplicate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personIds: [string, string]) => api.duplicates.dismiss(personIds),
    onSuccess: () => invalidateKeys(queryClient, ['duplicates']),
    // A refused dismiss usually means a person is gone, so the list reloads.
    onError: () => invalidateKeys(queryClient, ['duplicates']),
  });
}

// A merge moves records between people and deletes one, so every view that shows people or their records reloads.
const MERGE_KEYS = ['duplicates', 'people', 'person', 'organizations', 'organization', 'opportunities', 'opportunity', 'tasks', 'activities', 'lists', 'today', 'search'];

export function useMergePeople() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeInput) => api.duplicates.merge(input),
    onSuccess: () => invalidateKeys(queryClient, MERGE_KEYS),
    onError: () => invalidateKeys(queryClient, ['duplicates']),
  });
}

export function useOrganizationDuplicates() {
  return useQuery({ queryKey: ['duplicates', 'organizations'], queryFn: api.duplicates.listOrganizations });
}

export function useDismissOrganizationDuplicate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (organizationIds: [string, string]) => api.duplicates.dismissOrganization(organizationIds),
    onSuccess: () => invalidateKeys(queryClient, ['duplicates']),
    // A refused dismiss usually means an organization is gone, so the list reloads.
    onError: () => invalidateKeys(queryClient, ['duplicates']),
  });
}

// Same keys as a person merge: the organization's people, deals, tasks, and activities move to the survivor.
export function useMergeOrganizations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeInput) => api.duplicates.mergeOrganizations(input),
    onSuccess: () => invalidateKeys(queryClient, MERGE_KEYS),
    onError: () => invalidateKeys(queryClient, ['duplicates']),
  });
}

export function useLists() {
  return useQuery({ queryKey: ['lists'], queryFn: api.lists.list });
}

// Membership and list changes show in the list select (counts), the people tables, and open person sheets.
const LIST_KEYS = ['lists', 'people', 'person'];

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.lists.create(name),
    // Waiting for the reload lets the caller pick the new list once it is in the cache.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['lists'] }),
  });
}

export function useRenameList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; name: string }) =>
      api.lists.rename(input.id, input.expectedVersion, input.name),
    onSuccess: () => invalidateKeys(queryClient, LIST_KEYS),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'version_conflict') invalidateKeys(queryClient, ['lists']);
    },
  });
}

export function useDeleteList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.lists.remove(id),
    onSuccess: () => invalidateKeys(queryClient, LIST_KEYS),
    onError: () => invalidateKeys(queryClient, ['lists']),
  });
}

export function useAddListMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { listId: string; personIds: string[] }) => api.lists.addMembers(input.listId, input.personIds),
    onSuccess: () => invalidateKeys(queryClient, LIST_KEYS),
    // A refused add usually means a person or the list is gone, so the lists reload.
    onError: () => invalidateKeys(queryClient, ['lists']),
  });
}

export function useRemoveListMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { listId: string; personId: string }) => api.lists.removeMember(input.listId, input.personId),
    onSuccess: () => invalidateKeys(queryClient, LIST_KEYS),
    onError: () => invalidateKeys(queryClient, ['lists']),
  });
}

export function useRemoveListMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { listId: string; personIds: string[] }) => api.lists.removeMembers(input.listId, input.personIds),
    onSettled: () => invalidateKeys(queryClient, LIST_KEYS),
  });
}

// Meeting changes show in the Meetings screen, the Today card, and open meeting sheets.
const MEETING_KEYS = ['meetings', 'meeting'];

export function useMeetings(filters: MeetingFilters = {}) {
  return useQuery({
    queryKey: ['meetings', filters.from ?? '', filters.to ?? '', filters.organizationId ?? '', filters.personId ?? '', filters.limit ?? '', filters.order ?? ''],
    queryFn: () => api.meetings.list(filters),
    placeholderData: keepPreviousData,
  });
}

export function useMeeting(id: string | null) {
  return useQuery({
    queryKey: ['meeting', id],
    queryFn: () => api.meetings.get(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewMeetingInput) => api.meetings.create(input),
    onSuccess: (meeting) => {
      queryClient.setQueryData(['meeting', meeting.id], meeting);
      invalidateKeys(queryClient, MEETING_KEYS);
    },
  });
}

export function useUpdateMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; fields: Record<string, unknown> }) =>
      api.meetings.patch(input.id, input.expectedVersion, input.fields),
    onSuccess: (meeting) => {
      queryClient.setQueryData(['meeting', meeting.id], meeting);
      invalidateKeys(queryClient, MEETING_KEYS);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'version_conflict') invalidateKeys(queryClient, MEETING_KEYS);
    },
  });
}

export function useDeleteMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.meetings.remove(id),
    onSuccess: () => invalidateKeys(queryClient, MEETING_KEYS),
    onError: () => invalidateKeys(queryClient, MEETING_KEYS),
  });
}

export function useAddMeetingAttendee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { meetingId: string; personId: string }) => api.meetings.addAttendee(input.meetingId, input.personId),
    onSuccess: (meeting) => {
      queryClient.setQueryData(['meeting', meeting.id], meeting);
      invalidateKeys(queryClient, MEETING_KEYS);
    },
    onError: () => invalidateKeys(queryClient, MEETING_KEYS),
  });
}

export function useRemoveMeetingAttendee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { meetingId: string; personId: string }) => api.meetings.removeAttendee(input.meetingId, input.personId),
    onSuccess: (meeting) => {
      queryClient.setQueryData(['meeting', meeting.id], meeting);
      invalidateKeys(queryClient, MEETING_KEYS);
    },
    onError: () => invalidateKeys(queryClient, MEETING_KEYS),
  });
}

export function useOpportunities(params: { pipelineId?: string; status?: string }) {
  return useQuery({
    queryKey: ['opportunities', params.pipelineId ?? '', params.status ?? ''],
    queryFn: () => api.opportunities.list(params),
    enabled: Boolean(params.pipelineId),
    placeholderData: keepPreviousData,
  });
}

export function useActivities(entityType: string, entityId: string | null) {
  return useQuery({
    queryKey: ['activities', entityType, entityId],
    queryFn: () => api.activities.list(entityType, entityId as string),
    enabled: Boolean(entityId),
  });
}

export function useRuns() {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['runs', ''],
    queryFn: () => api.runs.list(),
    refetchInterval: connection === 'open' ? false : 5000,
  });
}

export function useRun(id: string | null) {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['run', id],
    queryFn: () => api.runs.get(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return connection !== 'open' && status && isRunActive(status) ? 3000 : false;
    },
  });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.search(q, signal),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

export function usePatchPerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; fields: Record<string, unknown> }) =>
      api.people.patch(input.id, input.expectedVersion, input.fields),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      void queryClient.invalidateQueries({ queryKey: ['person', input.id] });
      // An organization counts as a relationship when one of its people is, so a lifecycle change can move it.
      if ('lifecycle' in input.fields) void queryClient.invalidateQueries({ queryKey: ['organizations'] });
      // Linking or unlinking changes the people list on both organization sheets.
      if ('organizationId' in input.fields) {
        void queryClient.invalidateQueries({ queryKey: ['organizations'] });
        void queryClient.invalidateQueries({ queryKey: ['organization'] });
        void queryClient.invalidateQueries({ queryKey: ['search'] });
      }
    },
  });
}

export function useCreatePerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewPersonInput) => api.people.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.organizations.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });
}

export function usePatchOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; fields: Record<string, unknown> }) =>
      api.organizations.patch(input.id, input.expectedVersion, input.fields),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
      void queryClient.invalidateQueries({ queryKey: ['organization', input.id] });
    },
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityType: string; entityId: string; body: string }) =>
      api.activities.createNote(input.entityType, input.entityId, input.body),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ['person', input.entityId] });
      void queryClient.invalidateQueries({ queryKey: ['organization', input.entityId] });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
  });
}

export function useCompleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number }) =>
      api.tasks.patch(input.id, input.expectedVersion, { status: 'done' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['today'] });
      void queryClient.invalidateQueries({ queryKey: ['person'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useMoveStage() {
  const queryClient = useQueryClient();
  const { pushToast } = useUI();
  return useMutation({
    mutationFn: (input: { opportunity: Opportunity; stageId: string; stageName: string }) =>
      api.opportunities.moveStage(input.opportunity.id, input.stageId, input.opportunity.version),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ['opportunities'] });
      const snapshots = queryClient.getQueriesData<Opportunity[]>({ queryKey: ['opportunities'] });
      queryClient.setQueriesData<Opportunity[]>({ queryKey: ['opportunities'] }, (current) =>
        current?.map((item) =>
          item.id === input.opportunity.id ? { ...item, stageId: input.stageId, version: item.version + 1 } : item,
        ),
      );
      return { snapshots };
    },
    onError: (error, input, context) => {
      for (const [key, data] of context?.snapshots ?? []) queryClient.setQueryData(key, data);
      const reason = error instanceof Error ? error.message : 'The server rejected the move.';
      pushToast(
        `Could not move ${input.opportunity.name} to ${input.stageName}. It is back in its previous stage. ${reason}`,
        'error',
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['opportunities'] });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
  });
}

export function useCreateOpportunity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewOpportunityInput) => api.opportunities.create(input),
    // Returning the refetches keeps the mutation pending until the pipeline and the linked records have reloaded, so the
    // button stays disabled and the new opportunity is already in the cache when its sheet opens. A linked person may
    // have been promoted to a relationship, so the people and organization lists reload too.
    onSuccess: async (opportunity, input) => {
      const personId = opportunity.personId ?? input.personId;
      const organizationId = opportunity.organizationId ?? input.organizationId;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['stage-counts'] }),
        queryClient.invalidateQueries({ queryKey: ['activities'] }),
        queryClient.invalidateQueries({ queryKey: ['today'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
        queryClient.invalidateQueries({ queryKey: ['people'] }),
        queryClient.invalidateQueries({ queryKey: ['organizations'] }),
        personId ? queryClient.invalidateQueries({ queryKey: ['person', personId] }) : Promise.resolve(),
        organizationId ? queryClient.invalidateQueries({ queryKey: ['organization', organizationId] }) : Promise.resolve(),
      ]);
    },
  });
}

export function usePatchOpportunity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; fields: Record<string, unknown> }) =>
      api.opportunities.patch(input.id, input.expectedVersion, input.fields),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['opportunities'] });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
      void queryClient.invalidateQueries({ queryKey: ['person'] });
      void queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
  });
}

export function useStartRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.runs.start(),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useControlRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'pause' | 'resume' | 'cancel' }) =>
      api.runs.control(input.id, input.action),
    onSettled: (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ['run', input.id] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useDecideApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      api.approvals.decide(input.id, input.decision),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
      void queryClient.invalidateQueries({ queryKey: ['run'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
      void queryClient.invalidateQueries({ queryKey: ['import'] });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      void queryClient.invalidateQueries({ queryKey: ['person'] });
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
}

export function useAgentMessage() {
  return useMutation({ mutationFn: (input: AgentMessageInput) => api.agentMessage(input) });
}

export function useConnectors(options: { refetchInterval?: number | false } = {}) {
  return useQuery({ queryKey: ['connectors'], queryFn: api.connectors.list, refetchInterval: options.refetchInterval ?? false });
}

export function useApifyConnector() {
  const query = useConnectors();
  const connector = query.data?.find((entry) => entry.kind === 'apify') ?? null;
  return { query, connector };
}

export function useSaveApifyConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApifyConnectorInput) => api.connectors.saveApify(input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.invalidateQueries({ queryKey: ['apify-actors'] });
      void queryClient.invalidateQueries({ queryKey: ['apify-actor'] });
    },
  });
}

export function useRemoveApifyConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.connectors.removeApify(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.removeQueries({ queryKey: ['apify-actors'] });
      void queryClient.removeQueries({ queryKey: ['apify-actor'] });
    },
  });
}

export function useCaptureSettings() {
  return useQuery({ queryKey: ['capture-settings'], queryFn: () => api.capture.settings() });
}

export function useGenerateCaptureToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.capture.generateToken(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['capture-settings'] }),
  });
}

export function useRemoveCaptureToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.capture.removeToken(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['capture-settings'] }),
  });
}

export function useModelConnector(kind: ModelProviderKind) {
  const query = useConnectors();
  const connector = query.data?.find((entry) => entry.kind === kind) ?? null;
  return { query, connector };
}

// The provider chat and drafting use, or null when none is configured.
export function useModelProvider() {
  return useQuery({ queryKey: ['model-provider'], queryFn: api.modelProvider.get });
}

export function useSetModelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: ModelProviderKind) => api.modelProvider.set(kind),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['model-provider'] });
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
  });
}

export function useSaveModelConnector(kind: ModelProviderKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ModelProviderInput) => api.connectors.saveModelProvider(kind, input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.invalidateQueries({ queryKey: ['model-provider'] });
    },
  });
}

export function useRemoveModelConnector(kind: ModelProviderKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.connectors.removeModelProvider(kind),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.invalidateQueries({ queryKey: ['model-provider'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['run'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
      if (kind === 'ollama') void queryClient.removeQueries({ queryKey: ['ollama-models'] });
    },
  });
}

// Installed models on the configured local server. Fetch on demand with refetch(), or automatically once enabled.
export function useOllamaModels(enabled: boolean) {
  return useQuery({
    queryKey: ['ollama-models'],
    queryFn: api.connectors.ollamaModels,
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export function useStartDraftOutreach() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DraftOutreachInput) => api.runs.startDraftOutreach(input),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useApifyActorSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['apify-actors', q],
    queryFn: ({ signal }) => api.apify.searchActors(q, signal),
    enabled: enabled && q.length > 0,
    staleTime: 60_000,
    retry: false,
  });
}

export function useApifyActor(id: string | null) {
  return useQuery({
    queryKey: ['apify-actor', id],
    queryFn: ({ signal }) => api.apify.actor(id as string, signal),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useStartApifyRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApifyRunInput) => api.runs.startApify(input),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useStartLeadCapture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadCaptureInput) => api.runs.startLeadCapture(input),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useImportBatch(id: string | null, status: string | null) {
  const connection = useEventConnection();
  return useInfiniteQuery({
    queryKey: ['import', id, status ?? 'all'],
    queryFn: ({ pageParam }) =>
      api.imports.get(id as string, { cursor: pageParam, limit: 50, status: status ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    refetchInterval: connection === 'open' ? false : 5000,
  });
}

export function useCsvPreview() {
  return useMutation({
    mutationFn: (input: { fileName: string; content: string }) => api.imports.csvPreview(input),
  });
}

export function useStageCsv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CsvImportInput) => api.imports.csvStage(input),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useStageMailbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MailboxCaptureInput) => api.imports.mailboxStage(input),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useStartTranscriptCapture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TranscriptCaptureInput) => api.imports.transcriptStage(input),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useImportSettings() {
  return useQuery({ queryKey: ['import-settings'], queryFn: api.importSettings.get });
}

// The toggle shows the saved value, so it updates when the server confirms, not before.
export function useSaveImportSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportSettings) => api.importSettings.put(input),
    onSuccess: (saved) => {
      queryClient.setQueryData(['import-settings'], saved);
    },
  });
}

export function useQualification() {
  return useQuery({ queryKey: ['qualification'], queryFn: api.qualification.get });
}

export function useSaveQualification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: QualificationConfig) => api.qualification.put(config),
    onSuccess: (saved) => {
      queryClient.setQueryData(['qualification'], saved);
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      void queryClient.invalidateQueries({ queryKey: ['person'] });
    },
  });
}

export function useQualifyRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scope: { tag?: string } = {}) => api.runs.startQualify(scope),
    onSuccess: (run) => {
      queryClient.setQueryData(['run', run.id], run);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useAgentMailConnector() {
  const query = useConnectors();
  const connector = query.data?.find((entry) => entry.kind === 'agentmail') ?? null;
  return { query, connector };
}

export function useSaveAgentMailConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { token?: string; inboxId?: string; inboxEmail?: string }) =>
      api.connectors.saveAgentMail(input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-inboxes'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-provider'] });
    },
  });
}

export function useRemoveAgentMailConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.connectors.removeAgentMail(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.removeQueries({ queryKey: ['mail-inboxes'] });
      void queryClient.invalidateQueries({ queryKey: ['send-intents'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-provider'] });
    },
  });
}

// Which mail connector sending and inbound sync use. Null when none is configured.
export function useMailProvider() {
  return useQuery({ queryKey: ['mail-provider'], queryFn: api.mailProvider.get });
}

export function useSetMailProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: MailProviderKind) => api.mailProvider.set(kind),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mail-provider'] });
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
    },
  });
}

// While `waiting`, the connector list refetches every few seconds so the card notices the sign in finishing in another tab.
export function useGmailConnector(waiting = false) {
  const query = useConnectors({ refetchInterval: waiting ? 3000 : false });
  const connector = query.data?.find((entry) => entry.kind === 'gmail') ?? null;
  return { query, connector };
}

function invalidateGmail(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['connectors'] });
  void queryClient.invalidateQueries({ queryKey: ['mail-provider'] });
  void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
}

export function useSaveGmailConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GmailCredentialsInput) => api.connectors.saveGmail(input),
    onSettled: () => invalidateGmail(queryClient),
  });
}

export function useStartGmailOAuth() {
  return useMutation({ mutationFn: () => api.connectors.startGmailOAuth() });
}

export function useRemoveGmailConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.connectors.removeGmail(),
    onSettled: () => {
      invalidateGmail(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['send-intents'] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

// Same waiting behavior as Gmail: refetch while a sign in is open in another tab.
export function useMicrosoftConnector(waiting = false) {
  const query = useConnectors({ refetchInterval: waiting ? 3000 : false });
  const connector = query.data?.find((entry) => entry.kind === 'microsoft') ?? null;
  return { query, connector };
}

export function useSaveMicrosoftConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MicrosoftCredentialsInput) => api.connectors.saveMicrosoft(input),
    onSettled: () => invalidateGmail(queryClient),
  });
}

export function useStartMicrosoftOAuth() {
  return useMutation({ mutationFn: () => api.connectors.startMicrosoftOAuth() });
}

export function useRemoveMicrosoftConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.connectors.removeMicrosoft(),
    onSettled: () => {
      invalidateGmail(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['send-intents'] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useImapConnector() {
  const query = useConnectors();
  const connector = query.data?.find((entry) => entry.kind === 'imap') ?? null;
  return { query, connector };
}

export function useSaveImapConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImapConnectorInput) => api.connectors.saveImap(input),
    onSettled: () => invalidateGmail(queryClient),
  });
}

export function useRemoveImapConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.connectors.removeImap(),
    onSettled: () => {
      invalidateGmail(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['send-intents'] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

// Maps a provider kind to the name people see. IMAP shows the preset's own name when it is known, so it needs the connector.
export function useMailProviderNamer(): (kind: string | null | undefined) => string {
  const { connector } = useImapConnector();
  const preset = connector?.imap?.preset ?? null;
  return (kind) => mailProviderName(kind, preset);
}

export function useMailInboxes(enabled: boolean) {
  return useQuery({
    queryKey: ['mail-inboxes'],
    queryFn: api.mail.inboxes,
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCreateMailInbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username?: string) => api.mail.createInbox(username),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mail-inboxes'] });
    },
  });
}

export type MailReadiness =
  | { state: 'loading' }
  | { state: 'ready'; inboxEmail: string | null; provider: string }
  | { state: 'blocked'; message: string; settingsLink: boolean };

// Whether a send can be prepared: a mail connector is in use, healthy, and has a sending address.
export function useMailReadiness(): MailReadiness {
  const query = useMailProvider();
  if (query.isPending) return { state: 'loading' };
  if (query.isError) {
    return { state: 'blocked', message: 'Could not check the sending connection, so sending cannot be prepared.', settingsLink: false };
  }
  const provider = query.data;
  if (!provider) {
    return { state: 'blocked', message: 'No sending connector is in use. Connect one in Settings.', settingsLink: true };
  }
  if (!provider.ready) {
    return {
      state: 'blocked',
      message: 'The sending connector in use is not ready, so nothing can be prepared for sending.',
      settingsLink: true,
    };
  }
  return { state: 'ready', inboxEmail: provider.address, provider: provider.kind };
}

export function useSendIntents(enabled = true) {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['send-intents', 'all'],
    queryFn: () => api.mail.intents(),
    enabled,
    refetchInterval: connection === 'open' ? false : 5000,
  });
}

export function useMailSummary(enabled = true) {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['mail-summary'],
    queryFn: api.mail.summary,
    enabled,
    refetchInterval: connection === 'open' ? false : 5000,
  });
}

export function useStageSend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StageSendInput) => api.mail.stage(input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
      void queryClient.invalidateQueries({ queryKey: ['run'] });
      void queryClient.invalidateQueries({ queryKey: ['send-intents'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
    },
  });
}

export function useControlSendIntent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'cancel' | 'acknowledge' }) =>
      api.mail.control(input.id, input.action),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['send-intents'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

// Follow-up rules, newest first. Omit status for every rule, pass "active" for waiting, armed, and sending.
export function useFollowupRules(params: { status?: string; personId?: string | null } = {}, enabled = true) {
  const connection = useEventConnection();
  const status = params.status;
  const personId = params.personId ?? undefined;
  return useQuery({
    queryKey: ['followup-rules', status ?? 'all', personId ?? 'any'],
    queryFn: () => api.followups.list({ status, personId }),
    enabled,
    refetchInterval: connection === 'open' ? false : 5000,
  });
}

export function useStopFollowupRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.followups.stop(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['followup-rules'] });
      void queryClient.invalidateQueries({ queryKey: ['send-intents'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useSuppressions() {
  return useQuery({ queryKey: ['suppressions'], queryFn: api.mail.suppressions });
}

export function useAddSuppression() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => api.mail.addSuppression(email),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });
}

export function useLiftSuppression() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.mail.liftSuppression(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['suppressions'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
    },
  });
}
