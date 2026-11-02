# Contributing

Thanks for your interest in AgentCRM. The project is in early development, so expect the contracts in `docs/` to move.

## Development setup

Requires Node.js 22 or newer.

```bash
npm run setup
npm run seed
npm run dev
```

The API runs on http://127.0.0.1:4720 and the web app on http://127.0.0.1:5173.

## Before you open a pull request

- Read [AGENTS.md](AGENTS.md). The rules there apply to human contributors too.
- Run `npm run build` and `npm run test` and make sure both pass.
- If your change alters behavior, update README.md and the relevant file in `docs/` in the same pull request.
- Keep pull requests focused on one change.

## Writing style

This applies to documentation, code comments, commit messages, and UI copy.

- Plain, concrete language. Say what a thing does, not how impressive it is.
- Sentence case for headings, labels, and buttons.
- Active voice. A button says exactly what it does.
- No em dashes. Use a comma, a colon, parentheses, or a new sentence.
- Avoid filler adjectives such as seamless, powerful, robust, cutting edge, and blazingly fast. Claims about speed or capability belong next to their evidence.
- State honest status. A feature that is simulated, partial, or untested is labelled that way.

## Data rules

- No secrets, tokens, or credentials in any file, test, or fixture.
- No real people, companies, or email addresses in demo data or tests. Use fictional names with example.com or example.org domains.
- No absolute paths from your machine in committed files.
