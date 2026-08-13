# TASK-653 — Browser-Extension Origins in the Origin Registry

**Status:** Review (code complete + verified; cluster deploy pending)
**Type:** feature
**Owner:** Platform / API
**Related:** TASK-610 (origin registry), TASK-641 (allowed-origin hardening, wildcard-injection fix)

## Requirement Analysis

Allow browser-extension origins to access the HOPE APIs and WebSocket streams by
registering them in `TenantAllowedOrigin`. Concretely, support the three browser
extension URL schemes and a per-scheme "any extension" wildcard:

- `chrome-extension://<id>` (Chrome/Edge/Brave; `<id>` = 32 chars `a–p`)
- `moz-extension://<internal-uuid>` (Firefox)
- `safari-web-extension://<uuid>` (Safari)
- Wildcard form `<scheme>://*` — matches any extension id of that scheme.

Today this is impossible **by design**: `normalizeOrigin()` accepts only `http`/`https`
and the pattern grammar's `SCHEME_PREFIX_PATTERN` is `^(https?)://`. Both the write
path AND the incoming-`Origin` lookup (`OriginRegistryService.toLookupKey`) reject any
extension scheme, so no DB row can ever match. This ticket widens the two normalizer
modules; the registry, guard, CORS, and WS gateway need **no logic change** (they already
route through the normalizers and classify rows by "contains `*`").

Decisions (product owner):
- Schemes: **all three** (chrome-extension, moz-extension, safari-web-extension).
- Breadth: **grammar supports both** pinned exact ids and `<scheme>://*`; **seed the
  arcaai tenant with the three `://*` wildcards for now** (pin specific ids later).
  Rationale: Firefox/Safari use per-install UUIDs, so wildcard is the only practical
  form there; Chrome ids are stable and can be pinned later.

### Security posture (explicit)

