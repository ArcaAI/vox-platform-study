# @arcaai/database

Database package for the HOPE platform, containing Prisma schema definitions, database client configuration, migration management, and seeding scripts.

## Overview

The `@arcaai/database` package provides the data access layer for the HOPE platform using Prisma 7 with the PostgreSQL adapter. It includes a singleton Prisma client with a soft-delete extension that automatically filters deleted records, schema definitions following standardized model conventions, and database seeding utilities.

## Usage

```typescript
import { getExtendedPrismaClient } from '@arcaai/database';

const prisma = getExtendedPrismaClient();
const users = await prisma.user.findMany();
```

## Structure

- `src/client.ts` - Prisma client singleton with soft-delete extension
- `src/prisma/db_main/` - Prisma schema files and seed scripts
- `src/generated/` - Auto-generated Prisma client

## Development

### Setup

Create a `.env` file with your database connection string:

```
DATABASE_URL="postgresql://username:password@localhost:5432/hope"
```

#### Pool sizing (Prisma 7 — TASK-302 Stream C Phase 0)

In Prisma 7, the driver adapter (`@prisma/adapter-pg`) owns pool sizing —
the legacy `connection_limit` URL parameter is ignored. The HOPE client
in `src/client.ts` reads two env vars:

| Env var          | Default | Purpose                                          |
|------------------|---------|--------------------------------------------------|
| `PRISMA_PG_MAX`  | `5`     | `max` connections per pool (per pod).            |
| `DIRECT_URL`     | unset   | Un-pooled URL consumed by `prisma.config.ts` for migrations. Required after the PgBouncer cutover (TASK-302 Stream C Phase 2A/2B); optional today. |

The client also pins `connectionTimeoutMillis = 5_000` and
`idleTimeoutMillis = 300_000` so a saturated pool fails fast and idle
backends survive Patroni / PgBouncer keep-alives.

**Budget rule** for `PRISMA_PG_MAX`:

```
pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections
```

See [`docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md`](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md)
for the full rationale, validation rig, and rollout plan.

### Commands

- `pnpm build` - Build the package
- `pnpm dev` - Build in watch mode
- `pnpm lint` - Lint the code
- `pnpm seed` - Run the database seeding script

### Schema Management

```bash
# Generate Prisma client after schema changes
npx prisma generate

# Create and apply a new migration
npx prisma migrate dev --name describe_your_changes

# Deploy migrations to production
npx prisma migrate deploy
```

## Key Features

- **Prisma 7** with `@prisma/adapter-pg` for PostgreSQL
- **Soft-Delete Extension** - Automatically filters `resourceStatus: DELETED` records
- **Singleton Pattern** - `getPrismaClient()` and `getExtendedPrismaClient()`
- **Standardized Models** - All models include UUIDv7 IDs, audit fields, multi-tenancy, and resource status

## License

MIT
