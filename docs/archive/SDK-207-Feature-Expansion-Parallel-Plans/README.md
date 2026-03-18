# SDK-207: Feature Expansion — Parallel Engineering Plans

- **Ticket Number**: SDK-207
- **Created Date**: 2026-02-18
- **Last Updated**: 2026-02-18
- **Status**: Pending
- **Parent Plan**: `sdk-v2_feature_expansion_f27a5528.plan.md`

---

## Requirement Analysis

The SDK-V2 Feature Expansion plan (`sdk-v2_feature_expansion_f27a5528.plan.md`) covers 16 feature areas across backend and SDK. This document:

1. Records the sequential-thinking review of that plan for best practices
2. Decomposes the plan into 5 dedicated workstreams engineers can execute in parallel

### Business Context

HOPE's agentic SDK (v2) has gaps between its frontend capabilities and the backend services. This expansion adds:
- DNA Writing Style analysis (new backend + SDK)
- Prompt Template management (new backend + SDK)
- MLflow proxy removal (replaced by PostgreSQL-native modules)
- Summary versioning, consultation chains, audio mixing
- Admin hooks (departments, tenant, health, consultations)
- jsdiff-based version comparison

---

## Sequential Analysis Review

### Evidence Collected

| # | Source | Finding | Confidence |
|---|--------|---------|------------|
| E1 | Backend code inspection | Plan's Prisma models, module structure, SDK patterns align with existing conventions | High |
| E2 | `prompt-resolution.service.ts` | PromptResolutionService never used MLflow — it uses Department fields from TASK-021. Plan incorrectly says "rewire from MLflow" | High |
| E3 | `summary.service.ts:191-224` | Confirmed: `updateSummary` does NOT create `ContextItemVersion`. Plan's gap is accurate | High |
| E4 | MLflow module inspection | MLflow module is an HTTP proxy with `http-proxy-middleware`. Some routes lack auth guards. Removal is correct | High |
| E5 | SDK `constants.ts`, `summary.ts` | `DNA_ENDPOINTS` already deprecated. `DNAStyle`/`DNAStyleData` types exist. Plan doesn't reference migration path | High |
| E6 | TASK-021 + SDK-206 docs | TASK-021 fully completed. SDK-206 Layer 0 done. Plan should build on these, not duplicate | High |
| E7 | Dependency analysis | Plan phases are mostly correct but undertap parallelism. Phase 2d has no dependency on 2a-2c | High |
| E8 | SMR integration patterns | 3 different env vars (`SMR_SERVICE_URL`, `SMR_URL`, `SMR_SERVICE_URL_HTTP`) used inconsistently | High |

### Issues Found

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 1 | **High** | Plan says "rewire PromptResolutionService from MLflow" but it never used MLflow — uses Department fields from TASK-021 | Correct: *extend* PromptResolutionService to also look up `PromptTemplate` by ID, not "rewire from MLflow" |
| 2 | **High** | Plan doesn't reference existing `DNAStyle`/`DNAStyleData` types in `summary.ts` or deprecated `DNA_ENDPOINTS` | Explicitly migrate/extend existing types, replace deprecated endpoints |
| 3 | **High** | No rollback strategy for Prisma migration (6 new models + enums) | Add migration rollback SQL and verification step |
| 4 | **Medium** | SMR URL env var inconsistency not addressed | SmrAdapterService should standardize on one env var with clear precedence |
| 5 | **Medium** | No TDD test strategy per task — single "tests" todo at the end | Each workstream should have tests colocated with implementation |
| 6 | **Medium** | `ComprehensiveSummaryProcessor` doesn't use `PromptResolutionService` (TASK-021 finding) | Wire `PromptResolutionService` fallback into comprehensive summary path |
| 7 | **Low** | No API versioning consideration — new modules use `/dna-styles/` without `/api/v1/` prefix | Verify consistency with existing modules |
| 8 | **Low** | Monitoring module has no auth guard — `useSystemHealth` hook should document this | Clarify auth expectations for SDK health hook |

