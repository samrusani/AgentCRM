// A local stand-in for Google's OAuth and Gmail endpoints, for checking the Gmail card in a browser without a Google
// account. Run it with:
//
//   npx tsx test/googleStubServer.ts            (from apps/server)
//
// It prints the three environment variables to start the API server with, and the client id and secret to paste into
// the Gmail card. The consent page it serves has an Allow link that sends the browser back to the app with a code.
import { startGoogleStub, stubGmailAddress, stubGoogleClientId, stubGoogleClientSecret } from './googleStub.js';

const port = Number(process.env.GOOGLE_STUB_PORT ?? 4799);
const stub = await startGoogleStub({ port });

console.log(`Stub Google server listening on ${stub.url}`);
console.log('');
console.log('Start the API server against it (from the repository root):');
console.log(
  `  AGENTCRM_GOOGLE_AUTH_BASE=${stub.url} AGENTCRM_GOOGLE_TOKEN_BASE=${stub.url} AGENTCRM_GMAIL_BASE=${stub.url} npm run dev`,
);
console.log('');
console.log(`Client id:     ${stubGoogleClientId}`);
console.log(`Client secret: ${stubGoogleClientSecret}`);
console.log(`Account it signs in as: ${stubGmailAddress}`);
console.log('');
console.log('While it runs:');
console.log(`  Add a reply:    curl -X POST ${stub.url}/__stub/inbound -H 'content-type: application/json' -d '{"from":"person@elsewhere.invalid","text":"Happy to talk."}'`);
console.log(`  Add a bounce:   curl -X POST ${stub.url}/__stub/bounce -H 'content-type: application/json' -d '{}'   (names the last message sent)`);
console.log(`  See what it sent: curl ${stub.url}/__stub/sent`);

const stop = (): void => {
  void stub.close().then(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
