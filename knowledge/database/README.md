# @arcaai/database

Prisma 7 database package for the HOPE monorepo. Provides a configured PostgreSQL client with soft-delete extensions, generated types, schema definitions, migration tooling, and seed scripts.

## Architecture

```
@arcaai/database
├── client.ts                 # Prisma singleton + soft-delete extension
├── env.ts                    # Environment loader (.env.dev / .env.test / .env.production)
├── generated/                # Auto-generated Prisma client (do not edit)
│   └── core-prisma-client/
└── prisma/db_main/           # Schema files, migrations, seeds
    ├── schema.prisma         # Datasource + generator config
    ├── enums.prisma          # Shared enumerations
    ├── user.prisma           # User, UserProfile, UserGroup, etc.
    ├── tenant.prisma         # Tenant model
    ├── rbac.prisma           # Role, Policy, RolePolicy
    ├── consultation.prisma   # Consultation, ContextItem, AudioRecording
    ├── stt.prisma            # AiModel, AsrPipeline, TranscriptionJob
    ├── media.prisma          # Media file tracking
    └── seed/                 # Seed scripts (ordered by numeric prefix)
```

## Package Info

| Field | Value |
|-------|-------|
| **Package** | `@arcaai/database` |
| **Version** | `0.1.0` |
| **ORM** | Prisma 7 with `@prisma/adapter-pg` |
| **Database** | PostgreSQL |
| **Schemas** | `public`, `core` |
| **Module Type** | ESM (`"type": "module"`) |

## Key Features

| Feature | Description |
|---------|-------------|
| **Prisma 7 Driver Adapter** | Uses `@prisma/adapter-pg` — connection string is provided in application code, not in the schema file |
| **Soft-Delete Extension** | Client extension automatically filters `resourceStatus: DELETED` from all read queries |
| **Singleton Pattern** | `getPrismaClient()` and `getExtendedPrismaClient()` ensure a single connection pool |
| **Preview Features** | `fullTextSearchPostgres`, `postgresqlExtensions`, `relationJoins`, `views`, `typedSql` |

## Getting Started

### 1. Set Environment Variables

Create a `.env.dev` file in the package root:

```
DATABASE_URL="postgresql://username:password@localhost:5432/arcaai"
```

| File | Purpose |
|------|---------|
| `.env.dev` | Local development (`NODE_ENV=development`) |
| `.env.test` | Test environment (`NODE_ENV=test`) |
| `.env.production` | Production reference (runtime uses host env vars) |

### 2. Generate the Prisma Client

```bash
pnpm --filter @arcaai/database db:generate
```

This runs `prisma generate` and then auto-generates the re-export index file.

### 3. Push Schema to Database (Development)

```bash
pnpm --filter @arcaai/database db:push
```

### 4. Seed the Database

```bash
pnpm --filter @arcaai/database seed
```

## Client Usage

```typescript
// Recommended: extended client with soft-delete filtering
import { getExtendedPrismaClient } from '@arcaai/database';
const prisma = getExtendedPrismaClient();

// Base client (bypasses soft-delete filter)
import { getPrismaClient } from '@arcaai/database';
const prisma = getPrismaClient();

// Fresh connection (not singleton — use sparingly)
import { createNewPrismaClient } from '@arcaai/database';

// Types and enums
import { Prisma, ResourceStatusType } from '@arcaai/database';
import type { CorePrismaClient, ExtendedCorePrismaClient } from '@arcaai/database';
```

## Soft-Delete Extension

The extended client intercepts read operations and adds `WHERE resourceStatus != 'DELETED'` automatically.

**Filtered operations:** `findMany`, `findFirst`, `count`, `aggregate`, `groupBy`

> **Note:** `findUnique` is intercepted but does **not** apply the soft-delete filter because its where clause structure doesn't support complex conditions like `{ not: 'DELETED' }`. Use `findFirst` for strict soft-delete filtering on unique lookups.

> **Important:** Not all models have `resourceStatus`. Eight models (version history, usage tracking, extracted metadata) are excluded from soft-delete filtering. See [Soft-Delete Architecture](./03_SOFT_DELETE.md) for the full list and the defense-in-depth strategy.

**Bypass soft-delete** by explicitly setting `resourceStatus` in the where clause:

```typescript
const prisma = getExtendedPrismaClient();

// Normal query — DELETED records excluded automatically
const users = await prisma.user.findMany();

// Include deleted records
const allUsers = await prisma.user.findMany({
  where: { resourceStatus: undefined },
});

// Only deleted records
const deleted = await prisma.user.findMany({
  where: { resourceStatus: 'DELETED' },
});
```

## Schema Overview

### Standard Model Fields

Every model follows the BaseEntity pattern:

```prisma
model Example {
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    tenantId String? @default("50000000-0000-0000-0000-000000000000")

    // ... business fields ...

    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?

    createdBy String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy String?
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    tags String[] @default([])

    @@index([tenantId], name: "Example_tenantId_idx")
    @@schema("core")
}
```

### Key Models

