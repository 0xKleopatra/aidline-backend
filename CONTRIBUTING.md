# Contributing to Aidline Backend

Thanks for helping make relief and climate funding transparent. This guide gets you from clone to merged pull request.

## Finding something to work on

- Issues labelled `good first issue` are small and well scoped.
- Every issue lists acceptance criteria and the files you will likely touch. Ask in the issue if anything is unclear.
- Comment on an issue to get assigned before you start.

## Working on a Stellar Wave issue

Issues labelled `Stellar Wave` are part of the [Stellar Wave program on Drips](https://docs.drips.network/wave/). Contributors earn points for resolved issues and share the Wave reward pool in proportion to their points.

| Complexity | Label                 | Points |
| ---------- | --------------------- | ------ |
| Trivial    | `complexity: trivial` | 100    |
| Medium     | `complexity: medium`  | 150    |
| High       | `complexity: high`    | 200    |

How it works:

1. Pick an open issue and comment to ask for it. A maintainer assigns it to you. Please take one issue at a time and check nobody else is already assigned.
2. Read the acceptance criteria. Every box needs to be true for the issue to count as resolved.
3. Open a pull request that links the issue with `Closes #123`. Keep it focused on that one issue.
4. Respond to review comments. A maintainer merges the pull request and marks the issue resolved, which awards the points.

Quality matters more than speed. Pull requests are reviewed for understanding, not just for passing checks:

- Write and run the tests for your change. Do not submit code you have not run or cannot explain.
- Do not open pull requests that only fix typos or reformat files to collect points.
- If you use an AI assistant, you are still responsible for every line. Pull requests that look untested or not understood will be closed.
- Do not claim several issues at once or comment on assigned issues asking to be reassigned.

See the Drips [Terms and rules](https://docs.drips.network/wave/terms-and-rules/) for the full conduct rules.

## Local setup

```sh
git clone https://github.com/aidline-org/aidline-backend
cd aidline-backend
npm install
cp .env.example .env
npm run dev:db     # keep running
npm run dev
npm test
```

Tests start their own temporary Postgres, so they work without `dev:db` running.

### Using a hosted Postgres for development

If you cannot run Docker, a free hosted Postgres such as [Neon](https://neon.tech) works too. Create a **development-only** database (or a separate branch in your hosted project), then put its connection string in `.env`:

```sh
DATABASE_URL=postgres://<user>:<password>@<host>/aidline_dev?sslmode=require
```

`sslmode=require` is needed because hosted providers require TLS. `npm run migrate` and `npm run dev` use whatever `DATABASE_URL` points at, so check the value before running either command.

> **Never point development at the production database.** Use a dedicated dev database and testnet accounts only. Migrations and the demo seed script write to the database named in `DATABASE_URL`; a mistake there can destroy real data. Keep the connection string out of commits — `.env` is gitignored.

`npm test` starts its own temporary Postgres and ignores `DATABASE_URL`, so tests never touch your hosted database.

## Making a change

1. Fork the repo and branch: `git checkout -b feat/short-description`
2. Keep pull requests focused on one issue.
3. Add tests in `test/`. Route changes need an API test, indexer changes need an indexer test.
4. Run the checks CI runs:
   ```sh
   npm run lint
   npm run typecheck
   npm test
   npx prettier --check .
   ```
5. Schema changes go in a new numbered file in `src/db/migrations/`. Never edit a migration that has already been merged.
6. Update `docs/API.md` if you change a request or response.
7. Open a pull request, fill in the template and link the issue with `Closes #123`.

## Security checks

Every pull request runs the `Security` workflow, and its `security` job must pass before anything can merge. It checks that:

- no new dependency has a known high or critical advisory, including packages GitHub has flagged as malware
- every package in `package-lock.json` comes from the public npm registry
- the pull request does not add a package that runs an install script, which is where most npm malware hides
- the commits in the pull request contain no secrets or keys

If a check fails, read the log, fix the cause and push again. If you think it is a false positive, explain why in the pull request and a maintainer will look at it. Do not edit files under `.github/` to make a check pass. Changes there always need the project lead's review.

Maintainers, before merging a pull request:

1. Confirm the `security` check has passed.
2. Read the whole diff, not just the description.
3. Question anything unusual: new dependencies, lockfile changes, install scripts, changes under `.github/`, obfuscated code or long encoded strings, unknown URLs, and code that reads environment variables or sends data somewhere.
4. Do not run a pull request's code on your machine before you have read it.
5. Leave the `Stellar Wave` label, complexity and points to the project lead.

## Code guidelines

- Validate every request with zod. Errors are turned into `400` responses automatically.
- Keep token amounts as strings or `bigint`. Never `Number()` an amount.
- SQL lives next to the route that uses it. Always use parameters (`$1`), never string interpolation of user input.
- The contract is the source of truth. Do not compute balances that the chain already knows.

## Commit messages

Use a short prefix: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`. Example: `feat: add donor refund history endpoint`.
