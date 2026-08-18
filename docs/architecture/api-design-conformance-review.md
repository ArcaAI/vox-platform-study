# API design conformance review — plane taxonomy & auth model

| | | | |
|---|---|---|---|
| **Owner** | Platform / Architecture | **Date** | 2026-08-18 |
| **Scope** | `apps/api` — 104 HTTP controllers, 3 WS gateways, 605 HTTP/SSE handlers | **Status** | Review — no code changed |

Evidence base: [api-controller-inventory.md](./api-controller-inventory.md) (re-verified against source 2026-08-18) and [api-controller-groupings.md](./api-controller-groupings.md).

---

## 0. The policy under review

| # | Rule |
|---|---|
| P1 | Standalone features and core business capabilities MUST NOT carry `admin` in the prefix |
| P2 | Administrative features MUST carry `admin` in the prefix |
| P3 | Internal service-to-service endpoints MUST carry `internal` in the prefix |
| A1 | Non-`admin` (business) routes: auth model = **JWT + API key** |
| A2 | `admin` routes: auth model = **JWT only**; API keys prohibited |
| A3 | Compat / SDK-compat surfaces: out of scope (dedicated deprecation ticket) |
| R1 | One resource MAY expose separate admin and business endpoints |
| R2 | SSE follows the same rules as REST |
| R3 | WebSocket: only the party that requested the connection may use it |

**Verdict on the policy: sound, and it matches current REST/OAuth practice** — plane separation by URI segment, credential class by plane, capability-scoped tokens. Two refinements are required before it can ship as stated; both are in §3.

---

## 1. Conformance scorecard

| Rule | Conformant | Non-conformant | Notes |
|---|---:|---:|---|
| A2 — admin ⇒ JWT only | 2 controllers | **65 controllers / 386 handlers** | Only `AdminImpersonationController` and `ConsentGrantController` already carry `@ForbidApiKey()` |
| A1 — business ⇒ JWT + API key | 14 controllers | **18 controllers / 69 handlers** | Several are legitimate exemptions — see §2.2 |
| P1/P2 — prefix matches nature | **all** | ~~2 controllers~~ 0 | ~~`MonitoringController`, `ApiHealthController` (`/services` routes)~~ — **CLOSED by TASK-759**: `monitoring` → `admin/monitoring`; the two `/health/services` routes split into `AdminHealthServicesController` at `admin/health/services`. Hard move, no alias (there is no redirect convention in `apps/api`); gates, throttles and `@ForbidApiKey()` carried across unchanged. |
| P3 — internal prefix | 5/5 | 0 (prefix) / 0 | `SttInternalController` is the lone internal surface on the API-key path — **recorded by TASK-759 as a POLICED CARVE-OUT, not drift**: BUG-013 requires the STT worker to present a real `ApiKey` row, and `RESERVED_INTERNAL_SCOPE_CONTROLLERS` fails boot if the reserved `internal:`-rooted scope is dropped. Documented in `api-controller-inventory.md` §1 and at the controller (`// API-KEY-NOTE`). |
| R3 — WS requester-only | **2/2 in-scope gateways** | 0 | ~~One critical (STT hijack), one defence-in-depth (TTS origin)~~ — STT closed by TASK-754 (`e3f3713fb`); TTS closed by TASK-755 (origin/CSWSH check + `tts_session` mint branch). Original finding text kept below. |

---

## 2. Findings

### 2.1 [P0-SECURITY] Same-tenant live-session hijack on `/ws/stt/stream`

> **RESOLVED 2026-08-18** by commit `e3f3713fb` (TASK-754), after this review was written. `rebindSession` now carries an owner invariant that refuses the rebind on mismatch — closes the new socket `4401` and leaves the incumbent connected. `StreamSessionTenantBindingService` tracks `userId`. The analysis below is retained as the record of the defect; **the line numbers cited predate the fix.**

Not a policy gap — an exploitable defect, and the clearest violation of R3. Three gates check **tenant only**, never the session's owning user:

