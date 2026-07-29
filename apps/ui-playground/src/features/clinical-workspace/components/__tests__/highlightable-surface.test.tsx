/**
 * HighlightableSurface render test (TASK-344 Workstream B).
 *
 * Verifies the presentational surface: stored highlights re-anchor to the
 * current text and render as DISTINCT manual marks, orphaned highlights are
 * dropped (never thrown on), the remove control fires `onRemove`, and readOnly
 * hides the remove affordance. The anchoring math itself is unit-tested in
 * `lib/__tests__/highlight-anchoring.test.ts`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HighlightableSurface } from '../highlightable-surface';
import type { WorkspaceHighlight } from '../../types';

function hl(over: Partial<WorkspaceHighlight>): WorkspaceHighlight {
  return {
    id: 'h1',
    consultationId: 'c1',
    targetKind: 'CASE_NOTE',
    exact: 'cough',
    startOffset: 0,
    endOffset: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('HighlightableSurface', () => {
  it('renders stored highlights as distinct manual marks and reconstructs the text', () => {
    const text = 'cough and fever';
    render(<HighlightableSurface text={text} highlights={[hl({ exact: 'cough', startOffset: 0, endOffset: 5 })]} data-testid="surface" />);

    const surface = screen.getByTestId('surface');
    expect(surface.textContent).toContain('cough and fever');
    const marks = surface.querySelectorAll('mark[data-manual-highlight="true"]');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toContain('cough');
  });

  it('renders the stored color on a manual mark while staying distinct from AI marks', () => {
    render(
      <HighlightableSurface
        text="cough and fever"
        highlights={[hl({ exact: 'cough', startOffset: 0, endOffset: 5, color: '#22c55e' })]}
        data-testid="surface"
      />,
    );

    const mark = screen.getByTestId('surface').querySelector('mark[data-manual-highlight="true"]') as HTMLElement;
    expect(mark).not.toBeNull();
    // The stored color paints the mark background…
    expect(mark.style.backgroundColor).toBeTruthy();
    // …but the dotted underline is preserved so manual marks stay distinguishable
    // from the solid amber AI-entity marks.
    expect(mark.className).toContain('decoration-dotted');
  });

  it('falls back to the default manual styling when no color is stored', () => {
    render(<HighlightableSurface text="cough and fever" highlights={[hl({ exact: 'cough', startOffset: 0, endOffset: 5 })]} data-testid="surface" />);

    const mark = screen.getByTestId('surface').querySelector('mark[data-manual-highlight="true"]') as HTMLElement;
    expect(mark.style.backgroundColor).toBeFalsy();
    expect(mark.className).toContain('bg-sky');
  });

  it('drops orphaned highlights (exact text gone) without throwing', () => {
    render(
      <HighlightableSurface
        text="only fever here"
        highlights={[hl({ id: 'orphan', exact: 'pneumothorax', startOffset: 0, endOffset: 12 })]}
        data-testid="surface"
      />,
    );

    const surface = screen.getByTestId('surface');
    expect(surface.querySelectorAll('mark[data-manual-highlight="true"]')).toHaveLength(0);
    expect(surface.textContent).toBe('only fever here');
  });

  it('invokes onRemove with the highlight id when the remove control is clicked', () => {
    const onRemove = vi.fn();
    render(
      <HighlightableSurface
        text="cough and fever"
        highlights={[hl({ id: 'rm', exact: 'fever', startOffset: 10, endOffset: 15 })]}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByTestId('remove-highlight-rm'));
    expect(onRemove).toHaveBeenCalledWith('rm');
  });

  it('hides the remove affordance in readOnly mode', () => {
    render(
      <HighlightableSurface
        text="cough and fever"
        highlights={[hl({ id: 'ro', exact: 'cough', startOffset: 0, endOffset: 5 })]}
        onRemove={vi.fn()}
        readOnly
      />,
    );

    expect(screen.queryByTestId('remove-highlight-ro')).toBeNull();
  });
});
