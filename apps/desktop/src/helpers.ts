import path from 'node:path';

// Pure helpers for the main process, kept free of Electron imports so they run under plain vitest.

export interface PathInputs {
  env: Record<string, string | undefined>;
  home: string;
}

// AGENTCRM_DB wins; otherwise the per user Application Support file.
export function resolveDatabasePath(inputs: PathInputs): string {
  const override = inputs.env.AGENTCRM_DB;
  if (override && override.length > 0) return override === ':memory:' ? override : path.resolve(override);
  return path.join(inputs.home, 'Library', 'Application Support', 'AgentCRM', 'agentcrm.db');
}

// In a packaged app the web build sits in the app's resources folder; from source it is the sibling web package.
export function resolveWebDist(options: { packaged: boolean; resourcesPath: string; appDirectory: string }): string {
  return options.packaged
    ? path.join(options.resourcesPath, 'web')
    : path.resolve(options.appDirectory, '..', 'web', 'dist');
}

export function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// True only for the exact loopback origin the window loads. Everything else goes to the default browser.
export function isAppOrigin(target: string, port: number): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port;
  } catch {
    return false;
  }
}

// Only web links are handed to the default browser; file:, custom schemes and the like are dropped.
export function isOpenableExternally(target: string): boolean {
  try {
    const protocol = new URL(target).protocol;
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}
