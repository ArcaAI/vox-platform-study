/**
 * R7's definition of done, per PATH.
 *
 * `gate-edit-loop.e2e.test.ts` already proves the loop end to end ONCE. What it
 * cannot show is that the loop is reachable from every place the product actually
 * generates a note — and that was precisely R7's failure mode: the seam was
 * correct, and two of the four callers could not reach it.
 *
 * There are exactly four modules that provide `PromptAssemblyService` for live
 * generation, and they are DISCOVERED here rather than listed:
 *
 *   SummaryServiceModule — the legacy synchronous generate/approve path
 *   ChainSummaryServiceModule — the pre-summary / comprehensive chain
 * ConsultationJobServiceModule — the ASYNC job path; since this is the
 *                                   PRIMARY "Generate" route in the console
 *   HarnessInternalServiceModule — the harness gate-adapter path
 *
 * For each one this suite asserts BOTH halves of "an exemplar reaches the prompt":
 *
 *   1. the token that module resolves is the REAL `GateEditMiningService`, not
 *      some other implementation and not `undefined`;
 *   2. driving a real `PromptAssemblyService` with a real `GateEditMiningService`
 *      over a store holding one `APPROVED_CLEAN` row puts that row's REDACTED text
 *      into the assembled prompt.
 *
 * (1) is per-path and structural; (2) is behavioural and shared, because the class
 * under test is the same one in all four containers — the only thing that ever
 * differed between them was whether the token resolved.
 */
import { describe, expect, it, vi } from 'vitest';
import '../../../index';
import { PromptAssemblyService } from '../../consultation/prompt/prompt-assembly.service';
import { GateEditMiningService } from '../gate-edit-mining.service';
import { IGateEditExemplarRetriever } from '../IGateEditExemplarRetriever';
import { modulesProviding, resolveProviderDefinition } from './module-graph.helper';

const TENANT = 'tenant-r7';
const REDACTED_NOTE =
  'S: [REDACTED] reports intermittent chest pain for three days. ' +
  'O: Blood pressure 130/80, heart rate 72. ' +
  'A: Stable angina. ' +
  'P: Start aspirin, review in one week.';

const cls = () => ({ get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : undefined)) });

/** A mining service over a store holding exactly one clean, redacted exemplar. */
function realRetrieverOverOneCleanExemplar() {
  const findTopForRetrieval = vi.fn(async () => [
    { tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN', redactedAfter: REDACTED_NOTE, redactedBefore: 'irrelevant' },
  ]);
  const service = new GateEditMiningService(
    { findTopForRetrieval } as never,
    { emit: vi.fn() } as never,
    cls() as never,
    { redact: vi.fn() } as never,
  );
  return { service, findTopForRetrieval };
}

function realPromptAssembly(retriever: unknown) {
  return new PromptAssemblyService(
    { resolve: vi.fn().mockResolvedValue({ promptId: null, content: 'Summarize the transcript.', resolvedFrom: 'default' }) } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never,
    { get: vi.fn() } as never,
    { getEffectivePolicy: vi.fn().mockResolvedValue({ warmStartEnabled: false }) } as never,
    cls() as never,
    retriever as never,
  );
}

describe('R7 — an APPROVED_CLEAN exemplar reaches an assembled prompt on every generation path', () => {
  it('finds the four live-generation providers of PromptAssemblyService', async () => {
    const names = (await modulesProviding(PromptAssemblyService)).map(([name]) => name).sort();

    expect(names).toEqual([
      'ChainSummaryServiceModule',
      'ConsultationJobServiceModule',
      'HarnessInternalServiceModule',
      'SummaryServiceModule',
    ]);
  });

  it('every path resolves IGateEditExemplarRetriever to the real GateEditMiningService', async () => {
    const paths = await modulesProviding(PromptAssemblyService);
    expect(paths.length).toBe(4);

    for (const [name, moduleClass] of paths) {
      const definition = resolveProviderDefinition(moduleClass, IGateEditExemplarRetriever) as { useExisting?: unknown } | undefined;

      expect(definition, `${name} does not resolve IGateEditExemplarRetriever at all`).toBeDefined();
      // `useExisting`, not `useClass` — the read half must share the ONE instance the
      // write half mines into, or retrieval would read a second, empty service.
      expect(definition?.useExisting, `${name} resolves the retriever to the wrong implementation`).toBe(GateEditMiningService);
    }
  });

  it('injects the exemplar text into the prompt when the token is wired (all four paths)', async () => {
    const { service, findTopForRetrieval } = realRetrieverOverOneCleanExemplar();

    const assembled = await realPromptAssembly(service).assemble({
      tenantId: TENANT,
      departmentId: null,
      promptType: 'SUMMARY',
      transcript: 'Doctor: what brings you in today?',
    } as never);

    expect(assembled.userPrompt).toContain('STYLE REFERENCE');
    expect(assembled.userPrompt).toContain('review in one week.');
    expect(findTopForRetrieval).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN' }));
  });

  it('produces the pre-R7 zero-shot prompt when the token is NOT wired — the exact silent defect', async () => {
    // The control. This is what ConsultationJobServiceModule and
    // HarnessInternalServiceModule produced before this ticket: a valid prompt,
    // no error, no log, no exemplar.
    const assembled = await realPromptAssembly(undefined).assemble({
      tenantId: TENANT,
      departmentId: null,
      promptType: 'SUMMARY',
      transcript: 'Doctor: what brings you in today?',
    } as never);

    expect(assembled.userPrompt).not.toContain('STYLE REFERENCE');
    expect(assembled.userPrompt).not.toContain('review in one week.');
  });
});
