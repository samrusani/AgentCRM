import { runUntilSignal, startServer } from './server.js';

try {
  runUntilSignal(await startServer());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