| Gate | Location |
|---|---|
| Ticket mint, `scope: stt_session:<id>` | `auth.controller.ts:1015` — `boundTenantId !== activeTenantId` |
| `POST .../stream/session/:id/refresh-ticket` | `tenant-owned-resource.interceptor.ts:162` — same comparison |
| Connect-time rebind | `stt-ws.gateway.ts:546` → `rebindSession`, `:738` `session.userId = stored.userId` — **unconditional overwrite, no prior-owner comparison** |

Any authenticated user in the tenant who learns a colleague's `sessionId` can mint a ticket, connect, and have the live clinical audio-ingest + transcript stream transplanted onto their socket. The original clinician's socket is orphaned — next frame returns a generic `NO_SESSION`; `handleDisconnect` treats the stale entry as ordinary cleanup, so nothing is logged as anomalous. Enables mid-consultation eavesdropping, audio injection, and silent DoS.

**Root cause is structural.** `StreamSessionTenantBindingService` maps `sessionId → tenantId` only; `StreamSessionMeta` carries just `sampleRate`. **No owner identity is recorded anywhere to check against.** The existing `stt-session-cross-tenant.spec.ts` pins the *tenant* boundary and never covered same-tenant/different-user.

`closeStreamSession` and `switchStreamSessionToFallback` share the same tenant-only gate, so a gateway-only patch is insufficient.

### 2.2 [P1] A2 — the admin plane is uniformly API-key reachable

65 controllers / 386 handlers. Retiring API keys there makes **56 `admin:*` scopes** (55 concrete at `apikey-scopes.registry.ts:39-134`, plus the `'admin:*'` wildcard at `:152`) inert, plus the `webhook:*` family, whose only consumer (`WebhookController`) sits at `admin/webhooks`. Inert, not deleted — see §3.1 step 2.

**The real defect behind this rule** is not the key path itself but the missing privilege ceiling: `ApiKeyService.create()` persists `request.scopes` as-is (`apikey.service.ts:326`) with **no check that the caller holds the ability the scope implies**. A tenant admin — gated only by `manage:ApiKey`, not SUPER_ADMIN — can mint a key carrying `admin:*` or `'*'`. Already documented as an open gap (`conformance/gateway-and-sdk.md` §6.4) and deferred by TASK-708 §8.5.

Partial mitigation, worth stating precisely: `UnifiedAuthGuard.enforceApiKeyAbilities()` (`unified-auth.guard.ts:448-505`) evaluates the route's CASL metadata against the key's **bound user** at request time. Scope and ability are a conjunction, never a fallback, and an unbound `SERVICE_ACCOUNT` key is refused outright on any permissioned route. So over-granting does not create a raw privilege delta — it creates a **long-lived static credential with an admin's blast radius**, minus MFA, session expiry, and revocation-on-logout. That risk profile is the case for A2.

**On prior decisions.** TASK-708 §6 asked this question and the owner answered: *"Lets review, suggest best practices. We cannot mix the `/admin/*` and `/internal/*` routes as they was design for different purposes."* That ruled out **mixing the two mechanisms**; it did not rule that admin must accept API keys. The implementation chose scope-narrowing as its reading. A2 narrows further and is consistent with the ruling — this is a refinement, not a reversal.

**Blast radius of A2 — small.** No first-party dependency: `apps/admin-console`'s BFF sends `Authorization: Bearer` only (`hope-proxy.ts:20-35`); no CI/deployment/script automation calls admin routes with a key; `vox-node` never touches `/admin/*`. Breakage is confined to (a) **two** e2e specs that assert the current contract (`task-708-apikey-scope-contract.spec.ts`, `api-key-auth.spec.ts` — `api-key-owner-scope.spec.ts` only ever sends `bearer(...)`), (b) dev-only seeded keys (`shouldSeedApiKeys()` gates prod out), and (c) `@arcaai/vox`'s documented `apiKey` credential path to admin hooks (`useAdminConsultations`, `useHarnessAdmin`, …) — no known consumer, but a public README contract.

### 2.2b [INFO] An accidental defence already blocks API keys from super-admin routes

`handleApiKeyAuth` sets the CLS principal to `{ id, tenantId }` only — **no `roles`** (`unified-auth.guard.ts:339-344`). `isSuperAdmin()` reads `user.roles` (`tenant-guards.ts:55-59`). So every imperative super-admin check already returns `false` for an API-key caller, and the super-admin-only admin surfaces are *effectively* JWT-only today.

