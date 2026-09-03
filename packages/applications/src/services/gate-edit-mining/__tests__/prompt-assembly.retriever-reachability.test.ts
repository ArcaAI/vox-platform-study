/**
 * the regression guard for R7.
 *
 * R7 shipped half-done TWICE for the same reason: the list of modules that
 * provide `PromptAssemblyService` for live generation was a four-line MANUAL
 * checklist in a code comment. Two of the four were wired, two were not, every
 * unit test stayed green (they all construct the service positionally), and the
 * most-used generation path in the console silently degraded to zero-shot.
 *
 * So the checklist is DISCOVERED here, not written down. This suite walks every
 * `*.module.ts` in the package, finds the ones whose `providers` include
 * `PromptAssemblyService`, and asserts `IGateEditExemplarRetriever` is actually
 * resolvable from each one's import closure. A fifth provider added tomorrow is
 * covered the moment it exists — nobody has to remember to add it to a list.
 *
 * ── WHY REACHABILITY IS COMPUTED, NOT ASSUMED ───────────────────────────────
 *
 * NestJS does not make a grandchild module's exports visible: importing
 * `ChainSummaryServiceModule` (which imports `GateEditMiningServiceModule`) does
 * NOT give you the retriever token, because `ChainSummaryServiceModule` exports
 * only `ChainSummaryService`. The walker below therefore follows a module's
 * `exports` — where a re-exported MODULE does propagate — and never its
 * `imports`. Asserting "the module lists GateEditMiningServiceModule" would be a
 * weaker test that a legitimate re-export refactor would falsely fail.
 */
import { describe, expect, it } from 'vitest';
// Barrel first — `services/index.ts` participates in a pre-existing import
// cycle, so a deep file loaded first leaves some `imports` entries `undefined`
// at decoration time. The real application loads the barrel; so does this suite.
import '../../../index';
import { PromptAssemblyService } from '../../consultation/prompt/prompt-assembly.service';
import { IGateEditExemplarRetriever } from '../IGateEditExemplarRetriever';
import { exportedTokens, modulesProviding, resolvableTokens } from './module-graph.helper';

describe('R7 guard — every live-generation PromptAssemblyService can reach the exemplar retriever', () => {
  it('discovers the providers rather than trusting a hand-maintained list', async () => {
    const found = await modulesProviding(PromptAssemblyService);

    // Not a magic number to keep in sync: it asserts the DISCOVERY works at all.
    // If it ever returns 0, every assertion below would vacuously pass.
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it('resolves IGateEditExemplarRetriever in EVERY module that provides PromptAssemblyService', async () => {
    const found = await modulesProviding(PromptAssemblyService);

    const unwired = found
      .filter(([, moduleClass]) => !resolvableTokens(moduleClass).has(IGateEditExemplarRetriever))
      .map(([name]) => name);

    expect(unwired, `these modules provide PromptAssemblyService but cannot resolve IGateEditExemplarRetriever, so they silently generate zero-shot: ${unwired.join(', ')}`).toEqual([]);
  });

  it('the reachability walker does NOT accept a grandchild import as resolution', async () => {
    // Guards the guard: `ChainSummaryServiceModule` imports `GateEditMiningServiceModule`
    // but exports only `ChainSummaryService`, so importing IT must not count.
    const { ChainSummaryServiceModule } = await import('../../consultation/summary/chain-summary.service.module');

    expect(exportedTokens(ChainSummaryServiceModule).has(IGateEditExemplarRetriever)).toBe(false);
  });
});
