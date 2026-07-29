# Development Token Generator

Generate JWT tokens for development and testing purposes. Uses predefined users that match the database seed data.

## Prerequisites

1. Ensure you have a `.env` file in the workspace root with `JWT_SECRET_KEY` defined
2. Run database seeds to create the users: `pnpm seed`

## Usage

```bash
# From workspace root
pnpm gen-dev-token

# Or from packages/tools
pnpm gen-dev-token
```

## Options

| Option                      | Description                      | Default        |
| --------------------------- | -------------------------------- | -------------- |
| `-u, --username <username>` | Username to generate token for   | `super_admin`  |
| `-e, --expires <expires>`   | Token expiration time            | `24h`          |
| `-t, --tenant <tenantId>`   | Override tenant ID               | User's default |
| `-r, --roles <roles>`       | Override roles (comma-separated) | User's default |
| `-p, --print`               | Print full token payload         | `false`        |
| `-l, --list`                | List available users             | -              |
| `-V, --version`             | Output version number            | -              |
| `-h, --help`                | Display help                     | -              |

## Examples

### List available users

```bash
pnpm gen-dev-token -- -l
```

### Generate token for default user (super_admin)

```bash
pnpm gen-dev-token
```

### Generate token for a specific user

```bash
pnpm gen-dev-token -- -u admin
```

### Generate token with custom expiration

```bash
pnpm gen-dev-token -- -e 7d    # 7 days
pnpm gen-dev-token -- -e 1h    # 1 hour
pnpm gen-dev-token -- -e 30d   # 30 days
```

### Generate token with tenant override

```bash
pnpm gen-dev-token -- -u admin -t "50000000-0000-0000-0000-000000000001"
```

### Generate token with role override

```bash
pnpm gen-dev-token -- -u user -r "ADMIN,MANAGER"
```

### Print full payload

```bash
pnpm gen-dev-token -- -p
```

### Combine options

```bash
pnpm gen-dev-token -- -u admin -e 48h -t "tenant-123" -r "ADMIN" -p
```

## Available Users

Users are defined in `users.ts` and match the database seed data:

| Username      | Roles       | Tenant | Description                           |
| ------------- | ----------- | ------ | ------------------------------------- |
| `super_admin` | SUPER_ADMIN | Global | System administrator with full access |
| `admin`       | ADMIN       | Global | Organization administrator            |
| `user`        | USER        | Global | Standard user with basic permissions  |

## Adding New Users

To add more development users:

1. Add the user to `packages/database/src/prisma/db_main/seed/91-user.ts`
2. Add the corresponding entry to `packages/tools/src/gen-dev-token/users.ts`
3. Run `pnpm seed` to create the user in the database

## Security Notes

- These tokens are for **development only**
- Never use development tokens in production
- The `JWT_SECRET_KEY` should be different in production
- Tokens include user ID, roles, and tenant information
