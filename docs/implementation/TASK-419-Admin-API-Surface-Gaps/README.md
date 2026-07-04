# TASK-419 — Admin API Surface Gaps (gateway work feeding the Admin Console)

- **Status**: Pending
- **Type**: feature — new/changed NestJS gateway surfaces required by TASK-415 review decisions
- **Created**: 2026-07-04
- **Origin**: TASK-415 capabilities-matrix review (section 6 gap resolutions + decisions 6–7)

## Requirement Analysis

The TASK-415 review resolved several capability gaps into concrete gateway work so the Admin Console can build real screens against them:

1. **Evaluation golden sets/runs REST surface** — `packages/applications/src/services/eval` is service-layer only; expose admin CRUD/read endpoints (beyond the read-only `GET /admin/harness/eval-runs*`).
2. **Notifications, resource subscriptions, webhooks controllers** — services + Prisma models exist with no public controllers; a webhook/notification management screen needs them.
3. **Guardrail / NLP admin surface** — configuration lives inside the Python services with no gateway admin exposure; design a safe admin read/config plane.
4. **Prisma Studio in production behind a dedicated permission** (TASK-415 Decision 7) — replace the dev-only fail-closed gate (`shouldEnablePrismaStudio`) with production-capable registration guarded by a dedicated CASL subject (e.g. `manage:PrismaStudio`) granted only to `GLOBAL_ADMIN` policy sets; keep the truthful `/status` probe.
5. **AI model registry guard re-pin** (TASK-415 Decision 6) — `/admin/ai-models*` is class-guarded `manage:AiModel` (tenant-scoped); re-pin to global-admin-only to match the console posture.

## Current State Evaluation

See `docs/implementation/TASK-415-Hope-Admin-Console/capabilities-matrix.md` section 6 (gap inventory) and rows 11–12 (AI models, Prisma Studio). Each work item follows the layer chain: database (if needed) → domains → applications → api, with CASL policies seeded accordingly.

## Implementation Plan (high level — detail per item before starting)

Each numbered item above becomes a workstream with its own TDD slice (failing controller e2e/unit test → implement → verify) and policy/seed updates. Items 4 and 5 are authorization-only and should land first (small, unblock console tiers 10–19); items 1–3 need API design review before implementation.

## Implementation Summary

*Pending.*

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review gap resolutions. |
