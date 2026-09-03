# Embedding MLflow / Temporal / MinIO GUIs in the HOPE Admin Console

Research brief — 2026-09-01. Read-only investigation; no repo files were modified.

> **TL;DR for the orchestrator.** Do not build three embeds. All three services already have native
> console screens, and the console already ships a correct embedded-GUI pattern (`db-studio`).
> **MinIO: close the question** — its OSS console was gutted to 21 object-browser endpoints in May
> 2025, and `minio/minio` was **archived 2026-04-25 ("no longer maintained")** with the console repo
> now a 404; our `/storage` browser is already better. **Temporal: keep native** — the upstream UI
> cannot express tenancy, and its sub-path support has an unresolved CSP regression in the version we
> pin. **MLflow: the one real fast win** — it is the only GUI with a working sub-path flag, no CSP of
> its own, a documented `x-frame-options NONE` switch and a documented proxy-auth pattern; and our
> screen already renders a conditional iframe the instant a live probe says it is embeddable.
> Ship it behind the BFF on our own origin. Two things to do regardless of the embedding decision:
> the console currently sets **no `frame-ancestors` at all**, and `hope-temporal-ui` currently allows
> **workflow termination by anyone who can reach it** (`TEMPORAL_DISABLE_WRITE_ACTIONS` is unset).
> Separately and more urgently, HOPE's MinIO is now an **EOL upstream** running an image that predates
> the final CVE release — that is a supply-chain item for the owner regardless of any GUI decision.

---

## 0. THE HEADLINE THE ASK DID NOT ANTICIPATE

**All three GUIs already have native, shipped surfaces in the admin console.** The product owner's
request — "embed MLflow, Temporal, MinIO GUI so platform admin can manage each service" — is ~70%
already delivered, by a better pattern than embedding. Verified in the working tree:

| Service | Existing screen | Route | Gateway API | Gate |
|---|---|---|---|---|
| MinIO | `features/storage-browser` (+ `features/storage`) | `/storage`, `/tenants/storage` | `storage/buckets`, `.../files`, presigned URLs, `storage/health` | `read`/`manage:Storage` |
| MLflow | `features/mlflow` | `/ai-services/mlflow` | `admin/ai-services/mlflow/{status,experiments,registered-models,model-versions}` | `manage:all` + `@ForbidApiKey` |
| Temporal | `features/harness-ops` | `/harness/workflows`, `/harness/observability` | `admin/harness/workflows` — list / detail / cancel / terminate / signal | `workflow-harness` domain |

And the console already ships a **working embedded-GUI pattern** (`features/db-studio` +
`apps/api/src/modules/pstudio/`) that is the correct template for anything that still needs framing.

So the honest framing for the owner is: *the fast win is not "start embedding" — it is "finish the
two gaps in what we already have, and stop treating embedding as the goal."*

