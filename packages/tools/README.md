# @arcaai/tools — internal CLI toolbox

Internal CLI toolbox for the HOPE monorepo: a Prisma multi-domain commander, DDD code generators
(data models, entities, mappers, repositories, factories, service modules, controllers), and
development credential generators (JWT tokens, API keys). All tools run via `ts-node` package
scripts — there are no `bin` entries and the package is not consumed as a library by any other
workspace package.

## Layout

| Path | What it holds |
|---|---|
| `src/gen-api-key/` | Development API key creation (commander CLI) |
| `src/gen-dev-token/` | Development JWT generation — has its own README |
| `src/generate-controller/` | NestJS controller generator |
| `src/generate-data-entity/` | Domain entity generator (reconciler, does not create new files — see Gotchas) |
| `src/generate-data-model/` | Data model generator (the one TRUE generator) |
| `src/generate-factory/` | Factory class generator (reconciler, does not create new files) |
| `src/generate-mapper/` | Mapper generator — **destructive, do not run** (see Gotchas) |
| `src/generate-repository/` | Repository generator — **broken** (see Gotchas) |
| `src/generate-service-module/` | Service module + DTO generator |
| `src/generate-prisma-index.ts` | `index.ts` generator for generated Prisma clients |
| `src/prisma-commander/` | Prisma CLI (`index.ts`, `types/`, `utils/`) |
| `src/utils/` | Shared helpers (DMMF access, ts-morph, naming, env loading) |
| `src/index.ts` | Namespaced exports (`Utils`, `PrismaCommander`, `GenDevToken`, ...) |

## Commands

Every tool is a script in `package.json`. Invoke them either through the root-level aliases or
with `pnpm --filter`:

| Root alias (from repo root) | Package script | Purpose |
|---|---|---|
| `pnpm gen:prisma` | `prisma-commander` | Prisma operations across schema domains |
| `pnpm gen:model` | `generate-data-model` | Generate data models from Prisma schema |
| `pnpm gen:entity` | `generate-data-entity` | Reconcile domain entities + prove schema coverage |
| `pnpm gen:mapper` | `./scripts/gen-guard.sh mapper` -> `generate-mapper` | **Destructive — see Gotchas** |
| `pnpm gen:repository` | `./scripts/gen-guard.sh repository` -> `generate-repository` | **Broken — see Gotchas** |
| `pnpm gen:factory` | `generate-factory` | Reconcile factory classes + prove schema coverage |
| `pnpm gen:service` | `generate-service-module` | Generate application service modules |
| `pnpm gen:controller` | `generate-controller` | Generate NestJS controllers |
| `pnpm gen:token` | `gen-dev-token` | Generate a development JWT |
| `pnpm gen:api-key` | `gen-api-key` (runs `create`) | Create a development API key |

`gen:mapper` and `gen:repository` route through `./scripts/gen-guard.sh` at the repo root FIRST —
it requires a typed confirmation and a clean git worktree before calling the underlying package
script, so recovery is always a `git checkout` away. It is a safety net, not permission to run
either casually.

Package scripts without a root alias: `generate-prisma-index`, `generate-data-model:all|:check`,
`generate-data-entity:all|:check`, `generate-factory:all|:check`, `typecheck`.

Pass tool flags directly after the alias — pnpm forwards them to the underlying script (verified:
`pnpm gen:token -l`). Do not insert a `--` separator; pnpm forwards it literally and the tools then
ignore the flags that follow it.

```bash
pnpm gen:token -u super_admin -e 7d
# equivalent to:
pnpm --filter @arcaai/tools gen-dev-token -u super_admin -e 7d
```

## How it works

### Prisma Commander

Interactive and non-interactive CLI for managing Prisma operations across the schema domains
discovered in `packages/database` (e.g. `db_main`). It finds the monorepo root via
`pnpm-workspace.yaml`/`turbo.json` and loads `.env.dev` / `.env.test` / `.env.staging` based on
`NODE_ENV` (skipped in CI/production).

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

