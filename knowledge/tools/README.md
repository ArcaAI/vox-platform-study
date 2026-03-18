# @arcaai/tools

CLI tools and code generators for the HOPE monorepo. Provides an interactive Prisma management CLI, a full suite of code generators that scaffold domain and application modules from the Prisma schema, and a development JWT token generator.

## Architecture

```
@arcaai/tools
├── prisma-commander/         # Interactive CLI for database operations
├── generate-data-entity/     # Entity class generator
├── generate-data-model/      # Data model class generator
├── generate-factory/         # Factory class generator
├── generate-mapper/          # Mapper class generator
├── generate-repository/      # Repository class generator
├── generate-service-module/  # Full service module generator
├── generate-controller/      # NestJS controller generator
├── generate-prisma-index/    # Prisma re-export index generator
├── gen-dev-token/            # Development JWT token generator
└── utils/                    # Shared utilities (naming, paths, ts-morph)
```

## Package Info

| Field | Value |
|-------|-------|
| **Package** | `@arcaai/tools` |
| **Version** | `0.1.0` |
| **Runtime** | TypeScript 5.8, ts-node |
| **Key Dependencies** | `commander`, `inquirer`, `chalk`, `handlebars`, `ts-morph`, `@prisma/internals`, `@prisma/generator-helper` |

## Prisma Commander

Interactive and non-interactive CLI for managing Prisma database operations across all schema domains.

### Interactive Mode

```bash
pnpm --filter @arcaai/tools prisma-commander
# or explicitly:
pnpm --filter @arcaai/tools prisma-commander interactive
```

Prompts you to select an activity and target domain(s).

### Non-Interactive Commands

```bash
# Generate Prisma clients
pnpm --filter @arcaai/tools prisma-commander generate --all
pnpm --filter @arcaai/tools prisma-commander generate --domain db_main

# Push schema to database
pnpm --filter @arcaai/tools prisma-commander push --domain db_main
pnpm --filter @arcaai/tools prisma-commander push --domain db_main --force

# Create a migration
pnpm --filter @arcaai/tools prisma-commander migrate --domain db_main --name add_users_table

# Run seed scripts
pnpm --filter @arcaai/tools prisma-commander seed

# Launch Prisma Studio
pnpm --filter @arcaai/tools prisma-commander studio --domain db_main

# List available activities and domains
pnpm --filter @arcaai/tools prisma-commander list:activities
pnpm --filter @arcaai/tools prisma-commander list:domains
```

### Activities

| Activity | Command | Description |
|----------|---------|-------------|
| `generate` | `generate` | Regenerate Prisma clients for selected domains |
| `push` | `push` | Push schema to database (`prisma db push`) |
| `push:force` | `push --force` | Force push with data loss (`--force-reset`) |
| `migrate` | `migrate` | Create a new migration (`prisma migrate dev`) |
| `seed` | `seed` | Run database seed scripts |
| `studio` | `studio` | Start Prisma Studio for visual database inspection |

### Command Options

| Option | Short | Description |
|--------|-------|-------------|
| `--domain <names...>` | `-d` | Domain name(s) to process |
| `--all` | `-a` | Process all domains |
| `--force` | `-f` | Force operation (for push) |
| `--name <name>` | `-n` | Migration name (for migrate) |
| `--help` | `-h` | Show help |

## Code Generators

All generators read the Prisma schema via `@prisma/internals` DMMF (Data Model Meta Format) and produce TypeScript source files using Handlebars templates and `ts-morph`.

### Generator Catalog

| Generator | Command | Output Location | Description |
|-----------|---------|-----------------|-------------|
| **Data Entity** | `pnpm generate-data-entity` | `packages/domains/src/entities/` | Entity class with typed properties, getters/setters, change tracking |
| **Data Model** | `pnpm generate-data-model` | `packages/domains/src/models/` | Database model class mirroring Prisma schema structure |
| **Factory** | `pnpm generate-factory` | `packages/domains/src/factories/` | Factory class with UUIDv7 generation and default values |
| **Mapper** | `pnpm generate-mapper` | `packages/domains/src/mappers/` | Mapper with auto-mapping, singleton pattern, and custom handler hooks |
| **Repository** | `pnpm generate-repository` | `packages/domains/src/repositories/` | Repository extending base with typed entity and model generics |
| **Service Module** | `pnpm generate-service-module` | `packages/applications/src/services/` | Complete NestJS service module (interface, implementation, module, DTOs, DTO mapper) |
| **Controller** | `pnpm generate-controller` | `apps/api/src/` | NestJS controller with CRUD endpoints and Swagger decorators |
| **Prisma Index** | `pnpm generate-prisma-index` | `packages/database/src/generated/` | Re-export index for generated Prisma client types |

