---
'@arcaai/vox-node': patch
---

**`@arcaai/vox-node` reaches the administration plane.** Adds the service-account credential class and a generated `hope.admin.*` surface covering 52 admin areas, so a backend integration can administer HOPE without a human logging in.

The version number does not carry the size of this change — it is a deliberate patch bump per owner decision D-4, taken so the SDK family stays in lockstep. Read this entry, not `3.0.0 → 3.0.1`, for what actually landed.

**New credential class.** `new HopeClient({ serviceAccount: { clientId, clientSecret } })`. The SDK exchanges the pair at `POST /auth/service-token` for an opaque short-lived token and presents it as `X-Service-Account-Token`. Construction still never touches the network: the first call exchanges lazily, the token is cached and refreshed on a margin before expiry, concurrent calls during a refresh collapse to one exchange, and a token revoked mid-flight (revocation is immediate, not TTL-bound) is re-exchanged once and the call retried. Neither the secret nor the token can reach a log line or a serialized error.

An API key still cannot reach `/admin/*` under any scope, including `*` — that is platform policy, enforced by a boot audit, not a gap. A service account is the only path.

**`workingTenantId` binds at exchange, not per request.** This is the one place API-key intuition misleads: a token *carries* its working tenant, so the SDK never sends `X-Tenant-Id` alongside it. Supplying top-level `tenantId` together with `serviceAccount` now throws at construction rather than being silently dropped, as does supplying `apiKey` and `serviceAccount` together (the gateway rejects two credentials, so failing at construction turns a runtime refusal into a programming error).

**`hope.admin.*`** — generated from the gateway's own route metadata cross-checked against its OpenAPI document, with a CI gate that fails on drift, so the surface cannot quietly fall behind the API. Areas are named after the scope they require (`svc:admin:tenant-tts-config:manage` → `hope.admin.tenantTtsConfig`), and every 403 names the scope that route needs.

Three behaviours worth knowing before you write against it:

- **Use `listIterate()` rather than a hand-rolled page loop.** The gateway echoes back the raw `page`/`limit` query values, so reading them off the response and incrementing does not work; the iterator drives pagination from the request side.
- **The row is the OCC precondition**, not a header — `update(id, patch, { ifMatch: row })`. `ifMatch` is a required property, so forgetting it is a compile error rather than a 428. List responses carry no ETag at all, since one validator cannot represent N rows.
- **A 404 can mean "not yours"**, not "does not exist" — the platform answers cross-tenant reads with 404 deliberately.

Five admin areas are deliberately absent from the surface, machine-closed by owner decision: service-account issuance (self-replication), impersonation (it would defeat audit attribution, which records exactly one actor — human or machine, never both), consent grants (consent is an act of a person), and the monitoring and service-health telemetry surfaces. A method that always 403s is worse than no method.

Also exports `ServiceAccountCredentials` from the root barrel, which was previously reachable only from the `core` subpath, so integrators could not name the type of the credential they were constructing.

The other seven packages in the SDK family are unchanged in this release; they move only to hold lockstep.
