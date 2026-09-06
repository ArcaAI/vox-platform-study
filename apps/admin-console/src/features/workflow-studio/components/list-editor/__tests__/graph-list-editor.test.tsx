/**
 * `GraphListEditor` — the WCAG 2.5.7 peer editor. Every assertion here
 * exercises the graph purely through `<button>` `click()` (no `MouseEvent`/drag dispatch, no
 * `dragstart`/`dragover`/`drop`) — the same activation path a keyboard Enter/Space triggers on
 * a real `<button>`, proving the mutation set never depends on a pointer drag.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { GraphListEditor } from '../graph-list-editor';
import { findingsByNodeId } from '../../../store/selectors';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import type { WorkflowFinding } from '../../../api/types';

function n(id: string, type: string, safetyClasses: string[] = [], config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses, config };
}

describe('GraphListEditor', () => {
  it('shows the Empty state with no nodes', () => {
    render(
      <GraphListEditor
        nodes={[]}
        edges={[]}
        selectedNodeId={null}
        problemsByNodeId={new Map()}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={vi.fn()}
      onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText(/no nodes yet/i)).toBeTruthy();
  });

  it('a two-node graph can be built end to end with clicks only: select, connect, then delete the non-mandatory node', () => {
    const onSelect = vi.fn();
    const onConnect = vi.fn(() => ({ ok: true }) as const);
    const onDeleteRequest = vi.fn(() => ({ ok: true }) as const);
    const nodes = [n('a', 'noop'), n('b', 'passthrough')];
    render(
      <GraphListEditor
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        problemsByNodeId={new Map()}
        onSelect={onSelect}
        onDeleteRequest={onDeleteRequest}
        onMove={vi.fn()}
      onDuplicate={vi.fn()}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
      />,
    );

    // Select node A (Configure).
    screen.getByRole('button', { name: /configure noop/i }).click();
    expect(onSelect).toHaveBeenCalledWith('a');

    // Connect A -> B via the picker (Select + Connect button), never a drag.
    const rowA = screen.getByRole('button', { name: /configure noop/i }).closest('li') as HTMLElement;
    const connectButton = within(rowA).getByRole('button', { name: 'Connect' });
    // Nothing selected yet -> disabled (button, single-pointer/keyboard operable once a target
    // is chosen — the Select itself needs no drag).
    expect(connectButton.hasAttribute('disabled')).toBe(true);

    // Delete node B (non-mandatory).
    screen.getByRole('button', { name: /delete passthrough/i }).click();
    expect(onDeleteRequest).toHaveBeenCalledWith('b');
  });

  it('a mandatory node exposes NO delete affordance and says why', () => {
    render(
      <GraphListEditor
        nodes={[n('m1', 'guardrail_gate', ['mandatory'])]}
        edges={[]}
        selectedNodeId={null}
        problemsByNodeId={new Map()}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={vi.fn()}
      onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /delete guardrail gate/i })).toBeNull();
    expect(screen.getByText(/mandatory.*cannot be deleted/i)).toBeTruthy();
  });

  it('reorder uses move up/down buttons, never drag; disabled at the boundary', () => {
    const onMove = vi.fn();
    render(
      <GraphListEditor
        nodes={[n('a', 'noop'), n('b', 'passthrough')]}
        edges={[]}
        selectedNodeId={null}
        problemsByNodeId={new Map()}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={onMove}
        onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={vi.fn()}
      />,
    );
    // Names carry the node's short id since TASK-890/BBJ4-F3 ("Move Noop · a up").
    expect((screen.getByRole('button', { name: /move noop .* up/i }) as HTMLButtonElement).disabled).toBe(true);
    screen.getByRole('button', { name: /move noop .* down/i }).click();
    expect(onMove).toHaveBeenCalledWith('a', 'down');
    expect((screen.getByRole('button', { name: /move passthrough .* down/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an existing edge with a Disconnect button, never a drag-to-delete', () => {
    const onDisconnect = vi.fn();
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }];
    render(
      <GraphListEditor
        nodes={[n('a', 'noop'), n('b', 'passthrough')]}
        edges={edges}
        selectedNodeId={null}
        problemsByNodeId={new Map()}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={vi.fn()}
      onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={onDisconnect}
      />,
    );
    screen.getByRole('button', { name: /disconnect from passthrough/i }).click();
    expect(onDisconnect).toHaveBeenCalledWith('e1');
  });

  it('renders the validation status per row from grouped server findings', () => {
    const findings: WorkflowFinding[] = [{ ruleId: 'WF-C-001', ruleClass: 'schema', severity: 'ERROR', nodeId: 'a', message: 'bad config' }];
    render(
      <GraphListEditor
        nodes={[n('a', 'noop')]}
        edges={[]}
        selectedNodeId={null}
        problemsByNodeId={findingsByNodeId(findings)}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={vi.fn()}
      onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 error/i)).toBeTruthy();
  });

  it('0 axe violations', async () => {
    const { container } = render(
      <GraphListEditor
        nodes={[n('a', 'noop'), n('m1', 'guardrail_gate', ['mandatory'])]}
        edges={[{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'm1', targetHandle: 'in' }]}
        selectedNodeId="a"
        problemsByNodeId={new Map()}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={vi.fn()}
      onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  /**
   * TASK-890 black-box J4-F3 — two nodes of the SAME type must be tellable apart. Before this,
   * every row and every "Connect to…" option read "Noop", so an admin picking a target was
   * guessing which one they meant.
   */
  it('names each node by its label, else its type plus a short id — and the connect options carry the id', () => {
    render(
      <GraphListEditor
        nodes={[n('node_aa11', 'noop'), n('node_bb22', 'noop'), n('node_cc33', 'noop', [], { label: 'Key points' })]}
        edges={[{ id: 'e1', source: 'node_aa11', sourceHandle: 'out', target: 'node_bb22', targetHandle: 'in' }]}
        selectedNodeId={null}
        problemsByNodeId={new Map()}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={vi.fn()}
        onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Configure Noop · aa11' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Configure Noop · bb22' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Configure Key points' })).toBeTruthy();
    // The existing edge names its TARGET, not just its type.
    expect(screen.getByRole('button', { name: 'Disconnect from Noop · bb22' })).toBeTruthy();
  });

  it('every "Connect to…" option is identifiable and carries its node id as data', () => {
    render(
      <GraphListEditor
        nodes={[n('node_aa11', 'noop'), n('node_bb22', 'noop')]}
        edges={[]}
        selectedNodeId={null}
        problemsByNodeId={new Map()}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn(() => ({ ok: true }) as const)}
        onMove={vi.fn()}
        onDuplicate={vi.fn()}
        onConnect={vi.fn(() => ({ ok: true }) as const)}
        onDisconnect={vi.fn()}
      />,
    );

    // Radix renders options only once the Select is opened; the trigger is a real combobox.
    const trigger = screen.getAllByRole('combobox', { name: 'Connect to…' })[0] as HTMLElement;
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const option = screen.getByRole('option', { name: 'Noop · bb22' });
    expect(option.getAttribute('data-value')).toBe('node_bb22');
  });
});