### Data Entity Generator

Generates entity classes from Prisma models with:
- Interface defining all fields (`IUserEntity extends IBaseTaggedEntity`)
- Private fields with underscore prefix
- Typed getters and `setProperty()`-based setters for change tracking
- Constructor initializing from interface

```bash
pnpm --filter @arcaai/tools generate-data-entity
```

### Data Model Generator

Generates data model classes that represent the database row shape, including `@VirtualDbProperty()` decorators for relation fields.

```bash
pnpm --filter @arcaai/tools generate-data-model
```

### Factory Generator

Generates factory classes with static creation methods, UUIDv7 ID generation, and sensible defaults for all fields.

```bash
pnpm --filter @arcaai/tools generate-factory
```

### Mapper Generator

Generates mapper classes with:
- `AutoClassMapper` for standard field mapping
- `AutoEntityChangeMapper` for partial update mapping
- Custom handler hooks for relation mapping (`$toDomain`, `$toPersistence`)
- Singleton pattern via `getInstance()`

```bash
pnpm --filter @arcaai/tools generate-mapper
```

### Repository Generator

Generates repository classes extending the base `Repository<EntityType, ModelType>` with the correct mapper singleton.

```bash
pnpm --filter @arcaai/tools generate-repository
```

### Service Module Generator

Generates a complete service module scaffold including:
- Service interface
- Service implementation
- NestJS module definition
- DTO mapper
- DTOs (Create, Update, Response, Paginated Response)

```bash
# Interactive mode
pnpm --filter @arcaai/tools generate-service-module

# Non-interactive
pnpm --filter @arcaai/tools generate-service-module -n UserProfile -o packages/applications/src/services -g user
```

### Controller Generator

Generates NestJS controllers with standard CRUD endpoints and Swagger decorations.

```bash
pnpm --filter @arcaai/tools generate-controller
```

## Development Token Generator

Generates JWT tokens for local development and testing without running the full authentication flow.

### Usage

```bash
# Generate token for default user (super_admin)
pnpm --filter @arcaai/tools gen-dev-token

# List available users
pnpm --filter @arcaai/tools gen-dev-token -- -l

# Generate for specific user
pnpm --filter @arcaai/tools gen-dev-token -- -u admin

# Custom expiration (default: 24h)
pnpm --filter @arcaai/tools gen-dev-token -- -e 7d

# Override tenant ID
pnpm --filter @arcaai/tools gen-dev-token -- -t "tenant-uuid"

# Override roles
pnpm --filter @arcaai/tools gen-dev-token -- -r "ADMIN,MANAGER"

# Print full JWT payload
pnpm --filter @arcaai/tools gen-dev-token -- -p
```

### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--user <name>` | `-u` | Select a predefined user profile |
| `--list` | `-l` | List available user profiles |
| `--expiry <duration>` | `-e` | Token expiry (e.g., `1d`, `7d`, `1h`) |
| `--tenant <id>` | `-t` | Override tenant ID |
| `--roles <roles>` | `-r` | Override roles (comma-separated) |
| `--payload` | `-p` | Print the full JWT payload |
| `--help` | | Show help |

## Common Workflows

### Adding a New Domain Model

1. **Define the Prisma model** in `packages/database/src/prisma/db_main/`:

```prisma
model Appointment {
    metaData Json? @map("_metadata") @db.JsonB
    version  Int   @default(1) @map("_version")
    id       String @id @default(uuid(7))
    tenantId String? @default("50000000-0000-0000-0000-000000000000")
    // ... fields ...
    resourceStatus ResourceStatusType @default(ENABLED)
    // ... audit fields ...
    @@schema("core")
}
```

2. **Generate the Prisma client:**

```bash
pnpm --filter @arcaai/database db:generate
```

3. **Generate domain artifacts** (run from the tools package):

```bash
pnpm generate-data-model       # → domains/src/models/
pnpm generate-data-entity      # → domains/src/entities/
pnpm generate-factory          # → domains/src/factories/
pnpm generate-mapper           # → domains/src/mappers/
pnpm generate-repository       # → domains/src/repositories/
```

4. **Generate application service:**

