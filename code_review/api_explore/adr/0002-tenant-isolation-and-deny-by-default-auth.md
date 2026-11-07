# ADR-0002: Tenant isolation and deny-by-default authentication

**Status:** Accepted  
**Date:** 2026-10-23  
**Deciders:** API team  
**Context:** [packages/applications/src/authorization/unified-auth.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts), [apps/api/src/database/tenant-context.provider.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/database/tenant-context.provider.ts), [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts)

## Decision

- **Deny-by-default:** [UnifiedAuthGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts) authenticates and rejects unknown/invalid credentials; failures return 401 or 404-over-403 as appropriate to avoid leaking existence.
- **Tenant isolation:** CLS ([ClsGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts)) carries request context, [TenantContextProvider](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/database/tenant-context.provider.ts) provides tenant-scoped access for Prisma, and guards enforce origin binding and SSE resource ownership.

## Rationale

Defense-in-depth for multi-tenant system with PHI and sensitive operations. Early auth/tenant checks prevent data leakage and enforce boundaries.

## Consequences

- Requires careful boot-time configuration (env, origins, auth providers).
- 404-over-403 complicates debugging but improves security.
- Tenant-scoped data access is enforced consistently through Prisma context.

## References

- [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md)
- [codebase/CONCERNS.md](../codebase/CONCERNS.md)
- [diagrams/api-gateway-internals-deep-dive.html](../diagrams/api-gateway-internals-deep-dive.html)
- [docs/08-CODE-REVIEW.md](../docs/08-CODE-REVIEW.md)
