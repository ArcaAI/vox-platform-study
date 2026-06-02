/**
 * SavedSummariesPanel smoke test (TASK-329 P6)
 *
 * Verifies the consultation-scoped summary management surface:
 *   - empty/info state when no consultation is active
 *   - skeleton → empty when a consultation has no summaries
 *   - list renders cacheHit / qualityScore badges
 *   - selecting a summary loads versions + tags; adding a tag calls the SDK
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// The ui-playground vitest config stubs every `@arcaai/ui/*` subpath with
// `export default {}`, so each primitive used by the component must be mocked
// with a lightweight element here (mirrors the all-reports-panel test pattern).
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...p }: any) => <button {...p}>{children}</button>,
}));
vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, ...p }: any) => <span {...p}>{children}</span>,
}));
vi.mock('@arcaai/ui/input', () => ({
  Input: (p: any) => <input {...p} />,
}));
vi.mock('@arcaai/ui/textarea', () => ({
  Textarea: (p: any) => <textarea {...p} />,
}));
vi.mock('@arcaai/ui/skeleton', () => ({
  Skeleton: (p: any) => <div data-testid="skeleton" {...p} />,
}));
vi.mock('@arcaai/ui/separator', () => ({
  Separator: (p: any) => <hr {...p} />,
}));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/version-diff-panel', () => ({
  VersionDiffPanel: () => <div data-testid="version-diff-panel" />,
}));

const state = vi.hoisted(() => ({
  consultation: null as { id: string } | null,
  loadSummaries: vi.fn(),
  getSummaryHistory: vi.fn(),
  getSummaryTags: vi.fn(),
  tagSummary: vi.fn(),
  deleteSummaryTag: vi.fn(),
  diffSummaryVersions: vi.fn(),
  updateSummary: vi.fn(),
}));

vi.mock('@arcaai/vox', () => ({
  useArca: () => ({ session: { consultation: state.consultation } }),
  useArcaSummary: () => ({
    loadSummaries: state.loadSummaries,
    getSummaryHistory: state.getSummaryHistory,
    getSummaryTags: state.getSummaryTags,
    tagSummary: state.tagSummary,
    deleteSummaryTag: state.deleteSummaryTag,
    diffSummaryVersions: state.diffSummaryVersions,
    updateSummary: state.updateSummary,
  }),
}));

import { SavedSummariesPanel } from '../saved-summaries-panel';

const SUMMARY = {
  id: 'sum-1',
  contextItemId: 'ctx-1',
  type: 'summary' as const,
  content: 'Patient presents with chest pain.',
  versionNumber: 2,
  structuredData: { cacheHit: true, qualityScore: 0.9 },
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  state.consultation = null;
  state.loadSummaries.mockResolvedValue([]);
  state.getSummaryHistory.mockResolvedValue([]);
  state.getSummaryTags.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('SavedSummariesPanel', () => {
  it('shows an informational state when no consultation is active', () => {
    render(<SavedSummariesPanel />);
    expect(screen.getByText(/Open a consultation/i)).toBeTruthy();
    expect(state.loadSummaries).not.toHaveBeenCalled();
  });

  it('loads summaries and shows the empty state when there are none', async () => {
    state.consultation = { id: 'c-1' };
    render(<SavedSummariesPanel />);
    await waitFor(() => expect(state.loadSummaries).toHaveBeenCalled());
    expect(await screen.findByTestId('summaries-empty')).toBeTruthy();
  });

  it('renders cacheHit and qualityScore badges for each summary', async () => {
    state.consultation = { id: 'c-1' };
    state.loadSummaries.mockResolvedValue([SUMMARY]);
    render(<SavedSummariesPanel />);

    expect(await screen.findByText('Patient presents with chest pain.')).toBeTruthy();
    expect(screen.getByText('cache hit')).toBeTruthy();
    expect(screen.getByText('quality 0.90')).toBeTruthy();
  });

  it('selecting a summary loads its versions + tags and lets you add a tag', async () => {
    state.consultation = { id: 'c-1' };
    state.loadSummaries.mockResolvedValue([SUMMARY]);
    state.tagSummary.mockResolvedValue({ id: 'tag-1', tagValue: 'reviewed' });
    render(<SavedSummariesPanel />);

    const row = await screen.findByText('Patient presents with chest pain.');
    fireEvent.click(row);

    await waitFor(() => expect(state.getSummaryHistory).toHaveBeenCalledWith('ctx-1'));
    expect(state.getSummaryTags).toHaveBeenCalledWith('ctx-1');

    const input = await screen.findByPlaceholderText('Add a tag…');
    fireEvent.change(input, { target: { value: 'reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/i }));

    await waitFor(() => expect(state.tagSummary).toHaveBeenCalledWith('ctx-1', { tagValue: 'reviewed' }));
  });
});
