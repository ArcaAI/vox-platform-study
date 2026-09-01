# 428 on the LM Studio / vLLM engine screens — root-cause analysis

Repo: `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`, branch `dev-2.2`. Read-only investigation;
nothing was edited, built or run.

---

## A. ROOT CAUSE

**The 428 is not produced by the gateway's optimistic-concurrency machinery at all — the stated
hypothesis is REFUTED.** It is produced by `apps/text`, and it reaches the screen as a *string
inside a 200 OK response body*, not as the status of the console's own request.

Causal chain: the engine screen issues `GET /api/hope/admin/ai-models/discovery?provider=<engine>`
(`apps/admin-console/src/features/inference-engines/api/client.ts:29-31`), which the BFF forwards
verbatim as a `GET` to `/api/v1/admin/ai-models/discovery`. That gateway route is a plain `@Get`
with no OCC decorators (`apps/api/src/modules/ai-model/ai-model-discovery.controller.ts:28`;
`apps/api/route-manifest.json` records `"requiresIfMatch": false` for it), so
`RequiresIfMatchGuard` never annotates the request and `extractExpectedVersion` never runs. The
handler delegates to `AiModelDiscoveryService.discover()`, which makes an **outbound axios POST to
the text service** at `${TEXT_URL}/api/v1/providers/probe`
(`apps/api/src/modules/ai-model/ai-model-discovery.service.ts:344`) carrying only two headers:

```ts
// apps/api/src/modules/ai-model/ai-model-discovery.service.ts:339-341
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
const serviceToken = this.secretsService?.getSecretSync('TEXT_SERVICE_TOKEN');
if (serviceToken) headers['X-Service-Token'] = serviceToken;
```

`X-Tenant-Id` is absent. Text enforces that header as a **middleware precondition on every
non-exempt path**, and refuses with 428:

```python
# apps/text/src/text/api/middleware/auth.py:126-137
raw = (request.headers.get("X-Tenant-Id") or "").strip()
if not raw:
    logger.error(
        "text.tenant_header.missing",
        path=request.url.path,
        detail=(
            "internal request carried no X-Tenant-Id; refusing rather than "
            "resolving the platform default provider and mis-attributing the "
            "spend. This is a CALLER defect."
        ),
    )
    return JSONResponse(status_code=428, content={"detail": _TENANT_REQUIRED_DETAIL})
```

`EXEMPT_PATHS` (`auth.py:23-33`) holds only `/metrics`, `/api/v1/docs`, `/api/v1/redoc`,
`/api/v1/openapi.json`, `/api/v1/health`, `/api/v1/health/live`, `/api/v1/health/ready` —
`/api/v1/providers/probe` is not among them.

Axios turns that 428 response into `AxiosError: Request failed with status code 428` (axios's own
message template — note the word **code**, which the console's own `GatewayError` does *not* use:
`toGatewayError` renders `Request failed with status ${response.status}`,
`apps/admin-console/src/shared/api/http.ts:81`. That single word is the fingerprint proving the
string originated in a Node axios client inside the gateway, not in the browser fetch layer).

The gateway then swallows it and reports it as a *probe result*:

```ts
// apps/api/src/modules/ai-model/ai-model-discovery.service.ts:356-361
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  this.logger.warn({ message: 'TEXT provider probe failed; discovery degrades to registry-only', error: message });
  // Every server-managed provider is UNKNOWN rather than missing.
  return [[], SERVER_MANAGED_PROVIDERS.map((provider) => ({ provider, probeStatus: 'error' as const, error: message }))];
}
```

`SERVER_MANAGED_PROVIDERS` is `DISCOVERABLE_AI_MODEL_PROVIDERS = ['ollama', 'lm-studio', 'vllm',
'llama-cpp']` (`packages/applications/src/services/stt/model/dto/create-model.request.ts:38`), so
**both** engines get `probeStatus: 'error'` and the same message; `discover()` then filters to the
requested one (`ai-model-discovery.service.ts:208`). The console receives **HTTP 200** with that
document, so `discovery.error` is undefined, `gatewayError` is falsy
(`engine-screen.tsx:180`), the `ProbeBanner` renders instead of the `ErrorState`
(`engine-screen.tsx:211`), `probeLabel` maps `'error'` → `Unreachable`
(`engine-screen.tsx:48`) and the banner prints the probe error verbatim
(`engine-screen.tsx:71`). Result on screen: **"Unreachable" + "Request failed with status code
428"**.

