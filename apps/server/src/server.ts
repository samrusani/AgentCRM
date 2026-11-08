import type { FastifyInstance } from 'fastify';
import { createContext, ensureWorkspace } from './actions/index.js';
import { apiHost, apiPort, imapFakeEnabled } from './config.js';
import { createSchemaGuard, type Db, openDatabase } from './db.js';
import { EventBus } from './events.js';
import { buildApp } from './http/app.js';
import { startWorker } from './jobs/worker.js';
import { displayDatabasePath, resolveDatabasePath } from './paths.js';
import { startExternalWatcher } from './watcher.js';

const staleApiMessage =
  'The database schema changed after this server started, usually because AgentCRM was updated. Quit and reopen the app.';

export interface RunningServer {
  app: FastifyInstance;
  db: Db;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(options: { port?: number; databasePath?: string } = {}): Promise<RunningServer> {
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const port = options.port ?? apiPort();
  const db = openDatabase(databasePath);
  const bus = new EventBus();
  const workspace = ensureWorkspace(db);

  // openDatabase applied the migrations, so the snapshot taken here is the schema this code expects.
  const guard = createSchemaGuard(db, staleApiMessage);
  const app = buildApp({ db, bus, databasePath, guard });
  const worker = startWorker(
    createContext(db, workspace.id, { bus, actor: 'system' }),
    (error) => {
      app.log.error(error);
    },
    { guard },
  );
  const stopWatcher = startExternalWatcher(db, bus);

  const close = async (): Promise<void> => {
    worker.stop();
    stopWatcher();
    await app.close();
    db.close();
  };

  try {
    await app.listen({ host: apiHost, port });
  } catch (error) {
    await close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use. Stop the other process or set AGENTCRM_PORT.`);
    }
    throw error;
  }
  // Port 0 asks the OS for a free port; report the one it picked.
  const address = app.server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  const people = Number((db.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number }).n);
  console.log(`AgentCRM API listening on http://${apiHost}:${boundPort} (database ${displayDatabasePath(databasePath)})`);
  if (imapFakeEnabled()) console.log('AGENTCRM_IMAP_FAKE=1: IMAP and SMTP use an in process fake mail server. No real mail is sent or read. Debug routes are under /api/debug/imap-fake.');
  if (people === 0) console.log('The database has no records yet. Run "npm run seed" to add synthetic demo data.');
  return { app, db, port: boundPort, close };
}

export function runUntilSignal(server: RunningServer): void {
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
