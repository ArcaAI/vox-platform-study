/**
 * TASK-811 tasks 7 and 14 — the realtime NODE REGISTRY.
 *
 * Task 7: `LIVE_TOOL_KEYS` was a three-boolean allow-list (D-13). Three booleans
 * cannot express "run this node, bound to that port, with this budget, degrading
 * that way", which is exactly why a tenant could author a graph and have it
 * govern nothing. Here a node runs because the LANE contains it.
 *
 * Task 14: `consultation.captureBinding` becomes a REAL producer of `transcript`,
 * which is what makes `consultation.extractEntities`' required input satisfiable
 * — the open item TASK-809 §2y1 records.
 */
import { describe, it, expect, vi } from 'vitest';
import { NODE_PORTS, portPrimitiveSatisfies, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { REALTIME_NODE_HANDLERS, REALTIME_NODE_TYPES, realtimeHandlerFor, type RealtimeCapabilities } from '../realtime-node-registry';
import { LIVE_TOOL_KEYS } from '../../../../departmentAgent/constants';

const capabilities = (over: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities => ({
  transcribe: vi.fn().mockResolvedValue({ transcript: 'raw transcript', pipelineId: 'pipeline-7' }),
  generateDocument: vi.fn().mockResolvedValue({ text: 'note', sections: [], stats: null, repaired: false }),
  extractEntities: vi.fn().mockResolvedValue({ entities: [{ text: 'aspirin', type: 'MEDICATION' }], vitals: { systolic: 120 } }),
  ...over,
});

const ctx = (bound: Record<string, unknown>, caps = capabilities()) => ({
  bound,
  tenantId: 'tenant-1',
  consultationId: 'consultation-1',
  capabilities: caps,
});

describe('task 7 — LIVE_TOOL_KEYS is no longer the dispatch mechanism', () => {
  it('every realtime node type is a REGISTERED workflow node, not an invented key', () => {
    for (const type of REALTIME_NODE_TYPES) {
      expect(WORKFLOW_NODE_REGISTRY[type], type).toBeDefined();
      expect(WORKFLOW_NODE_REGISTRY[type].paletteKey).toBe('consultation');
    }
  });

  it('every handler declares the ports the CONTRACT declares — this file cannot widen them', () => {
    for (const [type, handler] of Object.entries(REALTIME_NODE_HANDLERS)) {
      expect(handler.inputs).toBe(NODE_PORTS[type].inputs);
      expect(handler.outputs).toBe(NODE_PORTS[type].outputs);
    }
  });

  it('`vitals` remains a PROJECTION of the extraction response, not a node of its own', () => {
    // The three legacy keys are still the tool vocabulary; what changed is that
    // they no longer DECIDE what runs.
    expect(LIVE_TOOL_KEYS).toEqual(['ner', 'vitals', 'groundedness']);
    expect([...REALTIME_NODE_TYPES]).not.toContain('consultation.vitals');
  });

  it('an unregistered type resolves to no handler — the executor skips it rather than guessing', () => {
    expect(realtimeHandlerFor('consultation.persistDraft')).toBeUndefined();
    expect(realtimeHandlerFor('made.up')).toBeUndefined();
  });

  it('extraction makes ONE call and projects both blocks off it', async () => {
    const caps = capabilities();
    const output = await REALTIME_NODE_HANDLERS['consultation.extractEntities'].run(ctx({ in: 'patient takes aspirin' }, caps));

    expect(caps.extractEntities).toHaveBeenCalledTimes(1);
    expect(output).toEqual({ entities: [{ text: 'aspirin', type: 'MEDICATION' }], vitals: { systolic: 120 } });
  });

  it('extraction with NO bound transcript makes no call and fabricates nothing', async () => {
    const caps = capabilities();
    const output = await REALTIME_NODE_HANDLERS['consultation.extractEntities'].run(ctx({}, caps));

    expect(caps.extractEntities).not.toHaveBeenCalled();
    expect(output).toEqual({ entities: [] });
  });
});

describe('task 14 — captureBinding is a REAL producer of `transcript` (TASK-809 §2y1)', () => {
  it('publishes the transcript under the `outputKey` its declared port names', async () => {
    const port = NODE_PORTS['consultation.captureBinding'].outputs.find((p) => p.name === 'out');
    expect(port).toMatchObject({ primitive: 'transcript', outputKey: 'transcript' });

    const output = await REALTIME_NODE_HANDLERS['consultation.captureBinding'].run(ctx({}));

    // The declaration is KEPT: the key the port names is the key the node emits.
    expect(output).toHaveProperty(port!.outputKey!);
    expect(output.transcript).toBe('raw transcript');
  });

  it('carries the AsrPipeline binding alongside the transcript', async () => {
    const output = await REALTIME_NODE_HANDLERS['consultation.captureBinding'].run(ctx({}));
    expect(output.pipelineId).toBe('pipeline-7');
  });

  it("SATISFIES extractEntities' required input — the palette now has a transcript producer", () => {
    const produced = NODE_PORTS['consultation.captureBinding'].outputs.find((p) => p.name === 'out')!;
    const consumed = NODE_PORTS['consultation.extractEntities'].inputs.find((p) => p.name === 'in')!;

    expect(consumed.required).toBe(true);
    expect(portPrimitiveSatisfies(produced.primitive as never, consumed.primitive as never)).toBe(true);
  });

  it('and a GENERATION node still does not — the invariant is unaffected by task 14', () => {
    const generated = NODE_PORTS['consultation.realtimeSummary'].outputs.find((p) => p.name === 'out')!;
    const consumed = NODE_PORTS['consultation.extractEntities'].inputs.find((p) => p.name === 'in')!;

    expect(generated.primitive).toBe('document');
    expect(portPrimitiveSatisfies(generated.primitive as never, consumed.primitive as never)).toBe(false);
  });
});
