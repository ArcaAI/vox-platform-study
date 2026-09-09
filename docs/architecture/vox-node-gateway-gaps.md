# @arcaai/vox-node — Known Gateway Quirks

Recorded 2026-08-16. These are gateway (`apps/api`) behaviors the Node SDK
deliberately surfaces rather than papers over — read this before "fixing" a quirk in
`packages/vox-node` that actually belongs on the gateway.

| #       | Gap                                                                                                                                                                                                                                                                 | Impact                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1**  | API-key scopes were unenforceable when this was written — no decorator ever set the `requiredScopes` metadata the guard reads. Fixed on the SDK's own surface.                                                                                       | Historical — confirm current state in `unified-auth.guard.ts` before assuming it still applies.                                                                                                                 |
| **G2**  | No published `openapi.json` — Swagger is built at runtime, non-production only, never written to disk.                                                                                                                                                              | Blocks contract tests / generated types.                                                                                                                                                                        |
| **G3**  | Webhooks never fire — `Webhook.hashedSecret` / `WebhookRunHistory` are modeled, `sysEvent.service.ts` comments that the queue feeds webhooks, but no processor consumes `JobQueue.SysEvent`.                                                                        | Async consumers must poll; separate ticket.                                                                                                                                                                     |
| **G4**  | Idempotency is honored on `internal/*` routes and the async summary body, but not on public sync writes.                                                                                                                                                            | SDK auto-retry must not retry sync POSTs without an idempotency key.                                                                                                                                            |
| **G5**  | Async-job status casing is inconsistent across two endpoints of the same workflow: `AsyncJobResponseDto.status` uses `pending\|processing\|completed\|failed`; `JobStatusResponse.status` uses `PENDING\|RUNNING\|COMPLETED\|FAILED\|CANCELLED`. Not a 1:1 mapping. | SDK types both faithfully rather than silently normalizing — ships `isTerminalJobStatus()` to accept both vocabularies. A gateway-side fix is tracked separately.                                               |
| **G6**  | `JobStatusResponse` timestamps are declared `Date` server-side but always cross the wire as ISO strings (via `JSON.stringify`).                                                                                                                                     | SDK types them as `string` — wire truth over declaration.                                                                                                                                                       |
| **G7**  | Category wildcard scopes (`consultation:*`, `stt:*`, `admin:*`) never matched in `ApiKeyService.hasScope` — fixed as a regression B1 would otherwise have introduced when scope enforcement went live.                                               | `hasScope` now handles the trailing `:*` form.                                                                                                                                                                  |
| **G8**  | `PATCH :id/summary/:summaryId` has no optimistic concurrency, contrary to the house OCC pattern — no `@RequiresIfMatch()`/`@ExpectedVersion()`, edits append a new `ContextItemVersion` row instead.                                                                | SDK ships `update(..., { ifMatch })` forward-compatibly (harmless no-op today) rather than claiming concurrency protection that doesn't exist. Whether the route should be OCC-protected is a gateway decision. |
| **G9**  | `JobStreamEvent`'s union can't be discriminated on the presence of `error` — a FAILED job also carries its own `error?: string`.                                                                                                                                    | Discriminate on the presence of `status` instead.                                                                                                                                                               |
| **G10** | No seeded API key could generate a summary — every seeded key carried `consultation:report:read` but none carried `consultation:report:write`. Fixed by adding the write scope to the SDK-type seeded keys.                                                         | Local dev / SDK integration tests would 403 on the flagship day-1 capability otherwise.                                                                                                                         |
| **G11** | Two SDK-reachable routes (`consultations.get`, `summaries.update`) were left unscoped by the initial scope-enforcement pass. Fixed — both now declare `@RequiredScopes`.                                                                                            | Boot audit rewritten to assert over the named route set rather than a brittle count.                                                                                                                            |

## Addenda

### 2026-09-08 (TASK-931) — **G3 is CLOSED**

