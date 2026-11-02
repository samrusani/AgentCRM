# AgentCRM

AgentCRM is a local first, open source CRM built for agent workflows. People and coding agents work through the same core: one action service behind the web UI, the CLI, and an MCP server. Your data lives in a SQLite file on your own computer, so there is no network round trip between you and your records.

Status: early development, not yet ready for real work. The app runs locally with synthetic demo data, and a simulated research run shows the run and approval machinery end to end. Apify imports are the first live provider: bring your own Apify account, run any store Actor, and review staged results before they become records. LinkedIn lead capture builds on it: paste a post URL and the agent scrapes who reacted or commented through your Apify account, enriches the new people with one batched profile run, and stages everything for one review; known and already staged people are excluded before enrichment is bought. Model backed chat and outreach drafting work with your own model access: Anthropic, OpenAI, DeepSeek, or Z.ai keys, or a local Ollama server, with one active provider chosen in Settings; every cost shown is an estimate from list prices. Sending works through your own AgentMail account: every message is approved word for word before it goes out, submits reuse the provider's duplicate protection so retries do not send twice within its roughly one day window (an attempt whose outcome stays unknown past that window is surfaced to you, never retried), replies and opt outs are handled, and neither MCP, chat, nor the CLI can approve or submit a send. Connector tokens and keys are stored unencrypted in the local database file, which is created with owner only permissions.

## Why another CRM

Most CRMs treat AI as a chat box bolted onto a database. AgentCRM is built the other way around:

- Every agent action goes through the same audited action service as a human click.
- Every scraped or inferred fact keeps its source and verification status.
- Nothing external happens without an approval, and editing an approved payload invalidates the approval.
- The interface stays useful with no model connected: read, edit, search, and filter all work offline.

Compared with hosted tools such as Attio, Clay, and folk, this project is built around a different combination: local first, open source, operable by agents through MCP and a CLI, data in a file you own, no per seat pricing.

## Quick start

Requires Node.js 22 or newer. No Docker, no accounts, no external services.

```bash
git clone <repository-url>
cd AgentCRM
npm run setup
npm run seed
npm run dev
```

Open http://127.0.0.1:5173 in your browser. The API listens on http://127.0.0.1:4720. Both bind to loopback only.

`npm run seed` fills the database with clearly synthetic demo data: fictional investors, funds, and companies. All demo names are invented, and any resemblance to a real person or organization is coincidental.

## What works today

| Area | Status |
| --- | --- |
| Relationships: people and organizations with search and detail views | Working, synthetic data |
| Pipeline: opportunities in board and table views with stage history | Working |
| Research: runs with live steps, counts, and partial results | Simulated demo run only |
| Agent panel: chat, run progress, approvals | Working; model backed with your own key for Anthropic, OpenAI, DeepSeek, or Z.ai, or a local Ollama server; honest deterministic replies with none |
| Draft outreach: model written drafts with budgets, review before saving | Working, verified against stubbed provider APIs; drafts are never sent |
| Approvals: review, approve, reject, audit trail | Working |
| Evidence: field claims with source and verification status | Working, synthetic sources |
| Apify imports: run any store Actor, staged rows, dedupe, review before anything is saved | Working, verified against a stubbed Apify API; bring your own Apify account |
| CSV import: column mapping, staged rows, same dedupe and review as Apify | Working, UI and CLI |
| LinkedIn lead capture: paste a post URL, scrape reactions and comments, enrich new people, one review | Working, verified against a stubbed Apify API; runs on your own Apify account |
| Qualification: editable criteria, per criterion verdicts with evidence, fit sort | Working; unknown never counts as a match |
| MCP server over stdio | Working, read and propose tools; can start qualify runs, allowlisted Apify runs, allowlisted lead captures, and budgeted draft runs |
| CLI: doctor, seed, serve, search, runs | Working |
| Email: AgentMail connector, reviewed sends with idempotent submits, replies, opt outs, bounces, suppressions | Working, verified against a stubbed AgentMail API; bring your own account. Gmail not built |
| Model costs: per call usage rows, per run estimates from list prices | Working, always labelled estimates |

## Documentation

- [Architecture and API contract](docs/architecture.md)
- [Design system](docs/design.md)
- [AGENTS.md](AGENTS.md) for coding agents working in this repository
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