**The 428 fires before the handler runs, and therefore before text ever tries to open a socket to
LM Studio or vLLM.** The engines' actual state is never observed.

### Exact origin

`/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/text/src/text/api/middleware/auth.py:137`
(`return JSONResponse(status_code=428, content={"detail": _TENANT_REQUIRED_DETAIL})`), triggered by
the missing header at
`/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/api/src/modules/ai-model/ai-model-discovery.service.ts:339-341`.
The defect is in the CALLER (the gateway), exactly as text's own comment says.

### Why this is a *caller* defect and not a text-side over-reach

The contract is explicit and platform-wide: `.claude/rules/00-project-context.md` §"Tenant identity
is mandatory on internal service calls" — *"`X-Tenant-Id` is REQUIRED on every internal
service-to-service request that carries tenant-scoped work. A peer client that omits it is a bug in
the CALLER."* The shared helper exists and is already used by the sibling call sites:

```ts
// apps/api/src/modules/streaming/text-proxy.controller.ts:399-405
private getForwardHeaders(): Record<string, string> {
  const serviceToken =
    this.secretsService?.getSecretSync('INTERNAL_ACCESS_TOKEN') || this.secretsService?.getSecretSync('TEXT_SERVICE_TOKEN') || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [TENANT_ID_HEADER]: tenantHeaderValue(this.clsService?.get('tenantId'), TENANTLESS.PLATFORM_OPERATOR),
  };
```

That file's own docstring (`text-proxy.controller.ts:383-392`) records TASK-737 fixing this exact
omission at "all seven call sites" in that controller. `AiModelDiscoveryService.probeText` was
never included in that sweep — it already reads `tenantId` from CLS a few lines earlier
(`ai-model-discovery.service.ts:279`, for connection resolution) but never puts it on the wire.

---

## B. CALL PATH TABLE

| # | Hop | file:line | Method + path | Headers added / dropped | Outcome |
|---|---|---|---|---|---|
| 1 | React hook | `apps/admin-console/src/features/inference-engines/api/hooks.ts:21-28` | — (`useQuery`, `retry: false`) | — | calls `getEngineDiscovery(provider)` |
| 2 | Feature client | `.../inference-engines/api/client.ts:29-31` | `getJson('admin/ai-models/discovery', { provider })` | — | delegates to shared http |
| 3 | Browser fetch | `apps/admin-console/src/shared/api/http.ts:140-151` (`getJson` at `:167-169`) | **GET** `/api/hope/admin/ai-models/discovery?provider=lm-studio` | ADDS: none (no body ⇒ no `content-type`). **NO `If-Match`** — `headers.set('if-match', …)` at `:144` only fires when `options.etag` is passed, and `getJson` passes no `etag` | request leaves the browser |
| 4 | BFF route | `apps/admin-console/src/app/api/hope/[...path]/route.ts:10-19` | same method (all five verbs share one `handler`) | — | `handleProxy(request, path)` |
| 5 | BFF proxy | `apps/admin-console/src/server/hope-proxy.ts:54-62`, allow-list at `:11` | **GET** `${API_URL}/api/v1/admin/ai-models/discovery?provider=…` | FORWARDS verbatim: `content-type`, `if-match`, `idempotency-key`, `user-agent`. ADDS: `authorization: Bearer …` (`:27`), `x-tenant-id` = working tenant when elevated (`:34-36`). DROPS: every other request header. **Synthesizes nothing** — no method rewrite, no If-Match invention | hits the gateway |
| 6 | Gateway guards | `apps/api/src/app.module.ts:246` (`RequiresIfMatchGuard` global) + `apps/api/src/decorators/requiresIfMatch.guard.ts:33-40` | — | reads `REQUIRES_IF_MATCH_KEY`; **route is not annotated ⇒ `req._requiresIfMatch` stays unset** | `return true`, no-op |
| 7 | Gateway handler | `apps/api/src/modules/ai-model/ai-model-discovery.controller.ts:28-40` | `@Get('discovery')`, `@Query('provider')` | class decorators are `@ApiBearerAuth` `@ApiTags` `@ForbidApiKey` `@RequiredSvcScopes` `@Controller('admin/ai-models')` `@Authorize(['manage','all'])` (`:19-24`). **No `@RequiresIfMatch()`, no `@ExpectedVersion()` parameter.** `route-manifest.json` → `"requiresIfMatch": false` | `discoveryService.discover(provider)` |
| 8 | Connection cascade | `.../ai-model-discovery.service.ts:275-321` | — | reads `clsService.get('tenantId')` (`:279`) to resolve the engine address | returns `{ connections, sources }` |
| 9 | **Gateway → text** | `.../ai-model-discovery.service.ts:334-344` | **POST** `${TEXT_URL}/api/v1/providers/probe` | ADDS: `Content-Type`, and `X-Service-Token` *only if* the legacy `TEXT_SERVICE_TOKEN` secret resolves. **OMITS `X-Tenant-Id`** ← the defect | — |
| 10 | text middleware | `apps/text/src/text/api/middleware/auth.py:85` (exempt check) → `:111-114` → `:119-137` | — | path not in `EXEMPT_PATHS` (`:23-33`); token check passes/bypasses; tenant check finds no header | **HTTP 428** `{"detail": "X-Tenant-Id is required on internal requests carrying tenant-scoped work. Declare 'tenantless:<reason>' …"}` — handler at `providers.py:142-162` **never runs** |
| 11 | axios | (node_modules `axios`) | — | — | throws `AxiosError`, `.message === "Request failed with status code 428"` |
| 12 | Gateway catch | `.../ai-model-discovery.service.ts:356-361` | — | — | logs a warn; returns `probes = [{provider, probeStatus:'error', error:'Request failed with status code 428'}]` for **all four** discoverable providers |
| 13 | Gateway response | `.../ai-model-discovery.service.ts:206-210` | — | — | **HTTP 200** `{ entries: [], probes: [<filtered to the asked provider>], probedAt }` |
| 14 | BFF response | `apps/admin-console/src/server/hope-proxy.ts:64-71` | — | forwards `content-type`, `etag`, `cache-control`; status verbatim (200) | — |
| 15 | Console render | `engine-screen.tsx:180-183`, `:211`, `:43-49`, `:58-77` | — | — | `gatewayError` undefined ⇒ `ProbeBanner`; badge **"Unreachable"** (`:48`); banner text **"Request failed with status code 428"** (`:71`); Models tab shows "The engine did not answer the probe" |

