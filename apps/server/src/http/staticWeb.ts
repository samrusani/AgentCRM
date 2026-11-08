import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticFile {
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

// Serves the built web app for desktop use. Returns null when the path is not a static answer (the caller then
// sends its normal 404). API paths never reach a file: the caller only asks after every real route has declined.
export function createStaticWeb(rootDirectory: string): (urlPath: string) => Promise<StaticFile | null> {
  // A missing root must never sink the process: the promise would otherwise reject unhandled at startup. It
  // resolves to null instead, and every request then answers the JSON 404 while the API keeps running.
  const rootPromise = realpath(path.resolve(rootDirectory)).catch(() => null);

  async function readInside(root: string, relative: string): Promise<StaticFile | null> {
    const candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
    let real: string;
    try {
      real = await realpath(candidate);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      if (!(await stat(real)).isFile()) return null;
    } catch {
      return null;
    }
    const extension = path.extname(real).toLowerCase();
    const isIndex = path.basename(real) === 'index.html';
    return {
      body: await readFile(real),
      contentType: contentTypes[extension] ?? 'application/octet-stream',
      cacheControl: isIndex ? 'no-cache' : 'public, max-age=3600',
    };
  }

  return async (urlPath: string) => {
    if (urlPath === '/api' || urlPath.startsWith('/api/')) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const segments = decoded.split('/').filter((segment) => segment !== '');
    if (segments.some((segment) => segment === '..' || segment === '.')) return null;
    const root = await rootPromise;
    if (root === null) return null;
    const relative = segments.join('/');
    if (relative !== '') {
      const file = await readInside(root, relative);
      if (file) return file;
      // A path with an extension is an asset request: a missing one is a real 404, never the app shell.
      if (path.extname(segments[segments.length - 1] ?? '') !== '') return null;
    }
    return readInside(root, 'index.html');
  };
}
