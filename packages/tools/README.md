# @arcaai/tools

Internal CLI toolbox for the HOPE monorepo: a Prisma multi-domain commander, DDD code generators (data models, entities, mappers, repositories, factories, service modules, controllers), and development credential generators (JWT tokens, API keys). All tools run via `ts-node` package scripts — there are no `bin` entries and the package is not consumed as a library by any other workspace package.

Last updated: 2026-07-04

## Running the Tools

Every tool is a script in [package.json](./package.json). Invoke them either through the root-level aliases or with `pnpm --filter`:

| Root alias (from repo root) | Package script | Purpose |
|---|---|---|
| `pnpm gen:prisma` | `prisma-commander` | Prisma operations across schema domains |
| `pnpm gen:model` | `generate-data-model` | Generate data models from Prisma schema |
| `pnpm gen:entity` | `generate-data-entity` | Generate domain entities |
| `pnpm gen:mapper` | `generate-mapper` | Generate entity/model mappers |
| `pnpm gen:repository` | `generate-repository` | Generate repository classes |
| `pnpm gen:factory` | `generate-factory` | Generate factory classes |
| `pnpm gen:service` | `generate-service-module` | Generate application service modules |
| `pnpm gen:controller` | `generate-controller` | Generate NestJS controllers |
| `pnpm gen:token` | `gen-dev-token` | Generate a development JWT |
| `pnpm gen:api-key` | `gen-api-key` (runs `create`) | Create a development API key |

Package scripts without a root alias: `generate-prisma-index`, `generate-data-model:all|:check`, `generate-data-entity:all|:check`, `generate-factory:all|:check`, `typecheck`.

Pass tool flags directly after the alias — pnpm forwards them to the underlying script (verified: `pnpm gen:token -l`). Do not insert a `--` separator; pnpm forwards it literally and the tools then ignore the flags that follow it.

```bash
pnpm gen:token -u admin -e 7d
# equivalent to:
pnpm --filter @arcaai/tools gen-dev-token -u admin -e 7d
```

## Prisma Commander

Interactive and non-interactive CLI for managing Prisma operations across the schema domains discovered in `packages/database` (e.g. `db_main`). It finds the monorepo root via `pnpm-workspace.yaml`/`turbo.json` and loads `.env.dev` / `.env.test` / `.env.staging` based on `NODE_ENV` (skipped in CI/production).

```bash
# Interactive mode (default when no subcommand is given)
pnpm gen:prisma

# Non-interactive subcommands
pnpm gen:prisma generate --all              # regenerate Prisma clients
pnpm gen:prisma generate --domain db_main
pnpm gen:prisma push --all                  # prisma db push
pnpm gen:prisma push --domain db_main --force   # force reset (data loss)
pnpm gen:prisma migrate --domain db_main --name add_users_table
pnpm gen:prisma seed                        # run seed scripts
pnpm gen:prisma studio --domain db_main     # Prisma Studio
pnpm gen:prisma list:activities             # alias: la
pnpm gen:prisma list:domains                # alias: ld
```

| Option | Short | Applies to | Description |
|---|---|---|---|
| `--domain <names...>` | `-d` | generate, push, migrate, studio | Domain name(s) to process |
| `--all` | `-a` | generate, push, migrate | Process all domains |
| `--force` | `-f` | push | Force reset (`--force-reset --accept-data-loss`) |
| `--name <name>` | `-n` | migrate | Migration name |

## Code Generators

Generators read the Prisma DMMF and emit code into `packages/domains` / `packages/applications` following the repo's DDD layering. Most support interactive prompts plus flags; the `:all` variants run non-interactively for every model and the `:check` variants verify coverage without writing.

```bash
pnpm gen:model                                         # interactive
pnpm --filter @arcaai/tools generate-data-model:all    # all models, overwrite
pnpm --filter @arcaai/tools generate-data-model:check  # coverage check only

pnpm gen:entity && pnpm gen:mapper && pnpm gen:repository && pnpm gen:factory

# Service module generator (service interface + implementation + module + DTOs + DTO mapper)
pnpm gen:service -n UserProfile -o packages/applications/src/services -g user

pnpm gen:controller                                    # NestJS controller

pnpm --filter @arcaai/tools generate-prisma-index      # index.ts files for generated Prisma clients
```

## Development Credentials

### gen-dev-token

Generates a JWT for testing API endpoints. See [src/gen-dev-token/README.md](./src/gen-dev-token/README.md) for full documentation.

```bash
pnpm gen:token                    # token for the default user (super_admin)
pnpm gen:token -l                 # list available users
pnpm gen:token -u admin -e 7d     # specific user, custom expiry
pnpm gen:token -t "tenant-uuid" -r "ADMIN,MANAGER" -p   # override tenant/roles, print payload
```

Requires `JWT_SECRET_KEY` in the workspace-root env file (the tool loads `.env` / `.env.dev` automatically).

### gen-api-key

Creates development API keys in the database (the package script always invokes the `create` subcommand).

```bash
pnpm gen:api-key
pnpm gen:api-key --name "Example App API Key" --type SDK --scopes read,write

# The `list` subcommand is only reachable by invoking the entry point directly:
pnpm --filter @arcaai/tools exec ts-node src/gen-api-key/index.ts list
```

`create` options: `-n/--name`, `-t/--type` (SDK, WEBHOOK, INTEGRATION, SERVICE_ACCOUNT), `--tenant`, `--user`, `-s/--scopes`, `-r/--rate-limit`, `-e/--environment`, `-d/--description`. Raw keys are shown only at creation time.

## Project Structure

```
src/
├── gen-api-key/                # Development API key creation (commander CLI)
├── gen-dev-token/              # Development JWT generation (has its own README)
├── generate-controller/        # NestJS controller generator
├── generate-data-entity/       # Domain entity generator
├── generate-data-model/        # Data model generator
├── generate-factory/           # Factory class generator
├── generate-mapper/            # Mapper generator
├── generate-repository/        # Repository generator
├── generate-service-module/    # Service module + DTO generator
├── generate-prisma-index.ts    # index.ts generator for Prisma clients
├── prisma-commander/           # Prisma CLI (index.ts, types/, utils/)
├── utils/                      # Shared helpers (DMMF access, ts-morph, naming, env loading)
└── index.ts                    # Namespaced exports (Utils, PrismaCommander, GenDevToken, ...)
```

## Adding a New Tool

1. Create a folder under `src/` with an `index.ts` entry point (commander-based CLIs are the convention).
2. Add a script to [package.json](./package.json) (`ts-node src/<tool>/index.ts`).
3. Optionally add a root-level `gen:*` alias in the repo root `package.json`.
4. Export from [src/index.ts](./src/index.ts) if the internals should be importable.
5. Update this README.
