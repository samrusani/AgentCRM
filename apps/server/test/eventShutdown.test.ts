import { expect, it } from 'vitest';
import { createTestEnvironment } from './helpers.js';
import { buildApp } from '../src/http/app.js';

it('finishes closing the API while a browser event stream is still open', async () => {
  const env = createTestEnvironment();
  const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: ready');

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The event stream blocked API shutdown.')), 2000);
    });
    await Promise.race([app.close(), timeout]);
    expect(controller.signal.aborted).toBe(false);
    expect((await reader.read()).done).toBe(true);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await app.close();
    env.cleanup();
  }
});
