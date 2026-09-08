/**
 * A node's prompt PIN must survive an edit-and-save cycle through this UI.
 *
 * ## The bug this pins down
 *
 * `promptVersionNumber` (DD-11's per-node pin) was undeclared on the node
 * config schemas, and every one of those schemas is `additionalProperties:
 * false` while the Studio inspector builds its form from
 * `Object.entries(schema.properties)` alone. It is fixed now
 * (`PROMPT_BINDING_PROPERTIES`, shared across the seven declaration sites), and
 * these tests exist so it cannot come back.
 *
 * ## What is actually at risk, measured rather than assumed
 *
 * The console's own serialization does NOT drop the key. `setAtPath` writes
 * with an object spread (`{ ...config, [head]: value }`) and `toGraphNode`
 * copies `config` verbatim, so an UNDECLARED sibling survives a client-side
 * edit — verified directly by rendering this panel against a schema with the
 * pin removed and reading the emitted config, which still carried it.
 *
 * So the declaration buys two other things, and they are what the assertions
 * below actually protect:
 *
 *   1. The SERVER accepts the key at all (`additionalProperties: false` on the
 *      published schema is the evaluator's rule, not this form's).
 *   2. The pin is VISIBLE and editable instead of an invisible passenger an
 *      admin can neither see nor deliberately change.
 *
 * The serialization assertions are kept as well: they are cheap, and they fail
 * loudly the day someone replaces the spread with a declared-keys whitelist —
 * which is the change that WOULD make the console itself drop pins.
 *
 * ## Why these tests import the real contract
 *
 * They read `NODE_CONFIG_SCHEMAS` from `@arcaai/workflow-contract` rather than
 * a hand-written fixture. A fixture would only prove this UI preserves a key
 * *some* schema declares; the failure mode was the schema not declaring it. So
 * the assertion has to run against the schema the server actually publishes —
 * delete `promptVersionNumber` from the contract again and these go red, which
 * a fixture-based test would not.
 *
 * (The console does not import `@arcaai/workflow-contract` at RUNTIME — the
 * registry is fetched over HTTP and the wire types are hand-mirrored. This is a
 * test-only, devDependency import, which is the point: it cross-checks the
 * hand-mirrored side against the source of truth.)
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACTION_CONFIG_SCHEMAS, NODE_CONFIG_SCHEMAS } from '@arcaai/workflow-contract';
import { renderWithProviders } from '@/test/render';
import { fromWorkflowGraph, toWorkflowGraph } from '../../../lib/graph-serialization';
import type { GraphStoreNode } from '../../../store/types';
import type { WorkflowGraph } from '../../../api/types';
import { InspectorPanel } from '../inspector-panel';

const PINNED_VERSION = 4;
const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';

/** Every node type whose config schema declares the DD-11 prompt binding. */
/**
 * TASK-893 Phase 4 — the prompt pin lives on the `prompt.template_ref` ACTION now. A `core.agent`
 * takes its prompt from the referenced published Agent, so no NODE type declares the binding; the
 * carriers are looked up in the action schemas, which is where the inspector reads them from for
 * a `core.action` instance's `action` sub-config.
 */
const BOUND_NODE_TYPES = Object.entries(ACTION_CONFIG_SCHEMAS)
  .filter(([, schema]) => Object.hasOwn((schema as { properties?: Record<string, unknown> }).properties ?? {}, 'promptTemplateId'))
  .map(([type]) => type);