Secondary hop worth recording: the token presented at step 9 is the **legacy** `TEXT_SERVICE_TOKEN`
key, whereas text now accepts only the shared `INTERNAL_ACCESS_TOKEN`
(`apps/text/src/text/core/config.py:238-247` — `accepted_service_tokens` returns
`(internal_access_token,)` or `()`). Because the observed status is 428 and not 401, the token
branch did not refuse in this environment — i.e. text's `accepted_service_tokens` is currently
empty (dev/unconfigured bypass) or the gateway's `TEXT_SERVICE_TOKEN` happens to hold the shared
value. UNKNOWN which, without inspecting the live cluster config. Either way it is a latent second
caller defect on the same line: once text is properly tokenized this call becomes a **401**, not a
success.

---

## C. IS IT TWO BUGS OR ONE?

**Two independent defects, and they do not interact.**

1. **The 428 masking (a real code defect, gateway-side).** `probeText` omits the mandatory
   `X-Tenant-Id`. This is unconditional and environment-independent: it would fire identically with
   both engines at full replicas, because text refuses in middleware *before* routing to
   `probe_providers`. The console has therefore **never** observed the engines' true state through
   this screen.

2. **The engines being scaled to zero (an operational fact, not a code defect).** `hope-lmstudio`
   and `hope-vllm` at `replicas: 0` is the documented, expected state — the screens are built
   around it (`engine-screen.tsx:150-166` docstring: *"The unreachable path is the PRIMARY path.
   Both engines run at zero replicas today"*), and `useEngineDiscovery` sets `retry: false` for
   exactly that reason (`hooks.ts:8-20`).

**Fixing (1) does reveal a truthful message.** With `X-Tenant-Id` present, the probe reaches
`_probe_all` (`apps/text/src/text/api/endpoints/providers.py:110-139`), whose per-provider
isolation catches the engine connection failure and returns `probe_status: "error"` /
`"timeout"` with the real `probe_error` (`providers.py:80-98`). The gateway maps that through
`normalizeProbeStatus` (`ai-model-discovery.service.ts:348-354`) and the banner would then read
something like `connect ECONNREFUSED 10.43.2.7:1234` — which is precisely the string the existing
frontend test fixture already uses (see §E). The badge stays **"Unreachable"**; only the
explanatory line becomes true.

So: (1) is a bug worth fixing on its own merits (it is a live violation of the mandatory-tenant
directive, and it silently blinds every discovery probe, including the `/ai-models` registry-merge
screen that shares the route). (2) needs no code change at all.

---

## D. THE MLFLOW DIFFERENCE

MLflow's message is **a genuine upstream-connect failure**, fully consistent with 0 replicas. It is
not a masked error.

The difference is structural: MLflow is **not** an internal HOPE Python service, so there is no
`ServiceAuthMiddleware` and no tenant precondition in front of it. The gateway dials it directly:

```ts
// apps/api/src/modules/ai-service-admin/mlflow-proxy.client.ts:156
const health = await this.httpService.axiosRef.get<unknown>(`${baseUrl}/health`, { timeout: DEFAULT_TIMEOUT_MS });
```

With the Deployment at zero replicas the TCP connect fails, the catch at `:170-184` runs, and the
client returns a **status document** (never throws — `:143-146` says so explicitly):

```ts
// apps/api/src/modules/ai-service-admin/mlflow-proxy.client.ts:173-183
return {
  baseUrl, uiUrl,
  reachable: false,
  probeStatus,                    // 'error' (or 'timeout' via isTimeout, :301-304)
  latencyMs: Date.now() - startedAt,
  error: probeStatus === 'timeout' ? '…did not answer within the probe timeout.' : TRANSPORT_ERROR_MESSAGE,
  ...this.describeEmbeddability(null, uiUrl),
};
```

`TRANSPORT_ERROR_MESSAGE` = `'The MLflow tracking server is temporarily unavailable. Please retry.'`
(`:11`) — deliberately opaque per TASK-768, with the real cause going to the log only (`:172`,
`describeCauseForOperator`).

The console renders the heading from its own copy, not from the payload:

```tsx
// apps/admin-console/src/features/mlflow/components/mlflow-screen.tsx:72-85
function StatusBanner({ status }: { status: MlflowStatus }) {
  if (status.reachable) return null;
  …
        Tracking server not reachable
  …
      {status.error ? <span className="text-destructive/90 text-xs">{status.error}</span> : null}
```

So MLflow reads *"Tracking server not reachable"* + *"…temporarily unavailable. Please retry."*
rather than an axios string, because (a) nothing intercepts the request with a 428, and (b) the
MLflow client sanitizes its error text where the discovery service passes `err.message` through raw.
The MLflow route itself (`ai-service-admin.controller.ts:71-84`) is likewise a plain `@Get` with
`"requiresIfMatch": false` in the route manifest — no OCC involvement anywhere on this screen.

---

## E. TEST ENTANGLEMENT

**No existing test asserts the broken behaviour. Fixing the bug breaks nothing.**

| Test | file:line | What it pins | Effect of the fix |
|---|---|---|---|
| Engine screen — unreachable fixture | `apps/admin-console/src/features/inference-engines/components/__tests__/engine-screen.test.tsx:37-40` | `probes: [{ provider: 'lm-studio', probeStatus: 'error', error: 'connect ECONNREFUSED 10.43.2.7:1234', latencyMs: 12 }]` — the **truthful transport error**, not a 428 | none; the fix makes production match this fixture |
| Engine screen — banner renders the error verbatim | same file `:161-166` (`expect(within(banner).getByText(/connect ECONNREFUSED 10\.43\.2\.7:1234/))`) | that the banner echoes whatever `probe.error` says | none — the assertion is on the fixture's string, which is unchanged |
| Engine screen — "Unreachable" badge | same file `:182`, `:323`, `:331`, `:365` (vLLM case uses `error: 'no route to host'`, `:345`) | badge label for `probeStatus !== 'ok'` | none — the badge stays "Unreachable" after the fix |
| Engine screen — header comment | same file `:1-15` (*"the engine is not reachable is the PRIMARY state of these screens"*) | intent, not the defect: it describes **engine** unreachability, which is genuinely the expected state (§C item 2) | none |
| Gateway — TEXT unreachable | `apps/api/src/modules/ai-model/__tests__/ai-model-discovery.controller.test.ts:139-146` | stubs `textError: new Error('ECONNREFUSED')` and asserts only `result.probes[0]?.probeStatus === 'error'` — a transport error, and the message is never asserted | none |
| Gateway — axios stub | same file `:35-36` (`const post = …; const httpService = { axiosRef: { post } }`) | the stub **never inspects the third argument**, so the header set is unpinned today | none; this is where the regression test belongs (§F.4) |
| MLflow client — down server | `apps/api/src/modules/ai-service-admin/__tests__/mlflow-proxy.client.test.ts:101-107` | rejects with `connect ECONNREFUSED 127.0.0.1:5000`, asserts `reachable === false`, `probeStatus === 'error'` | none (MLflow path is untouched) |
| text — the 428 contract itself | `apps/text/src/text/tests/unit/test_task799_phase0.py:213-229`, `:248`, `:282`; `test_generate_mandatory_tenant_header.py:91-105` | that an absent/blank `X-Tenant-Id` **must** be 428, enforced in middleware so a route cannot opt out | none — the fix satisfies this contract rather than weakening it. Do **not** "fix" the console by exempting `/providers/probe`; that reintroduces exactly the per-route opt-out F-10 removed |

Conclusion: the current tests encode the *intended* behaviour (a truthful transport error rendered
as information). Production diverges from them because the gateway never gets far enough to produce
a transport error. Nothing is asserting the defect.

---

## F. MINIMAL FIX SKETCH (described, not applied)

The probe should **stay a GET at the console/gateway boundary** — it already is one, and it needs
no `@NoOptimisticConcurrency` (that decorator is metadata for the *mutating-route* boot audit,
`apps/api/src/decorators/noOptimisticConcurrency.decorator.ts:12-27`; a GET is out of its scope).
The controller decorators are **correct as written**, and the frontend is calling the **right
endpoint**. Exactly one line-group is wrong.

### F.1 — THE FIX (required): send the mandatory tenant header

**File:** `apps/api/src/modules/ai-model/ai-model-discovery.service.ts`
**Lines:** `339-341` (inside `probeText`, which is already `async`)

Replace the hand-rolled two-header object with the shared contract helper, exactly as the sibling
call sites do. `internalServiceHeaders` already emits `Content-Type` + `X-Service-Token` +
`X-Tenant-Id` (`packages/applications/src/common/internal-service-headers.ts:92-100`), and
`resolveInternalAccessToken` (`:143-150`) prefers the shared `INTERNAL_ACCESS_TOKEN` with
`TEXT_SERVICE_TOKEN` as the migration fallback — fixing the latent token defect in the same edit.

- tenant value: `tenantHeaderValue(this.clsService?.get('tenantId'), TENANTLESS.PLATFORM_OPERATOR)`
  — `internalServiceHeaders` does this internally when given `tenantId` + `tenantlessReason`.
- `TENANTLESS.PLATFORM_OPERATOR` is the correct sentinel: a SUPER_ADMIN opening the LM Studio
  screen with no working tenant selected legitimately has no tenant
  (`internal-service-headers.ts:57-62`), and text accepts a declared `tenantless:` marker without
  428 (`auth.py:138-139`; pinned by `test_task799_phase0.py:242-247`).
- `probeText` currently takes no tenant argument but the class already holds `clsService`
  (`ai-model-discovery.service.ts:151`) and reads the tenant at `:279`, so no signature change is
  needed.
- Note the async shift: `resolveInternalAccessToken` uses `getSecretOptional` (async), replacing
  the current `getSecretSync`. `probeText` is already `async`, so this is a local `await`. If
  keeping the sync warm-cache read matters, `getSecretSync('INTERNAL_ACCESS_TOKEN') ||
  getSecretSync('TEXT_SERVICE_TOKEN')` mirrors `text-proxy.controller.ts:400-401` instead — either
  is acceptable; the tenant header is the load-bearing half.

Exemplar to copy: `apps/api/src/modules/ai-inference/ai-inference.client.ts:114-128`.

### F.2 — OPTIONAL truthfulness hardening (same file, `:356-361`)

Even after F.1, this catch conflates *"text answered with an HTTP error"* with *"the engine is
unreachable"*, and leaks a raw axios string into an operator-facing banner. A minimal improvement:
when `isAxiosError(err) && err.response` (i.e. text *answered*), the probe is not evidence about the
engine — report a distinct operator-facing message naming the text service, mirroring the
sanitization posture of `MlflowProxyClient.toHttpError`
(`apps/api/src/modules/ai-service-admin/mlflow-proxy.client.ts:277-285`) and TASK-768. This is a
separate, smaller concern from the root cause; skip it if the change must stay surgical.

### F.3 — ADJACENT, do not bundle: the sibling client has the same omission

`apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts:104-107`:

```ts
private async buildHeaders(secretKey: 'GUARDRAIL_SERVICE_TOKEN' | 'NLP_SERVICE_TOKEN'): Promise<Record<string, string>> {
  return { 'X-Service-Token': (await this.secretsService?.getSecretOptional(secretKey)) ?? '' };
}
```

Same missing `X-Tenant-Id`, same file family, backing the Guardrail/NLP tiles on the AI-services
screen. Whether it currently 428s depends on whether `guardrail`'s `/api/health`,
`/api/medical/config`, `/api/guardrail/types` and `nlp`'s `/api/v1/health` are exempt in those
services' own middlewares — **not verified in this investigation (UNKNOWN)**. Flag it; fix it in
its own change with its own verification.

### F.4 — REGRESSION TEST (write it failing first)

`apps/api/src/modules/ai-model/__tests__/ai-model-discovery.controller.test.ts` already captures the
axios `post` spy (`:35-36`) and already stubs a tenant in CLS (`:43`). Add one assertion on the
third argument:

```
expect(post).toHaveBeenCalledWith(
  expect.stringContaining('/api/v1/providers/probe'),
  expect.anything(),
  expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': 'tenant-1' }) }),
);
```

plus a `tenantId: null` case asserting the header is `'tenantless:platform-operator'` rather than
absent. Both fail on the current code and pass after F.1. No existing assertion needs changing.

### F.5 — What must NOT be done

- Do **not** add `/api/v1/providers/probe` to `EXEMPT_PATHS` in
  `apps/text/src/text/api/middleware/auth.py:23-33`. That reverses TASK-799 F-10's whole point
  (`auth.py:40-47`) and is contradicted by the owner directive in
  `.claude/rules/00-project-context.md`.
- Do **not** touch `@RequiresIfMatch` / `@ExpectedVersion` / `RequiresIfMatchGuard` — they are not
  on this path, as the route manifest proves.
- Do **not** change the frontend endpoint. `client.ts:4-16` documents why there is deliberately no
  second discovery route, and the read it issues is the correct one.

---

## §5 — THE CORS ANGLE: DOES NOT APPLY HERE

The comments at `apps/api/src/cors.headers.ts:25` and `:57-58` describe a real hazard, but a
different one:

```
 * Without an entry here only the CORS-safelisted response headers reach
 * `fetch`. `ETagInterceptor` sets a strong `ETag` on every versioned response,
 * but `AgenticClient.getWithEtag` would read `undefined` and the follow-up
 * PATCH would send no validator — which `RequiresIfMatchGuard` answers with
 * 428. The OCC round trip is therefore broken cross-origin unless `ETag` is
 * exposed, however correct the server side is.
```

Verified, not assumed — it is irrelevant to this bug for four independent reasons, any one of which
is sufficient:

1. **No cross-origin hop exists.** The browser calls `/api/hope/...` — a same-origin Next.js route
   handler (`apps/admin-console/src/shared/api/http.ts:119-124`, `PROXY_MOUNT = '/api/hope/'`). The
   gateway hop is a **server-side** `fetch` from Node (`hope-proxy.ts:55`), where CORS does not
   apply at all.
2. **`ETag` already survives the BFF anyway.** `FORWARDED_RESPONSE_HEADERS` includes `'etag'`
   (`hope-proxy.ts:16`), so even the OCC round trip the comment worries about is intact for this
   app. (The comment's subject is `AgenticClient` — the browser SDK in
   `packages/agentic-sdk-v2`, which *does* call the gateway cross-origin. Different client.)
3. **This path has no ETag and no If-Match.** `getJson` never sets `if-match`
   (`http.ts:144` is gated on `options.etag`), and the route is a GET with
   `"requiresIfMatch": false`.
4. **The 428 is not in a response the browser ever sees.** The console's own request returns
   **200**; the 428 is an internal gateway→text status that only ever appears as a string in the
   body.

Both `CORS_ALLOWED_HEADERS` (`cors.headers.ts:20-48`, includes `If-Match` and `X-Tenant-Id`) and
`CORS_EXPOSED_HEADERS` (`:61`, `['ETag']`) are correctly configured regardless.
