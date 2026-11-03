import { imapFakeEnabled } from '../config.js';
import { createSeededFakeMailTransport, type FakeMailTransport } from './fakeMailTransport.js';
import type { MailTransport } from './mailTransport.js';
import { createRealMailTransport } from './realMailTransport.js';

// Which transport the IMAP and SMTP provider talks through. The real one by default, the in process fake when
// AGENTCRM_IMAP_FAKE=1, and tests can set their own.

let override: MailTransport | null = null;
let real: MailTransport | null = null;
let fake: FakeMailTransport | null = null;

export function setMailTransportOverride(transport: MailTransport | null): void {
  override = transport;
}

// The fake of this process, or null when the flag is not set. The debug routes use it.
export function getFakeMailTransport(): FakeMailTransport | null {
  if (!imapFakeEnabled()) return null;
  fake ??= createSeededFakeMailTransport();
  return fake;
}

export function getMailTransport(): MailTransport {
  if (override) return override;
  const inProcess = getFakeMailTransport();
  if (inProcess) return inProcess;
  real ??= createRealMailTransport();
  return real;
}
