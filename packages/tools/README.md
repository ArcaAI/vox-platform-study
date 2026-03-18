# @arcaai/tools

This package contains various CLI tools and utilities for the HOPE monorepo.

## Available Tools

### Prisma Commander

Interactive and non-interactive CLI for managing Prisma database operations.

#### Quick Start

```bash
# Interactive mode (default) - prompts for activity and domains
pnpm prisma-commander

# Or explicitly
pnpm prisma-commander interactive
```

#### Non-Interactive Commands

```bash
# Generate Prisma clients
pnpm prisma-commander generate --all
pnpm prisma-commander generate --domain db_main
pnpm prisma-commander generate -d db_main db_audit

# Push schema to database
pnpm prisma-commander push --all
pnpm prisma-commander push --domain db_main
pnpm prisma-commander push --domain db_main --force  # Force reset with data loss

# Create migration
pnpm prisma-commander migrate --all
pnpm prisma-commander migrate --domain db_main --name add_users_table

# Run seeds
pnpm prisma-commander seed

# Start Prisma Studio
pnpm prisma-commander studio --domain db_main

# List available activities
pnpm prisma-commander list:activities
pnpm prisma-commander la

# List available domains
pnpm prisma-commander list:domains
pnpm prisma-commander ld
```

#### Available Activities

| Activity | Command | Description |
|----------|---------|-------------|
| `generate` | `generate` | Regenerate Prisma clients for selected domains |
| `push` | `push` | Push schema to database (db push) |
| `push:force` | `push --force` | Force push with data loss (--force-reset) |
| `migrate` | `migrate` | Create a new migration (migrate dev) |
| `seed` | `seed` | Run database seed scripts |
| `studio` | `studio` | Start Prisma Studio for database inspection |

#### Command Options

| Option | Short | Description |
|--------|-------|-------------|
| `--domain <names...>` | `-d` | Domain name(s) to process |
| `--all` | `-a` | Process all domains |
| `--force` | `-f` | Force operation (for push) |
| `--name <name>` | `-n` | Migration name (for migrate) |
| `--help` | `-h` | Show help |

---

### Development Token Generator

Generate JWT tokens for development and testing.

#### Usage

```bash
# Generate token for default user (super_admin)
pnpm gen-dev-token

# List available users
pnpm gen-dev-token -- -l

# Generate for specific user
pnpm gen-dev-token -- -u admin

# Custom expiration
pnpm gen-dev-token -- -e 7d

# Override tenant
pnpm gen-dev-token -- -t "tenant-uuid"

# Override roles
pnpm gen-dev-token -- -r "ADMIN,MANAGER"

# Print full payload
pnpm gen-dev-token -- -p

# Show help
pnpm gen-dev-token -- --help
```

See [gen-dev-token/README.md](src/gen-dev-token/README.md) for detailed documentation.

---

### Code Generators

#### Data Model Generator

Generate data models from Prisma schema.

```bash
pnpm generate-data-model
```

#### Data Entity Generator

Generate data entities from Prisma schema.

```bash
pnpm generate-data-entity
```

#### Mapper Generator

Generate mappers between entities and models.

```bash
pnpm generate-mapper
```

#### Repository Generator

Generate repository classes.

```bash
pnpm generate-repository
```

#### Factory Generator

Generate factory classes.

```bash
pnpm generate-factory
```

#### Service Module Generator

Generate complete service modules including:
- Service interface
- Service implementation
- Service module
- DTO mapper
- DTOs (Create, Update, Response, Paginated Response)

```bash
# Interactive mode
pnpm generate-service-module

# Command-line options
pnpm generate-service-module -n UserProfile -o packages/applications/src/services -g user

# Show help
pnpm generate-service-module --help
```

#### Controller Generator

Generate NestJS controllers.

```bash
pnpm generate-controller
```

---

### Prisma Index Generator

Generate index.ts files for Prisma generated clients.

```bash
pnpm generate-prisma-index
```

---

## Development

### Adding a New Tool

1. Create a new folder under `src/` with your tool name
2. Create an `index.ts` entry point
3. Add a script to `package.json`
4. Export from `src/index.ts` if needed
5. Update this README

### Project Structure

```
src/
├── gen-dev-token/              # Development token generation
├── generate-controller/        # NestJS controller generator
├── generate-data-entity/       # Data entity generator
├── generate-data-model/        # Data model generator
├── generate-factory/           # Factory class generator
├── generate-mapper/            # Mapper generator
├── generate-repository/        # Repository generator
├── generate-service-module/    # Service module generator
├── prisma-commander/           # Prisma CLI utility
│   ├── index.ts               # CLI entry point
│   ├── types/                 # TypeScript types
│   └── utils/                 # Utilities
│       ├── activities.ts      # Activity implementations
│       ├── cli.ts             # Interactive CLI
│       ├── domainScanner.ts   # Domain discovery
│       └── generatePrismaIndex.ts
├── utils/                      # Shared utilities
└── index.ts                   # Package exports
```
