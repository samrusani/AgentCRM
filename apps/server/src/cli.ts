#!/usr/bin/env node
import { existsSync, accessSync, constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AppError } from './errors.js';

const usage = `Usage: crm <command> [options]

Commands:
  doctor                 Check Node version, database state, and port availability
  seed [--reset]         Fill the database with synthetic demo data
  serve                  Start the API server on 127.0.0.1:4720
  search <query>         Search people, organizations, and opportunities
  runs list              List runs, newest first
  runs get <id>          Show one run with its steps
  import <file.csv>      Stage a CSV file for review, or show how it would map with --preview
  approvals list         List approvals, newest first
  approvals decide <id> approve|reject
                         Decide an approval as the local user
  backup [directory]     Write a snapshot of the database (default: data/backups)
  restore <file>         Replace the database with a snapshot, after the server is stopped
  mcp                    Start the MCP server over stdio

Options:
  --json                 Print JSON instead of text (search, runs, import, approvals, doctor)
  --preview              With import: print the parse result and suggested mapping, stage nothing
  --note <text>          With approvals decide: attach a note
  --help                 Show this message

Exit codes: 0 success, 1 expected failure with a printed reason, 2 usage error.`;

class UsageError extends Error {}

interface Parsed {
  positionals: string[];
  json: boolean;
  reset: boolean;
  preview: boolean;
  note: string | null;
  help: boolean;
}

function parseArguments(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], json: false, reset: false, preview: false, note: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--json') parsed.json = true;
    else if (argument === '--reset') parsed.reset = true;
    else if (argument === '--preview') parsed.preview = true;
    else if (argument === '--note' || argument.startsWith('--note=')) {
      const inline = argument.startsWith('--note=') ? argument.slice('--note='.length) : argv[(index += 1)];
      if (inline === undefined || inline === '') throw new UsageError('--note needs text, for example: --note "Looks right".');
      parsed.note = inline;
    } else if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (argument.startsWith('-')) throw new UsageError(`Unknown option ${argument}.`);
    else parsed.positionals.push(argument);
  }
  return parsed;
}

function print(parsed: Parsed, value: unknown, text: () => string): void {
  console.log(parsed.json ? JSON.stringify(value, null, 2) : text());
}