Two consequences:

- **It narrows A2's real exposure.** The admin routes genuinely reachable by API key are the tenant-admin-level ones, not the super-admin ones. TASK-757 largely formalises what is already accidentally true at the top of the privilege range.
- **It is a latent landmine.** This is a side effect of an unpopulated field, not an explicit deny. Anyone "fixing" the API-key principal to carry roles — a reasonable-looking improvement — would silently open every super-admin-only route to API keys, with no test failing. Pin it with an explicit regression test regardless of A2's fate.

### 2.3b [P1] Audit cannot attribute an action to a machine

`AuditLog` carries only `responsibleUserId` / `responsibleIp` (`audit.prisma:11-12`), and `BaseService` stamps the bound *human* user. A machine's administrative action is therefore recorded against a person. This makes audit attribution for any future service-account credential a **schema change**, not just plumbing — factor it into TASK-762 rather than discovering it during implementation.

### 2.3 [P1] A2 leaves **zero** machine path to administration

`X-Service-Token` is structurally confined to `/internal/*` (no admin controller uses those guards). There is no OAuth2 client-credentials flow and no machine JWT. The only reserved internal scope is `internal:stt:worker`. Applying A2 with nothing built to replace it removes headless administration entirely rather than narrowing it. See §3.1.

### 2.4 [P2] A1 — 18 business controllers forbid API keys

**Correction to the framing:** 15 of the 18 do not carry a deliberate decision at all — they carry a verbatim `// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION` block that explicitly defers to an owner ruling and notes *"Reversing it is a one-line change"*. A1 therefore **supplies the classification those blocks are waiting for** rather than reversing anything.

Even so, applying A1 blanket would open personal and biometric surfaces to static credentials: `DnaWritingStyleController` (14 handlers, owner/doctor-gated), `VoiceProfileController` (5, voice biometrics), `PromptTemplateController` (5, owner-scoped writes). Recommend a **narrow, documented exemption list** rather than blanket application — see §3.3.

Three of the 18 are not really A1 candidates at all:
- `AuthController` — the credential-issuing plane. A key authenticating `logout`/`refresh`/`stream-ticket` is circular; keep `@ForbidApiKey()`.
- `ApiHealthController` — public probes plus ops telemetry; split per §2.5.
- `MonitoringController` — an admin capability, not business; move per §2.5.

### 2.5 [P2] P1/P2 prefix misplacements

| Controller | Now | Nature | Action |
|---|---|---|---|
| `MonitoringController` | ~~`api/v1/monitoring`~~ → `api/v1/admin/monitoring` | requires `manage:all \| read:TenantTelemetry` | **DONE (TASK-759).** Prefix moved; `@CanAny` (OR mode), `@Throttle(300/60s)` and `@ForbidApiKey()` unchanged. Already JWT-only, so A2-compliant on arrival. |
| `ApiHealthController` `/services`, `/services/:serviceKey` (**`:serviceKey`**, not `:key` — D-1) | `api/v1/health` | ops telemetry behind CASL | **DONE (TASK-759).** Split executed: the four probes stay `@Public()` on `health`; the two CASL-gated routes are now `AdminHealthServicesController` at `api/v1/admin/health/services`, carrying the same `@CanAny`, the same 30/60s throttle and the same `@ForbidApiKey()`. `ApiHealthController` is no longer "Mixed". |
| `SttInternalController` | `api/v1/internal/stt` | prefix correct; auth deviates | **Already settled and boot-policed — no decision needed.** `RESERVED_INTERNAL_SCOPE_CONTROLLERS` (`api-key-scope-audit.ts:169`) names the exemption and fails boot if the reserved scope is removed; `task-708-apikey-scope-contract.spec.ts:30-49` records it as *"the SETTLED design … do not re-derive"*. BUG-013 requires the STT worker to present a real `ApiKey` row. Action is **documentary**: record it in the inventory so it stops reading as drift. |
| `WorkflowSandboxRunController` | `api/v1/admin/…` | doc comment says *"Session-JWT admin console ONLY"* yet carries `admin:workflow-definition:manage` | Unenforced drift (`conformance/gateway-and-sdk.md` §6.3); A2 fixes it automatically |

