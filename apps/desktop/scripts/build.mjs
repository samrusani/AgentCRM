// Builds the desktop shell into dist/:
//   dist/main.js            the Electron main process (electron stays external)
//   dist/server/server.js   the existing API server, bundled from apps/server/src/server.ts (not forked)
//   dist/migrations/        the server's SQL migrations, where the bundled server looks for them
// better-sqlite3 is the one external: it is a native module, installed here and rebuilt for Electron's ABI.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const server = path.resolve(root, '..', 'server');
const dist = path.join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(dist, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
});

await build({
  entryPoints: [path.join(server, 'src', 'server.ts')],
  outfile: path.join(dist, 'server', 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  nodePaths: [path.join(server, 'node_modules')],
});

cpSync(path.join(server, 'migrations'), path.join(dist, 'migrations'), { recursive: true });
console.log('Built apps/desktop/dist');
