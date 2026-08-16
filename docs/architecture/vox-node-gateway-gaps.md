# @arcaai/vox-node — Known Gateway Quirks

Extracted 2026-08-16 from TASK-632 §2.4 "Gaps found during exploration"
(`docs/archive/TASK-632-HOPE-Node-SDK/README.md`, dated 2026-08-07) into a live location, because
`docs/archive/**` is off-limits to this sprint's tooling (see `.claude/settings.local.json`) and
`08-vox-sdk.md` points agents here for it. These are gateway (`apps/api`) behaviors the Node SDK
deliberately surfaces rather than papers over — read this before "fixing" a quirk in
`packages/vox-node` that actually belongs on the gateway.

| # | Gap | Impact |
|---|---|---|
| **G1** | API-key scopes were unenforceable when this was written — no decorator ever set the `requiredScopes` metadata the guard reads. Fixed in this ticket on the SDK's own surface. | Historical — confirm current state in `unified-auth.guard.ts` before assuming it still applies. |
| **G2** | No published `openapi.json` — Swagger is built at runtime, non-production only, never written to disk. | Blocks contract tests / generated types. |
| **G3** | Webhooks never fire — `Webhook.hashedSecret` / `WebhookRunHistory` are modeled, `sysEvent.service.ts` comments that the queue feeds webhooks, but no processor consumes `JobQueue.SysEvent`. | Async consumers must poll; separate ticket. |
| **G4** | Idempotency is honored on `internal/*` routes and the async summary body, but not on public sync writes. | SDK auto-retry must not retry sync POSTs without an idempotency key. |
| **G5** | Async-job status casing is inconsistent across two endpoints of the same workflow: `AsyncJobResponseDto.status` uses `pending\|processing\|completed\|failed`; `JobStatusResponse.status` uses `PENDING\|RUNNING\|COMPLETED\|FAILED\|CANCELLED`. Not a 1:1 mapping. | SDK types both faithfully rather than silently normalizing — ships `isTerminalJobStatus()` to accept both vocabularies. Gateway-side fix tracked separately (TASK-638). |
| **G6** | `JobStatusResponse` timestamps are declared `Date` server-side but always cross the wire as ISO strings (via `JSON.stringify`). | SDK types them as `string` — wire truth over declaration. |
| **G7** | Category wildcard scopes (`consultation:*`, `stt:*`, `admin:*`) never matched in `ApiKeyService.hasScope` — fixed in this ticket as a regression B1 would otherwise have introduced when scope enforcement went live. | `hasScope` now handles the trailing `:*` form. |
| **G8** | `PATCH :id/summary/:summaryId` has no optimistic concurrency, contrary to the house OCC pattern — no `@RequiresIfMatch()`/`@ExpectedVersion()`, edits append a new `ContextItemVersion` row instead. | SDK ships `update(..., { ifMatch })` forward-compatibly (harmless no-op today) rather than claiming concurrency protection that doesn't exist. Whether the route should be OCC-protected is a gateway decision. |
| **G9** | `JobStreamEvent`'s union can't be discriminated on the presence of `error` — a FAILED job also carries its own `error?: string`. | Discriminate on the presence of `status` instead. |
| **G10** | No seeded API key could generate a summary — every seeded key carried `consultation:report:read` but none carried `consultation:report:write`. Fixed by adding the write scope to the SDK-type seeded keys. | Local dev / SDK integration tests would 403 on the flagship day-1 capability otherwise. |
| **G11** | Two SDK-reachable routes (`consultations.get`, `summaries.update`) were left unscoped by the initial scope-enforcement pass. Fixed — both now declare `@RequiredScopes`. | Boot audit rewritten to assert over the named route set rather than a brittle count. |

Full ticket context (requirement analysis, design, implementation plan, verification evidence)
remains in the archived README if `docs/archive/**` access is available in your environment.
