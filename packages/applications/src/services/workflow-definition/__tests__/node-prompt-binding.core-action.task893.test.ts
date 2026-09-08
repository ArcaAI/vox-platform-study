/**
 * TASK-893 — a prompt binding authored in the `core` vocabulary must still be COLLECTED.
 *
 * ## The defect
 *
 * `collectPromptBindings` is keyed off the PRESENCE of `promptTemplateId` rather than off a node
 * type allow-list, and its docstring says why: a type list "would silently miss the next
 * generation node someone adds to the registry". The retirement did something the allow-list
 * argument did not anticipate — it moved the binding one level DOWN. `prompt.template_ref` is no
 * longer a node type; it is an ACTION, so a graph binds it as a `core.action` whose delegate
 * config lives under `config.action` (`core.action`'s schema is `additionalProperties: false`,
 * so the key cannot be authored at the top level any more).
 *
 * Read only at the top level, the collector therefore returns NOTHING for every `core` graph:
 *  - `policyBindings.promptTemplateRefs` is empty, so a published artifact pins no prompt version
 *    and a template edit re-prompts a published clinical workflow — the exact failure DD-11's pin
 *    exists to prevent;
 *  - the "new version available" surface shows no referencing node;
 *  - `movePin` cannot find the node to re-pin.
 *
 * None of that errors. It just stops protecting.
 */
import { describe, expect, it } from 'vitest';
import { collectPromptBindings, withMovedPin } from '../node-prompt-binding';

const TEMPLATE_ID = '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41';

const coreGraph = (action: Record<string, unknown>) =>
  ({
    version: 1,
    nodes: [
      { id: 't1', type: 'core.trigger', config: { kinds: ['api'] } },
      { id: 'n_gen', type: 'core.action', config: { actionKey: 'prompt.template_ref', action } },
      { id: 'o1', type: 'core.output', config: { protocols: ['http'] } },
    ],
    edges: [],
  }) as never;

describe('TASK-893 — prompt bindings under the core vocabulary', () => {
  it('collects a PINNED binding carried under a core.action’s delegate config', () => {
    const bindings = collectPromptBindings(coreGraph({ promptTemplateId: TEMPLATE_ID, promptVersionNumber: 3 }));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ nodeId: 'n_gen', nodeType: 'core.action', promptTemplateId: TEMPLATE_ID, pinnedVersionNumber: 3 });
  });

  it('collects an UNPINNED binding as pinnedVersionNumber null — never as absent', () => {
    const bindings = collectPromptBindings(coreGraph({ promptTemplateId: TEMPLATE_ID }));

    expect(bindings).toHaveLength(1);
    expect(bindings[0].pinnedVersionNumber).toBeNull();
  });

  it('moves the pin where the binding actually lives, leaving the rest of the delegate config alone', () => {
    const moved = withMovedPin(coreGraph({ promptTemplateId: TEMPLATE_ID, promptVersionNumber: 3, variableBindings: { a: 'b' } }), 'n_gen', 7);

    expect(moved).not.toBeNull();
    const node = moved!.nodes.find((n) => n.id === 'n_gen')!;
    expect((node.config as { action: Record<string, unknown> }).action).toEqual({
      promptTemplateId: TEMPLATE_ID,
      promptVersionNumber: 7,
      variableBindings: { a: 'b' },
    });
    // The pin must NOT be written at the top level, where `core.action`'s
    // `additionalProperties: false` schema would refuse it on the next publish.
    expect(node.config).not.toHaveProperty('promptVersionNumber');
    expect(collectPromptBindings(moved!)[0].pinnedVersionNumber).toBe(7);
  });

  it('still reads a TOP-LEVEL binding — the two forms coexist, and top level wins', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'n1', type: 'core.action', config: { actionKey: 'prompt.template_ref', promptTemplateId: TEMPLATE_ID, promptVersionNumber: 2 } }],
      edges: [],
    } as never;

    expect(collectPromptBindings(graph)[0]).toMatchObject({ promptTemplateId: TEMPLATE_ID, pinnedVersionNumber: 2 });
  });

  it('a node with no binding on either level is not a binding', () => {
    expect(collectPromptBindings(coreGraph({ variableBindings: {} }))).toHaveLength(0);
    expect(withMovedPin(coreGraph({ variableBindings: {} }), 'n_gen', 4)).toBeNull();
  });
});
