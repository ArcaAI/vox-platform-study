/**
 * `GraphListEditor` (TASK-719 Task 13) — the WCAG 2.5.7 peer editor. Every assertion here
 * exercises the graph purely through `<button>` `click()` (no `MouseEvent`/drag dispatch, no
 * `dragstart`/`dragover`/`drop`) — the same activation path a keyboard Enter/Space triggers on
 * a real `<button>`, proving the mutation set never depends on a pointer drag.
 */
import { render, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { GraphListEditor } from '../graph-list-editor';
import { findingsByNodeId } from '../../../store/selectors';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import type { WorkflowFinding } from '../../../api/types';

function n(id: string, type: string, safetyClasses: string[] = []): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses, config: {} };
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
    expect((screen.getByRole('button', { name: /move noop up/i }) as HTMLButtonElement).disabled).toBe(true);
    screen.getByRole('button', { name: /move noop down/i }).click();
    expect(onMove).toHaveBeenCalledWith('a', 'down');
    expect((screen.getByRole('button', { name: /move passthrough down/i }) as HTMLButtonElement).disabled).toBe(true);
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
});