### 2.5b [P2] The admin boot audit's static list has already drifted

`ADMIN_SCOPED_CONTROLLERS` polices **63 of the 65** admin controllers: `KnowledgeController` (`knowledge.controller.ts:31`) and `WorkflowSandboxRunController` (`workflow-sandbox-run.controller.ts:33`) both declare `@RequiredScopes` yet are absent from the hand-maintained list. This is the argument for TASK-761's inverted, metadata-driven audit: a transcribed list drifts silently, a derived one cannot.

### 2.6 [P3] Business-plane shape drift

Not covered by your four rules, but visible once the planes are separated:

- **Singular/plural mixed:** `user/me/*` vs `users/:id/roles` vs `users/password-reset`; `tenant` vs `admin/tenants`; `voice-profile` vs `dna-writing-styles`.
- **"Mine" has three shapes:** bare (`billing`, `usage`, `entitlements`, `tenant`), `user/me/*`, and `tenant/me/context-schema`.
- **Verb-as-resource:** `rbac/check` is RPC, not a resource.
- **Service-named prefixes leak topology:** `ai` and `text` name internal services rather than capabilities. **Correction:** `speech` does *not* — its backing service is `apps/tts` (`speech-proxy.controller.ts:145` resolves `TTS_URL`), so `speech` is already a capability name and is not an offender.
- **Misleading class name:** `AudioPipelinePublicController` is JWT-only, not `@Public()`.

### 2.7 R1 already has precedent — codify it

The "one resource, two endpoints" rule is established in five places and should be named as the standard, not reinvented: `Consultation`/`AdminConsultation`, `AudioPipeline`/`AudioPipelinePublic`, `DnaWritingStyle{,Admin}`, `TranscriptionJob`/`AdminTranscriptionJob`, `ConsultationContextSchemaAdmin`/`MyTenantContextSchema`.

---

## 3. Recommendations

### 3.1 Adopt A2, but ship the machine identity in the same change

Sequenced, because A2 alone strands automation:

1. **Now — close the actual hole.** Add the privilege ceiling to `ApiKeyService.create()`/`update()`: reject any scope whose implied ability the *calling principal* does not hold. This removes the escalation path regardless of what happens to A2, and it is the fix the conformance doc already recommends.
2. **Then — apply `@ForbidApiKey()` at class level across all 65 admin controllers.** That alone is sufficient: `enforceApiKeyNotForbidden` runs *before* the scope check (`unified-auth.guard.ts:365`, *"a forbidden route has no scope that could rescue it"*), so every `admin:*` scope — including `'*'` — becomes inert without touching the registry. Scopes are an API-key-only concept; the JWT path never reads them.

   **Do NOT delete the 56 `admin:*` scope strings.** They are the exact vocabulary a future service-account credential (step 3) will need, and deleting them means re-deriving the taxonomy later. Instead:
   - mark them **reserved** so `ValidScopesConstraint` refuses to grant them on `POST /admin/api-keys` (reject newly-added scopes only, so updating a pre-existing key does not fail on its stored array);
   - drop them from the advertised `GET /admin/api-keys/scopes` response, so the catalog stops promising access the platform will always refuse.

   **Regrowth is stopped by enforcement, not by deletion** — a `@RequiredScopes` decorator takes a raw string, so an emptied registry would not catch a new admin controller anyway. Extend the existing boot audits (`admin-scope-audit.ts`, `api-key-surface-audit.ts`) to **fail boot** when an `admin/`-prefixed controller declares `@RequiredScopes`.
3. **Machine administration** gets a deliberate answer rather than an accident. Pre-launch, the honest position is: *tenant-facing headless administration is unsupported until a service-account credential exists.* When it is needed, add a distinct credential class (OAuth2 client-credentials or a platform-issued service account with its own `svc:*` scope namespace and short-lived tokens) — **not** a reuse of the tenant API key, and **not** `X-Service-Token`, which stays confined to `/internal/*` per the owner's non-mixing ruling.

Do not silently overwrite TASK-708/742's record — append the decision, since those documents state the opposite reading.

