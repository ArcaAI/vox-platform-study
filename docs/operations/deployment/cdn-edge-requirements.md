# HOPE Edge / CDN Requirements — Strong ETag Preservation

> **Applies to**: every environment where a CDN, WAF, or reverse proxy sits between a browser (or
> SDK consumer) and HOPE — today that is **Cloudflare in front of `admin-hope.taphuynh.dev`**
> (proxied DNS; the zone resolves to Cloudflare anycast IPs, there is no `cloudflared` tunnel in
> the cluster). Local development and in-cluster traffic are unaffected, which is exactly why this
> class of failure only ever shows up *after* a deploy.
>
> **Status (2026-08-11)**: the breakage described in [§2](#2-how-it-manifests) is **live and
> verified** on `admin-hope.taphuynh.dev`. The fix in [§4](#4-required-configuration) is
> **prescribed but not yet applied** — nobody has confirmed it end-to-end against this zone. Treat
> [§5](#5-verification) as the acceptance test, not a formality.

---

## 1. The one thing to understand

**HOPE's optimistic concurrency control is built on RFC 7232 *strong* validators, and the API
rejects weak ones by design.** Any intermediary that rewrites `ETag: "7"` into `ETag: W/"7"`
does not degrade OCC — it disables every versioned write in the product.

Cloudflare rewrites strong ETags to weak whenever it compresses or otherwise transforms a response
body. That is correct HTTP behaviour on Cloudflare's part: the bytes it returns are no longer
byte-identical to what the origin produced, so a strong validator would be a lie. The mismatch is
on our side — HOPE uses the ETag to carry a **row version number**, not a byte-hash, so the
weakening destroys information the API depends on while being technically well-behaved.

This is a **deployment-topology requirement, not a bug in an individual screen.** Any host that
fronts either the admin console's BFF proxy or the gateway itself must be configured so HOPE's
responses reach the client untransformed.

---

## 2. How it manifests

The two client families fail *differently*, and neither symptom points at the CDN. Recognising
these is the fastest path to diagnosis:

| Client | Symptom | Why |
|---|---|---|
| **Admin console** | **Silent.** The Save button is permanently disabled. No error, no toast, no network request — nothing to inspect in DevTools. | The console defensively discards weak ETags (`apps/admin-console/src/shared/api/http.ts:150-151`), leaving `etag = null`; every OCC form gates its submit button on `!etag` (e.g. `apps/admin-console/src/features/agents/components/template-form-dialog.tsx:302`). |
| **`@arcaai/vox` browser SDK** | **Loud.** `400 Bad Request` — `Invalid If-Match header: W/"7". Expected a strong validator…` | `AgenticClient.getWithEtag` returns the header verbatim (`packages/agentic-sdk-v2/src/core/AgenticClient.ts:475`) and replays it as `If-Match`; the gateway rejects it. |

Both are indistinguishable from an application bug, and both reproduce **only** through the CDN —
the same build works locally. If you are chasing a "works locally, fails deployed" report on any
edit form, check [§5](#5-verification) *before* reading application code.

---

## 3. The mechanism

Verified end-to-end on `admin-hope.taphuynh.dev`, 2026-08-11:

1. **The gateway emits a correct strong validator.** `ETagInterceptor` renders `ETag: "<n>"` from
   any response body carrying a positive-integer `version`
   (`apps/api/src/interceptors/etag.interceptor.ts:40`). Confirmed by reading the *compiled*
   interceptor on the running pod, not just the source.
2. **The BFF proxy forwards it unchanged.** `etag` is on the response-header allowlist
   (`apps/admin-console/src/server/hope-proxy.ts:16`).
3. **Cloudflare compresses and weakens it.** The browser receives `etag: W/"5"` with
   `content-encoding: zstd`, `server: cloudflare`, `cf-cache-status: DYNAMIC`. The value is
   literally the origin's `"5"` with `W/` prepended — Cloudflare's documented transformation.
4. **The write is now impossible.** Either the client drops the token (console) or the gateway
   rejects it (SDK). `extractExpectedVersion` matches `/^"(0|[1-9][0-9]*)"$/` and throws `400` on
   anything weak — deliberately, and documented in its own behaviour table
   (`apps/api/src/decorators/expectedVersion.decorator.ts:12,27,75-78`).

Confirmed with a non-mutating probe (rejected at the param decorator, before the service or any
transaction runs):

```
PATCH /api/hope/admin/prompt-templates/<id>   If-Match: W/"5"
→ 400  Invalid If-Match header: W/"5". Expected a strong validator of the form "<positive integer>" (RFC 7232 §3.1).
```

**Blast radius.** Not one screen — every OCC-guarded surface behind the affected host. A
department detail read returns `W/"1"` just as a prompt template returns `W/"5"`. In the admin
console alone that is **15 feature modules** performing `patchWithEtag`/`putWithEtag` writes:
agents, agentic-policy, ai-models, allowed-origins, audio-pipelines, changelog, departments,
dna-writing-styles, harness-policy, identity-providers, playground-dna-style, settings, tenants,
tools-mcp, users.

---

## 4. Required configuration

**Disable compression for HOPE's API traffic on every Cloudflare-fronted HOPE hostname.**
Compression Rules are available on **all Cloudflare plans**, so this needs no plan upgrade.

### Dashboard

`taphuynh.dev` zone → **Rules** → **Overview** → **Create rule** → **Compression Rule**

| Field | Value |
|---|---|
| Rule name | `No compression for HOPE BFF (preserve strong ETags)` |
| Expression (use the **Editor**, not the visual builder) | `http.host eq "admin-hope.taphuynh.dev" and starts_with(http.request.uri.path, "/api/hope/")` |
| Compression options | **Disable compression** |

`starts_with()` is a standard Rules-language function with no plan restriction.

### API

The phase is `http_response_compression`. Take `{zone_id}` from the zone's Overview page.

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "HOPE BFF compression",
    "kind": "zone",
    "phase": "http_response_compression",
    "rules": [{
      "action": "compress_response",
      "action_parameters": { "algorithms": [{ "name": "none" }] },
      "expression": "http.host eq \"admin-hope.taphuynh.dev\" and starts_with(http.request.uri.path, \"/api/hope/\")",
      "description": "Preserve strong ETags for optimistic concurrency"
    }]
  }'
```

If the zone already has an `http_response_compression` ruleset, this `POST` conflicts — `PATCH`
the existing entrypoint instead of creating a second one.

### Scope: which hostnames need this

- **`admin-hope.taphuynh.dev` → `/api/hope/*`** — the admin console's BFF proxy. Required today.
- **Any host that publishes the gateway (`/api/v1/*`) directly** — required the moment one exists.
  The `@arcaai/vox` SDK drives the same `getWithEtag` → `patchWithIfMatch` OCC pattern, so a
  publicly-proxied gateway breaks every SDK optimistic-locking write with a `400`. As of
  2026-08-11 no such hostname resolves (`api-hope`, `hope-api`, `api`, `hope` under
  `taphuynh.dev` all return NXDOMAIN), so this is a **forward-looking requirement** — add the
  equivalent rule as part of exposing the gateway, not afterwards.
- **Any new environment** (staging/prod, or a customer-facing domain such as the `*.bcmch.org`
  origins already registered in `TenantAllowedOrigin`) inherits this requirement.

**Cost of disabling compression** is negligible here: these are small JSON admin payloads on a
low-traffic internal surface. Do not widen the rule to the whole host to "keep it simple" — that
would drop compression for the Next.js asset bundles too.

---

## 5. Verification

Apply the rule, then confirm from a browser logged into the console (no redeploy is needed — this
is a per-response header, it takes effect immediately):

```js
// DevTools → Console, on any admin-console page
const r = await fetch('/api/hope/admin/prompt-templates/71000000-0000-0000-0001-000000000024');
console.log({ etag: r.headers.get('etag'), enc: r.headers.get('content-encoding') });
```

**Pass**: `etag: "5"` (no `W/` prefix) and `enc: null`.
**Fail**: `etag: W/"5"` and/or `enc: "zstd"` — the rule did not match; re-check the expression's
hostname and path prefix.

Then confirm the user-visible behaviour, which is the thing that actually matters:

1. Open any record with an edit form (Prompt templates → Templates → pick any row).
2. The **Save changes** button must be **enabled**.
3. Make a trivial edit and save — expect `200`, not `400`/`412`/`428`.

A `412` on that last step is *not* a regression of this issue: it means OCC is working and the row
genuinely moved under you. Reload and retry.

---

## 6. Why "Respect Strong ETags" is not the fix

The obvious-looking setting is a trap. Cloudflare's Cache Rules expose **Respect Strong ETags**,
and most search results point at it. It does not solve this:

- Per Cloudflare's own documentation, even with the setting enabled it **still** converts strong
  ETags to weak "in situations where the visitor's compression preference differs from the origin
  server's" — which is precisely our case.
- It is a *cache*-oriented setting, and HOPE's API responses are `cf-cache-status: DYNAMIC`
  (uncached). The weakening we observe comes from compression, not from cache storage.
- It has real collateral: enabling it **automatically disables Rocket Loader, Email Obfuscation,
  and Automatic HTTPS Rewrites** across the zone.

Disable compression instead ([§4](#4-required-configuration)).

---

## Known gaps

| Gap | Consequence |
|---|---|
| The [§4](#4-required-configuration) rule is **not yet applied**; the fix is unverified end-to-end | Every OCC write on `admin-hope.taphuynh.dev` is currently broken. [§5](#5-verification) is an untested acceptance procedure until someone runs it. |
| The fix lives entirely in edge configuration, outside this repo and outside GitOps | Nothing in CI, Kustomize, or Argo asserts it. A zone-config change, a new hostname, or a migration to another CDN silently reintroduces the breakage with no failing test. A code-side mitigation (an origin response header that instructs any CDN not to transform) exists as an option but is deliberately **out of scope for this document** — see [§Related](#related). |
| No automated regression test asserts a strong ETag survives the edge | This was found by manual browser inspection. An e2e assertion on `etag` not starting with `W/` against a deployed environment would catch a recurrence; none exists. |
| The zone's Cloudflare plan was not confirmed | Immaterial for the prescribed fix (Compression Rules are on all plans), but relevant if someone later reaches for an Enterprise-only setting. |
| Only `admin-hope.taphuynh.dev` and `grafana-dev.taphuynh.dev` were enumerated | The hostname sweep in [§4](#4-required-configuration) was a targeted DNS probe, not an authoritative zone dump. Confirm against the Cloudflare DNS list when adding environments. |

---

## Related

- [`README.md`](./README.md) — the staging deploy / rollback / k3s-upgrade runbook for this cluster
- [`.claude/rules/05-nestjs-api.md`](../../../.claude/rules/05-nestjs-api.md) — §Optimistic Concurrency: the `_version` → `ETag` → `If-Match` → `updateWithVersion` chain this document protects
- [`docs/implementation/TASK-610-Tenant-Allowed-Origins/README.md`](../../implementation/TASK-610-Tenant-Allowed-Origins/README.md) — the other edge-adjacent concern on these hostnames (CORS origin registry)
- Cloudflare docs: [ETag headers](https://developers.cloudflare.com/cache/reference/etag-headers) · [Compression Rules](https://developers.cloudflare.com/rules/compression-rules/) · [Compression Rules settings](https://developers.cloudflare.com/rules/compression-rules/settings/) · [Create via API](https://developers.cloudflare.com/rules/compression-rules/create-api/) · [Rules language functions](https://developers.cloudflare.com/ruleset-engine/rules-language/functions/)

---

## Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-11 | Initial version. Documents the Cloudflare strong→weak ETag conversion breaking all optimistic-concurrency writes behind `admin-hope.taphuynh.dev`, verified live (`etag: W/"5"`, `content-encoding: zstd`; weak `If-Match` confirmed rejected `400` by a non-mutating probe). Prescribes a Compression Rule disabling compression for `/api/hope/*`. **The fix is not yet applied and [§5](#5-verification) has not been executed.** | Claude |
