/**
 * A node's DOCUMENT binding must survive an edit-and-save cycle through this UI — the DD-2
 * counterpart of `prompt-pin-round-trip.test.tsx`, and for the same reason.
 *
 * ## Why these tests import the real contract
 *
 * They read `NODE_CONFIG_SCHEMAS` from `@arcaai/workflow-contract` rather than a hand-written
 * fixture. A fixture would only prove this UI preserves a key *some* schema declares; the
 * failure mode is the SCHEMA not declaring it. Every schema in that module is
 * `additionalProperties: false`, so an undeclared key is rejected by the server outright, and
 * the inspector builds its form from `Object.entries(schema.properties)` alone, so an
 * undeclared key is also invisible. Delete `documentVersionNumber` from the contract and these
 * go red; a fixture-based test would not.
 *
 * (The console does not import `@arcaai/workflow-contract` at RUNTIME — the registry is fetched
 * over HTTP and the wire types are hand-mirrored. This is a test-only devDependency import,
 * which is the point: it cross-checks the hand-mirrored side against the source of truth.)
 *
 * ## What the assertions protect
 *
 *   1. Both keys are DECLARED on every schema that can carry a document binding.
 *   2. Neither key is REQUIRED — §7b's "no published graph is invalidated" is a property of the
 *      contract, and this UI must not quietly depend on it changing.
 *   3. The pin's floor is 1 in the schema, matching the compiled artifact (`versionNumber >= 1`)
 *      and both pydantic models (`ge=1`). A `0` authorable here would be a pin the interpreter
 *      cannot honour — so nothing in this UI may ever write one.
 *   4. The binding survives an edit of a neighbouring field, an edit of ITSELF through the real
 *      control, and the full graph serialization that is actually PATCHed.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '@arcaai/workflow-contract';
import { renderWithProviders } from '@/test/render';
import { fromWorkflowGraph, toWorkflowGraph } from '../../../lib/graph-serialization';
import type { GraphStoreNode } from '../../../store/types';
import type { WorkflowGraph } from '../../../api/types';
import { InspectorPanel } from '../inspector-panel';

const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const PINNED_VERSION = 3;

interface SchemaShape {
  properties?: Record<string, unknown>;
  required?: string[];
}

/** Every node type whose config schema carries DD-2's document binding. */
const BOUND_NODE_TYPES = Object.entries(NODE_CONFIG_SCHEMAS)
  .filter(([, schema]) => Object.hasOwn((schema as SchemaShape).properties ?? {}, 'documentTemplateId'))
  .map(([type]) => type);

function catalogRow(overrides: Record<string, unknown> = {}) {
  return { id: TEMPLATE_ID, name: 'Discharge Summary', slug: 'discharge_summary', status: 'PUBLISHED', pinnedVersionNumber: 3, isDefault: true, ...overrides };
}

function stubCatalog(templates: unknown[] = [catalogRow(), catalogRow({ id: OTHER_ID, name: 'Progress Note', isDefault: false })]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) =>
      String(input).includes('/versions')
        ? Response.json([{ versionNumber: 3, createdAt: '2026-08-01T00:00:00.000Z', changeReason: null }])
        : Response.json(templates),
    ),
  );
}

function node(config: Record<string, unknown>): GraphStoreNode {
  return { id: 'generate_note', type: 'generate.text', position: { x: 10, y: 20 }, safetyClasses: [], config };
}

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DD-2 document binding — the contract', () => {
  it('declares BOTH keys on every node type that can carry a document binding', () => {
    expect(BOUND_NODE_TYPES.length).toBeGreaterThan(0);
    for (const type of BOUND_NODE_TYPES) {
      const properties = (NODE_CONFIG_SCHEMAS[type] as SchemaShape).properties ?? {};
      expect(Object.hasOwn(properties, 'documentVersionNumber'), `${type} must declare documentVersionNumber`).toBe(true);
    }
  });

  it('keeps BOTH keys OPTIONAL on every one of them — a published graph without a binding stays valid', () => {
    for (const type of BOUND_NODE_TYPES) {
      const required = (NODE_CONFIG_SCHEMAS[type] as SchemaShape).required ?? [];
      expect(required, `${type} must not require documentTemplateId`).not.toContain('documentTemplateId');
      expect(required, `${type} must not require documentVersionNumber`).not.toContain('documentVersionNumber');
    }
  });

  it('floors the pin at 1, so 0 is not an authorable value anywhere', () => {
    for (const type of BOUND_NODE_TYPES) {
      const pin = ((NODE_CONFIG_SCHEMAS[type] as SchemaShape).properties ?? {})['documentVersionNumber'] as { minimum?: number; type?: string };
      expect(pin.type).toBe('integer');
      expect(pin.minimum).toBe(1);
    }
  });
});

