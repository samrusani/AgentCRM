import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './client';
import { useEventConnection } from './events';
import type { Opportunity } from './types';
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

export function usePeople(q: string) {
  return useInfiniteQuery({
    queryKey: ['people', q],
    queryFn: ({ pageParam }) => api.people.list({ q, cursor: pageParam, limit: PAGE_SIZE }),
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
    },
  });
}

export function useAgentMessage() {
  return useMutation({ mutationFn: (text: string) => api.agentMessage(text) });
}
