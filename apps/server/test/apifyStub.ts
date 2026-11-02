import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubState {
  token: string;
  username: string;
  items: unknown[];
  // Statuses returned by successive run polls. The last one repeats.
  runStatuses: string[];
  statusMessage: string | null;
  startCalls: number;
  // The status the start endpoint answers with. 201 is a normal start.
  startStatus: number;
  // Answers a start with a 200 whose body is not JSON, as a broken proxy might.
  startGarbage: boolean;
  // The status run polls answer with. 200 is normal.
  pollStatus: number;
  startBodies: unknown[];
  startQueries: string[];
  abortCalls: number;
  pollCalls: number;
  datasetCalls: number;
  authHeaders: string[];
  paths: string[];
  // Per actor datasets, keyed by the actor id in username~name form (any case). A start for a registered
  // actor creates a run with its own dataset holding these items. Other actor ids keep the shared `items`.
  actorItems: Record<string, unknown[]>;
  // Poll statuses for runs of one registered actor. Falls back to runStatuses.
  actorStatuses: Record<string, string[]>;
  // Start answer for one registered actor. Falls back to startStatus.
  actorStartStatus: Record<string, number>;
  // The actor of each start request, in order, lowercased.
  startActors: string[];
  // Registered actor runs by Apify run id.
  runs: Record<string, { actor: string; datasetId: string; polls: number }>;
  datasets: Record<string, unknown[]>;
  abortedRuns: string[];
  datasetReads: string[];
}

export interface ApifyStub {
  url: string;
  state: StubState;
  reset: () => void;
  close: () => Promise<void>;
}

export const stubToken = 'apify_api_testtoken1234';

const store = [
  {
    id: 'abc123internal',
    name: 'lead-scraper',
    username: 'tester',
    title: 'Lead scraper',
    description: 'Finds fictional leads.',
    stats: { totalRuns: 4200 },
    currentPricingInfo: { pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.004, unitName: 'result' },
  },
  { id: 'def456internal', name: 'map-finder', username: 'other', title: 'Map finder', description: null },
];

function freshState(): StubState {
  return {
    token: stubToken,
    username: 'tester',
    items: [],
    runStatuses: ['SUCCEEDED'],
    statusMessage: null,
    startCalls: 0,
    startStatus: 201,
    startGarbage: false,
    pollStatus: 200,
    startBodies: [],
    startQueries: [],
    abortCalls: 0,
    pollCalls: 0,
    datasetCalls: 0,
    authHeaders: [],
    paths: [],
    actorItems: {},
    actorStatuses: {},
    actorStartStatus: {},
    startActors: [],
    runs: {},
    datasets: {},
    abortedRuns: [],
    datasetReads: [],
  };
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startApifyStub(): Promise<ApifyStub> {
  const state = freshState();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.local');
    const authorization = request.headers.authorization ?? '';
    state.authHeaders.push(authorization);
    state.paths.push(`${request.method} ${url.pathname}`);
    if (authorization !== `Bearer ${state.token}`) {
      send(response, 401, { error: { type: 'user-or-token-not-found', message: 'Token is not valid.' } });
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = url.pathname;
      if (path === '/v2/users/me') return send(response, 200, { data: { id: 'usr1', username: state.username } });
      if (path === '/v2/store') {
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const items = store.filter((item) => `${item.name} ${item.title}`.toLowerCase().includes(search));
        return send(response, 200, { data: { total: items.length, items } });
      }
      const actorMatch = /^\/v2\/acts\/([^/]+)(\/runs)?$/.exec(path);
      if (actorMatch) {
        const id = decodeURIComponent(actorMatch[1]!);
        const registered = id.toLowerCase() in state.actorItems;
        if (id !== 'tester~lead-scraper' && id !== 'other~map-finder' && !registered) {
          return send(response, 404, { error: { type: 'record-not-found', message: 'Actor was not found.' } });
        }
        if (actorMatch[2]) {
          state.startCalls += 1;
          state.startBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
          state.startQueries.push(url.search);
          const actorKey = id.toLowerCase();
          if (registered) state.startActors.push(actorKey);
          if (state.startGarbage) {
            response.writeHead(200, { 'content-type': 'application/json' });
            return response.end('not json');
          }
          const startStatus = registered ? (state.actorStartStatus[actorKey] ?? state.startStatus) : state.startStatus;
          if (startStatus !== 201) {
            return send(response, startStatus, { error: { type: 'stub-failure', message: 'Stub failure.' } });
          }
          if (registered) {
            const runId = `run_${state.startCalls}`;
            const datasetId = `ds_${state.startCalls}`;
            state.runs[runId] = { actor: actorKey, datasetId, polls: 0 };
            state.datasets[datasetId] = state.actorItems[actorKey] ?? [];
            return send(response, 201, { data: { id: runId, status: 'READY', defaultDatasetId: datasetId } });
          }
          return send(response, 201, {
            data: { id: `run_${state.startCalls}`, status: 'READY', defaultDatasetId: 'ds_1' },
          });
        }
        return send(response, 200, {
          data: {
            ...store[0],
            exampleRunInput: { body: '{"queries":["fintech"],"max_results":10}', contentType: 'application/json' },
          },
        });
      }
      const runMatch = /^\/v2\/actor-runs\/([^/]+)(\/abort)?$/.exec(path);
      if (runMatch) {
        if (runMatch[2]) {
          state.abortCalls += 1;
          state.abortedRuns.push(runMatch[1]!);
          return send(response, 200, { data: { id: runMatch[1], status: 'ABORTING' } });
        }
        const meta = state.runs[runMatch[1]!];
        const statuses = meta ? (state.actorStatuses[meta.actor] ?? state.runStatuses) : state.runStatuses;
        const index = Math.min(meta ? meta.polls : state.pollCalls, statuses.length - 1);
        state.pollCalls += 1;
        if (meta) meta.polls += 1;
        if (state.pollStatus !== 200) {
          return send(response, state.pollStatus, { error: { type: 'stub-failure', message: 'Stub failure.' } });
        }
        return send(response, 200, {
          data: {
            id: runMatch[1],
            status: statuses[index],
            statusMessage: state.statusMessage,
            defaultDatasetId: meta ? meta.datasetId : 'ds_1',
          },
        });
      }
      const datasetMatch = /^\/v2\/datasets\/([^/]+)\/items$/.exec(path);
      if (datasetMatch) {
        state.datasetCalls += 1;
        state.datasetReads.push(datasetMatch[1]!);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const source = state.datasets[datasetMatch[1]!] ?? state.items;
        return send(response, 200, source.slice(offset, offset + limit));
      }
      return send(response, 404, { error: { type: 'not-found', message: 'No such route.' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    reset: () => Object.assign(state, freshState()),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Points the provider at the stub and makes polling immediate. Returns a function that restores the environment.
export function useStub(stub: ApifyStub, extra: Record<string, string> = {}): () => void {
  const names = ['AGENTCRM_APIFY_BASE', 'AGENTCRM_APIFY_POLL_MS', 'AGENTCRM_APIFY_TIMEOUT_MS', ...Object.keys(extra)];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.AGENTCRM_APIFY_BASE = stub.url;
  process.env.AGENTCRM_APIFY_POLL_MS = '0';
  Object.assign(process.env, extra);
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}