describe('DD-2 document binding — round-trip survival through the inspector', () => {
  it('renders the real control, NOT the two raw schema fields it replaces', async () => {
    stubCatalog();
    renderWithProviders(
      <InspectorPanel
        node={node({ taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID, documentVersionNumber: PINNED_VERSION })}
        configSchema={NODE_CONFIG_SCHEMAS['generate.text']}
        problems={[]}
        onConfigChange={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText('Document template')).toBeTruthy();
    // The generated string/number pair is gone: no free-text UUID box, no bare number box.
    expect(screen.queryByLabelText(/^Document Template Id$/)).toBeNull();
    expect(screen.queryByLabelText(/^Document Version Number$/)).toBeNull();
  });

  it('KEEPS the binding when an UNRELATED field on the same node is edited', async () => {
    stubCatalog();
    const onConfigChange = vi.fn();
    renderWithProviders(
      <InspectorPanel
        node={node({ taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID, documentVersionNumber: PINNED_VERSION })}
        configSchema={NODE_CONFIG_SCHEMAS['generate.text']}
        problems={[]}
        onConfigChange={onConfigChange}
      />,
    );

    fireEvent.change(await screen.findByLabelText(/^System Prompt/), { target: { value: 'Be concise.' } });

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const emitted = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(emitted.documentTemplateId).toBe(TEMPLATE_ID);
    expect(emitted.documentVersionNumber).toBe(PINNED_VERSION);
  });

  it('KEEPS the DD-11 prompt pin when the document binding is edited through its own control', async () => {
    stubCatalog();
    const onConfigChange = vi.fn();
    renderWithProviders(
      <InspectorPanel
        node={node({ taskKey: 'text.finalize', promptTemplateId: '11111111-1111-4111-8111-111111111111', promptVersionNumber: 4 })}
        configSchema={NODE_CONFIG_SCHEMAS['generate.text']}
        problems={[]}
        onConfigChange={onConfigChange}
      />,
    );

    const trigger = await screen.findByLabelText('Document template');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /Discharge Summary/ }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const emitted = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(emitted).toEqual({
      taskKey: 'text.finalize',
      promptTemplateId: '11111111-1111-4111-8111-111111111111',
      promptVersionNumber: 4,
      documentTemplateId: TEMPLATE_ID,
    });
  });

  it('KEEPS the binding across the full graph serialization round trip (the shape actually PATCHed)', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        {
          id: 'generate_note',
          type: 'generate.text',
          config: { taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID, documentVersionNumber: PINNED_VERSION },
          position: { x: 1, y: 2 },
        },
      ],
      edges: [],
    };

    const { nodes, edges } = fromWorkflowGraph(graph);
    expect(nodes[0].config.documentVersionNumber).toBe(PINNED_VERSION);
    expect(toWorkflowGraph(nodes, edges).nodes[0].config).toMatchObject({
      documentTemplateId: TEMPLATE_ID,
      documentVersionNumber: PINNED_VERSION,
    });
  });

  it('leaves an UNPINNED node unpinned — round-tripping must never invent a pin, least of all a 0', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'follows', type: 'generate.text', config: { taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID }, position: { x: 0, y: 0 } }],
      edges: [],
    };

    const { nodes, edges } = fromWorkflowGraph(graph);
    const saved = toWorkflowGraph(nodes, edges);
    expect(Object.hasOwn(saved.nodes[0].config, 'documentVersionNumber')).toBe(false);
  });
});
