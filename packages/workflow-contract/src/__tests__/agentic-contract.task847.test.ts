/**
 * steps 3, 5 and 6 — the checks a JSON Schema cannot express.
 *
 *  - **Hyper-parameter CAPABILITY gating**. Not every provider accepts
 *    `presencePenalty`, and most of those that do not IGNORE it rather than erroring. Silently
 *    dropping a parameter a clinician tuned is worse than refusing it, so a declared capability
 *    set that omits a parameter the node sets is an ERROR at publish.
 *  - **Exactly one selection source** (step 5's neighbour). `providerConfigRef` offers two shapes
 *    and the graph must pick one; JSON Schema's `oneOf` needs a discriminator the authorable
 *    subset requires and neither shape has one, so the rule lives here.
 *  - **Loop bounds** , including the cost ceiling the owner's specification did not name
 *    and the no-progress check.
 */
import { describe, expect, it } from 'vitest';
import * as agenticContract from '../agentic-contract';
import * as portValidation from '../port-validation';
import { publishProblems } from './publish-problems.helper';

const { GENERATION_HYPERPARAMETERS, agenticNodeConfigProblems, hyperparameterCapabilityProblems } = agenticContract;

const ROUTING_POLICY_ID = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b41';

describe(' step 3 — hyper-parameter capability gating', () => {
  it('names all seven hyper-parameters, including the two F-12 recorded as absent', () => {
    expect([...GENERATION_HYPERPARAMETERS].sort()).toEqual(
      ['frequencyPenalty', 'maxTokens', 'presencePenalty', 'seed', 'stopSequences', 'temperature', 'topP'].sort(),
    );
  });

  it('REFUSES a parameter the declared capability set omits — the ticket`s own criterion', () => {
    const problems = hyperparameterCapabilityProblems(
      { temperature: 0.2, presencePenalty: 0.5 },
      { supportedGenerationParams: ['temperature', 'maxTokens', 'topP'], label: 'azure-openai/gpt-4o' },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].parameter).toBe('presencePenalty');
    expect(problems[0].severity).toBe('ERROR');
    // The message has to name the provider configuration, or the author cannot act on it.
    expect(problems[0].message).toContain('presencePenalty');
    expect(problems[0].message).toContain('azure-openai/gpt-4o');
  });

  it('accepts a parameter the capability set declares', () => {
    expect(
      hyperparameterCapabilityProblems(
        { presencePenalty: 0.5, frequencyPenalty: -0.2 },
        { supportedGenerationParams: ['presencePenalty', 'frequencyPenalty'] },
      ),
    ).toEqual([]);
  });

  it('WARNS rather than blocks when the configuration declares no capability set at all', () => {
    // An undeclared capability set means "unknown", not "unsupported". Refusing every graph
    // bound to a configuration nobody has profiled would block the platform on data entry; a
    // warning tells the author the parameter is unverified without pretending it is refused.
    const problems = hyperparameterCapabilityProblems({ presencePenalty: 0.5 }, { label: 'lmstudio/local' });
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('WARNING');
  });

  it('says nothing at all when the node sets no hyper-parameters', () => {
    expect(hyperparameterCapabilityProblems(undefined, { supportedGenerationParams: [] })).toEqual([]);
    expect(hyperparameterCapabilityProblems({}, undefined)).toEqual([]);
  });
});

