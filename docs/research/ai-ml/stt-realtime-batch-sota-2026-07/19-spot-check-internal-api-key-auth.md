> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `Explore` `a71651a67502e48a8` (depth-3 spot check under 16). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Spot Check — Internal API-Key Auth Header (`X-Internal-Service-Key`)

Note: the actual implementation lives in `packages/applications`, not `apps/api/src` — `UnifiedAuthGuard` is imported from `@arcaai/applications` (confirmed by the comment at `apps/api/src/types/request-with-auth.ts:9-13`), so nothing under `apps/api/src` itself defines this logic.

**Header extraction:** `packages/applications/src/services/apiKey/apikey.service.ts:887-891`, in `ApiKeyService.extractApiKeyFromRequest`, tries headers in order:
```ts
const apiKey =
  (request.headers['apikey'] as string) ||
  (request.headers['api-key'] as string) ||
  (request.headers['x-api-key'] as string) ||
  (request.headers['x-internal-service-key'] as string);
```
So it's `apikey`, `api-key`, `x-api-key`, or `x-internal-service-key` (first match wins), with an optional `?apiKey=` query-param fallback gated by `API_KEY_ALLOW_QUERY_PARAM`.

Called from `packages/applications/src/authorization/unified-auth.guard.ts:103` (`this.apiKeyService.extractApiKeyFromRequest(request)`), matching the doc comment at line 48: "Try API key (headers: apikey, api-key, x-api-key)".