Key files:
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/mlflow/components/mlflow-screen.tsx`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/db-studio/components/db-studio-screen.tsx`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/storage-browser/api/client.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/harness-ops/components/harness-workflows-screen.tsx`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/api/src/modules/ai-service-admin/mlflow-proxy.client.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/api/src/modules/pstudio/pstudio.controller.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/api/src/modules/harness-admin/harness-admin.controller.ts` (L528-585)
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/server/hope-proxy.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/server/session.ts` (L88-96)

---

## A. PER-GUI FACT TABLE

| | **MLflow UI** | **Temporal Web UI** | **MinIO Console** |
|---|---|---|---|
| **Sub-path support (exact setting)** | **YES.** CLI `mlflow server --static-prefix /path` (must start with `/`, must not end with `/`; validated by `_validate_static_prefix()`). Passed to the server as `MLFLOW_STATIC_PREFIX` (`STATIC_PREFIX_ENV_VAR`) — **an implementation detail, absent from the public env-var reference**; prefer the CLI flag. [1][2] **Prefixed correctly:** `/`, `/static-files/<path>`, `/get-artifact`, `/model-versions/get-artifact`, all `/ajax-api/2.0/mlflow/*`. **Never prefixed:** `/health`, `/version`. `/api/2.0/mlflow/*` was unprefixed until **3.12.0 fixed it** (PR #22159) — **HOPE pins v3.15.2, so this is FIXED for us.** [1][10] | **YES, genuinely at RUNTIME — no rebuild — but a REGRESSION-PRONE surface.** `publicPath` / `TEMPORAL_UI_PUBLIC_PATH`. [3] **Mechanism (source-verified):** the Go server string-patches `base: ""` → `base: "/prefix"` and `"/_app/` → `"/prefix/_app/` in the single SPA `index.html` at startup. [19] **Covers `/api/v1/*` too** — `e.Pre(route.PublicPath(…))` strips the prefix before routing, and the frontend prepends `base` to API URLs. [20] Requests missing the prefix get a 308 redirect. `VITE_PUBLIC_PATH` is a *build-time* Vite arg and does **not** work at runtime. [5] **The regression:** a URL-DUPLICATION bug (`/custom/custom`) has broken and been "fixed" **three times** — #3183 (2.45.3-4, "fixed in 2.47.3"), #3325 (2.48.1+), and **#3442, still OPEN and uncommented against 2.50.0**. [17][21] We pin **2.53.1**. A guard test (`route-for-base-path.test.ts`, "resolve the base path exactly once") *does* exist at v2.53.3, but `server/route/ui.go` is byte-identical v2.50.0↔v2.53.3. **Status for our tag UNVERIFIED — smoke-test before committing.** | **YES, officially supported** (I was wrong in an earlier draft). `MINIO_BROWSER_REDIRECT_URL=https://host/admin/minio` → MinIO derives `CONSOLE_SUBPATH` and rewrites `<base href="/admin/minio/">` in `index.html`. [29][30] **Two hard constraints:** (a) the console's own API/WebSocket still serve **at ROOT** — the proxy MUST strip the prefix (`rewrite ^/admin/minio/(.*)$ /$1 break;` + bare `proxy_pass`); (b) the path must match `^[0-9a-zA-Z\/-]+$` — **no underscores, no dots**, and a non-matching path fails SILENTLY. **The S3 API cannot be sub-pathed at all** — SigV4 signs the URI path, and `MINIO_SERVER_URL` hard-strips paths (`u.Path = ""`). [30] |
| **X-Frame-Options / frame-ancestors** | **XFO: `SAMEORIGIN` by default, and configurable** — `MLFLOW_SERVER_X_FRAME_OPTIONS` / `--x-frame-options` ∈ {SAMEORIGIN, DENY, **NONE**}; `NONE` **omits the header entirely**. 3.5.0+ security middleware. [7][8] **CSP: MLflow emits NO `Content-Security-Policy` at all** — source-verified: `SecurityHeadersMiddleware` sets only `x-content-type-options: nosniff` and the conditional XFO. [11] Docs give the explicit recipe: `--x-frame-options NONE` for cross-origin iframe embedding. [7] | **`X-Frame-Options: SAMEORIGIN` on every response — HARDCODED, no config knob.** Source-verified: `server.go` calls `e.Use(middleware.Secure())` with no config, and echo v4.13.4's `DefaultSecureConfig` sets `XFrameOptions: "SAMEORIGIN"` unconditionally (`DefaultSkipper` never skips). A repo-wide grep for `x-frame-options|frame-ancestors|frameguard` finds no other hit and no header-output config field. [19][22] **CSP `frame-ancestors` is NOT sent on the UI** — the only `generateCSP()` call site is the unrelated `/render` markdown route. So framing is governed **solely** by XFO. [19] ⇒ **cross-origin iframe BLOCKED; same-origin iframe WORKS.** Also: setting `publicPath` **removes the SPA's CSP meta tag entirely** (with a warning log) — that was the fix for the 2.25.0 sub-path break. [4][19] No frame-busting JS. | **`X-Frame-Options: DENY` by default** (measured), and the direct knob is **unsettable** — `CONSOLE_SECURE_FRAME_DENY` exists but MinIO `os.Unsetenv`s *every* `CONSOLE_*` var before starting the console. [30] Default CSP carries **no** `frame-ancestors`, so XFO does all the blocking. **But two escapes exist:** (a) `MINIO_BROWSER_CONTENT_SECURITY_POLICY` **is** honored and can add `frame-ancestors`, which per CSP3 §6.4.2.2 **overrides XFO**; [31] (b) the STS deep-link path literally contains `// Allow us to be iframed` followed by `w.Header().Del("X-Frame-Options")`. [30] Both empirically verified. |
| **Auth model** | **None by default.** `--app-name basic-auth` enables a **still-experimental** basic-auth app (users + READ/USE/EDIT/MANAGE/NO_PERMISSIONS; needs `MLFLOW_FLASK_SERVER_SECRET_KEY` identical across replicas). No OIDC, **no native multi-tenancy**. [12] Measured against HOPE's own deployment: unauthenticated `experiments/search` → 200, `registered-models/delete` reachable. [9] **No read-only mode** (`--artifacts-only` is the opposite — it disables tracking APIs). | OIDC/SSO: `TEMPORAL_AUTH_ENABLED`, `_TYPE` (default `oidc`), `_PROVIDER_URL`, `_ISSUER_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_CALLBACK_URL`, `_SCOPES`. [3] | Encrypted session token in an httpOnly cookie literally named **`token`**, `Path=/`, `SameSite=Lax`, 12 h default. **OIDC and LDAP were REMOVED as console login methods in May 2025** — `loginStrategy` lost its `redirect` value. What remains: root creds, IAM keys, **STS**. [30][32] |
| **Proxy / trusted-header auth possible?** | **YES — officially documented, and it is the recommended pattern.** The SSO docs say to put MLflow behind a proxy that authenticates against your IdP and injects identity headers (`X-Email`, `X-Forwarded-User`), then **"Run MLflow *without* the Basic Auth app and rely on the proxy as the enforcement layer."** [13] Deeper hooks if wanted: `authorization_function` in the auth ini, or an `[mlflow.app]` plugin entry point (`--app-name`). [14] **Trap:** `MLFLOW_TRACKING_AUTH` is a *client-side* variable, not a server auth-mode selector. [8] | **YES — this is an explicitly supported shape.** `forwardHeaders`/`TEMPORAL_FORWARD_HEADERS` copies named headers into gRPC metadata; `Authorization` is forwarded by grpc-gateway itself. [23] ui-server performs **no authorization of its own** — `ValidateAuthHeaderExists` merely checks a header EXISTS, and its own comment says *"User autorization should be done in the frontend by claim-mapper and authorizer plugins"*, preserving compatibility for *"custom auth proxy"* deployments. [24] CSRF is skipped when an `Authorization` header is present. [19] ⚠️ With `TEMPORAL_AUTH_ENABLED=false` (**the default, and HOPE's current state**) ui-server authenticates **nobody**. | **Trusted-header: NO** — `GetTokenFromRequest` reads *only* the `token` cookie; its comment claims header support but the code does not implement it. [30] **BUT a real pre-authenticated deep link EXISTS and was verified end-to-end:** `GET /?sts=<tok>&sts_a=<ak>&sts_s=<sk>` logs in, sets the cookie, returns `features: ["hide-menu","object-browser-only"]`, and drops XFO. [30] ⚠️ Credentials ride in the **URL query string** (browser history, `Referer`, proxy logs) and the `SameSite=Lax` cookie forces same-site hosting. |
| **Usable read API for a native screen** | **YES.** `POST /api/2.0/mlflow/{experiments,runs,registered-models,model-versions}/search`, `GET .../get`, `GET /api/2.0/mlflow/artifacts/list`; a parallel `/api/3.0/mlflow/*` namespace carries traces/GenAI. **HOPE already proxies the three search verbs.** [15] **But no OpenAPI spec ships** (FR open since 2022), and the TS SDK is Node-only tracing — every type is hand-written. [16] | **YES.** ui-server's own `/api/v1/...` HTTP routes + the Temporal server gRPC-gateway HTTP API. **HOPE already consumes these** via `admin/harness/workflows` — and does so **tenant-filtered**, which the upstream UI structurally cannot: **the ui-server performs NO namespace-level access control of its own**, delegating entirely to the backend's claim-mapper/authorizer plugins. [18] | **YES.** S3 API (list buckets/objects, presigned URLs) via AWS SDK v3 / minio-js, plus the `madmin` admin API. **HOPE already has a full native browser on it.** |

[1] https://github.com/mlflow/mlflow/issues/22142 · [2] https://github.com/mlflow/mlflow/issues/4484, https://github.com/mlflow/mlflow/pull/116
[3] https://docs.temporal.io/references/web-ui-environment-variables · [4] https://github.com/temporalio/ui/issues/1924
[5] https://community.temporal.io/t/embed-temporal-ui-into-other-web-host/6350 · [6] https://github.com/minio/minio/discussions/16529
[7] https://mlflow.org/docs/latest/self-hosting/security/network/ · [8] https://mlflow.org/docs/latest/python_api/mlflow.environment_variables.html
[9] `docs/research/ai-ml/mlflow-vllm-minio-onprem-inference-2026-09.md` §6 (in-repo, measured) · [10] https://github.com/mlflow/mlflow/releases/tag/v3.12.0
[11] https://raw.githubusercontent.com/mlflow/mlflow/master/mlflow/server/fastapi_security.py (+ PR https://github.com/mlflow/mlflow/pull/17910)
[12] https://mlflow.org/docs/latest/self-hosting/security/basic-http-auth/ · [13] https://mlflow.org/docs/latest/self-hosting/security/sso/
[14] https://mlflow.org/docs/latest/self-hosting/security/custom/ · [15] https://mlflow.org/docs/latest/api_reference/rest-api.html
[16] https://github.com/mlflow/mlflow/issues/6086 · [17] https://github.com/temporalio/ui/issues/3183
[18] https://deepwiki.com/temporalio/ui-server/2.4-authentication-and-security (secondary; superseded below by source reads)
[19] https://github.com/temporalio/ui-server/blob/main/server/route/ui.go + https://github.com/temporalio/ui-server/blob/main/server/server.go (verified @ 48ee4ca, 2026-08-27)
[20] https://github.com/temporalio/ui/blob/main/src/lib/utilities/route-for-api.ts · [21] https://github.com/temporalio/ui/issues/3442 (OPEN)
[22] https://github.com/labstack/echo/blob/v4.13.4/middleware/secure.go (`DefaultSecureConfig.XFrameOptions = "SAMEORIGIN"`)
[23] https://github.com/temporalio/ui-server/blob/main/server/headers/headers.go · [24] https://github.com/temporalio/ui-server/blob/main/server/auth/auth.go (L208-225)
[25] https://github.com/temporalio/ui-server/blob/main/server/route/api.go (L38-62 — DisableWriteMiddleware) · [26] https://github.com/temporalio/ui/issues/1346 (OPEN since 2023, 0 comments)
[27] https://github.com/temporalio/temporal/releases/tag/v1.22.0 (HTTP API, port 7243) · [28] https://github.com/temporalio/ui/blob/main/src/lib/services/live-poll.ts
[29] https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/settings/console/ · [30] MinIO source `cmd/common-main.go`, `api/configure_console.go`, `api/config.go`, `pkg/auth/*` (verified empirically against `minio/minio:latest`)
[31] https://w3c.github.io/webappsec-csp/ (CSP L3 §6.4.2.2 — frame-ancestors overrides X-Frame-Options)
[32] https://github.com/minio/minio/releases/tag/RELEASE.2025-05-24T17-08-30Z · [33] https://github.com/minio/minio (archived 2026-04-25) · [34] https://github.com/minio/minio/blob/master/COMPLIANCE.md
[35] https://www.min.io/legal/aistor-free-agreement · [36] https://github.com/minio/minio-js (Apache-2.0) · [37] https://github.com/minio/madmin-go (AGPL-3.0) · [38] https://github.com/pgsty/silo

### The MinIO facts that end the MinIO conversation

**1. MinIO's open-source server is ARCHIVED and end-of-life.** `minio/minio` was archived
**2026-04-25** (GitHub API `"archived": true`); the README now reads *"THIS REPOSITORY IS NO LONGER
MAINTAINED."* [33] The console's own repo — `minio/object-browser` (formerly `minio/console`) —
**returns HTTP 404 and is gone from GitHub entirely** (confirmed against a client simultaneously
getting 200 for `minio/minio`; deleted vs privatised is UNVERIFIED).

**2. There is an unpatched-image gap.** The last OSS release, `RELEASE.2025-10-15T17-29-55Z`, was a
**security/CVE release that was never published to Docker Hub** — `minio/minio:latest` is still
`RELEASE.2025-09-07T16-13-09Z`, and pulling the October tag returns `manifest unknown`.
**Whether that CVE affects the console or the server data path is UNVERIFIED and is worth checking
before this image keeps running in a PHI environment.**

**3. The console was hollowed out in May 2025 — quantified.** Diffing the console's own OpenAPI spec
across the two versions (retrieved from the Go module proxy, which still holds them):

| Console version | Date | API paths |
|---|---|---|
| `v1.7.6` (pre-removal) | 2025-02-11 | **89** |
| `v1.7.7-…2017f33b26e1` (shipped in final MinIO) | 2025-09-05 | **21** |

The 21 survivors are *all* object-browser routes (buckets, objects, upload/download/share, versioning,
quota, login/logout/session). **Entire path groups deleted:** `users`, `groups`, `policies`,
`service-accounts`, `configs`, `idp`, `ldap-entities`, `kms`, `logs`, `nodes`, `service`,
`remote-buckets`, `buckets-replication`, `bucket-policy`, plus ~25 of 30 bucket sub-paths (lifecycle,
tiering, replication, events, encryption, retention). The release notes say it plainly: *"Embedded UI
Console is now deprecated and moved to object-browser — External IDP logins via LDAP/OIDC are removed
as well; these are now available as part of the AiStor Product."* [32]
Admin GUI now lives only in commercial **AIStor** (reported from ~$96k/yr for 400 TB).
https://www.blocksandfiles.com/ai-ml/2025/06/19/minio-users-complain-after-admin-ui-removed-from-community-edition/1610856

*(Correcting an earlier draft of this brief: the change was not "PR #3509 changed the license" — the
repo was RENAMED `console` → `object-browser`, proven by the Go proxy returning the same commit hash
under both module paths, and the license stayed AGPLv3 throughout.)*

**So: embedding the MinIO Console would mean embedding an unmaintained, source-deleted, AGPL
component — whose remaining feature set is exactly the object browser HOPE already built natively.**

### Licensing (commercial healthcare product — flag for counsel, NOT legal advice)

- `minio/minio` is **AGPLv3** and always has been through this window — GitHub reports
  `spdx_id: AGPL-3.0`. **The licence never changed; the code stopped being published instead.** [33]
  (Historical: MinIO relicensed Apache-2.0 → AGPLv3 in April 2021, before this window.)
- The console module is likewise **AGPLv3**.
- **MinIO's own position is deliberately non-committal.** `COMPLIANCE.md`: *"MinIO cannot make the
  determination as to whether your application's usage of MinIO is in compliance with the AGPLv3
  license requirements."* When challenged directly on network clients, a collaborator quoted §13 and
  said *"I am not going to entertain interpreting it here. You and your legal team can go through
  it."* [34] https://github.com/minio/minio/discussions/21296

Two situations, unequal risk:
1. **Running stock MinIO as a separate service and calling its S3 API** (what HOPE does today).
   Common industry reading: **low risk** — §13's source-offer obligation is scoped to *"a modified
   version"*, and we ship the image unmodified, same posture as any AGPL database over its wire
   protocol. **Aggravating factor unique to MinIO:** the vendor refuses to disclaim the maximal
   reading and sells a commercial licence as the remedy — so the practical risk is
   commercial/reputational pressure, not clean doctrine, and there is now **no upstream to negotiate
   with**.
2. **Iframing the AGPL console into our proprietary app.** Composition in the browser is not linking,
   so the mainstream reading is still "not a derivative work" — **but** the STS deep-link wires our
   auth into it (closer coupling), and **any modification** (restyling beyond `ov_st`, restoring
   removed features, patching it for a prefix) fires §13 unambiguously. Sourcing the code to modify
   now requires the Go module proxy or a fork, because upstream is deleted.

**Hard engineering rule regardless of counsel's answer:** use the **Apache-2.0** SDKs
(`minio-js`, `minio-go`, `minio-py`) or AWS SDK v3 with `forcePathStyle: true`. **Never link
`madmin-go` — it is AGPL-3.0** and is the one unambiguously dangerous dependency here. [36][37]

**AIStor is not a drop-in escape.** The Free Tier agreement (effective 2026-01-30) grants use
*"solely in standalone mode (single-node deployments without distributed clustering or high
availability)"*, forbids modification and **any redistribution**, and requires a licence key via
SUBNET registration. [35] Single-node rules out HA on k3s; the redistribution ban blocks shipping it
inside an on-prem customer deployment. Multi-node needs Enterprise Lite/Enterprise.

**Maintained forks exist, both still AGPLv3** (so the same licence question applies):
`pgsty/silo` — active (last push 2026-08-30, ~2.6k★), restores the full console, keeps `MINIO_*`
vars and `/minio/*` routes; [38] and `OpenMaxIO/openmaxio-object-browser` — stale since 2025-06-24.
Neither is audited as a healthcare supply-chain dependency.

---

## B. PATTERN COMPARISON MATRIX

| | **(i) Same-origin iframe + BFF proxy** *(the db-studio pattern)* | **(ii) Traefik path-route + ForwardAuth** | **(iii) Native screens on the service API** | **(iv) Deep link, new tab** |
|---|---|---|---|---|
| **Effort** | **LOW** *if* the GUI supports a sub-path and emits relative assets; **HIGH/impossible** otherwise. Reuses `hope-proxy.ts` + the pstudio precedent verbatim. | **MEDIUM-HIGH.** Two repos (manifests live in `arca/hope-v2-deployment`), a new auth-decision endpoint, per-environment ingress changes. | **HIGH per screen** — but **already paid** for all three services here. | **~ZERO.** Already implemented on the MLflow Access tab and db-studio. |
| **Security** | **BEST.** Credential never leaves the server; one authorization point; the gateway route carries the ability check, `@ForbidApiKey`, svc-scope and audit. | **GOOD**, but the ForwardAuth endpoint is a *second* place authorization is decided — drift risk, and a new confused-deputy surface. Blocked in practice: our session is a **jose JWE only the Next app can decrypt**, so Traefik must call back into Next/gateway anyway. | **BEST.** We choose exactly which verbs exist. HOPE's MLflow client calls only `axiosRef.get`; destructive MLflow verbs are simply not proxied. | **WORST/N-A.** Console grants nothing; safety depends entirely on what fronts the GUI. An unauthenticated MLflow behind a routable URL is the measured failure in §6 of the in-repo research doc. |
| **UX** | **BEST** — one login, one shell, no tab switch. | Same as (i). | **BEST for the 80%** (our shell, theme, a11y, tenancy); **worse for the deep 20%** (MLflow run-compare charts, Temporal event-history timeline). | **WORST** — second login, context switch, foreign theme. |
| **Failure modes** | Absolute-rooted asset 404s; upstream redirect to `/` escaping the prefix; upstream `X-Frame-Options`/CSP; **cannot proxy a WebSocket upgrade** [A]; request-body streaming needs `duplex:'half'` [A]; `sandbox` is near-decorative on same-origin content [B]; confused deputy if the proxy forwards arbitrary methods/paths. | ForwardAuth fires on *every* asset request (latency); `maxResponseBodySize` misconfig; the auth endpoint reachable without the middleware; prefix-strip mismatch; cross-repo drift. | Upstream feature lag; re-implementing rich viewers is genuinely expensive. | Unauthenticated GUI exposed to anyone who can reach the URL. |

[A] https://nextjs.org/docs/app/getting-started/route-handlers · [B] https://romaincoupey.com/posts/iframe-sandbox/

### The cookie fact that eliminates every cross-origin variant
`apps/admin-console/src/server/session.ts:88-96` sets the session cookie
`httpOnly: true, sameSite: 'lax', secure (prod), path: '/'` — **with no `Domain` attribute, so it is
host-only.**
- Same-host, same-origin embed → cookie is sent. **Works.**
- Different subdomain (`mlflow.console.example.com`) → host-only cookie is **not** sent. **Breaks.**
- Different site → `SameSite=Lax` *and* host-only both block it. **Breaks.**

Making a cross-origin embed work would require `SameSite=None; Secure` plus a `Domain` attribute —
widening the session cookie's blast radius to every subdomain, and walking into third-party-cookie
deprecation (Chrome 135's `allow-same-site-none-cookies` sandbox token exists precisely because this
is dying). For a PHI platform that is a security regression and should be refused.
https://privacysandbox.google.com/blog/sandbox-allow-same-site-none-cookies ·
https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies

**Therefore: any embed must live on the console's own origin, under a path.** That is pattern (i).

---

## C. RECOMMENDATION PER GUI

### MLflow → **(iii) native, already shipped + (i) same-origin iframe as an opt-in second view**
The existing screen is the right answer and should stay the primary surface. But the repo's
recorded verdict is now **partly out of date in our favour**: `mlflow-proxy.client.ts` lists three
blockers, and MLflow 3.5+ officially documents the way through the first one —
`--x-frame-options NONE` plus CORS for our domain is the *documented* iframe-embedding recipe. [7]
The console already computes `embeddable` from a live probe and **already renders a conditional
`<iframe>` the moment it flips true** — so enabling a framed MLflow is an operator/deployment
action, not a code change.

Three facts make this materially easier than the repo's comment assumes:
1. **MLflow emits no CSP at all** — `SecurityHeadersMiddleware` sets only `nosniff` and the
   conditional XFO. So once XFO is `NONE`, framing is governed **entirely by our proxy**, and the
   `frame-ancestors` we add is the only such header in play. No conflict to resolve.
2. **Proxy/trusted-header auth is the officially recommended pattern**, not a hack: the SSO docs say
   to authenticate at the proxy, inject `X-Email`/`X-Forwarded-User`, and *"run MLflow without the
   Basic Auth app and rely on the proxy as the enforcement layer."* That is precisely our BFF.
3. **The `--static-prefix` REST-route bug is fixed** in 3.12.0, and we pin 3.15.2.

So: serve MLflow at `/api/hope/admin/ai-services/mlflow/ui/*` through the BFF so our session is the
auth, and set `--static-prefix` to match. Keep the gateway's `/health` probe on the **un-prefixed**
in-cluster URL (see §G1). Do **not** put it behind Cloudflare Access and then try to frame it — an
IdP redirect cannot complete inside a frame, which the repo already notes, and which stacking a
second IdP in front would reintroduce.

### Temporal → **(iii) native, already shipped — and keep it. Embedding is the trap.**
**Correction to an earlier assumption, stated plainly:** framing Temporal is *technically* more
feasible than I first reported. `X-Frame-Options: SAMEORIGIN` is hardcoded with no config knob, and
no CSP `frame-ancestors` is sent on the UI at all [19][22] — which means a **same-origin** proxy embed
satisfies it and would render. So the recommendation does not rest on "framing is blocked". It rests
on three other things:

1. **The ui-server performs NO namespace-level access control at all** — source-verified: grepping
   `server/auth/**` for `namespace` returns zero hits, and `ValidateAuthHeaderExists`'s own comment
   says authorization *"should be done in the frontend by claim-mapper and authorizer plugins"*. [24]
   There is no configuration that makes an embedded Temporal UI tenant-safe; it shows every namespace
   the gRPC identity can see. In a multi-tenant PHI platform, workflow IDs and search attributes are
   tenant-identifying data. Our `admin/harness/workflows` list is **tenant-filtered at the gateway**.
   This is not a gap to close — it is the wrong tool. **This reason alone is decisive.**
2. **Sub-path support is a thrice-regressing surface.** The `/custom/custom` URL-duplication bug was
   fixed in 2.47.3, regressed in 2.48.1+, and is **still open and unacknowledged against 2.50.0**
   (#3442). [21] We pin 2.53.1. There is a guard test at v2.53.3, but `server/route/ui.go` is
   byte-identical between 2.50.0 and 2.53.3 — no server-side fix landed. Nobody has confirmed it
   either way.
3. **The embed would have to bypass our BFF anyway.** The UI drives live history with **HTTP
   long-polling** (`waitNewEvent=true`, holding the response open), not WebSockets. [28] Putting that
   through a Next.js route handler means holding a request open for the full long-poll window; any
   short read timeout severs it and the client falls into a permanent 5s error-backoff loop. The
   correct shape would be an **edge** proxy (Traefik/ingress) — i.e. pattern (ii), with all its
   cross-repo cost — not pattern (i). So the cheap version of this embed does not exist.

And we already have terminate / cancel / signal natively, behind our RBAC and audit trail.

If a deep event-history viewer is later wanted, the honest options are: build it natively on the
ui-server `/api/v1` routes, or deep-link (iv) with **`TEMPORAL_DISABLE_WRITE_ACTIONS=true`** so the
linked UI cannot terminate, cancel or reset anything. [3] That flag is the single cheapest safety
improvement available for Temporal today and is worth setting on `hope-temporal-ui` **regardless of
whether anything is ever embedded** — the UI is currently a full-privilege console reachable by
anyone who can reach port 8233.

### MinIO → **(iii) native, already shipped. Do not embed. Close the question.**

**Correction to an earlier draft: embedding is technically POSSIBLE** — the sub-path is officially
supported, and there are two working iframe escapes (custom CSP `frame-ancestors`, or the STS
deep-link that literally deletes `X-Frame-Options`). I verified the STS flow works end-to-end.
So this recommendation does not rest on "it can't be done." It rests on the fact that **doing it
buys nothing and costs a great deal**:

1. **Nothing left to embed.** The OSS console is now 21 object-browser endpoints. HOPE's `/storage`
   browser already covers that surface *and* adds tenant scoping, our RBAC, audit and theming.
2. **It is an archived, source-deleted, unmaintained AGPL component** with an unpatched-CVE image gap.
3. **The STS deep-link puts credentials in a URL query string** — browser history, `Referer`, proxy
   and APM logs. On a PHI platform that is a finding, not a footnote.
4. **A cookie-name collision waiting to happen.** The console's session cookie is literally named
   **`token`** at `Path=/`. Proxied under `https://console.example.com/admin/minio/`, it is sent to
   **every** path on that host — including our own BFF routes. Our session cookie is
   `hope_admin_session`, so there is no clash *today*, but this is a sharp edge to introduce
   deliberately for zero gain.
5. `SameSite=Lax` on that cookie means the console must be same-site anyway — so the sub-path proxy
   is a prerequisite, not an optimisation.

**If anything, the finding runs the other way:** the native screen is the *cheaper* option even from
a standing start — a fresh bucket/object browser on `minio-js` (Apache-2.0) or AWS SDK v3 is roughly
**2–4 days** with HOPE's existing `ScreenTemplate` / `AdminDataGrid` / BFF patterns. We already paid
that cost. **Effort-to-value for embedding is negative.**

---

## D. SECURITY BOUNDARY (the concrete design)

**Where the credential lives:** in the sealed `jose` JWE session cookie, `httpOnly`, decrypted
**only** in Next server code (`src/server/session.ts`), converted to an `Authorization: Bearer` in
`hope-proxy.ts` **on the server**, and sent to the gateway. The browser holds an opaque blob it
cannot read and cannot replay anywhere but our origin. **No upstream GUI credential — no MinIO key,
no MLflow token, no Temporal identity — is ever minted into the browser.** The upstream services are
reached only from the gateway, in-cluster.

**The authorization boundary, in four layers (this is the pstudio design, generalised):**

1. **Route gate on the gateway.** `@CanManage('<Subject>')` + `@ForbidApiKey()` +
   `@RequiredSvcScopes('svc:admin:<x>:manage')`. `@ForbidApiKey` is checked *first* in the API-key
   branch, so it is unconditional. These are **403 privilege boundaries**, not the 404-over-403
   cross-tenant posture — per the platform rule, a super-admin-only surface returns 403.
2. **A dedicated ability subject per GUI**, not `manage:all`. pstudio already models this with
   `manage:PrismaStudio`. Do the same (`manage:MlflowUi`, …) so the god-mode consoles are grantable
   and revocable independently, and so the audit says which one was used.
3. **Method + path allow-list at the proxy — this is the confused-deputy fix.** A proxy that
   authenticates the operator at `/admin/mlflow/*` and then forwards *any* method to *any* sub-path
   is a deputy: the browser (or an XSS in the frame) can drive
   `DELETE /api/2.0/mlflow/registered-models/delete` with full admin rights, because MLflow has no
   identity of its own to refuse with. HOPE's MLflow client already gets this right — it calls only
   `axiosRef.get` and proxies exactly three search verbs. **Any UI-serving proxy must enumerate the
   asset/API paths it will forward and reject the rest**, and must never forward a destructive verb
   just because the GUI's JS asked for it.
4. **Audit at the gateway.** pstudio logs an audit row with a dedicated `eventType`, capturing the
   *query shape* and deliberately **never the result set** (which is the PHI surface). Any embedded
   god-mode console must do the same.

**Fail-closed availability probe.** Every embed ships with an always-registered `…/status` endpoint
so the screen renders a truthful "disabled" card instead of a broken frame — pstudio and MLflow both
already do this.

**Prerequisite gap to fix first (found, currently unmitigated):** the console sets **no
`Content-Security-Policy` and no `X-Frame-Options` at all** — `grep` across `apps/admin-console`,
`next.config.ts`, `deployment/`, and `apps/api/src/main.ts` (no helmet) returns nothing. The console
is framable by anyone today. Before adding embedded god-mode consoles, set
`Content-Security-Policy: frame-ancestors 'self'` on the console (it supersedes `X-Frame-Options`
where both are present). https://content-security-policy.com/frame-ancestors/

---

## E. LAYOUT RECIPE (full-height embed inside ScreenTemplate)

The shell already gives you everything; there is no new layout primitive to build.

**The chain** (`app/(console)/layout.tsx` → `ScreenTemplate`):
`SidebarInset` is `h-svh overflow-hidden`; the chrome group is `shrink-0`; the content region is
`flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6`. `ScreenTemplate` is
`flex min-h-0 flex-1 flex-col`, pinned top group `shrink-0`, content `mt-4` +
(`fill` → `flex min-h-0 flex-1 flex-col`), footer `mt-4 shrink-0`.

**The recipe — use `contentMode="fill"` and the proven db-studio surface class:**
```tsx
<ScreenTemplate contentMode="fill" header={…} statusBanner={…} footer={<StatusFooter … />}>
  <div className="flex min-h-0 flex-1 flex-col gap-3">
    {/* toolbar row: status badge + "Open in new tab" */}
    <iframe
      title="MLflow"
      src="/api/hope/admin/ai-services/mlflow/ui"   // SAME ORIGIN — see §B
      sandbox="allow-scripts allow-same-origin allow-forms"
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 rounded-md border bg-card"
    />
  </div>