| Schema File | Models | Description |
|-------------|--------|-------------|
| `user.prisma` | `User`, `UserProfile`, `UserSettings`, `UserGroup`, `UserRoleAssignment`, `UserGroupRoleAssignment`, `UserMedia` | User identity, profiles, groups, role bindings |
| `tenant.prisma` | `Tenant` | Multi-tenant organizations |
| `rbac.prisma` | `Role`, `Policy`, `RolePolicy` | CASL policy-based authorization |
| `consultation.prisma` | `Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `NamedEntity`, `ContextItemVersion` | Clinical consultation workflow |
| `stt.prisma` | `AiModel`, `AsrPipeline`, `TranscriptionJob` | Speech-to-text AI pipeline |
| `media.prisma` | `Media` | File metadata (name, URI, MIME type, hash) |
| `department.prisma` | `Department` | Department lookup table |
| `apikey.prisma` | `ApiKey` | API key management |
| `notification.prisma` | `Notification`, `ResourceSubscription` | User notifications and resource subscriptions |
| `webhook.prisma` | `Webhook`, `WebhookRunHistory` | Webhook endpoints and execution history |
| `tag.prisma` | `Tag` | Resource tagging |
| `audit.prisma` | `AuditLog` | Audit trail |
| `globalSetting.prisma` | `GlobalSetting` | System-wide settings |
| `dna-writing-style.prisma` | `DnaWritingStyleReport`, `DnaWritingStyleVersion`, `DnaUsageRecord`, `PromptUsageRecord` | Doctor writing style analysis, versions, and usage tracking |
| `prompt-template.prisma` | `PromptTemplate`, `PromptVersion` | AI prompt templates and versioning |
| `fedl.prisma` | `FedlClient`, `FedlRound`, `FedlUpdate`, `FedlModelVersion` | Federated learning models |

### Resource Status Enum

| Status | Description |
|--------|-------------|
| `ENABLED` | Active record (default) |
| `DISABLED` | Temporarily deactivated |
| `ARCHIVED` | Historical, read-only |
| `DELETED` | Soft-deleted — filtered by extension |

## Migration Workflow

### Creating a Migration

```bash
# Development — creates migration SQL and applies it
pnpm --filter @arcaai/database db:migrate

# Equivalent to:
npx prisma migrate dev --name describe_your_changes
```

### Deploying Migrations

```bash
# Production — applies pending migrations without generating
pnpm --filter @arcaai/database db:migrate:deploy
```

### Command Reference

| Command | Script | Description |
|---------|--------|-------------|
| `db:generate` | `prisma generate` | Regenerate Prisma client from schema |
| `db:migrate` | `prisma migrate dev` | Create and apply a migration (dev) |
| `db:migrate:deploy` | `prisma migrate deploy` | Apply pending migrations (production) |
| `db:push` | `prisma db push` | Push schema without migrations (dev prototyping) |
| `db:push:force` | `prisma db push --force-reset --accept-data-loss` | Force push with data loss (dev only) |
| `db:studio` | `prisma studio` | Launch Prisma Studio GUI |
| `seed` | `tsx src/index.ts` | Run seed scripts |

### Migration Naming Convention

Use lowercase with underscores: `add_user_authentication`, `create_session_table`, `add_consultation_department_fk`.

### Rollback Strategy

| Scenario | Action |
|----------|--------|
| **Not yet deployed** | Delete migration folder, revert schema changes, create a new migration |
| **Already deployed** | Create a new revert migration — never modify existing migration files |

## Seeding

Seed scripts are located in `src/prisma/db_main/seed/` and run in numeric order:

| File | Seeds |
|------|-------|
| `00-constants.ts` | Shared seed IDs and constants |
| `01-policy.ts` | CASL policy definitions |
| `02-apikey.ts` | Default API keys |
| `03-role.ts` | System roles |
| `04-department.ts` | Department lookup data |
| `05-tenant.ts` | Default tenant |
| `06-stt.ts` | STT pipeline and model defaults |
| `07-prompt-template.ts` | Prompt templates |
| `08-dna-writing-style.ts` | DNA writing style presets |
| `91-user.ts` | Default users (admin, service accounts) |

Run seeding:

```bash
pnpm --filter @arcaai/database seed
```

## Configuration

The `DATABASE_URL` follows standard PostgreSQL format:

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=core
```

Logging is controlled by `NODE_ENV`:
- **development**: logs queries, errors, and warnings
- **production**: logs errors only

## Build

```bash
pnpm build     # Compile TypeScript
pnpm clean     # Remove dist and build info
pnpm nuke      # Remove dist, node_modules, and cache
```

## Related Packages

- [Soft-Delete Architecture](./03_SOFT_DELETE.md) — Model-aware filtering, defense-in-depth layers, troubleshooting
- [Data Model & Entity Relationships](./01_DATA_MODEL.md) — Schema definitions, field types, enums, relationships
- [DDD Patterns](./02_DDD_PATTERNS.md) — Repository, Mapper, Entity, Factory patterns
- [Seed Data Reference](./seed-data.md) — Seed constants, execution order, test fixtures
- [`@arcaai/domains`](../domains/README.md) — Domain entities and repositories built on top of this client
- [`@arcaai/applications`](../applications/README.md) — Business services that query via repositories
- [`@arcaai/tools`](../tools/README.md) — Prisma Commander CLI and code generators