```bash
pnpm generate-service-module   # → applications/src/services/
```

5. **Generate API controller:**

```bash
pnpm generate-controller       # → apps/api/src/
```

### Generating a Dev Token for API Testing

```bash
# Quick token for Postman/curl
pnpm --filter @arcaai/tools gen-dev-token

# Copy the token and use in Authorization header:
# Authorization: Bearer <token>
```

### Database Operations via Prisma Commander

```bash
# Prototype a schema change quickly
pnpm --filter @arcaai/tools prisma-commander push --domain db_main

# Create a proper migration when ready
pnpm --filter @arcaai/tools prisma-commander migrate --domain db_main --name add_appointment_table

# Inspect the database visually
pnpm --filter @arcaai/tools prisma-commander studio --domain db_main
```

## Project Structure

```
packages/tools/src/
├── gen-dev-token/              # JWT token generation
│   ├── index.ts                # CLI entry point
│   ├── generate.ts             # Token signing logic
│   ├── users.ts                # Predefined user profiles
│   └── README.md               # Dev token documentation
├── generate-controller/        # NestJS controller generator
│   ├── index.ts
│   ├── generator.ts
│   └── templates/              # Handlebars templates
│       ├── controller.hbs
│       ├── controller-module.hbs
│       └── index.hbs
├── generate-data-entity/       # Entity class generator
│   ├── index.ts
│   ├── types.ts
│   └── templates/
│       └── entity.hbs
├── generate-data-model/        # Data model generator
│   ├── index.ts
│   ├── types.ts
│   └── templates/
│       └── model.hbs
├── generate-factory/           # Factory generator
│   ├── index.ts
│   ├── generator.ts
│   └── templates/
│       └── factory.hbs
├── generate-mapper/            # Mapper generator
│   ├── index.ts
│   ├── generator.ts
│   └── templates/
│       └── mapper.hbs
├── generate-repository/        # Repository generator
│   ├── index.ts
│   └── templates/
│       └── repository.hbs
├── generate-service-module/    # Service module generator
│   ├── index.ts
│   ├── generator.ts
│   └── templates/
│       ├── dto/
│       │   ├── create-dto.hbs
│       │   ├── index.hbs
│       │   ├── paginated-response-dto.hbs
│       │   ├── response-dto.hbs
│       │   └── update-dto.hbs
│       ├── dto-mapper.hbs
│       ├── index.hbs
│       ├── interface.hbs
│       ├── module.hbs
│       └── service.hbs
├── generate-prisma-index.ts    # Prisma client re-export index
├── prisma-commander/           # Prisma CLI utility
│   ├── index.ts                # CLI entry point (Commander.js)
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       ├── activities.ts       # Activity implementations
│       ├── cli.ts              # Interactive prompts (Inquirer)
│       ├── domainScanner.ts    # Auto-discovers Prisma schemas
│       └── generatePrismaIndex.ts
├── utils/                      # Shared utilities
│   ├── checkDirectory.ts
│   ├── clearDirectory.ts
│   ├── exportFromDirectory.ts
│   ├── formatDtoName.ts
│   ├── generate-indices.ts
│   ├── getNodeModulesPath.ts
│   ├── getPrismaDMMF.ts        # Reads Prisma schema DMMF
│   ├── loadEnv.ts
│   ├── Logger.ts
│   ├── names.ts                # Naming convention helpers
│   ├── parseEntityClassFile.ts
│   ├── parseModelClassFile.ts
│   ├── paths.ts
│   ├── removeUnusedImports.ts
│   ├── runCommand.ts
│   ├── toCamelCase.ts
│   ├── toPascalCase.ts
│   ├── toSnakeCase.ts
│   └── tsMorphUtils.ts         # ts-morph AST helpers
└── index.ts                    # Package exports
```

## Adding a New Tool

1. Create a new directory under `src/` with the tool name
2. Create an `index.ts` entry point
3. Add a script to `package.json`
4. Export from `src/index.ts` if the tool needs programmatic access
5. Update this documentation

## Build

```bash
# Tools are typically run directly via ts-node, not compiled.
# All scripts in package.json use ts-node for execution.
```

## Related Packages

- [`@arcaai/database`](../database/README.md) — Prisma schema that generators read from
- [`@arcaai/domains`](../domains/README.md) — Target output for entity, model, factory, mapper, and repository generators
- [`@arcaai/applications`](../applications/README.md) — Target output for service module generator
