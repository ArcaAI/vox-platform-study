/**
 * TASK-876 — `core.agent` on the realtime lane is AGENT-FIRST.
 *
 * The defect: `CoreAgentHandler.run` forwarded only the node's `config` to `generateDocument`,
 * whose doc comment claimed the host service resolved `agentRef` — and nothing did. A bound
 * agent's model, instruction, prompt pin and parameters were ignored on the live lane; the
 * flush generated on the tenant `text.live` default with the session's frozen prompt.
 *
 * The handler now hands the host the REFERENCE it must resolve: `agentRef.slug` plus the
 * optional version pin, read off the node's own config. Resolution (explicit slug + pin, fail
 * closed on drift, else the assigned agent) is the host's — `live-documentation.core-agent.task876.test.ts`.
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

  it('the legacy summary node carries NO agentRef — it stays on the assigned-agent path', async () => {
    const caps = capabilities();
    await REALTIME_NODE_HANDLERS['consultation.realtimeSummary'].run(ctx({ in: 'text' }, caps, {}));
    const [input] = (caps.generateDocument as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.agentRef).toBeUndefined();
  });
});
