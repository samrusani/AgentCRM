# Security policy

AgentCRM is local first software in early development. It has not had a security audit.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub security advisories on this repository. Do not open a public issue for a security problem. Include steps to reproduce and the version or commit you tested.

## Design posture

- The API server and web app bind to loopback (127.0.0.1) only. Exposing them to a network is an explicit, unsupported configuration for now.
- The database is a local SQLite file under `data/`, which is never committed. Connector secrets, such as the Apify API token, are stored in it unencrypted; the file and its directory are created with owner only permissions on macOS and Linux. Anyone who can read your user account's files can read the token.
- There is no authentication layer yet because the server only accepts loopback connections. A session layer is planned before any network accessible deployment mode.
- Content from the web, imported files, and email is treated as untrusted data, never as instructions. Agent tool calls cannot approve their own actions.

## Out of scope for now

Reports about missing TLS, missing authentication on loopback, or hosting the current build on a public network describe known, documented limitations rather than vulnerabilities.
