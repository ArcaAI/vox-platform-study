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