### Best Practices Checklist

| Practice | Status | Notes |
|----------|--------|-------|
| DDD pattern (Entity/Factory/Repository/Mapper) | Pass | Follows existing conventions |
| Prisma conventions (audit fields, indexes, `@@schema`) | Pass | All models correct |
| NestJS module structure | Pass | Module/Controller/Service separation |
| SDK hook patterns (Zustand, useCallback, useMemo) | Pass | Follows existing conventions |
| SDK endpoint constants (`as const`, dynamic paths) | Pass | Follows existing conventions |
| Test strategy (TDD) | **Fail** | Tests deferred to end |
| Rollback strategy | **Fail** | No migration rollback plan |
| Error handling specification | **Partial** | No error taxonomy defined |
| Documentation updates | Pass | SDK-206 update mentioned |
| Soft delete convention | Pass | Uses `resourceStatus` pattern |

### Conclusion

**Confidence**: 8/10

The plan is architecturally sound and well-detailed. The 8 issues above should be addressed before engineers begin work. The most critical correction is Issue #1 (PromptResolutionService description) as it could mislead an engineer into searching for non-existent MLflow integration code.

---

## Parallel Workstream Decomposition

### Dependency Graph

```
                    ┌─────────────────────────┐
                    │  WS-1: Database &        │
                    │  Domain Layer (shared)    │
                    │  (1 engineer, ~2 days)    │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
              ▼                  ▼                   ▼
   ┌──────────────────┐ ┌──────────────┐ ┌──────────────────────┐
   │  WS-2: Prompt    │ │  WS-3: Backend│ │  WS-4: SDK Types,   │
   │  Template +      │ │  Enhancements │ │  Plugins, Utilities  │
   │  DNA Modules     │ │  + MLflow     │ │  (no backend deps)   │
   │  (1 eng, ~3 days)│ │  Removal      │ │  (1 eng, ~2 days)    │
   │                  │ │  (1 eng, ~2d) │ │                      │
   └────────┬─────────┘ └──────┬───────┘ └──────────┬───────────┘
            │                  │                     │
            └──────────────────┼─────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  WS-5: SDK Hooks     │
                    │  (All layers 2 + 3)  │
                    │  (1-2 eng, ~3 days)  │
                    └──────────────────────┘
```

### Parallelism Rules

- **WS-1** must complete FIRST (Prisma migration + domain layer shared by all backend work)
- **WS-2**, **WS-3**, **WS-4** can run in PARALLEL after WS-1
- **WS-5** starts after WS-2 + WS-3 complete (needs backend APIs), but WS-4 should also be done
- **WS-4** has ZERO backend dependency — can start immediately alongside WS-1 for types/constants, but AudioMixer and diffUtils are fully independent

### Workstream Summary

| Workstream | Engineer | Estimated Duration | Dependencies | Files |
|------------|----------|--------------------|--------------|-------|
| WS-1: Database & Domain Layer | Engineer A | 2 days | None | See `workstream-1-database.md` |
| WS-2: Prompt Template + DNA Modules | Engineer B | 3 days | WS-1 | See `workstream-2-prompt-dna.md` |
| WS-3: Backend Enhancements + MLflow Removal | Engineer C | 2 days | WS-1 | See `workstream-3-backend-enhancements.md` |
| WS-4: SDK Types, Plugins, Utilities | Engineer D | 2 days | None (can start immediately) | See `workstream-4-sdk-foundation.md` |
| WS-5: SDK Hooks (All Layers) | Engineer D+E | 3 days | WS-2, WS-3, WS-4 | See `workstream-5-sdk-hooks.md` |

**Total calendar time (with parallelism)**: ~8 days  
**Total engineer-days**: ~12 days  
**Maximum parallelism**: 4 engineers during WS-2/WS-3/WS-4 phase

---

## Change History

_No changes yet — initial document._
