import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './client';
import { useEventConnection } from './events';
import type {
  AgentMessageInput,
  ApifyRunInput,
  CsvImportInput,
  DraftOutreachInput,
  Opportunity,
  QualificationConfig,
  StageSendInput,
} from './types';
import { isRunActive } from '../lib/format';
import { useUI } from '../lib/ui';

const PAGE_SIZE = 200;

export function useWorkspace() {
  return useQuery({ queryKey: ['workspace'], queryFn: api.workspace, staleTime: 60_000 });
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.health });
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

export function usePeople(q: string, sort: PeopleSort = 'default') {
  return useInfiniteQuery({
    queryKey: ['people', q, sort],
    queryFn: ({ pageParam }) =>
      api.people.list({ q, sort: sort === 'fit' ? 'fit' : undefined, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function useOrganizations(q: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['organizations', q],
    queryFn: ({ pageParam }) => api.organizations.list({ q, cursor: pageParam, limit: PAGE_SIZE }),
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

export function useConnectors() {
  return useQuery({ queryKey: ['connectors'], queryFn: api.connectors.list });
}

export function useApifyConnector() {
  const query = useConnectors();
  const connector = query.data?.find((entry) => entry.kind === 'apify') ?? null;
  return { query, connector };
}

export function useSaveApifyConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { token?: string; allowlist?: string[] }) => api.connectors.saveApify(input),
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

export function useAnthropicConnector() {
  const query = useConnectors();
  const connector = query.data?.find((entry) => entry.kind === 'anthropic') ?? null;
  return { query, connector };
}

export function useSaveAnthropicConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { token?: string; model?: string }) => api.connectors.saveAnthropic(input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
  });
}

export function useRemoveAnthropicConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.connectors.removeAnthropic(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['run'] });
      void queryClient.invalidateQueries({ queryKey: ['today'] });
    },
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
    },
  });
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
  | { state: 'ready'; inboxEmail: string | null }
  | { state: 'blocked'; message: string; settingsLink: boolean };

// Whether a send can be prepared: AgentMail connected, healthy, with a sending inbox chosen.
export function useMailReadiness(): MailReadiness {
  const { query, connector } = useAgentMailConnector();
  if (query.isPending) return { state: 'loading' };
  if (query.isError) {
    return { state: 'blocked', message: 'Could not check the AgentMail connection, so sending cannot be prepared.', settingsLink: false };
  }
  if (!connector) {
    return { state: 'blocked', message: 'AgentMail is not connected, so nothing can be prepared for sending.', settingsLink: true };
  }
  if (connector.status === 'error') {
    return {
      state: 'blocked',
      message: 'The AgentMail connection has an error, so nothing can be prepared for sending.',
      settingsLink: true,
    };
  }
  if (!connector.inboxId) {
    return { state: 'blocked', message: 'AgentMail has no sending inbox selected.', settingsLink: true };
  }
  return { state: 'ready', inboxEmail: connector.inboxEmail };
}

export function useSendIntents() {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['send-intents', 'all'],
    queryFn: () => api.mail.intents(),
    refetchInterval: connection === 'open' ? false : 5000,
  });
}

export function useMailSummary() {
  const connection = useEventConnection();
  return useQuery({
    queryKey: ['mail-summary'],
    queryFn: api.mail.summary,
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
