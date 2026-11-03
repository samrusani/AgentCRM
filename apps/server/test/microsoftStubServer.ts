// A local stand-in for Microsoft's sign in and Graph mail endpoints, for checking the Microsoft card in a browser
// without a Microsoft account. Run it with:
//
//   npx tsx test/microsoftStubServer.ts            (from apps/server)
//
// It prints the two environment variables to start the API server with, and the application (client) id to paste into
// the Microsoft card. The consent page it serves has Allow and Cancel links that send the browser back to the app.
import { startMicrosoftStub, stubMicrosoftAddress, stubMicrosoftClientId } from './microsoftStub.js';

const port = Number(process.env.MICROSOFT_STUB_PORT ?? 4798);
const stub = await startMicrosoftStub({ port });

console.log(`Stub Microsoft server listening on ${stub.url}`);
console.log('');
console.log('Start the API server against it (from the repository root):');
console.log(`  AGENTCRM_MS_LOGIN_BASE=${stub.url} AGENTCRM_GRAPH_BASE=${stub.url} npm run dev`);
console.log('');
console.log(`Application (client) id: ${stubMicrosoftClientId}`);
console.log(`Account it signs in as:  ${stubMicrosoftAddress}`);
console.log('');
console.log('While it runs:');
console.log(`  Add a reply:      curl -X POST ${stub.url}/__stub/inbound -H 'content-type: application/json' -d '{"from":"person@elsewhere.invalid","text":"Happy to talk."}'`);
console.log(`  Add a bounce:     curl -X POST ${stub.url}/__stub/bounce -H 'content-type: application/json' -d '{}'   (names the last message sent)`);
console.log(`  See what it sent: curl ${stub.url}/__stub/sent`);
console.log(`  Fail the next send, nothing processed (the draft stays unsent):`);
console.log(`    curl -X POST ${stub.url}/__stub/fail -H 'content-type: application/json' -d '{"target":"send","status":503}'`);
console.log(`  Fail the next send after it was processed (the answer is lost):`);
console.log(`    curl -X POST ${stub.url}/__stub/fail -H 'content-type: application/json' -d '{"target":"send","status":502,"processed":true}'`);
console.log(`  Fail the next draft create:`);
console.log(`    curl -X POST ${stub.url}/__stub/fail -H 'content-type: application/json' -d '{"target":"create","status":503}'`);

const stop = (): void => {
  void stub.close().then(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