</ScreenTemplate>
```
Rules that make it work:
- **`min-h-0` on every flex ancestor.** Without it the iframe's intrinsic height wins and the frame
  pushes the footer off-screen. This is the single most common failure.
- **`flex-1`, never `h-[60vh]`.** The current MLflow Access tab uses `h-[60vh]`, which is correct
  for a card *inside* a scrolling tab panel but wrong for a dedicated full-height screen.
- **One scroll container per panel.** The iframe scrolls internally; `contentMode="fill"` gives it
  the height and scrolls nothing itself. Never nest it inside a `scroll`-mode content region — that
  is the nested-scrollbar war.
- `sandbox` is defense-in-depth only: with `allow-scripts` + `allow-same-origin` on same-origin
  content the frame can script the parent and remove its own sandbox attribute. The boundary is the
  proxy allow-list (§D3), not the attribute. https://romaincoupey.com/posts/iframe-sandbox/

**The theme problem — say the honest thing.** None of these GUIs follow our `.dark` class or our
"Calm Clinical Teal" tokens, and we cannot style across an origin/document boundary
(`postMessage` aside, we do not control their code). Options, in order of preference:
1. **Accept it, and frame it honestly** — give the iframe a neutral `bg-card` border and a caption
   stating this is a third-party interface. This is what db-studio does today.
2. **Set the upstream's own theme where it has one**, at deploy time, and pick the variant matching
   our *default* theme. Do not attempt to sync it to the user's live toggle.
3. **Do not inject CSS into the frame.** Even where same-origin makes it technically possible, it
   couples us to the upstream's internal DOM and breaks on every upgrade.
4. The real fix for theme fidelity is pattern (iii) — which is exactly why the three native screens
   are the better surface.

---

## F. STAGED PLAN — ranked by effort-to-value

### Ships in DAYS (highest value first)

**1. Decide and document that MinIO and Temporal are DONE. (hours)**
Not code — a decision record. Both native surfaces exist; the upstream GUIs are respectively gutted
(MinIO CE) and unable to express tenancy (Temporal). Closing these two stops the team spending weeks
on negative-value work. **Highest effort-to-value item in this brief.**

**2. Add `frame-ancestors 'self'` to the console. (hours)**
A real, currently-unmitigated clickjacking gap, and a prerequisite for any embed. Do it regardless.

**2b. Set `TEMPORAL_DISABLE_WRITE_ACTIONS=true` on `hope-temporal-ui`. (minutes)**
Unrelated to embedding, and the cheapest security win in this brief. `hope-temporal-ui` today is a
full-privilege console — anyone who reaches port 8233 can terminate or reset a clinical-documentation
workflow. We already do terminate/cancel/signal natively, behind RBAC and audit, so the upstream UI
has no legitimate need for write actions. One env var. [3]

**2c. Open a separate ticket: MinIO is now EOL upstream. (assessment, ~half a day)**
Out of scope for the GUI question but surfaced by it, and more urgent than any of it. `minio/minio`
was archived 2026-04-25; the last OSS release (2025-10-15) was a CVE fix that **never reached Docker
Hub**, so the newest pullable image predates it. Decide deliberately between: stay pinned and accept
it, move to a maintained AGPL fork (`pgsty/silo`), buy AIStor (note: Free tier is **single-node
only** and forbids redistribution — likely disqualifying for k3s HA and on-prem shipping), or migrate
to another S3-compatible backend. Our native `/storage` screen is written against the S3 API, so a
backend swap costs little — which is itself an argument for having built it natively.

**3. Turn on the MLflow frame that is already coded. (1-3 days, mostly deployment)**
Zero console code. Set on the MLflow Deployment:
`--x-frame-options NONE` (or `MLFLOW_SERVER_X_FRAME_OPTIONS=NONE`), add our console host to
`MLFLOW_SERVER_ALLOWED_HOSTS`, and `MLFLOW_SERVER_CORS_ALLOWED_ORIGINS` for our origin;
then set the `MLFLOW_UI_URL` `global-kv` setting. `embeddable` flips true from the live probe and
the Access tab renders the frame. **Caveat:** this only makes it *framable*; it does not make it
*authenticated* — so do it only behind the BFF path in step 4, or on an internal-only environment.

**4. Serve MLflow through the BFF under a static prefix. (3-5 days)**
The genuine fast win, and the only new embed worth building. Add a gateway route that proxies
`admin/ai-services/mlflow/ui/*` — allow-listing the UI's own path families: `/` (index),
`/static-files/<path>`, `/ajax-api/2.0/mlflow/*`, `/get-artifact`, `/model-versions/get-artifact`,
and (3.12+) `/api/2.0/mlflow/*`. Run MLflow with
`--static-prefix=/api/v1/admin/ai-services/mlflow/ui`. Point the existing iframe at it.
Budget: ~1 day for absolute-URL rewriting (§G4 — AWS's own reference implementation needed it even
with a prefix), and keep `/health` un-prefixed (§G1). Reuse `pstudio` wholesale as the template.

### Ships in WEEKS (only if genuinely wanted)

**5. Native MLflow run detail + metric charts. (1-2 weeks)**
The one thing the native screen genuinely lacks vs the upstream UI. Build on
`GET /api/2.0/mlflow/runs/search` + `runs/get`. Do this *instead of* step 4 if the team would rather
not maintain a UI proxy at all — it is the more durable answer.

**6. Native Temporal event-history timeline. (2-3 weeks)**
Only if operators actually ask. Build on ui-server `/api/v1` history routes, tenant-filtered like the
existing workflow list. Do **not** embed to get this.

### Ranking, plainly
- **MLflow is the easy one** — a real sub-path flag (with the REST bug already fixed in the version
  we pin), no CSP to fight, an officially documented iframe recipe, an officially documented
  proxy-auth pattern, no login of its own to disable, and a screen already written to switch on.
- **Temporal is the trap** — not because framing is blocked (same-origin framing would in fact
  work), but because the UI *structurally* cannot express tenancy, its sub-path setting has regressed
  three times with an open report against 2.50.0, and its long-polling forces an edge proxy rather
  than the cheap BFF route.
- **MinIO is a non-starter** — not because it can't be framed (it can), but because the OSS console
  is now 21 object-browser endpoints inside an archived, source-deleted AGPL component, and we
  already have a better native equivalent.

---

## G. TOP GOTCHAS FROM PRIOR ART (5 that decide the design, 4 operational)

**G1. MLflow's `--static-prefix` does not prefix `/health` or `/version` — and the host-validation
middleware only exempts the *exact* path `/health`.** So `/{prefix}/health` and `/{prefix}/version`
return **401/403**, breaking k8s liveness/readiness probes and ingress health checks. Affects 3.8.0+
and is **still OPEN**. This one bites HOPE directly: our MLflow status probe calls `/health` and the
gateway comment describes it as "host-validation-exempt" — that exemption stops working the moment a
static prefix is introduced.
*Mitigation:* keep probing the **un-prefixed** `/health` from the gateway (in-cluster, no prefix),
and only apply the prefix to the browser-facing UI path. Do not assume the probe and the UI share a
base URL. https://github.com/mlflow/mlflow/issues/19691
*(Superseded, do not re-report: the older `--static-prefix` bug that skipped `/api/2.0/mlflow/`
routes — https://github.com/mlflow/mlflow/issues/22142 — was **fixed in 3.12.0** by PR
https://github.com/mlflow/mlflow/pull/22159. HOPE pins v3.15.2, so we are past it. The flip side is
a breaking change: 3.12+ **does** prefix `/api/`, so proxy rules must forward
`/{prefix}/api/2.0/...`.)*

**G2. MLflow 3.5+ Host-header validation rejects proxied requests.**
`MLFLOW_SERVER_ALLOWED_HOSTS` defaults to "localhost, private IPs" as DNS-rebinding protection. A
proxy that forwards the public Host (`console.example.com`) gets rejected — a new-in-3.5 failure mode
that every pre-2025 blog recipe predates. Our pinned `v3.15.2-full` is affected.
*Mitigation:* add the console host to `MLFLOW_SERVER_ALLOWED_HOSTS`, or have the proxy set the Host
to something already allowed. Do **not** reach for `--disable-security-middleware` as a first move.
https://mlflow.org/docs/latest/self-hosting/security/network/

**G3. Temporal's sub-path support has broken TWICE, and `VITE_PUBLIC_PATH` is a decoy.**
Break #1: 2.25.0 added `script-src 'strict-dynamic' 'sha256-…'`; browsers then refuse the inline
script under a subdirectory. https://github.com/temporalio/ui/issues/1924
Break #2: 2.45.3/2.45.4 duplicated the path segment with a custom `publicPath` — `/custom/custom`
instead of `/custom`; reported Feb 2026, closed as a bug.
https://github.com/temporalio/ui/issues/3183 — **we pin 2.53.1, only ~8 minors later.**
Decoy: a community user burned time on `VITE_PUBLIC_PATH` in compose/k8s — that is a Vite
*build-time* variable and cannot work at runtime; the runtime one is `TEMPORAL_UI_PUBLIC_PATH`.
https://community.temporal.io/t/embed-temporal-ui-into-other-web-host/6350
*Mitigation:* treat sub-path Temporal as **unproven until tested on the exact pinned tag**, in both
the landing-page and deep-link/hard-refresh cases. Budget for rebuilding the UI image with a baked
base path. Better: do not embed Temporal (§C).

**G4. Absolute URLs still leak through, even with `--static-prefix` — and rewriting them in the
proxy does not scale.**
AWS's own reference implementation of this exact pattern (a custom portal embedding SageMaker MLflow
via a Flask reverse proxy) states the proxy must both **"strip `X-Frame-Options` headers so that the
browser allows the content to render inside the iframe"** and **"rewrite absolute MLflow URLs to
relative paths so that navigation works correctly through the proxy."** So budget for response-body
rewriting even after the prefix flag is set.
https://aws.amazon.com/blogs/machine-learning/build-a-custom-portal-with-embedded-amazon-sagemaker-ai-mlflow-apps/
The Temporal community hit the harder version of the same problem and gave up — rewriting `src`/`href`
in HTML failed because "more paths appear in JS scripts"; bundled JS builds URLs at runtime, so no
HTML rewrite catches them all. **This is the general reason sub-path support must come from the app,
not the proxy.**
The Temporal community attempt to rewrite `src`/`href` in HTML via reverse proxy failed because
"more paths appear in JS scripts" — bundled JS constructs URLs at runtime, so no HTML rewrite catches
them all. This is the general reason **sub-path support must come from the app, not the proxy**.
*Mitigation:* if the app has no working prefix setting, do not embed it — choose (iii) or (iv).
Where it does, still test deep-links and hard-refresh, not just the landing page.
https://community.temporal.io/t/embed-temporal-ui-into-other-web-host/6350

**G5. An IdP-protected GUI cannot complete its login inside a frame.**
The repo already records this for the planned Cloudflare Access in front of MLflow: the Access
redirect cannot complete in a third-party frame. Generally, any GUI fronted by an OAuth/OIDC proxy
becomes un-framable the moment its session expires — the frame silently shows a login page or a
blank box. (Compounded by third-party-cookie deprecation.)
*Mitigation:* **our BFF is the auth, not a second IdP in front of the GUI.** Never stack an
interactive IdP proxy in front of something you intend to frame.
https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies

**G6. MLflow 3.15's presigned-URL artifact transfers bypass your reverse proxy entirely.**
3.15.0 added "proxy-less" artifact transfers: MLflow hands the browser a presigned URL and the client
talks **directly** to object storage, with automatic fallback to proxied transfers.
https://mlflow.org/releases/3.15.0/
*Why it matters twice for HOPE:* (a) if you add a CSP at the proxy, those direct URLs need a
`connect-src` allowance or downloads fail silently; (b) in our on-prem MinIO topology the presigned
host must be browser-resolvable, which — per the in-repo research doc — it deliberately is not for
in-cluster addresses. Expect the fallback path, and verify which one you actually get.
*Adjacent, well-documented pain:* proxied artifact transfers time out (HTTP artifact repo default
timeout is **10 seconds**) and large downloads 502 through nginx.
https://github.com/mlflow/mlflow/issues/6205 · https://github.com/mlflow/mlflow/issues/6331
*Mitigation:* raise `proxy_read_timeout`/`proxy_send_timeout` and `client_max_body_size`, and turn
`proxy_buffering off` on artifact routes.

**G7. MLflow has no native multi-tenancy — the established pattern is one server per tenant.**
The canonical OSS solution (`mlflow-oidc-proxy`) runs **one MLflow tracking server per tenant, each
on its own static prefix**, each with its own backing and artifact store, with a policy document
mapping OIDC claims + URL to forward/reject. https://github.com/meln5674/mlflow-oidc-proxy
Also note MLflow's security middleware **does not exist at all** when the server is started with
`--gunicorn-opts` or `--waitress-opts` — so a deployment that tunes workers that way silently loses
XFO, host validation and CORS. https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/
*Mitigation for HOPE:* this reinforces the recommendation. Our MLflow is a **platform-level,
super-admin-only** registry, not a per-tenant surface — so keep it single-instance and keep tenancy
where it already lives (the gateway + our own screens), rather than importing MLflow's N-server model.

**G8. If you ever do proxy MinIO's console: the prefix must be stripped, and the path charset is
narrow.** The console serves its own API and WebSocket **at root** even when a sub-path is
configured, so the proxy must `rewrite "^/admin/minio/(.*)$" /$1 break;` with a **bare** `proxy_pass`
— putting the prefix in both places is the documented cause of the `/x/ → /x/x/login` redirect loop.
The base path must also match `^[0-9a-zA-Z\/-]+$`: **underscores and dots fail silently** (index is
returned unmodified, every asset 404s at root). WebSocket upgrade headers are required or the console
returns `400`. And the **S3 API can never be sub-pathed** — SigV4 signs the URI path.
https://github.com/minio/minio/discussions/16304 · https://github.com/minio/minio/issues/14285

**G9. Embedded consoles collide with your session cookie namespace.** MinIO's console session cookie
is named **`token`** at `Path=/`. Under a same-host sub-path proxy it is transmitted to every path on
that origin, including the BFF. HOPE is safe today only because our cookie is `hope_admin_session` —
but the general rule holds for any embedded GUI: **check the upstream's cookie name and Path before
you put it on your own origin**, because same-origin embedding is exactly what makes the collision
possible. (`SameSite=Lax` on such cookies simultaneously *forces* same-site hosting, so you cannot
dodge it by moving the GUI to another site.)

---

## UNVERIFIED / could not confirm
- **The exact `X-Frame-Options` and CSP `frame-ancestors` VALUES that Temporal ui-server emits, and
  whether they are configurable.** Confirmed only that it applies Echo's Secure middleware, which
  sets CSP / XFO / nosniff / XSS-Protection [18] — a secondary source (deepwiki), not the Go source.
  **This is the gate on any Temporal embed and must be checked with `curl -I` against the pinned
  image before anyone estimates the work.**
- Whether the 2.45.3 `publicPath` duplication bug (#3183) and the 2.25.0 CSP regression (#1924) are
  both resolved in 2.53.1. Both are closed/unclear upstream; neither is confirmed fixed for our tag.
- **Whether `minio/object-browser` was DELETED or made PRIVATE.** Both it and `minio/console` return
  a genuine 404 (confirmed against a client simultaneously getting 200 for `minio/minio`), and there
  is **no official MinIO announcement** of the removal.
- **Whether the CVE fixed in `RELEASE.2025-10-15` affects the console or the server data path.** The
  release exists on GitHub but was never published to Docker Hub, so the newest pullable image
  predates the fix. **Worth checking before this image keeps running in a PHI environment.**
- The exact archival timestamp of `minio/minio` (UI banner and secondary sources say 2026-04-25; the
  API's `pushed_at` is 2026-04-24T17:54:39Z; no `archived_at` field retrieved). A secondary claim
  that it was archived in Feb 2026, un-archived, then re-archived could not be verified.
- Whether the MinIO STS deep-link (`?sts=&sts_a=&sts_s=`) is **documented anywhere** — it was found
  by source reading and confirmed empirically, so treat it as working but undocumented, with no
  stability guarantee on a codebase whose upstream no longer exists. Likewise whether AIStor's
  console retains that behaviour (closed source, not inspectable).
- `pgsty/silo`'s security posture, build provenance and suitability as a healthcare supply-chain
  dependency — not audited.
- `TEMPORAL_CORS_ORIGINS` and `TEMPORAL_CSRF_COOKIE_INSECURE` are absent from the official env-var
  reference, though HOPE's compose sets the former — so they exist in practice but are undocumented.
- Resolution status of MLflow issue #3583 (UI in iframe, "Blocked a frame with origin ... from
  accessing a cross-origin frame") — **still OPEN since 2020-10-23**, no linked PR, but it predates
  the whole MLflow 3.x frontend. Note it is a *cross-origin* failure, so the same-origin sub-path
  embed recommended here likely sidesteps it. Reproduction on 3.15 UNVERIFIED.
- Whether the MLflow UI uses WebSockets or SSE. No evidence of either on the classic
  experiments/runs UI, but the negative could not be confirmed from a primary source; the 3.14+ LLM
  Playground / MLflow Assistant are streaming chat surfaces and plausibly use SSE. **Assume streaming
  may be in play on GenAI surfaces and configure the proxy accordingly (`proxy_buffering off`).**
  This matters because a Next.js route handler cannot proxy a WebSocket upgrade at all.
- `MLFLOW_STATIC_PREFIX` as a *supported public* env var — it exists in code (`STATIC_PREFIX_ENV_VAR`)
  but is absent from the official env-var reference page. Prefer the `--static-prefix` CLI flag.
- Whether MLflow's built JS uses relative asset references vs a build-time base href; deep-link and
  hard-refresh behaviour under a prefix is likewise unconfirmed. Test both explicitly.
- All AGPL characterisations are the common industry reading, **not legal advice** — route two
  specific questions to counsel: (1) unmodified-server network use, and (2) whether the STS
  deep-link embedding changes the analysis.

**Provenance note.** The MLflow and MinIO columns and the Temporal fact table rest on source-level
and empirical verification (repo clones, Go module proxy spec diffs, live `curl` against
`minio/minio:latest`, echo's `DefaultSecureConfig`). The Temporal **prior-art** subsection (§G3-G4
issue history) is single-sourced and was partially self-corrected by the researching agent: two of
its forum-thread characterisations (a CSRF/Secure-cookie claim and a load-balancer MIME diagnosis)
were retracted as mischaracterised and are **not** relied on anywhere in this brief. The Temporal
Helm finding — that there is **no chart value for `TEMPORAL_UI_PUBLIC_PATH`**, so it must be threaded
via `web.additionalEnv` decoupled from `ingress.hosts` — was subsequently confirmed against
`templates/web-ingress.yaml`.
