# AgentCRM capture extension

A Chrome extension (Manifest V3) that adds an "Add to AgentCRM" button to LinkedIn and X profile pages. One click sends the profile you are viewing to your local AgentCRM server, which creates the person. It has no runtime dependencies and talks only to the server address you configure (default `http://localhost:4720`).

## Install

1. In `apps/extension`, run `npm install` and then `npm run build`.
2. Open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and select the `apps/extension` folder.
3. In AgentCRM, open Settings, Connectors, Browser extension and generate a capture token. Open the extension's options, paste the token and the server address, choose Save, then Test connection.

## Limits

The extension captures only the profile you are viewing, and only when you click the button. It never runs in the background, crawls, or reads feeds. LinkedIn changes its markup often, so a capture can degrade to the name and the profile URL. X profiles carry less data than LinkedIn profiles. Capturing someone who is already in your CRM adds nothing new; edit that record in the app.

## Development

`npm run typecheck` runs the TypeScript compiler without emitting, `npm run test` runs the unit tests. The extraction functions in `src/extract` are pure and tested against hand-built fixture HTML.
