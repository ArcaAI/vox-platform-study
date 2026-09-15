# Development Token Generator

Generate JWT tokens for development and testing purposes, from a small hardcoded user list in
`users.ts` — not a live read of the database.

## Layout

| Path | What it holds |
|---|---|
| `index.ts` | The commander CLI entry point (`pnpm gen:token` / `pnpm --filter @arcaai/tools gen-dev-token`) |
| `users.ts` | `DEV_USERS` — the hardcoded username/role/tenant list this tool signs tokens from |

## Commands

```bash
# From workspace root
pnpm gen:token

# Or from packages/tools
pnpm gen-dev-token
```

Do not insert a `--` separator between the command and its flags — see the top-level
`@arcaai/tools` README's Commands section for why.

### Options

| Option | Description | Default |
|---|---|---|
| `-u, --username <username>` | Username to generate token for | `super_admin` |
| `-e, --expires <expires>` | Token expiration time | `24h` |
| `-t, --tenant <tenantId>` | Override tenant ID | User's default |
| `-r, --roles <roles>` | Override roles (comma-separated) | User's default |
| `-p, --print` | Print full token payload | `false` |
| `-l, --list` | List available users | - |
| `-V, --version` | Output version number | - |
| `-h, --help` | Display help | - |

## How it works

### Examples

```bash
# List available users
pnpm gen:token -l

# Generate token for default user (super_admin)
pnpm gen:token

# Generate token for a specific user
pnpm gen:token -u tenant_admin

# Generate token with custom expiration
pnpm gen:token -e 7d    # 7 days
pnpm gen:token -e 1h    # 1 hour
pnpm gen:token -e 30d   # 30 days

# Generate token with tenant override
pnpm gen:token -u tenant_admin -t "50000000-0000-0000-0000-000000000001"

# Generate token with role override
pnpm gen:token -u doctor -r "TENANT_ADMIN"

# Print full payload
pnpm gen:token -p

# Combine options
pnpm gen:token -u tenant_admin -e 48h -t "tenant-123" -r "TENANT_ADMIN" -p
```

### Available users

Defined in `users.ts`, ALL with `tenantId: null`:

| Username | Roles |
|---|---|
| `super_admin` | `SUPER_ADMIN` |
| `admin` | `ADMIN` |
| `user` | `USER` |

## Gotchas

- **`users.ts` has drifted from the current database seed.** The seed
  (`packages/database/src/prisma/db_main/seed/91-user.ts`) no longer creates usernames `admin` or
  `user` at all — it seeds `super_admin`, `tenant_admin`, `doctor`, `nurse`, `department_head`,
  `senior_nurse`, and many more specialty-scoped users instead. It also no longer has an `ADMIN` or
  `USER` role: the current role catalog is `SUPER_ADMIN`, `TENANT_ADMIN`, `DOCTOR`,
  `DEPARTMENT_HEAD`, `NURSE`, `SENIOR_NURSE`, `SERVICE_ACCOUNT` (see
  `packages/database/src/prisma/db_main/seed/03-role.ts`). `pnpm gen:token -u admin` still signs a
  syntactically valid JWT (this tool never queries the database), but that token does not
  correspond to any seeded row — a request authenticated with it will not resolve the way a real
  `admin` user's request would. Prefer `-u super_admin` or `-u tenant_admin`, both of which are
  real, currently-seeded usernames, until `users.ts` is reconciled with the seed.
- These tokens are for development only; never use them in production. The `JWT_SECRET_KEY` should
  be different in production. Tokens include user ID, roles, and tenant information.

### Adding new users
To add more development users:

1. Add the user to `packages/database/src/prisma/db_main/seed/91-user.ts`.
2. Add the corresponding entry to `users.ts`.
3. Run `pnpm seed` to create the user in the database.

## Related

- [`@arcaai/tools` README](../../README.md)
- [`00-project-context.md`](../../../../.claude/rules/00-project-context.md) — reserved seed UUID prefixes
