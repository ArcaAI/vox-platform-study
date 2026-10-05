/**
 * TASK-1036 (owner, 2026-10-05: "each node displayed a weird name: Core.trigger.n_trigger") — the
 * canvas cards are named in words: the authored label, the agent's catalogue name, or the type's
 * friendly title, with repeats numbered. The raw id never reaches a card (or its accessible name,
 * which the canvas derives from the same label).
 */
import { act } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { renderWithProviders } from '@/test/render';
import { GraphStoreProvider, useGraphStoreApi } from '../../../store';
import type { GraphStoreNode } from '../../../store/types';
import { REGISTRY } from '../../../lib/__tests__/registry-fixture';
import { ComposerCanvas } from '../composer-canvas';

type CanvasProps = Record<string, unknown> & { nodes: Array<{ id: string; label: string }> };
const captured: CanvasProps[] = [];
vi.mock('@arcaai/ui/components/workflow-canvas', () => ({
  WorkflowCanvas: (props: CanvasProps) => {
    captured.push(props);
    return <div data-testid="canvas" />;
  },
}));
vi.mock('../../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks')>();
  return {
    ...actual,
    useAgentOptions: () => ({
      data: [
        { slug: 'whisper-ml-en-realtime', name: 'Realtime transcription (whisper.cpp ML/EN)', task: 'SPEECH_TO_TEXT' },
        { slug: 'case-notes-pre-summary', name: 'Case notes pre-summary', task: 'TEXT_GENERATION' },
      ],
    }),
  };
});
beforeAll(() => {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

const holder: { api: ReturnType<typeof useGraphStoreApi> | null } = { api: null };
function Capture({ children }: { children: ReactNode }) {
  const storeApi = useGraphStoreApi();
  useEffect(() => {
    holder.api = storeApi;
  }, [storeApi]);
  return <>{children}</>;
}
function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}

describe('ComposerCanvas — friendly node names', () => {
  it('names every card in words, never "Core.x · id"', () => {
    renderWithProviders(
      <GraphStoreProvider>
        <Capture>
          <ComposerCanvas aria-label="graph" descriptorByType={REGISTRY} />
        </Capture>
      </GraphStoreProvider>,
    );
    act(() =>
      holder.api?.getState().hydrate(
        [
          node('n_trigger', 'core.trigger'),
          node('n_asr', 'core.agent', { agentRef: { slug: 'whisper-ml-en-realtime' }, execution: { lane: 'realtime' } }),
          node('n_pre', 'core.agent', { agentRef: { slug: 'case-notes-pre-summary' } }),
          node('n_map_a', 'core.data'),
          node('n_map_b', 'core.data'),
          node('n_note', 'core.agent', { label: 'Draft note', agentRef: { slug: 'case-notes-pre-summary' } }),
          node('n_output', 'core.output'),
        ],
        [],
      ),
    );
    const labels = Object.fromEntries((captured.at(-1)?.nodes ?? []).map((n) => [n.id, n.label]));
    expect(labels).toEqual({
      n_trigger: 'Start',
      n_asr: 'Realtime transcription (whisper.cpp ML/EN)',
      n_pre: 'Case notes pre-summary',
      n_map_a: 'Map fields',
      n_map_b: 'Map fields 2',
      n_note: 'Draft note',
      n_output: 'Output',
    });
    for (const label of Object.values(labels)) expect(label).not.toMatch(/core\.|n_[a-z]/i);
  });
});