### Code generators — the names promise more than four of them do

Generators read the Prisma DMMF and emit code into `packages/domains` / `packages/applications`.
Only `generate-data-model` is a TRUE generator — it creates files for new models. `generate-data-entity`
and `generate-factory` are RECONCILERS: they reproduce every committed file verbatim and run a
schema-coverage check; they never create a new entity or factory file. Full behavior table and the
new-model workflow: `.claude/rules/03-domain-layer.md` "Generated Code Discipline".

```bash
pnpm gen:model                                         # interactive
pnpm --filter @arcaai/tools generate-data-model:all    # all models, overwrite
pnpm --filter @arcaai/tools generate-data-model:check  # coverage check only

pnpm gen:entity && pnpm gen:factory                    # reconcile barrels, prove coverage

# Service module generator (service interface + implementation + module + DTOs + DTO mapper)
pnpm gen:service -n UserProfile -o packages/applications/src/services -g user

pnpm gen:controller                                    # NestJS controller

pnpm --filter @arcaai/tools generate-prisma-index      # index.ts files for generated Prisma clients
```

### Development credentials

**gen-dev-token** — generates a JWT for testing API endpoints. See
[`src/gen-dev-token/README.md`](src/gen-dev-token/README.md) for full documentation.

```bash
pnpm gen:token                    # token for the default user (super_admin)
pnpm gen:token -l                 # list available users
pnpm gen:token -u super_admin -e 7d     # specific user, custom expiry
pnpm gen:token -t "tenant-uuid" -r "ADMIN,MANAGER" -p   # override tenant/roles, print payload
```

Requires `JWT_SECRET_KEY` in the workspace-root env file (the tool loads `.env` / `.env.dev`
automatically).

**gen-api-key** — creates development API keys in the database (the package script always invokes
the `create` subcommand).

```bash
pnpm gen:api-key
pnpm gen:api-key --name "Example App API Key" --type SDK --scopes read,write

# The `list` subcommand is only reachable by invoking the entry point directly:
pnpm --filter @arcaai/tools exec ts-node src/gen-api-key/index.ts list
```

`create` options: `-n/--name`, `-t/--type` (SDK, WEBHOOK, INTEGRATION, SERVICE_ACCOUNT), `--tenant`,
`--user`, `-s/--scopes`, `-r/--rate-limit`, `-e/--environment`, `-d/--description`. Raw keys are
shown only at creation time.

## Gotchas

- **Never run `pnpm gen:mapper` outside the guarded root alias.** `generate-mapper` crashes
  partway through, but not before rewriting the mappers it already processed — and its output
  DROPS the `FIELDS_NOT_WRITABLE = ['version']` strip, which is the only thing stopping `_version`
  leaking into Prisma updates. Recovery is `git checkout -- packages/domains/src/mappers/generated/core/`.
- `generate-repository` fails immediately on a bad CLI argument (`--overwrite true`) — harmless but
  useless; do not spend time debugging it as if it were a real generator.
- `gen:entity`/`gen:factory` will NOT create a file for a brand-new Prisma model — hand-author the
  entity/factory/mapper/repository first, then run these to reconcile barrels and prove coverage.
- Do not insert a `--` separator before flags on any `gen:*` alias — see Commands above.

## Adding a new tool

1. Create a folder under `src/` with an `index.ts` entry point (commander-based CLIs are the convention).
2. Add a script to `package.json` (`ts-node src/<tool>/index.ts`).
3. Optionally add a root-level `gen:*` alias in the repo root `package.json`.
4. Export from `src/index.ts` if the internals should be importable.
5. Update this README.

## Related

- [`03-domain-layer.md`](../../.claude/rules/03-domain-layer.md) — Generated Code Discipline, the new-model checklist
- [`02-database-prisma.md`](../../.claude/rules/02-database-prisma.md) — the Prisma schema these generators read
- [`src/gen-dev-token/README.md`](src/gen-dev-token/README.md)
