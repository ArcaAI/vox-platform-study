/**
 * TASK-737 §4.4 — one contract fixture per gateway→python-service edge.
 *
 * The audit's headline finding was that nine `apps/api` → `apps/text` call
 * sites never even ATTEMPTED to send `X-Tenant-Id`, several with a `tenantId`
 * local in scope one line above the HTTP call. Code review missed all nine; this
 * fixture is the mechanical backstop that stops a tenth.
 *
 * The assertion is deliberately STRUCTURAL rather than behavioural: it pins that
 * every production call site building headers for a downstream Python service
 * goes through the ONE sanctioned builder
 * (`packages/applications/src/common/internal-service-headers.ts`), because a
 * hand-rolled `headers: { 'X-Service-Token': t }` object literal is exactly the
 * shape that dropped the tenant nine times. Behavioural per-service tests live
 * next to each service; this file answers "did anyone add a NEW one".
 *
 * Companion lint rule (fires at author time, not test time):
 * `arcaai-internal/require-internal-tenant-header`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

/**
 * Every production TypeScript module that POSTs tenant-scoped work to a
 * downstream Python service. Verified against the tree on 2026-08-17 — note
 * `jobs/processors/summary.processor.ts`, which TASK-737 §7.4 still lists, was
 * DELETED by TASK-732 and is therefore not here.
 */
const TENANT_SCOPED_CALL_SITES = [
  // → apps/text  /api/v1/generate (+ /translate, /tasks/:id[/stream])
  'apps/api/src/modules/text-compat/text-compat.controller.ts',
  'apps/api/src/modules/streaming/text-proxy.controller.ts',
  'packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts',
  'packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts',
  'packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts',
  'packages/applications/src/services/consultation/summary/chain-summary.service.ts',
  'packages/applications/src/services/consultation/summary/summary.service.ts',
  'packages/applications/src/services/prompt-management/prompt-management.service.ts',
  // → apps/guardrail, apps/nlp
  'packages/applications/src/services/phi-redaction/guardrail-phi-redactor.service.ts',
  'packages/applications/src/services/consultation/live-documentation/live-tool-registry.ts',
  'apps/api/src/modules/ai-inference/ai-inference.client.ts',
  // Closed 2026-08-18: the last pre-contract site. It was off-limits while a
  // concurrent agent held the file for TASK-700; that agent finished, and the
  // 428 it was causing on DNA-report generation is now fixed.
  'packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts',
  // → apps/stt  /internal/streaming/*, /internal/voice-profile/extract,
  //   /api/v1/pipelines/validate.
  //
  // Closed 2026-08-18. These were a LATENT deployed-environment break rather
  // than a live one: stt had NO inbound auth at all until `ServiceAuthMiddleware`
  // landed, and its dev bypass (no token configured) hides the gap locally. The
  // moment `INTERNAL_ACCESS_TOKEN` is set in a deployed environment every
  // streaming session, voice-profile enrolment and pipeline validation 401s.
  // Note `pipeline.service.ts` additionally carried a comment asserting stt
  // "carries no service-token middleware" — false since the middleware landed,
  // and exactly the kind of stale claim that re-introduces the gap.
  'packages/applications/src/services/stt/streaming/streamingSession.service.ts',
  'packages/applications/src/services/stt/pipeline/pipeline.service.ts',
  'packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts',
];

/**
 * Call sites still on the pre-contract shape, recorded rather than hidden.
 *
 * EMPTY as of 2026-08-18 — `dna-writing-style.processor.ts`, the last entry, was
 * closed and promoted into `TENANT_SCOPED_CALL_SITES` above. It had been held
 * off-limits by a concurrent agent, and while it sat here `apps/text /generate`
 * was returning **428** on DNA-report generation: a real live break, which is
 * exactly what this list existed to make visible instead of silent.
 *
 * Keep the mechanism. A future edge that cannot be fixed in the same pass goes
 * here and starts failing the moment someone fixes it, which is the hand-off
 * signal — a silently-skipped `it.todo` would let the gap outlive its fix.
 */
const KNOWN_REMAINING_SITES: string[] = [];

/**
 * The sanctioned ways to put a tenant on the wire. `internalServiceHeaders` is
 * the builder; `tenantHeaderValue` is for call sites that must merge the value
 * into an existing header map (the proxy controllers forward extra headers).
 */
const SANCTIONED_BUILDER = /\b(internalServiceHeaders|tenantHeaderValue)\s*\(/;

describe('TASK-737 — X-Tenant-Id is mandatory on every internal service call', () => {
  for (const rel of TENANT_SCOPED_CALL_SITES) {
    describe(rel, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');

      it('builds its downstream headers through the shared internal-service contract', () => {
        expect(src).toMatch(SANCTIONED_BUILDER);
      });

      // The conditional-assignment check below is about CODE, so comments are
      // stripped first — several of these files legitimately QUOTE the removed
      // `if (tenantId) headers['X-Tenant-Id'] = …` line while explaining why it
      // is gone, and prose describing the bug must not read as the bug.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      it('never assigns the tenant header CONDITIONALLY', () => {
        // `if (tenantId) headers['X-Tenant-Id'] = tenantId` was the narrower half
        // of the audit's Class-B finding: it makes a legitimate no-tenant caller
        // (a SUPER_ADMIN with no working tenant) indistinguishable from a header
        // dropped in transit — the exact ambiguity that has to be gone before
        // `apps/text` can refuse an absent header. Tenant-less work DECLARES
        // itself with `tenantless:<reason>` instead.
        // `[^)\n]` / `[^\n]` keep the match on ONE line — without that, a prose
        // comment mentioning the header several lines below an unrelated `if (…)`
        // reads as a hit.
        expect(code).not.toMatch(/if\s*\([^)\n]*\)[^\n]*X-Tenant-Id/i);
        expect(code).not.toMatch(/\.\.\.\([^)\n]*&&[^\n]*X-Tenant-Id/i);
      });
    });
  }

  /**
   * `it.fails` on purpose: this documents a gap that is REAL right now. It passes
   * while the call site is still broken and starts FAILING the moment someone
   * fixes it — which is the hand-off signal to move the entry into
   * `TENANT_SCOPED_CALL_SITES` above and delete this block. A silently-skipped
   * `it.todo` would let the gap outlive its fix unnoticed.
   */
  for (const rel of KNOWN_REMAINING_SITES) {
    it.fails(`KNOWN GAP — ${rel} still omits the tenant (see the list comment; /generate now 428s it)`, () => {
      expect(readFileSync(resolve(ROOT, rel), 'utf8')).toMatch(SANCTIONED_BUILDER);
    });
  }

  it('the tenant-less sentinel can never be mistaken for a tenant id', async () => {
    const { TENANTLESS, TENANTLESS_PREFIX, isTenantlessMarker, tenantHeaderValue } =
      await import('../../packages/applications/src/common/internal-service-headers');
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const marker of Object.values(TENANTLESS)) {
      expect(marker.startsWith(TENANTLESS_PREFIX)).toBe(true);
      expect(marker).not.toMatch(UUID);
      expect(isTenantlessMarker(marker)).toBe(true);
      // Never the `50000000-…` CUSTOMER tenant (the platform-admin playground).
      expect(marker).not.toContain('50000000');
    }
    // A real tenant always wins over the declared fallback.
    expect(tenantHeaderValue('tenant-1', TENANTLESS.PLATFORM_OPERATOR)).toBe('tenant-1');
    expect(tenantHeaderValue('   ', TENANTLESS.PLATFORM_OPERATOR)).toBe(TENANTLESS.PLATFORM_OPERATOR);
  });
});
