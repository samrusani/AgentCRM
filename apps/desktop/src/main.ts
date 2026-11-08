import { app, BrowserWindow, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAppOrigin, isOpenableExternally, loopbackUrl, resolveDatabasePath, resolveWebDist } from './helpers.js';

// What the packaged app contains: the Electron shell (dist/main.js), the API server bundled from apps/server
// (dist/server/server.js, the same startServer the CLI uses), its migrations (dist/migrations), the native
// better-sqlite3 module rebuilt for Electron, and the built web app under Resources/web. No tsx, no dev server.

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quitTimeoutMilliseconds = 5000;

let server: RunningServer | null = null;
let quitting = false;

async function start(): Promise<void> {
  const databasePath = resolveDatabasePath({ env: process.env, home: homedir() });
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true });
  process.env.AGENTCRM_WEB_DIST = resolveWebDist({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDirectory });

  const entry = pathToFileURL(path.join(appDirectory, 'dist', 'server', 'server.js')).href;
  const { startServer } = (await import(entry)) as { startServer: (options: { port?: number; databasePath?: string }) => Promise<RunningServer> };
  // Port 0 asks the OS for a free port, so a running dev stack on 4720 is never collided with.
  server = await startServer({ port: 0, databasePath });
  const port = server.port;

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const openExternally = (target: string): void => {
    if (isOpenableExternally(target)) void shell.openExternal(target);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppOrigin(url, port)) openExternally(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url, port)) return;
    event.preventDefault();
    openExternally(url);
  });
  await window.loadURL(loopbackUrl(port));
}

app.on('window-all-closed', () => app.quit());

// Stop the worker (which releases the lease) and close the server before exit, bounded so a stuck close cannot hang quit.
app.on('before-quit', (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  const closing = server.close().catch((error: unknown) => console.error(error));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, quitTimeoutMilliseconds));
  void Promise.race([closing, timeout]).finally(() => app.quit());
});

app.whenReady().then(start).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