describe('exactly one provider-configuration selection source', () => {
  it('accepts a pinned routing policy', () => {
    expect(
      agenticNodeConfigProblems({ id: 'a', type: 'agentic.agent', config: { providerConfigRef: { routingPolicyId: ROUTING_POLICY_ID } } }),
    ).toEqual([]);
  });

  it('accepts a task key', () => {
    expect(agenticNodeConfigProblems({ id: 'a', type: 'agentic.agent', config: { providerConfigRef: { taskKey: 'text.finalize' } } })).toEqual([]);
  });

  it('REFUSES both at once — two selection sources cannot both be "the one configuration"', () => {
    const problems = agenticNodeConfigProblems({
      id: 'a',
      type: 'agentic.agent',
      config: { providerConfigRef: { routingPolicyId: ROUTING_POLICY_ID, taskKey: 'text.finalize' } },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exactly one');
  });

  it('REFUSES neither — an empty binding resolves to nothing, and selection fails closed', () => {
    const problems = agenticNodeConfigProblems({ id: 'a', type: 'agentic.agent', config: { providerConfigRef: {} } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exactly one');
  });

  it('applies the same rule to the TTS node`s binding and the STT node`s pipeline ref', () => {
    expect(agenticNodeConfigProblems({ id: 't', type: 'agentic.tts', config: { providerConfigRef: {} } })).toHaveLength(1);
    expect(
      agenticNodeConfigProblems({ id: 's', type: 'agentic.stt', config: { pipelineRef: { pipelineId: ROUTING_POLICY_ID, pipelineSlug: 'x' } } }),
    ).toHaveLength(1);
  });
});

describe(' step 6 — loop bounds', () => {
  const BOUNDS = { maxIterations: 5, maxDurationSeconds: 300, maxTotalTokens: 100000 };

  it('accepts a fully bounded loop', () => {
    expect(agenticNodeConfigProblems({ id: 'l', type: 'agentic.loop', config: { bounds: BOUNDS, orchestratorNodeId: 'agent_node' } })).toEqual([]);
  });

  it('REFUSES a loop with no cost ceiling — an iteration cap bounds the schedule, not the bill', () => {
    const problems = agenticNodeConfigProblems({
      id: 'l',
      type: 'agentic.loop',
      config: { bounds: { maxIterations: 50, maxDurationSeconds: 300 }, orchestratorNodeId: 'agent_node' },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('maxTotalTokens');
  });

  it('REFUSES an orchestrator that is not a node in this graph', () => {
    const problems = agenticNodeConfigProblems(
      { id: 'l', type: 'agentic.loop', config: { bounds: BOUNDS, orchestratorNodeId: 'ghost' } },
      { nodeIds: ['l', 'agent_node'] },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ghost');
  });

  it('REFUSES a loop whose orchestrator is itself — a loop cannot orchestrate itself', () => {
    const problems = agenticNodeConfigProblems(
      { id: 'l', type: 'agentic.loop', config: { bounds: BOUNDS, orchestratorNodeId: 'l' } },
      { nodeIds: ['l'] },
    );
    expect(problems).toHaveLength(1);
  });
});

describe('guard references are checked against the graph', () => {
  it('REFUSES a guard reference naming a node that is not in the graph', () => {
    const problems = agenticNodeConfigProblems(
      { id: 'a', type: 'agentic.agent', config: { providerConfigRef: { taskKey: 'text.finalize' }, guards: { output: ['ghost'] } } },
      { nodeIds: ['a'] },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ghost');
  });

  it('REFUSES a guard reference naming a node that is not guard-classed', () => {
    const problems = agenticNodeConfigProblems(
      { id: 'a', type: 'agentic.agent', config: { providerConfigRef: { taskKey: 'text.finalize' }, guards: { input: ['not_a_guard'] } } },
      { nodeIds: ['a', 'not_a_guard'], nodeTypesById: { a: 'agentic.agent', not_a_guard: 'agentic.data' } },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not_a_guard');
  });

  it('accepts a guard reference to a real guard-classed node', () => {
    expect(
      agenticNodeConfigProblems(
        { id: 'a', type: 'agentic.agent', config: { providerConfigRef: { taskKey: 'text.finalize' }, guards: { input: ['g'] } } },
        { nodeIds: ['a', 'g'], nodeTypesById: { a: 'agentic.agent', g: 'agentic.guardrail' } },
      ),
    ).toEqual([]);
  });

  it('says nothing about a non-agentic node type — this is not a second validator for the pipeline palettes', () => {
    expect(agenticNodeConfigProblems({ id: 'x', type: 'generate.text', config: { taskKey: 'text.finalize' } })).toEqual([]);
  });
});

describe('the per-node checks are WIRED into the publish gate', () => {
  // An exported helper nobody calls is not a gate. `workflowPublishProblems` is the publish
  // boundary, so these tests are what turn `agenticNodeConfigProblems` from a function into a
  // rule — and they use the REAL graph shape (`from`/`to`), not a hand-rolled context.
  function graphWith(node: Record<string, unknown>) {
    return {
      version: 1,
      nodes: [{ id: 'start', type: 'core.start', config: {} }, node, { id: 'end', type: 'core.end', config: {} }],
      edges: [
        { id: 'e0', from: 'start', to: (node as { id: string }).id, fromPort: 'next', toPort: 'after' },
        { id: 'e1', from: (node as { id: string }).id, to: 'end', fromPort: 'next', toPort: 'after' },
      ],
    } as never;
  }

  it('REFUSES a loop with no cost ceiling at publish', () => {
    const problems = publishProblems(
      graphWith({
        id: 'loop_node',
        type: 'agentic.loop',
        config: { bounds: { maxIterations: 50, maxDurationSeconds: 300 }, orchestratorNodeId: 'start' },
      }),
    );
    expect(problems.some((problem) => problem.includes('maxTotalTokens'))).toBe(true);
  });

  it('REFUSES an agent whose provider binding names neither source', () => {
    const problems = publishProblems(graphWith({ id: 'agent_node', type: 'agentic.agent', config: { providerConfigRef: {} } }));
    expect(problems.some((problem) => problem.includes('exactly one'))).toBe(true);
  });

  it('REFUSES a guard reference naming a node that is not in the graph', () => {
    const problems = publishProblems(
      graphWith({
        id: 'agent_node',
        type: 'agentic.agent',
        config: { providerConfigRef: { taskKey: 'text.finalize' }, guards: { output: ['ghost'] } },
      }),
    );
    expect(problems.some((problem) => problem.includes('ghost'))).toBe(true);
  });

  it('PASSES a correctly bound agent — the gate is not simply refusing everything', () => {
    const problems = publishProblems(
      graphWith({ id: 'agent_node', type: 'agentic.agent', config: { providerConfigRef: { taskKey: 'text.finalize' } } }),
    );
    expect(problems.filter((problem) => problem.includes('exactly one') || problem.includes('bounds.'))).toEqual([]);
  });
});
