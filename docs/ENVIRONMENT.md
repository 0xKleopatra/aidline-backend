# Environment variables

All configuration comes from environment variables, parsed and validated with zod in [`src/config.ts`](../src/config.ts). An empty value is treated as unset, so the default applies. A bad value stops the server at startup with a message naming the variable.

Copy [`.env.example`](../.env.example) to `.env` for local development.

## Server

| Variable          | Default                 | Notes                                                                                                              |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PORT`            | `4000`                  | Port the API listens on                                                                                            |
| `HOST`            | `0.0.0.0`               | Interface to bind                                                                                                  |
| `PUBLIC_BASE_URL` | `http://localhost:4000` | Public URL of this service. Used to build the metadata and proof URIs stored on chain. A trailing slash is removed |
| `CORS_ORIGINS`    | `http://localhost:3000` | Comma separated list of allowed frontend origins                                                                   |
| `UPLOAD_DIR`      | `uploads`               | Directory for proof files                                                                                          |
| `METRICS_ENABLED` | `true`                  | Serve Prometheus metrics at `GET /metrics`. Restrict that path at your proxy in production                         |

## Database

| Variable       | Default                                             | Notes                      |
| -------------- | --------------------------------------------------- | -------------------------- |
| `DATABASE_URL` | `postgres://aidline:aidline@localhost:5433/aidline` | Postgres connection string |

## Stellar and the contract

| Variable              | Default                               | Notes                                                               |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `AIDLINE_NETWORK`     | `testnet`                             | `testnet`, `mainnet` or `futurenet`. Selects the network passphrase |
| `AIDLINE_RPC_URL`     | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint                                                |
| `AIDLINE_CONTRACT_ID` | empty                                 | Contract to index. The indexer is off when this is empty            |
| `AIDLINE_TOKEN_ID`    | empty                                 | Token the contract raises in. Keep it in sync with the frontend     |

## Indexer

| Variable               | Default           | Notes                                                     |
| ---------------------- | ----------------- | --------------------------------------------------------- |
| `INDEXER_ENABLED`      | `true`            | Set to `false` to run the API alone, for example in tests |
| `INDEXER_START_LEDGER` | latest minus 1000 | Where to start on a fresh database                        |
| `INDEXER_POLL_MS`      | `5000`            | Poll interval in milliseconds. Minimum `1000`             |

## Admin and keeper

| Variable                       | Default   | Notes                                                                                      |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------ |
| `ADMIN_WALLET_ADDRESS`         | empty     | `G...` address allowed to list pending verifier applications. Empty disables the endpoint  |
| `AIDLINE_KEEPER_SECRET`        | empty     | Funded Stellar secret for `extend_campaign_ttl`. Empty disables the keeper                 |
| `CAMPAIGN_TTL_LEDGERS`         | `172800`  | Contract campaign TTL in ledgers (about 30 days at 5s per ledger). Keep in sync with chain |
| `KEEPER_TTL_THRESHOLD_LEDGERS` | `7200`    | Bump campaigns with this many ledgers or fewer left before expiry                          |
| `KEEPER_INTERVAL_MS`           | `3600000` | Sweep interval in milliseconds. Minimum `60000`                                            |

The keeper only runs when the indexer is enabled: it uses the indexed ledger to decide which campaigns are near expiry. It signs a real `extend_campaign_ttl` transaction, so the key must be funded on the configured network.

## Why the `AIDLINE_` prefix

The Stellar CLI reads `STELLAR_*` variables from `.env`. Sharing those names would make CLI commands run from this folder fail, so Aidline settings use their own prefix.

## Secrets

The backend never moves funds, but the TTL keeper does sign a transaction, so `AIDLINE_KEEPER_SECRET` is a secret. Use a dedicated, minimally funded testnet account and keep it in the environment or a secret manager, never in the repo. `DATABASE_URL` is also a secret. Do not commit `.env`. The demo seeding script reads `SEED_ADMIN_SECRET` from the shell for a single run and never stores it.
