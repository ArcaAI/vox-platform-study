/**
 *  — the REALTIME lane carries per-node model selection.
 *
 * The durable interpreter reads `config.llmBinding` straight off `payload.config`, because a
 * Temporal activity IS handed its node's config. The realtime lane's handlers are handed one too
 * (`RealtimeNodeRunContext.config`), but only two of the four generation handlers were passing it
 * on to the capability that actually calls `apps/text` — so a binding authored on
 * `consultation.realtimeSummary` had no route to the call at all.
 *
 * These tests hold the ROUTE open. What the service then does with the binding is
 * `harness-policy.llm-binding.task816.test.ts`'s subject; what matters here is that the node's own
 * config reaches the capability boundary, because `config` is the ONLY thing that distinguishes
 * one instance of a node type from another (`RealtimeNodeRunContext`'s own docstring: "resolving
 * it from anything but the node would make one node's config govern another's call").
 */
import { describe, expect, it, vi } from 'vitest';
import { REALTIME_NODE_HANDLERS, type RealtimeCapabilities } from '../realtime-node-registry';

const capabilities = (over: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities =>
  ({
    transcribe: vi.fn().mockResolvedValue({ transcript: 'raw transcript', pipelineId: null }),
    generateDocument: vi.fn().mockResolvedValue({ text: 'note', sections: [], stats: null, repaired: false }),
    extractEntities: vi.fn().mockResolvedValue({ entities: [], vitals: undefined }),
    proposeCorrections: vi.fn().mockResolvedValue({ proposals: [], textSha256: '', rejectedProposals: 0 }),
    extractFindings: vi.fn().mockResolvedValue({ findings: [] }),
    ...over,
  }) as RealtimeCapabilities;

const ctx = (bound: Record<string, unknown>, caps: RealtimeCapabilities, config: Record<string, unknown>) =>
  ({ bound, config, tenantId: 'tenant-1', consultationId: 'consultation-1', capabilities: caps }) as never;

const BOUND = { llmBinding: { modelSlug: 'tenant-medgemma' }, taskKey: 'text.live' };

describe('every generation handler hands its node config to the capability', () => {
  it('consultation.realtimeSummary passes its config to generateDocument', async () => {
    const caps = capabilities();
    await REALTIME_NODE_HANDLERS['consultation.realtimeSummary'].run(ctx({ in: 'patient said something' }, caps, BOUND));

    expect(caps.generateDocument).toHaveBeenCalledWith(expect.objectContaining({ config: BOUND }), undefined);
  });

  it('agent.grammar passes its config to proposeCorrections', async () => {
    const caps = capabilities();
    await REALTIME_NODE_HANDLERS['agent.grammar'].run(ctx({ in: 'patient said something' }, caps, BOUND));

    expect(caps.proposeCorrections).toHaveBeenCalledWith(expect.objectContaining({ config: BOUND }), undefined);
  });

  it('agent.important_findings passes its config to extractFindings', async () => {
    const caps = capabilities();
    await REALTIME_NODE_HANDLERS['agent.important_findings'].run(ctx({ in: 'patient said something' }, caps, BOUND));

    expect(caps.extractFindings).toHaveBeenCalledWith(expect.objectContaining({ config: BOUND }), undefined);
  });

  it('an UNBOUND node still hands its config through — absence is decided downstream, not here', () => {
    // The handler must not filter: `readLlmBindingFromConfig` is the ONE place "no binding" is
    // decided, so a handler that pre-screened would be a second, divergent copy of that rule.
    const caps = capabilities();
    return REALTIME_NODE_HANDLERS['consultation.realtimeSummary']
      .run(ctx({ in: 'text' }, caps, { taskKey: 'text.live' }))
      .then(() => {
        expect(caps.generateDocument).toHaveBeenCalledWith(expect.objectContaining({ config: { taskKey: 'text.live' } }), undefined);
      });
  });
});
