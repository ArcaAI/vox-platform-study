/**
 * TASK-816 Phase 1 — the `llmBinding` reader.
 *
 * Mirrors `node-prompt-binding`'s posture exactly: presence-keyed (never a node-TYPE allow-list,
 * which would silently miss the next generation node registered), pure, and tolerant of a
 * malformed value — the authoring schema is where a bad shape is refused, and a runtime that
 * threw here would fail a live consultation over a field the validator already screened.
 */
import { describe, expect, it } from 'vitest';
import { collectLlmBindings, readLlmBinding, readLlmBindingFromConfig } from '../node-llm-binding';

const node = (id: string, type: string, config: unknown) => ({ id, type, config }) as never;

describe('readLlmBindingFromConfig', () => {
  it('reads a well-formed binding', () => {
    expect(readLlmBindingFromConfig({ llmBinding: { modelSlug: 'tenant-medgemma' } })).toEqual({ modelSlug: 'tenant-medgemma' });
  });

  it.each([
    ['no config at all', undefined],
    ['a config with no binding', { taskKey: 'text.finalize' }],
    ['an explicitly null binding', { llmBinding: null }],
    ['a binding that is not an object', { llmBinding: 'lms-gemma' }],
    ['a binding with no slug', { llmBinding: {} }],
    ['a binding with a blank slug', { llmBinding: { modelSlug: '' } }],
    ['a binding with a non-string slug', { llmBinding: { modelSlug: 7 } }],
  ])('reads %s as ABSENT rather than throwing', (_label, config) => {
    expect(readLlmBindingFromConfig(config)).toBeNull();
  });

  it('never mistakes the PROMPT binding for a model binding', () => {
    expect(readLlmBindingFromConfig({ promptTemplateId: 'a-uuid', promptVersionNumber: 3 })).toBeNull();
  });
});

describe('collectLlmBindings', () => {
  it('returns every bound node in AUTHORED order, and only bound ones', () => {
    const graph = {
      nodes: [
        node('n_unbound', 'agent.summarization', { taskKey: 'text.finalize' }),
        node('n_disc', 'agent.discharge_summary', { llmBinding: { modelSlug: 'big-model' } }),
        node('n_live', 'consultation.realtimeSummary', { llmBinding: { modelSlug: 'small-model' } }),
      ],
    } as never;

    expect(collectLlmBindings(graph)).toEqual([
      { nodeId: 'n_disc', nodeType: 'agent.discharge_summary', modelSlug: 'big-model' },
      { nodeId: 'n_live', nodeType: 'consultation.realtimeSummary', modelSlug: 'small-model' },
    ]);
  });

  it('lets two nodes of the same task key select DIFFERENT models — the gap this closes', () => {
    const graph = {
      nodes: [
        node('n_soap', 'agent.summarization', { taskKey: 'text.finalize', llmBinding: { modelSlug: 'fast' } }),
        node('n_disc', 'agent.discharge_summary', { taskKey: 'text.finalize', llmBinding: { modelSlug: 'thorough' } }),
      ],
    } as never;

    expect(collectLlmBindings(graph).map((b) => b.modelSlug)).toEqual(['fast', 'thorough']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a graph with no nodes array', {}],
  ])('returns [] for %s', (_label, graph) => {
    expect(collectLlmBindings(graph as never)).toEqual([]);
  });

  it('readLlmBinding carries the node identity a caller needs for lineage', () => {
    expect(readLlmBinding(node('n1', 'generate.text', { llmBinding: { modelSlug: 's' } }))).toEqual({
      nodeId: 'n1',
      nodeType: 'generate.text',
      modelSlug: 's',
    });
  });
});