### 3.2 Reserve `internal` for genuine service-to-service only

`/internal/*` should remain `@Public()` + service-token, never JWT, never tenant API keys. Converge `SttInternalController` onto the service-token guard, or record the BUG-013 exception explicitly in the inventory so it stops reading as drift.

### 3.3 Apply A1 with a documented exemption list

Default business routes to JWT + API key. Keep `@ForbidApiKey()` only where there is a stated reason, recorded inline. **Use the right marker:** API-key posture uses `// API-KEY-NOTE` (18 occurrences); `// AUTH-NOTE` (22) marks a *decorator-understates-the-gate* case. They are different conventions — consolidating or converting them is part of the work, not a free rename:

| Keep key-forbidden | Reason |
|---|---|
| `AuthController` | credential-issuing plane; circular otherwise |
| `ConsentGrantController` | human-only consent decisions (PHI posture) |
| `VoiceProfileController` | voice biometrics |
| `DnaWritingStyleController` | personal clinician writing model, owner-gated |

Everything else on the business plane gets a resource-scoped key path. **Make the `me` semantics explicit**: an API key is bound to a user, so `/user/me/*` under a key resolves to the *key's bound user*. Document it, or the first integrator will assume it resolves to the key's tenant.

### 3.4 WebSocket standard (R3)

Make the requester binding real, in this order:

1. **Record the owner.** Extend `StreamSessionTenantBindingService` to bind `sessionId → { tenantId, userId }`. Today there is nothing to check against.
2. **Check it at all four enforcement points** — ticket mint, refresh-ticket, connect/rebind, and close/switch. Cross-user within a tenant must 404, matching the cross-tenant posture.
3. **Refuse rebind on owner mismatch** at `stt-ws.gateway.ts:738`; never overwrite `session.userId`. On mismatch, close `4401` and leave the incumbent connected.
4. **Close the incumbent explicitly on legitimate resume** so takeover is never silent, and log it as a security event.
5. **DONE (TASK-755).** **Add the fail-closed Origin/CSWSH check to `TtsWsGateway`.** Correction: STT's comments argue alignment with the **HTTP CORS path** (`cors.config.ts`), not with TTS — the STT gateway never mentions TTS. The reasoning still transfers, and is the stronger argument: browsers exempt WebSockets from CORS entirely, so CSWSH is the one vector CORS cannot cover — on TTS as much as STT.
6. **DONE (TASK-755), as Option A rather than an ownership branch.** **Add an ownership branch for `tts_session:*` at mint** — currently the only scope prefix with no check at all. *Outcome:* an ownership branch is not implementable today — there is no server-side TTS session resource to look up (`SpeechProxyController` exposes only `synthesize` and `voices`), so `assertTtsSessionScopeShape` asserts what is knowable (well-formed bounded id + active tenant) and carries the reason plus the trigger that would upgrade it to a real ownership check. See `docs/implementation/TASK-755-Tts-Ws-Hardening/README.md` §Design decision.
7. **Regression tests**: same-tenant/different-user denied at each of the four points. That case has never been covered.

`SttWsGateway` remains the reference implementation on every other axis — single-use 30s tickets, fail-closed non-enumerable `4401`s, message-level binding to the connect-time session object.

### 3.5 Normalize the business plane (low risk, do it before launch)

- Plural resource collections. **But a single `/users/me/**` alias is the wrong target** — `billing`, `usage`, `entitlements`, `tenant` and `tenant/me/context-schema` are all `read:Tenant`/CLS-**tenant**-scoped, not user-scoped; folding them under `users/me` would assert something false about ownership. Use two aliases: `/users/me/**` for user-owned and `/tenants/me/**` for tenant-owned.
- **Route-collision hazard:** `UserRolesController` is `@Controller('users')` with `@Get(':id/roles')` (`user-roles.controller.ts:23,41`), so `GET /users/me/roles` is captured by `:id === 'me'` unless registration order is pinned. Needs an explicit test.
- Redirect shims must be **308**, not 301/302 — the latter permit a client to drop a POST body.
- Replace `rbac/check` with a resource form (e.g. `POST /users/me/permission-checks`).
- Rename capability prefixes off internal service names: `ai` and `text` → the capability they expose.
- Rename `AudioPipelinePublicController` — it is not public.
- **There is no redirect convention in `apps/api`** — zero `@Redirect`, zero 301/308, zero `deprecated: true`. The one-release-redirect rule is a Next.js page convention (`13-nextjs-apps.md`) with no gateway equivalent. Treat a hard move as the default and make any deprecation window an explicit owner decision.