Webhook delivery shipped in TASK-890: a processor consumes the queue, deliveries are signed
(`X-Hope-Webhook-Signature: sha256=<hex>` over the RAW body), and `WebhookRunHistory` records
them. `@arcaai/vox-node` ships the RECEIVER half — `verifyWebhookSignature` — and the outbound
trigger half for `POST /hooks/workflows/{hookId}` (`signWebhookTrigger`, a different header and
a different signed string: the trigger folds `X-Hope-Timestamp` into the HMAC, which is what
makes the gateway's 300-second replay window mean anything).

The row is left in the table above rather than deleted: a reader who arrives from a comment,
a changelog entry, or a search for "webhooks never fire" needs to find the correction where the
claim is, not discover that the claim silently disappeared. **Async consumers no longer have to
poll.**

### 2026-09-08 (TASK-931) — two additions, neither a gap

Recorded here because both change what the SDK may assume about the gateway, and the next
person to read this file for "what is the gateway actually like" should not have to reconstruct
them from a changelog:

- **The agent and workflow INVOCATION planes now accept a service account** (TASK-930 §3:
  `svc:agent:definition:read`, `svc:agent:invocation:write`, `svc:workflow:definition:read`,
  `svc:workflow:run:read`, `svc:workflow:run:write`). They previously recorded `svcScopes: []`,
  and the SDK refused a service-account client at the call site rather than ship a 403 no role
  grant could fix — that refusal is gone. The CONSULTATION-bound plane
  (`/consultations/{id}/workflows*`) deliberately gained none and still refuses: running a
  workflow that writes into a clinical record is not a machine-identity power.
- **A run stream can be read over a WebSocket** via a run-scoped, single-use ticket
  (`POST /workflows/{slug}/runs/{runId}/stream-ticket` → `{ ticket, expiresAt, scope, url }`,
  ~30s, scope `workflow_run:<runId>`, compared by strict equality). SSE remains the default and
  the only lane that RESUMES — the socket ticket is single-use, so a dropped socket ends the
  read where SSE reconnects with `Last-Event-ID` and loses nothing.

### 2026-09-09 (TASK-933) — the realtime consultation plane, and what it changes about the gateway

The owner opened the CONSULTATION surface to HOPE's machine identity (OD-1: a
NATIVE service-account plane, not delegation). Four facts a reader of this file
needs, none of which is a gap:

- **A service account can now run a consultation.** The realtime routes declare
  `svc:consultation:session:write`, `svc:consultation:session:read`,
  `svc:consultation:report:read`, `svc:tenant:context-schema:read` and
  `svc:workflows:execute`. Before this they declared none, and an absent scope
  declaration is a deny-by-default 403 for both machine classes — so the plane
  was unreachable rather than restricted.
- **The consultation-bound WORKFLOW plane is no longer machine-refused.** The
  2026-09-08 addendum above records the opposite ("running a workflow that writes
  into a clinical record is not a machine-identity power"), and that was true of
  the gateway as it stood. OQ-2 reverses it for this plane under
  `svc:workflows:execute`. `assertApiKeyPlane` and `CredentialClassError` remain
  exported, but **no plane in `@arcaai/vox-node` calls the check any more**.
- **A machine names the clinician; it never becomes one.** `POST /consultations/open`
  gained `clinicianUserId`, REQUIRED for a service-account caller and refused for
  a human one. It lands on `Consultation.doctorId`, which is the column every
  downstream consumer already reads (DNA writing style, redaction gate, the
  doctor's report, prompt tier). Audit stays principal-correct — the service
  account is the actor, the named clinician is the doctor.
- **An STT streaming session is owned by whichever principal opened it**,
  service accounts included. The session's ticket mint, refresh, WS handshake and
  close all compare against that owner, so a second client — even on the same
  tenant — gets 404, the ordinary 404-over-403 posture rather than a broken id.

Two SDK-side consequences worth writing down here, because they are properties of
the gateway that the SDK only mirrors:

1. **The live-summary SSE channel is MULTIPLEXED and discriminates inside the
   JSON.** Three payload kinds ride `GET :id/live-summary/stream` — the legacy
   whole-document snapshot, `section.patch`, and `presummary` — and every one of
   them is relayed as a default `message` frame. The `event` field is a property
   of the payload, not the SSE frame, and the legacy snapshot carries none at all.
   A consumer that switches on the SSE `event:` line sees one undifferentiated
   stream.
2. **The STT stream ticket is single-use, so a WebSocket reconnect is not a
   retry.** It is consumed at the handshake; reconnecting means minting a fresh
   ticket (`POST …/stream/session/:id/refresh-ticket`) and then sending
   `{type:'resume', sessionId, lastSeq}` on the new socket. The server replays
   only `seq > lastSeq`, from a bounded buffer — `resume_failed` with
   `buffer_overflow` is a REAL transcript gap, not a retryable condition. This is
   the mirror image of the workflow run socket recorded above, where SSE is the
   only lane that resumes: here the socket resumes and there is no SSE lane at
   all.
