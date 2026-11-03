# AGENTS.md

Instructions for coding agents working in this repository.

## Commands

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `npm run setup` | Install dependencies for the root, server, and web app |
| `npm run seed` | Create the local database and fill it with synthetic demo data |
| `npm run dev` | Start the API server (port 4720) and the web app (port 5173) |
| `npm run build` | Type check and build both apps |
| `npm run test` | Run the server test suite, then the web test suite |
| `npm run doctor` | Check Node version, database state, and port availability |

## Layout

| Path | Contents |
| --- | --- |
| `apps/server` | Fastify API, SQLite database, action service, job worker, CLI, MCP server |
| `apps/web` | React web app built with Vite |
| `docs/` | Architecture contract and design system |
| `data/` | Local database files, never committed |

## Rules

1. Every write goes through the action service in `apps/server/src/actions/`. Routes, jobs, the CLI, and MCP handlers never touch the database directly for mutations.
2. Every record is workspace scoped. Every query filters by `workspace_id`.
3. Mutations carry `expectedVersion`. A mismatch returns HTTP 409 with error code `version_conflict` and the current record.
4. Database writes happen only in the API server and MCP server processes, always through the action service, in short immediate transactions. No other process opens the database for writing.
5. No secrets, no real personal data, and no absolute paths from any contributor's machine anywhere in this repository. Demo data uses fictional names and example.com domains.
6. Writing style, for documentation, code comments, and UI copy: plain concrete language, sentence case, active voice. No em dashes. No marketing filler.
7. When a change alters behavior, update README.md and the relevant file in `docs/` in the same change.

## Contracts

- API endpoints, data shapes, and error codes: [docs/architecture.md](docs/architecture.md)
- Visual tokens, components, and copy rules: [docs/design.md](docs/design.md)
