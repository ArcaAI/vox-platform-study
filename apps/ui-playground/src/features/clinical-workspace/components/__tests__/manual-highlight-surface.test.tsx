/**
 * ManualHighlightSurface color-picker test (TASK-344 — color at creation).
 *
 * The connected surface lets the clinician pick a preset color, then anchors the
 * NEXT manual highlight with it. There is no update endpoint, so color is chosen
 * at creation only. `computeAnchorFromSelection` is stubbed to a canned anchor so
 * a surface mouse-up deterministically drives the create mutation (the DOM
 * selection → anchor math is unit-tested in `lib/__tests__/highlight-anchoring`),
 * and the `:id/highlights` query hooks are mocked to capture the create payload.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const createMutate = vi.fn();
vi.mock('../../api/queries', () => ({
  useHighlightsQuery: () => ({ data: [] }),
  useCreateHighlightMutation: () => ({ mutate: createMutate }),
  useDeleteHighlightMutation: () => ({ mutate: vi.fn() }),
}));

const cannedAnchor = { quote: { exact: 'chest pain', prefix: 'reports ', suffix: ' today' }, position: { start: 8, end: 18 } };
vi.mock('../../lib/highlight-anchoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/highlight-anchoring')>();
  return { ...actual, computeAnchorFromSelection: vi.fn(() => cannedAnchor) };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ManualHighlightSurface, HIGHLIGHT_COLORS, DEFAULT_HIGHLIGHT_COLOR } from '../highlightable-surface';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Fire the surface mouse-up; the stubbed anchor makes this a deterministic create. */
function selectTextOnSurface() {
  fireEvent.mouseUp(screen.getByTestId('surface'));
}

describe('ManualHighlightSurface — color picker', () => {
  it('renders the preset color swatches', () => {
    render(<ManualHighlightSurface consultationId="c1" targetKind="CASE_NOTE" text="reports chest pain today" data-testid="surface" />);

    for (const option of HIGHLIGHT_COLORS) {
      expect(screen.getByTestId(`highlight-color-${option.name.toLowerCase()}`)).toBeInTheDocument();
    }
  });

  it('creates a highlight with the default color when the doctor picks none', () => {
    render(
      <ManualHighlightSurface
        consultationId="c1"
        targetKind="CASE_NOTE"
        sourceContextItemId="ctx-1"
        text="reports chest pain today"
        data-testid="surface"
      />,
    );

    selectTextOnSurface();

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({
      targetKind: 'CASE_NOTE',
      sourceContextItemId: 'ctx-1',
      color: DEFAULT_HIGHLIGHT_COLOR,
      exact: 'chest pain',
      startOffset: 8,
      endOffset: 18,
    });
  });

  it('creates a highlight with the color the doctor selected', () => {
    render(<ManualHighlightSurface consultationId="c1" targetKind="SUMMARY" text="reports chest pain today" data-testid="surface" />);

    const green = HIGHLIGHT_COLORS.find((c) => c.name === 'Green')!;
    fireEvent.click(screen.getByTestId('highlight-color-green'));
    selectTextOnSurface();

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({ targetKind: 'SUMMARY', color: green.value });
  });

  it('hides the color picker in readOnly mode', () => {
    render(<ManualHighlightSurface consultationId="c1" targetKind="CASE_NOTE" text="x" readOnly data-testid="surface" />);

    expect(screen.queryByTestId('highlight-color-green')).toBeNull();
  });
});