### 3.6 Enforce in CI, not review

Every rule above is mechanically checkable. Add boot-time/lint gates: admin prefix ⇒ no `@RequiredScopes`; internal prefix ⇒ service-token guard; business prefix ⇒ either `@RequiredScopes` or a justified `@ForbidApiKey()`. The deny-by-default route audit already proves this pattern works.

**Status (TASK-761, 2026-08-18) — all four gates are live, with three corrections to the wording above.**

| Gate | Mechanism | Where |
|---|---|---|
| admin ⇒ no `@RequiredScopes` | boot audit (derived sweep) | `auditAdminControllersDeclareNoApiKeyScopes` — shipped with TASK-757 |
| internal ⇒ service-token guard | boot audit — **already existed** since TASK-708 | `auditInternalRoutesOffApiKeySurface`; TASK-761's delta is a test that FREEZES `RESERVED_INTERNAL_SCOPE_CONTROLLERS` at its single member, which nothing previously constrained |
| business ⇒ scope, or justified forbid | **split**: boot audits for presence + named exemption, lint for the justification | `api-key-surface-audit.ts` + `business-plane-apikey-exemptions-audit.ts`, plus `arcaai-internal/require-api-key-justification` |
| WS owner binding | boot audit for the DECLARATION + named regression specs for the behaviour | `ws-gateway-owner-audit.ts` |

1. **The justification half cannot be a boot audit.** A reason is a comment; `tsc` strips comments before any Nest metadata exists, so no `Reflector` can read one. It is a lint rule, and that is not an implementation preference — it is the only mechanism that sees source text.
2. **The marker is `// API-KEY-NOTE`, not `// AUTH-NOTE`** (owner decision, 2026-08-18). The two are deliberately distinct: `API-KEY-NOTE` classifies a surface's API-key posture; `AUTH-NOTE` is `.claude/rules/05-nestjs-api.md`'s marker for a permission decorator that understates the real gate. Every business-plane `@ForbidApiKey()` in the tree already carried `API-KEY-NOTE`, so there was no comment migration.
3. **WebSocket gateways are Nest PROVIDERS, not controllers.** Every audit in `apps/api/src/bootstrap/` walked `moduleRef.controllers` and was therefore blind to all three gateways. The WS gate walks `moduleRef.providers`, and it pins only the declaration — no metadata check can prove a runtime owner comparison, so claiming otherwise would ship a gate stronger in name than in fact.

---

## 4. Suggested sequencing

| Order | Work | Risk |
|---|---|---|
| 1 | ~~§2.1 WS hijack + §3.4 items 1-4, 7~~ — **DONE**, commit `e3f3713fb` (TASK-754) | Security — was first |
| 2 | §3.1 step 1 — privilege ceiling on key minting | Security — small, self-contained |
| 3 | ~~§3.4 items 5-6 — TTS origin + `tts_session` ownership~~ — **DONE** (TASK-755) | Low |
| 4 | ~~§3.1 step 2 — `@ForbidApiKey()` across admin + reserve scopes + boot audit~~ — **DONE** (TASK-757) | Medium; 3 e2e specs to rewrite |
| 5 | ~~§2.5 prefix moves (`monitoring`, `health/services`)~~ — **DONE** (TASK-759). Hard move, no redirect: verified there is no `@Redirect`/301/308/`deprecated: true` precedent anywhere in `apps/api`, and no consumer outside this repo. | Low; pre-launch |
| 6 | ~~§3.3 A1 rollout with exemption list~~ — **DONE** (TASK-758); the list is down to 3 controllers | Low |
| 7 | §3.5 business-plane normalization | Low, broad diff |
| 8 | Compat surfaces (A3) | Deferred — dedicated deprecation ticket |