function node(overrides: Partial<GraphStoreNode> = {}): GraphStoreNode {
  return {
    id: 'generate_note',
    type: 'prompt.template_ref',
    position: { x: 10, y: 20 },
    safetyClasses: [],
    config: { promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION },
    ...overrides,
  };
}

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DD-11 prompt pin — round-trip survival', () => {
  it('the contract declares the pin on every node type that can carry a prompt binding', () => {
    // Guards the ORIGINAL defect at its source: a node type that can reference
    // a template but does not declare the pin loses it on every round trip.
    expect(BOUND_NODE_TYPES.length).toBeGreaterThan(0);
    for (const type of BOUND_NODE_TYPES) {
      const properties = (ACTION_CONFIG_SCHEMAS[type] as { properties: Record<string, unknown> }).properties;
      expect(Object.hasOwn(properties, 'promptVersionNumber'), `${type} must declare promptVersionNumber`).toBe(true);
    }
  });

  it('renders a field for the pin, so it is visible and editable rather than silently carried', async () => {
    renderWithProviders(
      <InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={ACTION_CONFIG_SCHEMAS['prompt.template_ref']} problems={[]} onConfigChange={vi.fn()} />,
    );

    const field = (await screen.findByLabelText(/^Prompt Version Number/i)) as HTMLInputElement;
    expect(field.value).toBe(String(PINNED_VERSION));
  });

  it('KEEPS the pin when an UNRELATED field on the same node is edited and saved', async () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <InspectorPanel tab="config" onTabChange={vi.fn()}
        node={node({ config: { promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION, variableBindings: {} } })}
        configSchema={ACTION_CONFIG_SCHEMAS['prompt.template_ref']}
        problems={[]}
        onConfigChange={onConfigChange}
      />,
    );

    // Edit the prompt TEMPLATE id — the neighbouring field, and the one whose
    // own editor was the original suspect.
    const templateField = (await screen.findByLabelText(/^Prompt Template Id/i)) as HTMLInputElement;
    fireEvent.change(templateField, { target: { value: '22222222-2222-4222-8222-222222222222' } });

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const emitted = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(emitted.promptTemplateId).toBe('22222222-2222-4222-8222-222222222222');
    expect(emitted.promptVersionNumber).toBe(PINNED_VERSION);
  });

  it('KEEPS the pin through the no-schema fallback, where the PromptTemplatePicker rewrites promptTemplateId', async () => {
    // The real registry state today: no delivered node type ships a config
    // schema, so the inspector falls back to the whole-config editor plus a
    // standalone picker. That picker DELETES and re-adds `promptTemplateId`,
    // which is exactly the shape of edit that could drop a sibling key.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [{ id: TEMPLATE_ID, name: 'SOAP note' }, { id: 'tpl-2', name: 'Discharge' }], count: 2 })),
    );
    const onConfigChange = vi.fn();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={undefined} problems={[]} onConfigChange={onConfigChange} />);

    const trigger = await screen.findByLabelText('Prompt template');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('option', { name: 'Discharge' }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const emitted = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(emitted.promptTemplateId).toBe('tpl-2');
    expect(emitted.promptVersionNumber).toBe(PINNED_VERSION);
  });

  it('KEEPS the pin across the full graph serialization round trip (the shape actually PATCHed)', () => {
    // The inspector's emitted config only matters if it survives all the way
    // into the wire document. `toGraphNode` copies `config` verbatim and
    // `fromGraphNode` strips only the legacy `__position` key — assert that,
    // rather than assuming it.
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'generate_note', type: 'prompt.template_ref', config: { promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION }, position: { x: 1, y: 2 } }],
      edges: [],
    };

    const { nodes, edges } = fromWorkflowGraph(graph);
    expect(nodes[0].config.promptVersionNumber).toBe(PINNED_VERSION);

    const saved = toWorkflowGraph(nodes, edges);
    expect(saved.nodes[0].config).toMatchObject({ promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION });
  });

  it('leaves an UNPINNED node unpinned — round-tripping must not invent a pin either', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'follows_template', type: 'prompt.template_ref', config: { promptTemplateId: TEMPLATE_ID }, position: { x: 0, y: 0 } }],
      edges: [],
    };

    const { nodes, edges } = fromWorkflowGraph(graph);
    const saved = toWorkflowGraph(nodes, edges);
    expect(Object.hasOwn(saved.nodes[0].config, 'promptVersionNumber')).toBe(false);
  });
});
