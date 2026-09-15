/**
 * TASK-972 — the four new DI edges, asserted as RESOLUTION rather than as import lines.
 *
 * Every dependency this ticket adds is `@Optional()`, which is the right posture for a service
 * constructed positionally in a long tail of fixtures — and is also exactly how a load-bearing
 * dependency goes missing in production without anything failing. Each of these four resolves to
 * `undefined` in a graph that forgets the import, and each has a silent consequence:
 *
 *  - no `IWorkflowExposureService`      ⇒ a Substrate-B sign-off releases nothing (the H3-6 defect);
 *  - no `WorkflowDefinitionRepository`  ⇒ the review node cannot be found, same outcome;
 *  - no `ConfigResolver` in the miner   ⇒ an opted-out clinician is mined anyway;
 *  - no `EffectiveSettingsService`      ⇒ the tenant's training-capture gate answers its default
 *                                         for every tenant, so switching it OFF does nothing.
 *
 * The last spec is the one that cannot be recovered from later: Nest resolves a circular module
 * graph as `undefined` rather than as an error, so a cycle introduced by these imports would
 * present as the very silence above.
 */
import { describe, it, expect } from 'vitest';
import { UserDepartmentRepository, UserRepository, UserRoleAssignmentRepository, WorkflowDefinitionRepository } from '@arcaai/domains';
import { SummaryServiceModule } from '../summary.service.module';
import { GateEditMiningServiceModule } from '../../../gate-edit-mining/gate-edit-mining.service.module';
import { IWorkflowExposureService } from '../../../workflow-exposure/IWorkflowExposureService';
import { MODULE_IMPORTS_METADATA, metadata, resolvableTokens } from '../../../gate-edit-mining/__tests__/module-graph.helper';

describe('SummaryServiceModule — TASK-972 wiring', () => {
  const tokens = resolvableTokens(SummaryServiceModule);

  it('resolves IWorkflowExposureService (Lane 3 — releasing the governing run`s review)', () => {
    expect(tokens.has(IWorkflowExposureService)).toBe(true);
  });

  it('resolves WorkflowDefinitionRepository (Lane 3 — finding the graph`s review node)', () => {
    expect(tokens.has(WorkflowDefinitionRepository)).toBe(true);
  });

  it('resolves the three membership repositories (Lane 1 — the named-clinician rule)', () => {
    expect(tokens.has(UserRoleAssignmentRepository)).toBe(true);
    expect(tokens.has(UserDepartmentRepository)).toBe(true);
    expect(tokens.has(UserRepository)).toBe(true);
  });
});

// The Lane-2 wiring (GateEditMiningServiceModule → ConfigResolverModule → EffectiveSettingsModule)
// is asserted in `gate-edit-mining/__tests__/gate-edit-mining.di-wiring.task972.test.ts` and NOT
// here, deliberately. Importing `SummaryServiceModule` puts `config-resolver/index.ts` in flight
// (through `summary.service.ts`), and a module whose import of `ConfigResolverModule` is resolved
// during that window reads the binding as `undefined` — a pre-existing property of this barrel
// that `NoteGenerationServiceModule` and `ChainSummaryServiceModule` exhibit identically and that
// has nothing to do with this ticket. Asserting it from a file with no such import measures the
// wiring instead of the load order.

describe('the module import graph stays loadable', () => {
  /**
   * The failure mode a cycle actually produces. An ES module that is still evaluating hands back
   * an uninitialised binding, so a `@Module({ imports: [...] })` decorator captures `undefined`
   * where a module class should be — and Nest refuses to create a module whose imports array
   * contains one, which is a BOOT failure rather than a degraded read. Asserted for the two
   * modules this ticket adds an import to.
   */
  const undefinedImports = (m: unknown) => metadata(m, MODULE_IMPORTS_METADATA).filter((x) => x === undefined);

  it('SummaryServiceModule imports nothing uninitialised after adding WorkflowExposureServiceModule', () => {
    expect(undefinedImports(SummaryServiceModule)).toEqual([]);
  });

  it('GateEditMiningServiceModule imports nothing uninitialised', () => {
    expect(undefinedImports(GateEditMiningServiceModule)).toEqual([]);
  });

  /** Depth-first walk over `imports`, returning the first cycle found as a name path. */
  const findCycle = (root: unknown): string[] | null => {
    const path: unknown[] = [];
    const onPath = new Set<unknown>();
    const done = new Set<unknown>();

    const visit = (node: unknown): string[] | null => {
      if (onPath.has(node)) {
        const from = path.indexOf(node);
        return [...path.slice(from), node].map((m) => (m as { name?: string })?.name ?? String(m));
      }
      if (done.has(node) || !node) return null;
      onPath.add(node);
      path.push(node);
      for (const imported of metadata(node, MODULE_IMPORTS_METADATA)) {
        // A DynamicModule (BullModule.registerQueue, RedisCacheModule.register) has no class
        // identity to cycle through; its own `imports` are still walked by `metadata`.
        const found = visit(typeof imported === 'object' && imported !== null ? ((imported as { module?: unknown }).module ?? imported) : imported);
        if (found) return found;
      }
      path.pop();
      onPath.delete(node);
      done.add(node);
      return null;
    };

    return visit(root);
  };

  it('from SummaryServiceModule, after adding WorkflowExposureServiceModule', () => {
    expect(findCycle(SummaryServiceModule)).toBeNull();
  });

  it('from GateEditMiningServiceModule, after adding ConfigResolverModule', () => {
    expect(findCycle(GateEditMiningServiceModule)).toBeNull();
  });
});
