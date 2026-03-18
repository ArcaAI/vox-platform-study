# TASK-038: Embedded Prisma Studio

| Field | Value |
|-------|-------|
| **Ticket Number** | TASK-038 |
| **Feature Name** | Embedded Prisma Studio — Database Browser at `/api/pstudio` |
| **Created Date** | 2026-02-21 |
| **Last Updated** | 2026-02-21 |
| **Status** | Completed |

---

## 1. Requirement Analysis

### Background

The HOPE monorepo currently relies on `prisma studio` (CLI command) to browse and edit database records. This requires:
- Running a separate CLI process (`pnpm db:studio`)
- A local `prisma.config.ts` with correct env loading (recently fixed)
- Direct access to the developer's machine

Prisma now offers [`@prisma/studio-core`](https://www.npmjs.com/package/@prisma/studio-core) — an embeddable React component that provides the full Prisma Studio experience inside any web application. This task integrates it into the existing NestJS API Gateway so developers and admins can access a database browser at `/api/pstudio` without running a separate process.

### Business Context

- **Developer Experience**: One fewer process to manage during local development
- **Remote Access**: Team members can browse the database through the API without needing local PostgreSQL access or CLI tools
- **Admin Dashboard Foundation**: Embeddable Studio can serve as a quick admin data-editing tool
- **Security**: Access is gated behind JWT authentication and admin-level permissions, unlike the CLI which has no auth

### Acceptance Criteria

- [ ] `GET /api/pstudio` serves a self-contained HTML page with the embedded Prisma Studio React component
- [ ] `POST /api/pstudio` accepts Studio query payloads and executes them against PostgreSQL, returning results
- [ ] Both endpoints require JWT authentication (no `@Public()`)
- [ ] Both endpoints require admin-level authorization (`manage:all` permission)
- [ ] The module is conditionally registered — only in non-production environments by default
- [ ] The Studio UI is fully functional: browse tables, view/edit/create/delete records
- [ ] No additional build step required — the frontend loads from CDN at runtime
- [ ] The feature does not affect existing API routes or functionality

---

## 2. Current State Evaluation

### Existing Infrastructure

| Component | Status | Details |
|-----------|--------|---------|
| NestJS API Gateway | Running | `apps/api/`, port 3000, global prefix `/api` |
| PostgreSQL | Running | Connection via `DATABASE_URL` env var |
| JWT Auth | Available | `JwtAuthGuard` with `@Public()` bypass |
| RBAC | Available | `@Authorize('manage', 'all')` decorator |
| Prisma Client | Available | `@arcaai/database` package with `pg` adapter |
| Static File Serving | Not configured | No `ServeStaticModule` in the API |

### Current Database Browsing

- **CLI**: `pnpm db:studio` runs `prisma studio` from `packages/database/`
- **Prisma Commander**: `pnpm gen:prisma studio --domain db_main` via the custom CLI tool in `packages/tools/`
- Both require local terminal access and a running PostgreSQL instance

### Related Components

| File | Relevance |
|------|-----------|
| `apps/api/src/app.module.ts` | Where the new module will be registered |
| `apps/api/src/guards/jwtauth.guard.ts` | JWT authentication guard |
| `apps/api/src/decorators/authorize.decorator.ts` | RBAC authorization decorators |
| `apps/api/src/decorators/public.decorator.ts` | Public route decorator (NOT to be used) |
| `packages/database/src/client.ts` | Existing Prisma client singleton (not used by Studio — Studio has its own executor) |

---

## 3. Implementation Plan

### Architecture

Embedded Prisma Studio follows a **Backend-for-Frontend (BFF)** pattern:

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌───────────────────────────────────────────────────┐  │
│  │  GET /api/pstudio → HTML page                     │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  React App (loaded from CDN)                │  │  │
│  │  │  - @prisma/studio-core/ui (Studio component)│  │  │
│  │  │  - createPostgresAdapter                    │  │  │
│  │  │  - createStudioBFFClient → POST /api/pstudio│  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────┘
                         │ POST /api/pstudio
                         │ { query, customPayload }
                         │ + Authorization: Bearer <JWT>
                         ▼
┌─────────────────────────────────────────────────────────┐
│  NestJS API Gateway (apps/api/)                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  PrismaStudioController                           │  │
│  │  - JwtAuthGuard + Authorize('manage', 'all')      │  │
│  │  - GET /pstudio  → serve HTML                     │  │
│  │  - POST /pstudio → execute query via service      │  │
│  └──────────────────────┬────────────────────────────┘  │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │  PrismaStudioService                              │  │
│  │  - createPostgresJsExecutor (from studio-core)    │  │
│  │  - Uses DATABASE_URL from environment             │  │
│  │  - Executes SQL, returns results or errors        │  │
│  └──────────────────────┬────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────┘
                          │
                          ▼
                    ┌──────────┐
                    │PostgreSQL│
                    └──────────┘
```

### Technology Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Backend executor** | `@prisma/studio-core/data/postgresjs` | Self-hosted PostgreSQL executor using the `postgres` npm package. The `ppg` executor is for Prisma Postgres (hosted service), not self-hosted. |
| **Frontend delivery** | Inline HTML served by NestJS controller | No build step, no separate dev server, no `ServeStaticModule`. The HTML page loads React and `@prisma/studio-core` from CDN (esm.sh) via ES module import maps. |
| **Authentication** | JWT via `JwtAuthGuard` | Consistent with all other API endpoints. The JWT token is extracted from the browser session and passed as a custom header in Studio's BFF client. |
| **Authorization** | `@Authorize('manage', 'all')` | Only users with full admin permissions can access the database browser. This is the most restrictive permission level in the RBAC system. |
| **Environment gate** | Conditional module registration | The module is only imported in `AppModule` when `NODE_ENV !== 'production'` (configurable via env var `ENABLE_PRISMA_STUDIO`). |

### Dependencies to Install

| Package | Version | Where | Purpose |
|---------|---------|-------|---------|
| `@prisma/studio-core` | `^0.14.0` | `apps/api/` | Backend executor (`data/postgresjs`) and types (`data` for `Query` type) |
| `postgres` | `^3.4.0` | `apps/api/` | PostgreSQL driver required by the `postgresjs` executor |

> **Note**: No frontend dependencies are needed. The React app loads entirely from CDN at runtime.

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/modules/pstudio/pstudio.module.ts` | NestJS module definition |
| `apps/api/src/modules/pstudio/pstudio.controller.ts` | GET (serve HTML) + POST (execute queries) endpoints |
| `apps/api/src/modules/pstudio/pstudio.service.ts` | PostgreSQL executor wrapper using `@prisma/studio-core` |
| `apps/api/src/modules/pstudio/pstudio.html.ts` | HTML template for the Studio SPA (inline React app) |

### Files to Modify

| File | Change |
|------|--------|
| `apps/api/src/app.module.ts` | Conditionally import `PrismaStudioModule` |
| `apps/api/package.json` | Add `@prisma/studio-core` and `postgres` dependencies |

### Detailed Implementation Steps

#### Step 1: Install Dependencies

```bash
cd apps/api
pnpm add @prisma/studio-core postgres
```

#### Step 2: Create `pstudio.service.ts`

The service wraps the `@prisma/studio-core/data/postgresjs` executor:

```typescript
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createPostgresJsExecutor } from '@prisma/studio-core/data/postgresjs';
import { serializeError } from '@prisma/studio-core/data/bff';
import type { Query } from '@prisma/studio-core/data';
import postgres from 'postgres';

@Injectable()
export class PrismaStudioService implements OnModuleDestroy {
    private readonly logger = new Logger(PrismaStudioService.name);
    private sql: ReturnType<typeof postgres> | null = null;

    private getSql(): ReturnType<typeof postgres> {
        if (!this.sql) {
            const url = process.env.DATABASE_URL;
            if (!url) {
                throw new Error('DATABASE_URL environment variable is not set');
            }
            this.sql = postgres(url);
        }
        return this.sql;
    }

    async executeQuery(query: Query): Promise<[unknown, null] | [null, unknown]> {
        const sql = this.getSql();
        const executor = createPostgresJsExecutor(sql);
        const [error, results] = await executor.execute(query);

        if (error) {
            this.logger.warn('Studio query failed', { error });
            return [serializeError(error), null];
        }

        return [null, results];
    }

    async onModuleDestroy() {
        if (this.sql) {
            await this.sql.end();
        }
    }
}
```

> **Note**: The exact API of `createPostgresJsExecutor` will be verified during implementation by inspecting the package's TypeScript declarations. The `postgres` package may need to be passed differently (e.g., as a connection string rather than an instance).

#### Step 3: Create `pstudio.html.ts`

A self-contained HTML template that loads React and Studio from CDN:

```typescript
export function getStudioHtml(apiBaseUrl: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HOPE — Prisma Studio</title>
    <link rel="stylesheet" href="https://esm.sh/@prisma/studio-core@0.14.0/ui/index.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body, #root { height: 100%; width: 100%; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="importmap">
    {
        "imports": {
            "react": "https://esm.sh/react@18.3.1",
            "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
            "@prisma/studio-core/ui": "https://esm.sh/@prisma/studio-core@0.14.0/ui",
            "@prisma/studio-core/data/postgres-core": "https://esm.sh/@prisma/studio-core@0.14.0/data/postgres-core",
            "@prisma/studio-core/data/bff": "https://esm.sh/@prisma/studio-core@0.14.0/data/bff"
        }
    }
    </script>
    <script type="module">
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Studio } from '@prisma/studio-core/ui';
        import { createPostgresAdapter } from '@prisma/studio-core/data/postgres-core';
        import { createStudioBFFClient } from '@prisma/studio-core/data/bff';

        const { useMemo, createElement: h } = React;

        function App() {
            const adapter = useMemo(() => {
                const executor = createStudioBFFClient({
                    url: '${apiBaseUrl}',
                    customHeaders: {},
                });
                return createPostgresAdapter({ executor });
            }, []);

            return h(Studio, { adapter });
        }

        createRoot(document.getElementById('root')).render(h(App));
    </script>
</body>
</html>`;
}
```

> **Note**: The CDN approach will be validated during implementation. If `@prisma/studio-core` doesn't work well from CDN (due to CSS/asset dependencies), we may need to bundle the frontend assets and serve them statically. This is a known risk documented in the Risks section below.

#### Step 4: Create `pstudio.controller.ts`

```typescript
import { Controller, Get, Post, Body, Res, UseGuards, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../guards/jwtauth.guard';
import { Authorize } from '../../decorators/authorize.decorator';
import { PrismaStudioService } from './pstudio.service';
import { getStudioHtml } from './pstudio.html';

@ApiTags('Prisma Studio')
@ApiBearerAuth()
@Controller('pstudio')
export class PrismaStudioController {
    constructor(private readonly studioService: PrismaStudioService) {}

    @Get()
    @Authorize('manage', 'all')
    @ApiExcludeEndpoint()
    @Header('Content-Type', 'text/html')
    getStudioPage(@Res() res: Response) {
        const baseUrl = `${req.protocol}://${req.get('host')}/api/pstudio`;
        const html = getStudioHtml(baseUrl);
        res.send(html);
    }

    @Post()
    @Authorize('manage', 'all')
    @ApiOperation({ summary: 'Execute Prisma Studio query' })
    async executeQuery(@Body() body: { query: unknown }) {
        const [error, results] = await this.studioService.executeQuery(body.query);
        if (error) {
            return [error];
        }
        return [null, results];
    }
}
```

#### Step 5: Create `pstudio.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { PrismaStudioController } from './pstudio.controller';
import { PrismaStudioService } from './pstudio.service';

@Module({
    controllers: [PrismaStudioController],
    providers: [PrismaStudioService],
})
export class PrismaStudioModule {}
```

#### Step 6: Conditionally Register in `app.module.ts`

```typescript
// At the top of app.module.ts
import { PrismaStudioModule } from './modules/pstudio/pstudio.module';

// In the featureModules array, add conditionally:
const featureModules: any[] = [
    // ... existing modules ...
];

// Conditionally add Prisma Studio (non-production only, or via env flag)
if (process.env.ENABLE_PRISMA_STUDIO === 'true' || process.env.NODE_ENV !== 'production') {
    featureModules.push(PrismaStudioModule);
}
```

#### Step 7: Add Environment Variable

Add to `.env.dev` and `.env`:

```bash
# Prisma Studio (embedded database browser)
ENABLE_PRISMA_STUDIO=true
```

### Security Considerations

| Concern | Mitigation |
|---------|------------|
| **Unauthorized access** | JWT authentication required on both GET and POST endpoints |
| **Privilege escalation** | `@Authorize('manage', 'all')` — only full admin users can access |
| **Production exposure** | Module not registered when `NODE_ENV=production` (unless explicitly enabled) |
| **SQL injection** | Studio generates its own queries; execution goes through the official `@prisma/studio-core` executor, not raw SQL |
| **Data modification** | Studio allows editing — this is intentional for admin use. The RBAC guard ensures only authorized users can access it |
| **CORS** | The HTML page is served from the same origin as the API, so no CORS issues |

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `@prisma/studio-core` CSS/assets don't load from CDN | Medium | High | Fallback: bundle assets and serve via `ServeStaticModule` or inline CSS |
| `createPostgresJsExecutor` API differs from documentation | Low | Medium | Inspect TypeScript declarations during implementation; fall back to `createPrismaPostgresHttpClient` with direct PostgreSQL URL if needed |
| Studio component requires specific React version | Low | Low | Pin React version in import map; Studio demo uses React 18.3.x |
| Performance impact on API server | Low | Low | Studio module is lazy-loaded; PostgreSQL executor creates connections on demand |

### Testing Strategy

| Test Type | Scope | Details |
|-----------|-------|---------|
| **Manual** | Full flow | Access `http://localhost:8868/api/v1/api/pstudio` in browser, verify Studio loads, browse tables, edit a record |
| **Manual** | Auth | Verify unauthenticated requests to GET and POST return 401 |
| **Manual** | Authorization | Verify non-admin users get 403 |
| **Manual** | Production gate | Verify module is not registered when `NODE_ENV=production` and `ENABLE_PRISMA_STUDIO` is not set |

### Deployment Considerations

- **No database migration required**
- **No schema changes**
- **No new infrastructure** — uses existing PostgreSQL connection
- **Environment variable**: Add `ENABLE_PRISMA_STUDIO=true` to `.env.dev` and `.env` (not `.env.production`)
- **CDN dependency**: The frontend loads from `esm.sh` at runtime — requires internet access in the browser (not the server)

---

## 4. Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `apps/api/src/modules/pstudio/pstudio.module.ts` | NestJS module definition |
| `apps/api/src/modules/pstudio/pstudio.controller.ts` | GET (serve HTML) + POST (execute queries) endpoints |
| `apps/api/src/modules/pstudio/pstudio.service.ts` | PostgreSQL executor wrapper using `@prisma/studio-core` |
| `apps/api/src/modules/pstudio/pstudio.html.ts` | Self-contained HTML template for the Studio SPA |

### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/app.module.ts` | Conditionally import `PrismaStudioModule` (non-production or `ENABLE_PRISMA_STUDIO=true`) |
| `apps/api/package.json` | Added `@prisma/studio-core` (^0.14.0) and `postgres` (^3.4.0) dependencies |
| `.env.dev` | Added `ENABLE_PRISMA_STUDIO=true` |
| `.env` | Added `ENABLE_PRISMA_STUDIO=true` |
| `.env.example` | Added `ENABLE_PRISMA_STUDIO` with documentation |

### Key Decisions Made

1. **`require()` instead of `import`**: The API uses `moduleResolution: "node"` (CommonJS) which doesn't support package `exports` maps. The `@prisma/studio-core` subpath exports (`data/postgresjs`, `data/bff`) only resolve with `node16`/`nodenext`/`bundler`. Used `require()` with eslint-disable comments to work around this without changing the API's tsconfig.

2. **Sequential execution for sequences**: The `postgresjs` executor implements `Executor` (single query) but not `SequenceExecutor`. The service falls back to sequential execution for sequence requests (execute first query, then second).

3. **CDN-loaded frontend**: The Studio React component loads from `esm.sh` CDN at runtime via ES module import maps. No build step, no bundled assets, no `ServeStaticModule`. React 18.3.1 is pinned in the import map with `?deps=` hints for proper deduplication.

4. **Environment gate logic**: Module is enabled when `ENABLE_PRISMA_STUDIO=true` OR when `NODE_ENV !== 'production'` (unless explicitly set to `false`). This means it's on by default in dev/staging and off in production.

### Testing Performed

- [x] API builds with 0 TypeScript errors
- [x] API starts successfully with the module registered
- [x] Unauthenticated `GET /api/pstudio` returns 401
- [x] Unauthenticated `POST /api/pstudio` returns 401
- [x] Authenticated non-admin `GET /api/pstudio` returns 403 ("Missing permissions: manage:all")
- [x] Authenticated SUPER_ADMIN `GET /api/pstudio` returns 200 with full HTML page
- [x] Authenticated SUPER_ADMIN `POST /api/pstudio` with SQL query returns correct results from database
- [x] No impact on existing API endpoints (`/api/health` still works)

---

## 5. Change History

| Date | Update | Author |
|------|--------|--------|
| 2026-02-21 | Initial documentation and implementation plan created | AI Assistant |
| 2026-02-21 | Implementation completed and verified | AI Assistant |

---

## 6. References

- [Prisma Studio Embedding — Official Documentation](https://www.prisma.io/docs/studio/integrations/embedding)
- [Prisma Studio Core Demo — GitHub Repository](https://github.com/prisma/studio-core-demo)
- [`@prisma/studio-core` — npm Package](https://www.npmjs.com/package/@prisma/studio-core)
- [Prisma Studio Core — Available Exports](https://registry.npmjs.org/@prisma/studio-core) (v0.14.0: `data/postgresjs`, `data/ppg`, `data/pglite`, `data/postgres-core`, `data/bff`, `data/mysql2`, `data/node-sqlite`, `data/sqlite-core`, `data/sqljs`, `data/accelerate`, `data/mysql-core`)