async function openWorkspace() {
  const { openDatabase } = await import('./db.js');
  const { findWorkspace } = await import('./queries/workspace.js');
  const db = openDatabase();
  const workspace = findWorkspace(db);
  if (!workspace) throw new AppError('not_found', 'No workspace exists yet. Run "crm seed" first.');
  return { db, workspace };
}

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function doctor(parsed: Parsed): Promise<number> {
  const { default: Database } = await import('better-sqlite3');
  const { listMigrationFiles } = await import('./db.js');
  const { apiPort, workerLeaseTimeoutMilliseconds } = await import('./config.js');
  const { readWorkerLease } = await import('./actions/workerLease.js');
  const { displayDatabasePath, resolveDatabasePath } = await import('./paths.js');
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node version',
    status: major >= 22 ? 'ok' : 'fail',
    detail: major >= 22 ? `Node ${process.versions.node}` : `Node ${process.versions.node} is too old. Use Node 22 or newer.`,
  });

  const databasePath = resolveDatabasePath();
  const shown = displayDatabasePath(databasePath);
  if (!existsSync(databasePath)) {
    checks.push({ name: 'Database', status: 'warn', detail: `${shown} does not exist yet. Run "npm run seed" to create it.` });
  } else {
    try {
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      const mode = db.pragma('journal_mode', { simple: true });
      const applied = db.prepare("SELECT name FROM sqlite_master WHERE name = 'migrations'").get()
        ? (db.prepare('SELECT name FROM migrations').all() as { name: string }[]).length
        : 0;
      const pending = listMigrationFiles().length - applied;
      checks.push({
        name: 'Database',
        status: pending === 0 ? 'ok' : 'warn',
        detail: `${shown}, journal mode ${String(mode)}, ${pending === 0 ? 'migrations current' : `${pending} migration(s) pending, start the server to apply them`}`,
      });
      if (applied > 0) {
        const people = (db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n;
        checks.push({
          name: 'Records',
          status: people > 0 ? 'ok' : 'warn',
          detail: people > 0 ? `${people} people` : 'The database is empty. Run "npm run seed".',
        });
        // The lease table exists once migration 021 has been applied.
        if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'worker_lease'").get()) {
          const lease = readWorkerLease({ db });
          if (!lease) {
            checks.push({ name: 'Worker lease', status: 'ok', detail: 'No process holds it, so no worker is claiming jobs.' });
          } else {
            // The same freshness rule as the workers: a future dated or unreadable stamp is stale too.
            const ageMilliseconds = Date.now() - Date.parse(lease.renewedAt);
            const fresh = Math.abs(ageMilliseconds) <= workerLeaseTimeoutMilliseconds;
            const held = `Held by the ${lease.kind} process with pid ${lease.pid}`;
            const detail = fresh
              ? `${held}, renewed ${Math.round(Math.abs(ageMilliseconds) / 1000)} seconds ago.`
              : Number.isNaN(ageMilliseconds)
                ? `${held}, but its renewal time is unreadable, so it is stale and the next worker will take it.`
                : ageMilliseconds < 0
                  ? `${held}, but its renewal time is ${Math.round(-ageMilliseconds / 1000)} seconds in the future, so it is stale and the next worker will take it.`
                  : `${held}, last renewed ${Math.round(ageMilliseconds / 1000)} seconds ago, so it is stale and the next worker will take it.`;
            checks.push({ name: 'Worker lease', status: fresh ? 'ok' : 'warn', detail });
          }
        }
      }
      db.close();
    } catch (error) {
      checks.push({ name: 'Database', status: 'fail', detail: `Cannot open ${shown}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  try {
    const directory = existsSync(path.dirname(databasePath)) ? path.dirname(databasePath) : path.dirname(path.dirname(databasePath));
    accessSync(directory, constants.W_OK);
    checks.push({ name: 'Data folder', status: 'ok', detail: 'The data folder can be written.' });
  } catch {
    checks.push({ name: 'Data folder', status: 'fail', detail: 'The data folder cannot be written.' });
  }

  const port = apiPort();
  if (await portIsFree(port)) {
    checks.push({ name: `Port ${port}`, status: 'ok', detail: 'Free.' });
  } else {
    let running = false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      running = response.ok;
    } catch {
      running = false;
    }
    checks.push({
      name: `Port ${port}`,
      status: running ? 'ok' : 'warn',
      detail: running ? 'In use by a running AgentCRM server.' : 'In use by another process. Set AGENTCRM_PORT to change it.',
    });
  }

  print(parsed, { checks }, () => checks.map((check) => `${check.status.padEnd(4)}  ${check.name}: ${check.detail}`).join('\n'));
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}

async function seedCommand(parsed: Parsed): Promise<number> {
  const { openDatabase } = await import('./db.js');
  const { seedDatabase } = await import('./seed/seed.js');
  const db = openDatabase();
  const counts = seedDatabase(db, { reset: parsed.reset });
  print(parsed, { seeded: true, counts }, () =>
    `Seeded the demo workspace: ${counts.people} people, ${counts.organizations} organizations, ${counts.opportunities} opportunities, ${counts.tasksOpen} open tasks, ${counts.runs} run. All data is synthetic.`,
  );
  db.close();
  return 0;
}

async function searchCommand(parsed: Parsed): Promise<number> {
  const query = parsed.positionals.slice(1).join(' ').trim();
  if (!query) throw new UsageError('Give a search query, for example: crm search lanternrow');
  const { searchAll } = await import('./queries/search.js');
  const { db, workspace } = await openWorkspace();
  const found = searchAll(db, workspace.id, query);
  print(parsed, found, () => {
    const lines = [
      ...found.people.map((entry) => `person        ${entry.id}  ${entry.name}${entry.organizationName ? `, ${entry.organizationName}` : ''}`),
      ...found.organizations.map((entry) => `organization  ${entry.id}  ${entry.name}${entry.domain ? ` (${entry.domain})` : ''}`),
      ...found.opportunities.map((entry) => `opportunity   ${entry.id}  ${entry.name}, ${entry.stageName ?? ''} (${entry.status})`),
    ];
    return lines.length > 0 ? lines.join('\n') : `No records match "${query}".`;
  });
  db.close();
  return 0;
}

async function runsCommand(parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1];
  const { listRuns, getRunDetail } = await import('./queries/runs.js');
  if (action === 'list') {
    const { db, workspace } = await openWorkspace();
    const page = listRuns(db, workspace.id, { limit: 200 });
    print(parsed, page, () =>
      page.items.length === 0
        ? 'No runs yet.'
        : page.items
            .map((run) => `${run.id}  ${run.status.padEnd(16)}  found ${run.counts.found}, flagged ${run.counts.flagged}  ${run.title}${run.simulated ? ' (simulated)' : ''}`)
            .join('\n'),
    );
    db.close();
    return 0;
  }
  if (action === 'get') {
    const id = parsed.positionals[2];
    if (!id) throw new UsageError('Give a run id, for example: crm runs get run_0123456789ab');
    const { db, workspace } = await openWorkspace();
    const run = getRunDetail(db, workspace.id, id);
    print(parsed, run, () =>
      [
        `${run.id}  ${run.status}${run.simulated ? ' (simulated)' : ''}`,
        run.title,
        `processed ${run.counts.processed}, found ${run.counts.found}, flagged ${run.counts.flagged}`,
        ...run.steps.map((step) => `  ${step.seq}. ${step.status.padEnd(8)} ${step.title}${step.detail ? `: ${step.detail}` : ''}`),
        ...run.approvals.map((approval) => `approval ${approval.id}  ${approval.status}  ${approval.title}`),
      ].join('\n'),
    );
    db.close();
    return 0;
  }
  throw new UsageError('Use "crm runs list" or "crm runs get <id>".');
}

async function readCsvFile(file: string): Promise<{ fileName: string; content: string }> {
  const { readFile, stat } = await import('node:fs/promises');
  const { maxCsvBytes } = await import('./csv/parse.js');
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new AppError('validation', `${file} is not a file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('not_found', `Cannot read ${file}. Check the path.`);
  }
  if (size > maxCsvBytes) {
    throw new AppError('validation', `The file is larger than ${maxCsvBytes / (1024 * 1024)} MB. Split it into smaller files.`);
  }
  return { fileName: path.basename(file), content: await readFile(file, 'utf8') };
}

const delimiterNames: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

async function importCommand(parsed: Parsed): Promise<number> {
  const file = parsed.positionals[1];
  if (!file) throw new UsageError('Give a CSV file, for example: crm import leads.csv --preview');
  const { fileName, content } = await readCsvFile(file);
  const { previewCsvFile, stageCsvImport } = await import('./actions/index.js');
  if (parsed.preview) {
    const preview = previewCsvFile({ fileName, content });
    print(parsed, preview, () =>
      [
        `${preview.fileName}: ${preview.rowCount} ${preview.rowCount === 1 ? 'row' : 'rows'}, ${delimiterNames[preview.delimiter] ?? preview.delimiter} separated`,
        'Columns and suggested mapping:',
        ...preview.headers.map((header) => `  ${header} -> ${preview.suggestedMapping[header] ?? 'ignore'}`),
        `Sample (first ${preview.sample.length}):`,
        ...preview.sample.map((row) => `  ${preview.headers.map((header) => row[header] ?? '').join(' | ')}`),
      ].join('\n'),
    );
    return 0;
  }
  const preview = previewCsvFile({ fileName, content });
  const { createContext } = await import('./actions/index.js');
  const { db, workspace } = await openWorkspace();
  try {
    const run = stageCsvImport(
      createContext(db, workspace.id, { actor: 'user' }),
      { fileName, content, mapping: preview.suggestedMapping },
      { origin: 'user' },
    );
    const batchId = String(run.scope.batchId);
    print(parsed, { run, batchId }, () =>
      [
        `Staged ${preview.rowCount} ${preview.rowCount === 1 ? 'row' : 'rows'} from ${fileName}.`,
        `Run:   ${run.id}`,
        `Batch: ${batchId}`,
        'The server validates the rows, checks for duplicates, and then asks for review. Start it with "crm serve" if it is not running.',
        'Review with "crm approvals list" and decide with "crm approvals decide <id> approve".',
      ].join('\n'),
    );
  } finally {
    db.close();
  }
  return 0;
}

async function approvalsCommand(parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1];
  if (action === 'list') {
    const { listApprovals } = await import('./queries/runs.js');
    const { db, workspace } = await openWorkspace();
    const limit = 200;
    const page = listApprovals(db, workspace.id, { limit });
    print(parsed, page, () =>
      page.items.length === 0
        ? 'No approvals yet.'
        : [
            ...page.items.map(
              (approval) => `${approval.id}  ${approval.status.padEnd(8)}  ${approval.kind.padEnd(13)}  ${approval.title}  (run ${approval.runId})`,
            ),
            ...(page.items.length === limit ? [`Only the first ${limit} approvals are shown (newest first).`] : []),
          ].join('\n'),
    );
    db.close();
    return 0;
  }
  if (action === 'decide') {
    const id = parsed.positionals[2];
    const decision = parsed.positionals[3];
    if (!id || (decision !== 'approve' && decision !== 'reject')) {
      throw new UsageError('Use "crm approvals decide <id> approve|reject", for example: crm approvals decide apr_0123456789ab approve');
    }
    const { createContext, decideApproval } = await import('./actions/index.js');
    const { requireApproval } = await import('./queries/runs.js');
    const { db, workspace } = await openWorkspace();
    try {
      // A send shows every full message in the app. A terminal decision would approve mail nobody read in full.
      if (requireApproval(db, workspace.id, id).kind === 'send_review') {
        throw new Error('Send approvals are decided in the app, where the full messages are shown.');
      }
      const result = decideApproval(createContext(db, workspace.id, { actor: 'user' }), id, {
        decision,
        ...(parsed.note ? { note: parsed.note } : {}),
      });
      print(parsed, result, () =>
        [
          result.alreadyDecided
            ? `${result.approval.id} was already ${result.approval.status}. Nothing changed.`
            : `${decision === 'approve' ? 'Approved' : 'Rejected'} ${result.approval.id}.`,
          `Run ${result.run.id} is ${result.run.status.replace('_', ' ')}: processed ${result.run.counts.processed}, found ${result.run.counts.found}, flagged ${result.run.counts.flagged}.`,
        ].join('\n'),
      );
    } finally {
      db.close();
    }
    return 0;
  }
  throw new UsageError('Use "crm approvals list" or "crm approvals decide <id> approve|reject".');
}

async function backupCommand(parsed: Parsed): Promise<number> {
  const { backupDatabase } = await import('./backup.js');
  const { resolveDatabasePath } = await import('./paths.js');
  const directory = parsed.positionals[1];
  const result = await backupDatabase({ databasePath: resolveDatabasePath(), ...(directory ? { directory } : {}) });
  print(parsed, { path: result.displayPath, bytes: result.bytes }, () => result.message);
  return 0;
}

async function restoreCommand(parsed: Parsed): Promise<number> {
  const file = parsed.positionals[1];
  if (!file) throw new UsageError('Give a backup file, for example: crm restore data/backups/agentcrm-backup-20260301T090000Z.db');
  const { restoreDatabase } = await import('./backup.js');
  const { apiPort } = await import('./config.js');
  const { resolveDatabasePath } = await import('./paths.js');
  const result = await restoreDatabase({ snapshot: file, databasePath: resolveDatabasePath(), port: apiPort() });
  print(parsed, { restored: true, moved: result.moved.map((entry) => ({ from: path.basename(entry.from), to: path.basename(entry.to) })) }, () => result.message);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  const command = parsed.positionals[0];
  if (parsed.help || command === 'help' || command === undefined) {
    if (command === undefined && !parsed.help) {
      console.error(usage);
      return 2;
    }
    console.log(usage);
    return 0;
  }
  try {
    switch (command) {
      case 'doctor':
        return await doctor(parsed);
      case 'seed':
        return await seedCommand(parsed);
      case 'search':
        return await searchCommand(parsed);
      case 'runs':
        return await runsCommand(parsed);
      case 'import':
        return await importCommand(parsed);
      case 'approvals':
        return await approvalsCommand(parsed);
      case 'backup':
        return await backupCommand(parsed);
      case 'restore':
        return await restoreCommand(parsed);
      case 'serve': {
        const { startServer, runUntilSignal } = await import('./server.js');
        runUntilSignal(await startServer());
        return await new Promise<number>(() => undefined);
      }
      case 'mcp': {
        const { startMcpServer } = await import('./mcp/server.js');
        await startMcpServer();
        return await new Promise<number>(() => undefined);
      }
      default:
        console.error(`Unknown command "${command}".\n\n${usage}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage}`);
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
