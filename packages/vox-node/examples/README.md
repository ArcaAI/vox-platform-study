# `@arcaai/vox-node` examples

Small, runnable, dependency-free scripts against the real `HopeClient` API.
Each file has a header comment explaining what it demonstrates and which env
vars it needs.

| File | Shows |
|---|---|
| [`01-summary.ts`](./01-summary.ts) | Stateless summary from a transcript — the 60-second quickstart |
| [`02-presummary-stream.ts`](./02-presummary-stream.ts) | Streaming a pre-summary: iterating deltas, then `.result()` |
| [`03-consultation-async.ts`](./03-consultation-async.ts) | `generateAsync` + `jobs.waitFor` — the recommended pattern for long transcripts |
| [`04-error-handling.ts`](./04-error-handling.ts) | Catching the typed error hierarchy, incl. the 404-over-403 nuance |

## Running an example

Each script reads its config from environment variables — no config file, no
CLI flags:

```bash
export HOPE_API_URL=http://localhost:8868
export HOPE_API_KEY=<your API key>

npx tsx examples/01-summary.ts
```

`npx tsx` runs a TypeScript file directly with no build step. If you don't
have `tsx` available, `pnpm dlx tsx examples/01-summary.ts` works the same
way without a local install.

`03-consultation-async.ts` additionally needs `HOPE_CONSULTATION_ID` — an
existing consultation id in your tenant, since this SDK does not create
consultations (see the package README's "The two summarization families").

## Getting an API key

- **Local dev stack**: keys are seeded by
  [`packages/database/src/prisma/db_main/seed/02-apikey.ts`](../../database/src/prisma/db_main/seed/02-apikey.ts).
  Read that file to find (or mint) a key for your local stack — do not paste
  a key value into this README, an example file, or any other tracked file.
- **Any other environment**: mint a key through the HOPE admin console's API
  key management screen, or ask your platform admin. Match the key's scopes
  to what you intend to call — see the package README's
  ["Required API-key scopes, per method"](../README.md#required-api-key-scopes-per-method)
  table.

## What these are not

These are illustrations, not a test suite — they call a real, running HOPE
gateway and print to stdout. For automated coverage, see the package's own
`src/**/__tests__/*.test.ts` (`pnpm --filter @arcaai/vox-node test`).
