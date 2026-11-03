import { FakeMailTransport } from '../src/providers/fakeMailTransport.js';
import { setMailTransportOverride } from '../src/providers/mailTransportFactory.js';

// The stub of the mail transport seam. It is the same in process fake the server uses with AGENTCRM_IMAP_FAKE=1, with
// its knobs: scripted send outcomes (accept, reject, not sent, a lost connection with or without the message kept),
// the server saving its own Sent copy or not, a changed uidValidity, delivery status report fixtures, and failures of
// each step.
export { FakeMailTransport };

export const stubImapAddress = 'sender@imap-stub.invalid';
export const stubImapPassword = 'app-password-1234';

export function useMailTransportStub(): { stub: FakeMailTransport; restore: () => void } {
  const stub = new FakeMailTransport();
  setMailTransportOverride(stub);
  const previous = process.env.AGENTCRM_MAIL_RECONCILE_MS;
  // Reconciliation becomes immediate: every check is one second after the last.
  process.env.AGENTCRM_MAIL_RECONCILE_MS = '1000';
  return {
    stub,
    restore: () => {
      setMailTransportOverride(null);
      if (previous === undefined) delete process.env.AGENTCRM_MAIL_RECONCILE_MS;
      else process.env.AGENTCRM_MAIL_RECONCILE_MS = previous;
    },
  };
}
