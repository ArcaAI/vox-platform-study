import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// @arcaai/ui subpaths are stubbed to `{}` by the playground vitest config.
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));

vi.mock('@/components/version-diff-panel', () => ({
  VersionDiffPanel: ({ sections, left, right }: any) => (
    <div data-testid="version-diff-panel">
      <span data-testid="left-label">{left.changeReason}</span>
      <span data-testid="right-label">{right.changeReason}</span>
      {sections.map((s: any) => (
        <div key={s.label} data-testid="section">
          {s.oldText}=&gt;{s.newText}
        </div>
      ))}
    </div>
  ),
}));

import { DraftFinalDiffViewer } from '../draft-final-diff-viewer';

describe('DraftFinalDiffViewer', () => {
  it('renders the diff panel with the provided labels and content', () => {
    render(<DraftFinalDiffViewer draftText="old text" finalText="new text" draftLabel="Default" finalLabel="Yours" />);

    expect(screen.getByTestId('version-diff-panel')).toBeInTheDocument();
    expect(screen.getByTestId('left-label')).toHaveTextContent('Default');
    expect(screen.getByTestId('right-label')).toHaveTextContent('Yours');
    expect(screen.getByTestId('section')).toHaveTextContent('old text=>new text');
  });

  it('renders an empty hint (not the panel) when both sides are blank', () => {
    render(<DraftFinalDiffViewer draftText="" finalText="   " emptyHint="Nothing to compare yet" />);

    expect(screen.queryByTestId('version-diff-panel')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing to compare yet')).toBeInTheDocument();
  });
});
