/**
 * TASK-893 §7.4 — the realtime node registry keyed by what a node IS.
 *
 * Every realtime node is a `core.agent` (dispatching on its RESOLVED task) or a `core.action`
 * (dispatching through `ACTION_CATALOGUE[key].lane`). Nothing here is keyed by a legacy type
 * string, and an outcome carries the CAPABILITY it ran so a projection never has to be.
 */
import { describe, it, expect, vi } from 'vitest';
import { ACTION_CATALOGUE, NODE_PORTS, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import {
  REALTIME_ACTION_HANDLERS,
  REALTIME_ACTION_KEYS,
  REALTIME_NODE_HANDLERS,
  REALTIME_NODE_TYPES,
  readAgentRef,
  realtimeHandlerFor,
  type RealtimeCapabilities,
  type RealtimeResolvedAgentView,
} from '../realtime-node-registry';

const capabilities = (over: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities => ({
  transcribe: vi.fn().mockResolvedValue({ transcript: 'raw transcript', pipelineId: 'pipeline-7' }),
  generateDocument: vi.fn().mockResolvedValue({ text: 'note', sections: [], stats: null, repaired: false }),
  extractEntities: vi.fn().mockResolvedValue({ entities: [{ text: 'aspirin', type: 'MEDICATION' }], vitals: { systolic: 120 } }),
  proposeCorrections: vi.fn().mockResolvedValue({ proposals: [], textSha256: '', rejectedProposals: 0 }),
  extractFindings: vi.fn().mockResolvedValue({ findings: [] }),
  ...over,
});

const resolving = (view: Partial<RealtimeResolvedAgentView> & Pick<RealtimeResolvedAgentView, 'task'>) =>
  capabilities({ resolveAgent: vi.fn().mockResolvedValue({ slug: 'agent-x', ...view }) });

const ctx = (bound: Record<string, unknown>, caps: RealtimeCapabilities, config: Record<string, unknown>) => ({
  bound,
  config,
  tenantId: 'tenant-1',
  consultationId: 'consultation-1',
  capabilities: caps,
});

const agent = REALTIME_NODE_HANDLERS['core.agent'];

describe('the handler tables are keyed by the core vocabulary only', () => {
  it('no registered TYPE is realtime any more — lane is a property of the instance', () => {
    expect([...REALTIME_NODE_TYPES]).toEqual([]);
    expect(Object.keys(REALTIME_NODE_HANDLERS)).toEqual(['core.agent']);
    for (const type of Object.keys(REALTIME_NODE_HANDLERS)) expect(WORKFLOW_NODE_REGISTRY[type].paletteKey).toBe('core');
  });

  it('every handler declares the ports the CONTRACT declares — this file cannot widen them', () => {
    for (const [type, handler] of Object.entries(REALTIME_NODE_HANDLERS)) {
      expect(handler.inputs).toBe(NODE_PORTS[type].inputs);
      expect(handler.outputs).toBe(NODE_PORTS[type].outputs);
    }
  });

  it('the action handler table is TOTAL over the catalogue`s realtime actions (none today)', () => {
    expect(REALTIME_ACTION_KEYS).toEqual(Object.values(ACTION_CATALOGUE).filter((a) => a.lane === 'realtime').map((a) => a.key));
    for (const key of REALTIME_ACTION_KEYS) expect(REALTIME_ACTION_HANDLERS[key], key).toBeDefined();
    for (const key of Object.keys(REALTIME_ACTION_HANDLERS)) expect(ACTION_CATALOGUE[key]?.lane).toBe('realtime');
  });

  it('a durable action, an unknown action and an unregistered type resolve to no handler — skipped, never guessed', () => {
    expect(realtimeHandlerFor('core.action', { actionKey: 'consultation.persistDraft' })).toBeUndefined();
    expect(realtimeHandlerFor('core.action', { actionKey: 'agent.ner' })).toBeUndefined();
    expect(realtimeHandlerFor('consultation.extractEntities')).toBeUndefined();
    expect(realtimeHandlerFor('made.up')).toBeUndefined();
  });
});

describe('core.agent dispatches on the RESOLVED task (§7.4)', () => {
  it('SPEECH_TO_TEXT binds the live transcript under the `transcript` socket`s key', async () => {
    const caps = resolving({ task: 'SPEECH_TO_TEXT' });
    const run = await agent.run(ctx({}, caps, { agentRef: { slug: 'realtime-transcription' } }));
    expect(run.capability).toBe('transcribe');
    expect(run.output).toEqual({ transcript: 'raw transcript', pipelineId: 'pipeline-7' });
    expect(caps.resolveAgent).toHaveBeenCalledWith({ slug: 'realtime-transcription' }, undefined);
    expect(caps.generateDocument).not.toHaveBeenCalled();
  });

  it('NAMED_ENTITY_RECOGNITION extracts over the bound `in` text: data = { entities }, text passed through', async () => {
    const caps = resolving({ task: 'NAMED_ENTITY_RECOGNITION' });
    const run = await agent.run(ctx({ in: 'patient takes aspirin' }, caps, { agentRef: { slug: 'medical-ner' } }));
    expect(run.capability).toBe('extractEntities');
    expect(caps.extractEntities).toHaveBeenCalledWith({ sourceText: 'patient takes aspirin', tenantId: 'tenant-1' }, undefined);
    expect(run.output.data).toEqual({ entities: [{ text: 'aspirin', type: 'MEDICATION' }] });
    expect(run.output.text).toBe('patient takes aspirin');
    // `vitals` rides on the SAME response — a projection, not a second call.
    expect(run.output.vitals).toEqual({ systolic: 120 });
  });

  it('NER with NO bound text makes no call and fabricates nothing', async () => {
    const caps = resolving({ task: 'NAMED_ENTITY_RECOGNITION' });
    const run = await agent.run(ctx({}, caps, { agentRef: { slug: 'medical-ner' } }));
    expect(caps.extractEntities).not.toHaveBeenCalled();
    expect(run.output).toEqual({ data: { entities: [] }, text: '', entities: [] });
  });

  it('TEXT_GENERATION generates the running note and hands the host the agentRef', async () => {
    const caps = resolving({ task: 'TEXT_GENERATION' });
    const config = { agentRef: { slug: 'clinic-summarizer', versionNumber: 3 }, execution: { lane: 'realtime' } };
    const run = await agent.run(ctx({ in: 'said so far' }, caps, config));
    expect(run.capability).toBe('generateDocument');
    expect(caps.generateDocument).toHaveBeenCalledWith(
      { sourceText: 'said so far', tenantId: 'tenant-1', config, agentRef: { slug: 'clinic-summarizer', versionNumber: 3 } },
      undefined,
    );
    expect(run.output.text).toBe('note');
  });

  it('applies the agent`s declared output schema as a strict JSON-schema response format (contract N4)', async () => {
    const outputSchema = { type: 'object', properties: { case_note: { type: 'string' }, redactions: { type: 'array' } }, required: ['case_note'] };
    const caps = resolving({ task: 'TEXT_GENERATION', slug: 'casenote-finalization', outputSchema, parameters: null });
    await agent.run(ctx({ in: 'x' }, caps, { agentRef: { slug: 'casenote-finalization' } }));
    expect(caps.generateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: { type: 'json_schema', json_schema: { name: 'casenote_finalization_output', schema: outputSchema, strict: true } } }),
      undefined,
    );
  });

  it('sends NO response format for the task-default output, and never when parameters.responseFormat is set', async () => {
    const byDefault = resolving({ task: 'TEXT_GENERATION', outputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
    await agent.run(ctx({ in: 'x' }, byDefault, { agentRef: { slug: 'a' } }));
    expect((byDefault.generateDocument as ReturnType<typeof vi.fn>).mock.calls[0][0].responseFormat).toBeUndefined();

    const explicit = resolving({ task: 'TEXT_GENERATION', outputSchema: { type: 'object', properties: { note: {} } }, parameters: { responseFormat: { type: 'json_object' } } });
    await agent.run(ctx({ in: 'x' }, explicit, { agentRef: { slug: 'a' } }));
    expect((explicit.generateDocument as ReturnType<typeof vi.fn>).mock.calls[0][0].responseFormat).toBeUndefined();
  });

  it('falls back to TEXT_GENERATION when the host cannot resolve the task — today`s behaviour, unchanged', async () => {
    const caps = capabilities();
    const run = await agent.run(ctx({ in: 'said so far' }, caps, { agentRef: { slug: 'platform-summarization' } }));
    expect(run.capability).toBe('generateDocument');
    expect(caps.generateDocument).toHaveBeenCalledWith(expect.objectContaining({ agentRef: { slug: 'platform-summarization' } }), undefined);
  });

  it('a task-form reference (the platform lane) dispatches WITHOUT resolving — the assigned agent is the host`s to pick', async () => {
    const caps = capabilities({ resolveAgent: vi.fn() });
    const run = await agent.run(ctx({}, caps, { agentRef: { task: 'SPEECH_TO_TEXT' } }));
    expect(caps.resolveAgent).not.toHaveBeenCalled();
    expect(run.capability).toBe('transcribe');
    expect(readAgentRef({ agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } })).toEqual({ task: 'NAMED_ENTITY_RECOGNITION' });
    expect(readAgentRef({ agentRef: { task: 'nope' } })).toBeNull();
  });

  it('refuses to run without a reference, and refuses a TEXT_TO_SPEECH agent — named reasons, never a substituted default', async () => {
    const caps = resolving({ task: 'TEXT_TO_SPEECH' });
    await expect(agent.run(ctx({ in: 'x' }, caps, { agentRef: {} }))).rejects.toThrow(/agentRef\.slug/);
    await expect(agent.run(ctx({ in: 'x' }, caps, {}))).rejects.toThrow(/agentRef\.slug/);
    await expect(agent.run(ctx({ in: 'x' }, caps, { agentRef: { slug: 'voice' } }))).rejects.toThrow(/TEXT_TO_SPEECH/);
    expect(caps.generateDocument).not.toHaveBeenCalled();
  });
});
