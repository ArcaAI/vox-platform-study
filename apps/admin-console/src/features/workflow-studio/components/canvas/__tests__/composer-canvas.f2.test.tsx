/**
 * TASK-1036 F2 — what `ComposerCanvas` hands the canvas for the run overlay (node warnings, link
 * run state), and where "Add a step" sits: never in the corner the floating palette docks in.
 */
import { act, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { renderWithProviders } from '@/test/render';
import { GraphStoreProvider, useGraphStoreApi } from '../../../store';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import { REGISTRY } from '../../../lib/__tests__/registry-fixture';
import { ComposerCanvas, type ComposerCanvasProps } from '../composer-canvas';

type CanvasProps = Record<string, unknown> & {
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: Array<Record<string, unknown> & { id: string }>;
};
const captured: CanvasProps[] = [];
vi.mock('@arcaai/ui/components/workflow-canvas', () => ({
  WorkflowCanvas: (props: CanvasProps) => {
    captured.push(props);
    return <div data-testid="canvas" />;
  },
}));
vi.mock('../../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks')>();
  return { ...actual, useAgentOptions: () => ({ data: [] }) };
});
beforeAll(() => {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

const latest = () => captured.at(-1) as CanvasProps;
const holder: { api: ReturnType<typeof useGraphStoreApi> | null } = { api: null };
function Capture({ children }: { children: ReactNode }) {
  const storeApi = useGraphStoreApi();
  useEffect(() => {
    holder.api = storeApi;
  }, [storeApi]);
  return <>{children}</>;
}
function node(id: string, type: string): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config: {} };
}
function mount(props: Partial<ComposerCanvasProps>, nodes: GraphStoreNode[], edges: GraphStoreEdge[] = []) {
  const view = renderWithProviders(
    <GraphStoreProvider>
      <Capture>
        <ComposerCanvas aria-label="graph" descriptorByType={REGISTRY} {...props} />
      </Capture>
    </GraphStoreProvider>,
  );
  act(() => holder.api?.getState().hydrate(nodes, edges));
  return view;
}

describe('ComposerCanvas — run overlay (F2)', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('hands the canvas each node’s run warnings and each link’s run state', () => {
    mount(
      {
        runStates: new Map([
          ['a', { state: 'ok' as const, durationMs: 10, warnings: 2 }],
          ['b', { state: 'running' as const }],
        ]),
        edgeRunStates: new Map([['e1', 'active' as const]]),
      },
      [node('a', 'core.data'), node('b', 'core.data')],
      [{ id: 'e1', source: 'a', sourceHandle: 'next', target: 'b', targetHandle: 'after' }],
    );
    expect(latest().nodes.find((candidate) => candidate.id === 'a')).toMatchObject({ runState: 'ok', runDurationMs: 10, runWarnings: 2 });
    expect(latest().nodes.find((candidate) => candidate.id === 'b')).toMatchObject({ runState: 'running' });
    expect(latest().edges.find((candidate) => candidate.id === 'e1')).toMatchObject({ runState: 'active' });
  });

  it('gives a link no run state when the run did not reach it', () => {
    mount({}, [node('a', 'core.data'), node('b', 'core.data')], [{ id: 'e1', source: 'a', sourceHandle: 'next', target: 'b', targetHandle: 'after' }]);
    expect(latest().edges[0]?.runState).toBeUndefined();
  });
});

describe('ComposerCanvas — “Add a step” placement (F2)', () => {
  it('does not sit in the top-left corner the floating palette docks in, and stays reachable', () => {
    mount({}, []);
    const button = screen.getByRole('button', { name: /add a step/i });
    expect(button.className).not.toMatch(/(^|\s)left-2(\s|$)/);
    expect(button.className).toContain('left-1/2');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('accepts a placement so a host can move it away from its own panes', () => {
    mount({ addStepPlacement: 'top-right' }, []);
    const button = screen.getByRole('button', { name: /add a step/i });
    expect(button.className).toContain('right-2');
    expect(button.className).not.toContain('left-1/2');
  });
});
