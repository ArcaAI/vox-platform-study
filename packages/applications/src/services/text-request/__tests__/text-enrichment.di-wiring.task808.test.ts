// MUST be first — `services/index.ts` participates in a PRE-EXISTING import
// cycle, so requiring a deep module file first leaves some `imports` entries
// `undefined` at decoration time (an artifact of evaluation order, not of the
// wiring). `apps/api` imports the package barrel, so importing it here
// reproduces the production evaluation order. Same reason, same comment, as
// `gate-edit-mining.di-wiring.test.ts`.
import '../../../index';
import { describe, expect, it } from 'vitest';
import { KnownPhiService } from '../known-phi.service';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';
import { TextRequestServiceModule } from '../text-request.service.module';
import { LiveDocumentationService } from '../../consultation/live-documentation/live-documentation.service';
import { LiveDocumentationServiceModule } from '../../consultation/live-documentation/live-documentation.service.module';
import { PreSummaryProcessor } from '../../consultation/jobs/processors/pre-summary.processor';
import { ConsultationJobServiceModule } from '../../consultation/jobs/consultation-job.service.module';
import { SummaryService } from '../../consultation/summary/summary.service';
import { SummaryServiceModule } from '../../consultation/summary/summary.service.module';
import { DnaWritingStyleProcessor } from '../../dna-writing-style/dna-writing-style.processor';
import { DnaWritingStyleServiceModule } from '../../dna-writing-style/dna-writing-style.service.module';

/**
 * DI wiring guard for the four repaired TEXT `/generate` callers.
 * (`ChainSummaryService` was a fifth until TASK-1006: it now reaches TEXT through
 * `AgentInvocationService`, which injects the enrichment itself. `ComprehensiveSummaryProcessor`
 * was a sixth until the same ticket removed it outright — the comprehensive summary now runs
 * synchronously on the agent plane, through `ChainSummaryService`.)
 *
 * `TextRequestEnrichmentService` is injected `@Optional()` on all four, so a
 * module that does NOT import `TextRequestServiceModule` resolves it to
 * `undefined`, the `?.` call becomes a silent no-op, and the whole outage comes
 * back with every unit test still green — every existing fixture constructs
 * these classes POSITIONALLY with a hand-built mock and can never see it. That
 * is precisely the defect class `usage-ledger.di-wiring.task615.test.ts` and
 * `gate-edit-mining.di-wiring.test.ts` exist for.
 *
 * The `@Optional()` marker is right — a composition with no enrichment wired
 * must not fail to boot — but "optional at the type level, REQUIRED in the real
 * graph" needs a guard, and this is it. Checks the tokens NestJS actually
 * resolves: no container, no database, no Redis.
 */

const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';
const PARAMTYPES_METADATA = 'design:paramtypes';
const MODULE_IMPORTS_METADATA = 'imports';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reflect metadata is untyped
function effectiveConstructorTokens(target: any): unknown[] {
  const tokens: unknown[] = [...((Reflect.getMetadata(PARAMTYPES_METADATA, target) as unknown[]) ?? [])];
  const selfDeclared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) as { index: number; param: unknown }[]) ?? [];
  for (const { index, param } of selfDeclared) {
    tokens[index] = param;
  }
  return tokens;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reflect metadata is untyped
function moduleImports(target: any): unknown[] {
  return (Reflect.getMetadata(MODULE_IMPORTS_METADATA, target) as unknown[]) ?? [];
}

const CALLERS: Array<[name: string, service: unknown, module: unknown]> = [
  ['LiveDocumentationService', LiveDocumentationService, LiveDocumentationServiceModule],
  ['PreSummaryProcessor', PreSummaryProcessor, ConsultationJobServiceModule],
  ['SummaryService', SummaryService, SummaryServiceModule],
  ['DnaWritingStyleProcessor', DnaWritingStyleProcessor, DnaWritingStyleServiceModule],
];

describe('TextRequestEnrichmentService resolves for every repaired TEXT caller', () => {
  for (const [name, service, module] of CALLERS) {
    it(`${name} injects TextRequestEnrichmentService`, () => {
      expect(effectiveConstructorTokens(service)).toContain(TextRequestEnrichmentService);
    });

    it(`${name}'s module imports TextRequestServiceModule, so the token resolves at boot`, () => {
      expect(
        moduleImports(module),
        'without this import the @Optional() injection resolves to undefined and every /generate call ' +
          'silently reverts to posting no provider_overrides — TEXT then 503s with PROVIDER_CREDENTIALS_MISSING.',
      ).toContain(TextRequestServiceModule);
    });
  }
});

describe('the known-PHI egress statement resolves in the real graph', () => {
  it('TextRequestEnrichmentService injects KnownPhiService', () => {
    expect(effectiveConstructorTokens(TextRequestEnrichmentService)).toContain(KnownPhiService);
  });

  it('TextRequestServiceModule provides and exports KnownPhiService', () => {
    expect(Reflect.getMetadata('providers', TextRequestServiceModule) as unknown[]).toContain(KnownPhiService);
    expect(Reflect.getMetadata('exports', TextRequestServiceModule) as unknown[]).toContain(KnownPhiService);
  });
});