- `<scheme>://*` for a tenant means **any installed extension** (in anyone's browser)
  passes the *origin* gate for that tenant. It is NOT auth: the post-auth
  `OriginTenantBindingGuard` and the WS handshake still require a valid session/token,
  and HTTP CORS runs `credentials: false`. Origin is one layer, not the only one.
- Extension schemes are secure contexts, so the `http`-only-loopback rule does not apply.
- Wildcard writes remain gated behind `isSuperAdmin` in `TenantAllowedOriginService`
  (unchanged) — only elevated admins can create a `*` row via the API. Seeds bypass the
  service by design.

## Current State Evaluation (verified)

| File | Relevant fact |
|---|---|
| `packages/applications/src/services/origin-registry/origin-normalizer.ts` | `ALLOWED_SCHEMES = {http:,https:}` (L38); `NormalizedOrigin.scheme: 'http'\|'https'` (L32); raw + canonical `*` rejection (L52, L112); http-only-loopback (L116). Owns EXACT origins. |
| `.../origin-registry/origin-pattern.ts` | `SCHEME_PREFIX_PATTERN=/^(https?):\/\//i` (L75) used by BOTH `parsePattern` (write) and `parseCanonicalOrigin` (incoming header). Port is mandatory in the http/https grammar; `*` host must be `*.<suffix>` with ≥2 labels. `ParsedPattern.scheme`/`ParsedOrigin.scheme` unions (L153, L487). |
| `.../origin-registry/origin-registry.service.ts` | Classifies stored rows by `isOriginPattern` (contains `*`) only; `toLookupKey` → `normalizeOrigin`. **No change needed.** |
| `.../tenant-allowed-origin/tenant-allowed-origin.service.ts` | `normalizeIncomingOrigin` (L103-117) routes `*`→`normalizeOriginPattern`, else `normalizeOrigin`. Wildcard + SYSTEM writes gated by `isSuperAdmin`. **No change needed** — inherits new grammar. |
| create/update request DTOs | `origin` is `@IsString @IsNotEmpty @MaxLength(2048)` — **no scheme restriction**. **No change needed.** |
| `apps/api/src/modules/tenant-allowed-origin/…controller.ts` | Swagger only, no origin validation. **No change needed.** |
| `apps/api/src/cors.config.ts`, `…/streaming/stt-ws.gateway.ts`, `platform-knobs.binder.ts` | Consume the registry; inherit new behavior. **No change needed.** |
| seed `…/db_main/seed/11b-tenant-allowed-origins.ts` | `OriginSeed {origin,tenantId,label,description}`; strings must be **pre-canonical**; round-trip guarded by `seed-origin-canonicalization.task610.test.ts`. |
| descriptor `platform-ops.descriptors.ts` | `origin.enforcementEnabled` default **true** (L283). Enforcement is on in every env. |

Tests dir: `.../origin-registry/__tests__/` — `origin-normalizer.task610.test.ts`
(accepts/rejects, rejects-scheme block L76-81), `origin-pattern.task610.test.ts`
(scheme-reject block L154), `origin-registry.service.task610.test.ts`,
`seed-origin-canonicalization.task610.test.ts`. No existing extension-scheme cases.

## Design

### Canonical forms
- Exact: `<scheme>://<id>` — id lowercased, single opaque label, no port, no path.
- Wildcard: `<scheme>://*` — any id of that scheme, no port.

### Extension-id validation
Single ASCII label matching the existing `LABEL_PATTERN`
(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`), length 1–128, no dots, no `*`. Covers Chrome
(`[a-p]{32}`), Firefox/Safari UUIDs (hex+hyphens). Deliberately lenient: an exact id
row only ever matches its own literal string, so over-permissive id syntax is low-risk.
Safari sends uppercase → lowercased on both store and lookup, so matching is consistent.

### `origin-normalizer.ts`
- Add `export const EXTENSION_SCHEMES = ['chrome-extension','moz-extension','safari-web-extension'] as const;`
  `export type ExtensionScheme = …; export type OriginScheme = 'http'|'https'|ExtensionScheme;`
  `export function isExtensionScheme(s): boolean`.
- Widen `NormalizedOrigin.scheme` to `OriginScheme`.
- In `normalizeOrigin`, after the generic userinfo/path/query/fragment/`*` checks: if
  protocol is an extension scheme → require non-empty host, forbid a port, validate the
  id label, lowercase it, `canonical = <scheme>://<id>`, `port: null`. Skip the
  http-only-loopback rule for extension schemes. http/https path unchanged.

### `origin-pattern.ts`
- Share `EXTENSION_SCHEMES`/`isExtensionScheme` from the normalizer; widen the two scheme
  unions; change `SCHEME_PREFIX_PATTERN` to `/^(https?|chrome-extension|moz-extension|safari-web-extension):\/\//i`.
- `parsePattern`: if extension scheme → the authority must be exactly `*` (exact ids carry
  no `*` and go to `normalizeOrigin`); produce a parsed entry flagged "any extension"
  (`wildcard:true`, `matchHost:''`, `port:null`), `canonical = <scheme>://*`. Reject any
  other extension authority (`chrome-extension://*.x`, `chrome-extension://ab*`, a pinned
  id with `*`, a port). http/https branch unchanged (still port-mandatory, `*.<suffix>`).
- `parseCanonicalOrigin` (incoming header, never throws): parse extension origins →
  `{scheme, host:id(lowercased, single label), port:null}`; reject a port or `*`. http/https
  unchanged.
- `matchesOriginPattern`: for an any-extension pattern → scheme equal AND origin host
  non-empty ⇒ true (no port/label-boundary logic). Otherwise unchanged.
- `patternSpecificity`: give any-extension a small fixed rank above allow-all (log ordering
  only; not on the auth path).

### Seed
Append to `TENANT_ALLOWED_ORIGIN_SEEDS` (tenant `SEED_CUSTOMER_TENANT_IDS.ARCAAI`):
`chrome-extension://*`, `moz-extension://*`, `safari-web-extension://*`, each with a label
+ description. Strings are already canonical.

### No change
Registry service, admin service, DTOs, controller, CORS config, WS gateway,
platform-knobs binder.

## Implementation Plan (TDD, RED→GREEN)

1. **origin-normalizer** — add failing tests (accepts `chrome-extension://<id>` /
   `moz-extension://<uuid>` / `safari-web-extension://<UUID>`→lowercased; rejects a port,
   empty host, path; `chrome-extension` no longer in the reject-scheme block) → implement.
2. **origin-pattern** — failing tests (`normalizeOriginPattern` accepts+canonicalizes the
   three `://*`; rejects `chrome-extension://*.x`, `://ab*`, `://id:1234`;
   `matchesOriginPattern` matches an id origin against `<scheme>://*`, scheme-mismatch
   fails, hostile input never throws; `parseCanonicalOrigin` via matches for uppercase
   Safari id) → implement.
3. **registry service** — one integration-style test: a wildcard `chrome-extension://*`
   row for a tenant makes `allows('chrome-extension://<id>', tenant)` true; an exact pinned
   id row works; a different scheme's origin is denied. (Behavior falls out of 1+2; test to
   lock it.)
4. **seed** — add the three arcaai wildcard rows; `seed-origin-canonicalization.task610.test.ts`
   must stay green (round-trip canonical).
5. **Gates**: `pnpm --filter @arcaai/applications test`, `… build`, `pnpm lint` clean.

## Rollout to hope-v2-dev (`vox-dev`) — the original ask

The DB row is **necessary but not sufficient**: enforcement runs the normalizer code, so
the cluster must run the **updated `@arcaai/applications` (api + stt-ws) image** for an
extension `Origin` to be accepted. Sequence:

1. Land + review code (this ticket). Merge → CI builds `dev-<sha>` images.
2. Deploy updated api image to `hope-v2-dev` (GitLab build + Argo sync — out of band).
3. Resolve the real **arcaai** tenant id in `vox-dev` (query `core."Tenant"` by name;
   seed constant is `50000000-0000-0000-0000-000000000001`).
4. Insert the three wildcard rows into `core."TenantAllowedOrigin"` for that tenant
   (idempotent `ON CONFLICT (origin,tenantId) DO NOTHING`) via a short-lived `psql` pod
   (the `pgm` pattern), OR emit `origin-registry.invalidate` / wait ≤30s for the backstop
   refresh so the running registry picks the rows up.
5. Verify: a `chrome-extension://<id>` `Origin` passes CORS + the tenant-binding guard +
   the STT WS handshake for the arcaai tenant.

## Verification Criteria
- New unit tests pass; existing origin + seed tests stay green.
- `@arcaai/applications` builds; `pnpm lint` clean (no new only-warn violations).
- On the cluster (post-deploy): extension origin admitted for arcaai; a non-registered
  extension origin for another tenant still denied (cross-tenant isolation intact).

## Implementation Summary

Implemented via strict TDD (new tests observed RED before code). No change to the
registry service, DTOs, controller, CORS config, or WS gateway — they inherit the
new behavior, as the plan predicted (verified: none were edited and their tests
stay green).

Files changed:
- `origin-normalizer.ts` — added `EXTENSION_SCHEMES`, `ExtensionScheme`,
  `OriginScheme`, `isExtensionScheme()`; widened `NormalizedOrigin.scheme` to
  `OriginScheme`; widened `ALLOWED_SCHEMES` to admit the three extension protocols.
  `normalizeOrigin` gained an extension branch AFTER the raw-`*` reject, parse,
  userinfo/path/query/fragment checks and canonical-host `*` re-check (all
  unchanged): it requires a non-empty host, FORBIDS a port, lowercases and
  validates the id as a single LDH label (≤128 chars), and returns
  `<scheme>://<id>` with `port: null`. The http-only-loopback rule is skipped for
  extension schemes (secure contexts, no network hop). The `*`-never-returned
  invariant is preserved for all schemes.
- `origin-pattern.ts` — imported `isExtensionScheme` + `OriginScheme`; changed
  `SCHEME_PREFIX_PATTERN` to also accept the three extension schemes (used by both
  `parsePattern` and `parseCanonicalOrigin`); widened both scheme unions; added an
  `anyExtension` discriminant to `ParsedPattern`. `parsePattern` treats an
  extension scheme's authority as REQUIRED to be exactly `*` (`<scheme>://*`),
  rejecting `*.x`, `ab*`, `*:80`, a pinned id, etc. `parseCanonicalOrigin` parses
  an incoming `<scheme>://<id>` to `{scheme, host: id.toLowerCase(), port: null}`,
  returning null on a port/`*`/bad char. `matchesOriginPattern` returns true for an
  any-extension pattern iff scheme matches and the origin host is a valid non-empty
  id (no port/label-boundary logic). `patternSpecificity` gives an any-extension
  pattern a fixed rank of 2 (above allow-all=1, below concrete hosts). The
  wildcard-injection defenses, public-suffix logic, and http/https grammar are
  untouched.
- `seed/11b-tenant-allowed-origins.ts` — appended three pre-canonical ArcaAI rows:
  `chrome-extension://*`, `moz-extension://*`, `safari-web-extension://*`.

Tests added to the three existing suites (extension accepts/rejects in the
normalizer, `<scheme>://*` accepts/rejects + match + specificity in the pattern
grammar, registry admission for wildcard/SYSTEM/exact-pinned extension rows). Note:
neither the normalizer nor the pattern "rejects these schemes" list contained an
extension scheme, so nothing had to be moved from reject→accept.

Verification (all green): `pnpm --filter @arcaai/applications test` → 8580 passed /
4 skipped; `… build` → tsc exit 0; `… lint` → 0 errors (touched source files
0 warnings; the 189 pre-existing repo-wide warnings are unrelated
`eslint-comments/require-description`).

## Change History
- _pending_ — ticket created; plan authored, awaiting approval.
- Implemented TASK-653 (TDD). Widened `origin-normalizer.ts` /
  `origin-pattern.ts` to support the three browser-extension schemes as exact
  `<scheme>://<id>` origins and per-scheme `<scheme>://*` any-extension patterns;
  seeded the three ArcaAI wildcard rows. No security invariant weakened;
  registry/guard/CORS/WS inherit the behavior with no code change.
- Independent verification: re-ran `origin-registry` + `tenant-allowed-origin`
  suites → 9 files / 485 tests pass. Adversarial URL probes (`%2A`, fullwidth `＊`,
  `id:80`, `a.b`, `[::1]`) all rejected — opaque hosts never decode to `*`.
- Adversarial security review (independent agent): no exploitable cross-tenant
  bypass, scheme confusion, throw-to-500, or classification disagreement. Two
  non-blocking notes: (a) a Global allow-all `*` row would also admit extension
  origins — moot, that row was removed in TASK-641 and is absent from `vox-dev`;
  (b) LOW/DRY — the scheme list + `MAX_EXTENSION_ID_LENGTH` are duplicated across
  the two files (drift fails closed, not open) — follow-up to share one source.
- Cluster (`hope-v2-dev` / `vox-dev`) state confirmed: arcaai tenant =
  `50000000-0000-0000-0000-000000000001` (name "ArcaAI", key "ARCAAI"). A
  `chrome-extension://*` row already existed for it (hand-inserted, inert until
  the updated image deploys). No `moz-extension`/`safari-web-extension` rows yet;
  no bare `*` allow-all row.
