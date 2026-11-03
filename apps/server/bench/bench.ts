import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstNames } from '../src/seed/data.js';
import { fullProfile, type Profile, seedProfile, type SeedResult, smallProfile } from './seedProfile.js';

// Performance benchmark for the product spec budgets. Run with "npm run bench" from the repository root.
// Options: --scale=small (1,000 people, quick self check), --keep (keep the scratch database).

const warmupRequests = 20;
const sampleRequests = 200;
const sseSamples = 20;
const sseWarmups = 3;
const sseTimeoutMilliseconds = 10_000;

const benchDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(benchDirectory, '..');

const args = process.argv.slice(2);
const scaleArg = args.find((arg) => arg.startsWith('--scale='))?.slice('--scale='.length) ?? 'full';
const keepScratch = args.includes('--keep');
if (scaleArg !== 'full' && scaleArg !== 'small') {
  console.error('Unknown --scale value. Use --scale=small or --scale=full.');
  process.exit(2);
}
const profile: Profile = scaleArg === 'small' ? smallProfile : fullProfile;

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const format = (value: number): string => value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const log = (line: string): void => console.log(line);

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Result {
  name: string;
  budgetMilliseconds: number;
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  error?: string;
}

async function main(): Promise<void> {
  const runId = `run-${process.pid}-${Date.now().toString(36)}`;
  const scratchRoot = path.join(benchDirectory, '.scratch');
  const scratch = path.join(scratchRoot, runId);
  const databasePath = path.join(scratch, 'bench.db');
  const scratchLabel = `bench/.scratch/${runId}`;
  mkdirSync(scratch, { recursive: true });

  let server: ChildProcess | null = null;
  let serverStderr = '';
  const stopServer = async (): Promise<void> => {
    const child = server;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(10_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const cleanup = async (): Promise<void> => {
    await stopServer();
    if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = (): void => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    log('# AgentCRM performance benchmark');
    log('');
    log('## Machine');
    log('');
    log(`- Architecture: ${process.arch}`);
    log(`- CPU: ${os.cpus()[0]?.model ?? 'unknown'}`);
    log(`- CPU count: ${os.cpus().length}`);
    log(`- Memory: ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`);
    log(`- Node: ${process.version}`);
    log(`- OS: ${os.type()} ${os.release()}`);
    log('');

    log('## Seeding');
    log('');
    log(`Scratch database: ${scratchLabel}/bench.db (deleted when the run ends${keepScratch ? ', except that --keep is set' : ''})`);
    const seed: SeedResult = seedProfile(databasePath, profile, log);
    log(`Seeding finished in ${format(seed.seconds)} s.`);
    log(
      `Rows: ${seed.counts.people.toLocaleString('en-US')} people, ${seed.counts.organizations.toLocaleString('en-US')} organizations, ${seed.counts.activities.toLocaleString('en-US')} activities, ${seed.counts.opportunities.toLocaleString('en-US')} opportunities, ${seed.counts.claims.toLocaleString('en-US')} field claims.`,
    );
    log('');

    // The real server process, so the measuring client does not share its event loop.
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    log('## Server');
    log('');
    const bootStarted = performance.now();
    server = spawn(process.execPath, ['--import', 'tsx', path.join(serverRoot, 'src', 'index.ts')], {
      cwd: serverRoot,
      env: { ...process.env, AGENTCRM_DB: databasePath, AGENTCRM_PORT: String(port), AGENTCRM_LOG_LEVEL: 'error' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr?.on('data', (chunk: Buffer) => {
      serverStderr = `${serverStderr}${chunk.toString()}`.slice(-2000);
    });
    let serverExited = false;
    server.once('exit', () => {
      serverExited = true;
    });
    let coldStartMilliseconds = Number.NaN;
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      if (serverExited) throw new Error(`The server exited during start up.\n${serverStderr}`);
      try {
        const response = await fetch(`${base}/api/health`);
        await response.arrayBuffer();
        if (response.status === 200) {
          coldStartMilliseconds = performance.now() - bootStarted;
          break;
        }
      } catch {
        // Not listening yet.
      }
      await sleep(25);
    }
    if (Number.isNaN(coldStartMilliseconds)) throw new Error('The server did not answer /api/health within 60 s.');
    log(`Cold start (process spawn to health 200, includes TypeScript transpile through tsx): ${format(coldStartMilliseconds)} ms`);
    log('');

    const api = async (method: string, route: string, body?: unknown): Promise<{ status: number; json: any; milliseconds: number }> => {
      const started = performance.now();
      const response = await fetch(`${base}${route}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const milliseconds = performance.now() - started;
      let json: any = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json, milliseconds };
    };

    // Background load: a qualify run over everyone, started again whenever it finishes.
    const load = { stopped: false, started: 0, completed: 0, peopleEvaluated: 0, currentRunId: '', currentProcessed: 0 };
    const terminal = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
    const loadLoop = (async (): Promise<void> => {
      while (!load.stopped) {
        const created = await api('POST', '/api/runs', { kind: 'qualify', title: 'Bench background qualify' });
        if (created.status !== 201) {
          await sleep(1000);
          continue;
        }
        load.started += 1;
        load.currentRunId = String(created.json.id);
        load.currentProcessed = 0;
        while (!load.stopped) {
          await sleep(500);
          const detail = await api('GET', `/api/runs/${load.currentRunId}`);
          if (detail.status !== 200) continue;
          load.currentProcessed = Number(detail.json.counts?.processed ?? 0);
          if (terminal.has(String(detail.json.status))) {
            load.completed += 1;
            load.peopleEvaluated += load.currentProcessed;
            load.currentProcessed = 0;
            break;
          }
        }
      }
    })();
    for (let attempt = 0; attempt < 100 && load.started === 0; attempt += 1) await sleep(100);
    await sleep(1500);

    // Timing
    const results: Result[] = [];
    const measure = async (name: string, budgetMilliseconds: number, request: (index: number) => Promise<number>): Promise<void> => {
      try {
        for (let index = 0; index < warmupRequests; index += 1) await request(-1 - index);
        const times: number[] = [];
        for (let index = 0; index < sampleRequests; index += 1) times.push(await request(index));
        times.sort((a, b) => a - b);
        results.push({ name, budgetMilliseconds, samples: times.length, p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) });
      } catch (error) {
        results.push({ name, budgetMilliseconds, samples: 0, p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, error: error instanceof Error ? error.message : String(error) });
      }
      const last = results[results.length - 1]!;
      process.stderr.write(`  measured ${name}${last.error ? ` (error: ${last.error})` : ` p95 ${format(last.p95)} ms`}\n`);
    };
    const expectStatus = (response: { status: number; milliseconds: number }, expected: number, route: string): number => {
      if (response.status !== expected) throw new Error(`${route} returned HTTP ${response.status}, expected ${expected}.`);
      return response.milliseconds;
    };
    const get = async (route: string): Promise<number> => expectStatus(await api('GET', route), 200, route);
    const wrap = (items: string[], index: number): string => items[((index % items.length) + items.length) % items.length]!;

    const searchNames = firstNames.slice(0, 8).map((name) => name.toLowerCase());
    const claimed = seed.claimedPersonIds;
    const samplePeople = seed.samplePersonIds;

    await measure('List people: GET /api/people?limit=50', 250, () => get('/api/people?limit=50'));
    await measure('List organizations: GET /api/organizations?limit=50', 250, () => get('/api/organizations?limit=50'));
    await measure('List opportunities: GET /api/opportunities?limit=50', 250, () => get('/api/opportunities?limit=50'));
    // Every request reads a different claimed person, so no sample repeats a record.
    const claimedStride = Math.max(1, Math.floor(claimed.length / (warmupRequests + sampleRequests)));
    await measure('Record: GET /api/people/:id (person with claims)', 250, (index) =>
      get(`/api/people/${claimed[((index + warmupRequests) * claimedStride) % claimed.length]}`),
    );
    await measure('Search people: GET /api/people?q=<first name>', 400, (index) => get(`/api/people?q=${wrap(searchNames, index)}`));
    await measure('Search all: GET /api/search?q=<first name>', 400, (index) => get(`/api/search?q=${wrap(searchNames, index)}`));
    let noteCounter = 0;
    const createNote = (personId: string): Promise<{ status: number; json: any; milliseconds: number }> => {
      noteCounter += 1;
      return api('POST', '/api/activities', { entityType: 'person', entityId: personId, body: `Bench note ${noteCounter}`, kind: 'note' });
    };
    await measure('Write ack: POST /api/activities (note)', 300, async (index) =>
      expectStatus(await createNote(wrap(samplePeople, index)), 201, '/api/activities'),
    );
    await measure('Run creation: POST /api/runs (demo_research)', 500, async () => {
      const response = await api('POST', '/api/runs', { kind: 'demo_research', title: 'Bench run', scope: { targetCount: 1 } });
      const milliseconds = expectStatus(response, 201, '/api/runs');
      // Cancelled right away, outside the timing.
      await api('POST', `/api/runs/${response.json.id}/control`, { action: 'cancel' });
      return milliseconds;
    });

    // SSE: time from sending a note to its record_updated event reaching a connected client.
    {
      const name = 'SSE reflection: note write to record_updated event';
      const controller = new AbortController();
      const waiters: { match: (frame: { event: string; data: any }) => boolean; resolve: (arrivedAt: number) => void }[] = [];
      let ready: () => void = () => undefined;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const reading = (async (): Promise<void> => {
        const response = await fetch(`${base}/api/events`, { signal: controller.signal });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          const arrivedAt = performance.now();
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = /^event: (.+)$/m.exec(raw)?.[1] ?? '';
            const dataText = /^data: (.+)$/m.exec(raw)?.[1];
            let data: any = null;
            try {
              data = dataText ? JSON.parse(dataText) : null;
            } catch {
              data = null;
            }
            if (event === 'ready') ready();
            for (const waiter of [...waiters]) {
              if (waiter.match({ event, data })) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(arrivedAt);
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      })().catch(() => undefined);
      try {
        await Promise.race([readyPromise, sleep(10_000).then(() => Promise.reject(new Error('The event stream did not open.')))]);
        const times: number[] = [];
        for (let index = -sseWarmups; index < sseSamples; index += 1) {
          const personId = wrap(samplePeople, index + 7);
          const arrival = new Promise<number>((resolve) => {
            waiters.push({
              match: (frame) => frame.event === 'record_updated' && frame.data?.entityId === personId,
              resolve,
            });
            setTimeout(() => resolve(Number.NaN), sseTimeoutMilliseconds);
          });
          const sent = performance.now();
          const response = await createNote(personId);
          expectStatus(response, 201, '/api/activities');
          const arrivedAt = await arrival;
          const elapsed = Number.isNaN(arrivedAt) ? sseTimeoutMilliseconds : arrivedAt - sent;
          if (index >= 0) times.push(elapsed);
          await sleep(50);
        }
        times.sort((a, b) => a - b);
        results.push({ name, budgetMilliseconds: 2000, samples: times.length, p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) });
      } catch (error) {
        results.push({ name, budgetMilliseconds: 2000, samples: 0, p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, error: error instanceof Error ? error.message : String(error) });
      }
      controller.abort();
      await reading;
      const last = results[results.length - 1]!;
      process.stderr.write(`  measured ${name}${last.error ? ` (error: ${last.error})` : ` p95 ${format(last.p95)} ms`}\n`);
    }

    // Stop the load and collect process facts while the server still holds its working set.
    load.stopped = true;
    await Promise.race([loadLoop, sleep(5000)]);
    let rssMegabytes = 'not available on this platform';
    if (process.platform !== 'win32' && server.pid) {
      try {
        const kilobytes = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)], { encoding: 'utf8' }).trim());
        if (Number.isFinite(kilobytes) && kilobytes > 0) rssMegabytes = `${(kilobytes / 1024).toFixed(0)} MB`;
      } catch {
        // Leave the message as is.
      }
    }
    const fileSize = (file: string): number => (existsSync(file) ? statSync(file).size : 0);
    const mainBytes = fileSize(databasePath);
    const walBytes = fileSize(`${databasePath}-wal`);

    log('## Background load during measurement');
    log('');
    log(`- Qualify run over all people (chunks of 200, one chunk per 300 ms worker tick), restarted whenever it finishes: ${load.started} started, ${load.completed} finished, ${(load.peopleEvaluated + load.currentProcessed).toLocaleString('en-US')} people evaluated.`);
    log('- Job worker ticking every 300 ms, including the mail poll lane. No mail connector is configured, so each poll returns immediately.');
    log('- Measuring client: separate process, one request at a time, keep-alive connection.');
    log('');
    log('## Results');
    log('');
    log(`Each row: ${warmupRequests} warmup requests, then ${sampleRequests} timed samples (SSE: ${sseWarmups} warmups, ${sseSamples} samples), measured against the ${profile.name} profile.`);
    log('');
    log('| Measurement | Samples | p50 (ms) | p95 (ms) | p99 (ms) | p95 budget (ms) | Result |');
    log('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const result of results) {
      if (result.error) {
        log(`| ${result.name} | 0 | n/a | n/a | n/a | ${result.budgetMilliseconds} | error: ${result.error.replace(/\|/g, '/')} |`);
        continue;
      }
      const verdict = result.p95 <= result.budgetMilliseconds ? 'pass' : 'miss';
      log(`| ${result.name} | ${result.samples} | ${format(result.p50)} | ${format(result.p95)} | ${format(result.p99)} | ${result.budgetMilliseconds} | ${verdict} |`);
    }
    log('');
    log('## Process facts');
    log('');
    log(`- Cold start: ${format(coldStartMilliseconds)} ms`);
    log(`- Database file size: ${(mainBytes / 2 ** 20).toFixed(1)} MiB main file, ${(walBytes / 2 ** 20).toFixed(1)} MiB write-ahead log`);
    log(`- Server process RSS after the run: ${rssMegabytes}`);
    log('');
    const misses = results.filter((result) => result.error || result.p95 > result.budgetMilliseconds).length;
    log(`${results.length - misses} of ${results.length} measurements are within budget.`);
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
