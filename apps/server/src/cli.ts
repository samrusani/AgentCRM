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
  mcp                    Start the MCP server over stdio

Options:
  --json                 Print JSON instead of text (search, runs, doctor)
  --help                 Show this message

Exit codes: 0 success, 1 expected failure with a printed reason, 2 usage error.`;

class UsageError extends Error {}

interface Parsed {
  positionals: string[];
  json: boolean;
  reset: boolean;
  help: boolean;
}

function parseArguments(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], json: false, reset: false, help: false };
  for (const argument of argv) {
    if (argument === '--json') parsed.json = true;
    else if (argument === '--reset') parsed.reset = true;
    else if (argument === '--help' || argument === '-h') parsed.help = true;
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
  const { apiPort } = await import('./config.js');
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
