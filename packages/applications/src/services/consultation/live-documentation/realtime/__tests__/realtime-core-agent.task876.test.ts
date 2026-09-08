/**
 * TASK-876 — `core.agent` on the realtime lane is AGENT-FIRST: the handler hands the host the
 * REFERENCE it must resolve (`agentRef.slug` + optional version pin) and never substitutes a
 * tenant default. Since TASK-893 the same reference also decides the TASK the node runs as
 * (`realtime-node-registry.test.ts`); this file keeps the reference-forwarding contract pinned.
 */
import { describe, expect, it, vi } from 'vitest';
import { REALTIME_NODE_HANDLERS, realtimeHandlerFor, type RealtimeCapabilities } from '../realtime-node-registry';

const capabilities = (over: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities => ({
  transcribe: vi.fn().mockResolvedValue({ transcript: 'raw transcript', pipelineId: null }),
  generateDocument: vi.fn().mockResolvedValue({ text: 'note', sections: [], stats: null, repaired: false }),
  extractEntities: vi.fn().mockResolvedValue({ entities: [], vitals: undefined }),
  proposeCorrections: vi.fn().mockResolvedValue({ proposals: [], textSha256: '', rejectedProposals: 0 }),
  extractFindings: vi.fn().mockResolvedValue({ findings: [] }),
  ...over,
});

const ctx = (bound: Record<string, unknown>, caps: RealtimeCapabilities, config: Record<string, unknown>) =>
  ({ bound, config, tenantId: 'tenant-1', consultationId: 'consultation-1', capabilities: caps }) as never;

describe('core.agent hands its agentRef to the host', () => {
  it('passes slug + version pin from its own config, alongside the config itself', async () => {
    const caps = capabilities();
    const config = { agentRef: { slug: 'clinic-summarizer', versionNumber: 3 }, execution: { lane: 'realtime' }, overrides: { promptVariables: { tone: 'terse' } } };
    await REALTIME_NODE_HANDLERS['core.agent'].run(ctx({ in: 'patient said something' }, caps, config));

    expect(caps.generateDocument).toHaveBeenCalledWith(
      { sourceText: 'patient said something', tenantId: 'tenant-1', config, agentRef: { slug: 'clinic-summarizer', versionNumber: 3 } },
      undefined,
    );
  });

  it('an unpinned reference carries the slug alone (the host resolves the ACTIVE published version)', async () => {
    const caps = capabilities();
    await realtimeHandlerFor('core.agent')!.run(ctx({ in: 'said so far' }, caps, { agentRef: { slug: 'platform-summarization' } }));
    expect(caps.generateDocument).toHaveBeenCalledWith(expect.objectContaining({ agentRef: { slug: 'platform-summarization' } }), undefined);
  });

  it('refuses to run without a slug — the executor degrades the node with a named reason, never the tenant default', async () => {
    const caps = capabilities();
    await expect(REALTIME_NODE_HANDLERS['core.agent'].run(ctx({ in: 'x' }, caps, { agentRef: {} }))).rejects.toThrow(/agentRef\.slug/);
    await expect(REALTIME_NODE_HANDLERS['core.agent'].run(ctx({ in: 'x' }, caps, {}))).rejects.toThrow(/agentRef\.slug/);
    expect(caps.generateDocument).not.toHaveBeenCalled();
  });
});
