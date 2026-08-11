/**
 * ContextPanel remove-control test (TASK-342 GAP #3).
 *
 * The mid-visit context list was add-only; GAP #3 adds a per-row remove control
 * that soft-deletes the item via `DELETE /consultations/:id/context/:contextId`,
 * invalidates the context query, and toasts. `@arcaai/vox` + `@arcaai/ui/*` are
 * blanked by the ui-playground vitest config, so the bits the panel touches are
 * re-mocked here; the api + queries modules are mocked so the test drives the
 * delete seam directly.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (p: any) => <input {...p} /> }));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...p }: any) => <label {...p}>{children}</label> }));
vi.mock('@arcaai/ui/scroll-area', () => ({ ScrollArea: ({ children, ...p }: any) => <div {...p}>{children}</div> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (p: any) => <div {...p} /> }));
vi.mock('@arcaai/ui/tabs', () => ({
  Tabs: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  TabsList: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  TabsTrigger: ({ children, ...p }: any) => <button {...p}>{children}</button>,
  TabsContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/textarea', () => ({ Textarea: (p: any) => <textarea {...p} /> }));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const api = vi.hoisted(() => ({
  addContextItem: vi.fn(),
  deleteContextItem: vi.fn(),
}));
vi.mock('../../api/clinical-workspace.api', () => api);

const queryState = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  isLoading: false,
}));
vi.mock('../../api/queries', () => ({
  clinicalWorkspaceKeys: {
    context: (id: string) => ['clinical-workspace', 'context', id],
    highlights: (id: string) => ['clinical-workspace', 'highlights', id],
  },
  useContextItemsQuery: () => ({ data: queryState.items, isLoading: queryState.isLoading }),
  // TASK-344 Workstream B — persisted notes render a ManualHighlightSurface,
  // which consumes these hooks; stub them so the panel mounts.
  useHighlightsQuery: () => ({ data: [] }),
  useCreateHighlightMutation: () => ({ mutate: vi.fn() }),
  useDeleteHighlightMutation: () => ({ mutate: vi.fn() }),
}));

const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries }) }));

const storage = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock('@arcaai/vox', () => ({
  useArcaStore: (selector: any) => selector({ apiClient: { __fake: true } }),
  useStorage: () => storage,
}));

import { toast } from 'sonner';
import { ContextPanel } from '../context-panel';

describe('ContextPanel remove control (TASK-342 GAP #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.items = [
      { id: 'ctx-1', type: 'CASE_NOTE', content: 'BP 120/80' },
      { id: 'ctx-2', type: 'WORKNOTE', content: 'Follow up next week' },
    ];
    queryState.isLoading = false;
    api.deleteContextItem.mockResolvedValue({ ok: true });
    api.addContextItem.mockResolvedValue({ id: 'a-1' });
    // TASK-656 — key (the raw storage object key) and mediaId (the Media table
    // row UUID) are deliberately DIFFERENT values here so the assertion below
    // proves the component sends mediaId, not key.
    storage.uploadFile.mockResolvedValue({ key: 'raw-storage-key.txt', mediaId: 'media-1' });
  });

  it('renders a remove control for each added-context row', () => {
    render(<ContextPanel consultationId="c-1" />);

    expect(screen.getByTestId('remove-context-ctx-1')).toBeTruthy();
    expect(screen.getByTestId('remove-context-ctx-2')).toBeTruthy();
  });

  it('removing a row calls the delete API, toasts success, and invalidates the context query', async () => {
    render(<ContextPanel consultationId="c-1" />);

    fireEvent.click(screen.getByTestId('remove-context-ctx-1'));

    await waitFor(() => expect(api.deleteContextItem).toHaveBeenCalledWith({ __fake: true }, 'c-1', 'ctx-1'));
    expect(toast.success).toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['clinical-workspace', 'context', 'c-1'] });
  });

  it('shows an error toast when the delete fails', async () => {
    api.deleteContextItem.mockRejectedValueOnce(new Error('boom'));
    render(<ContextPanel consultationId="c-1" />);

    fireEvent.click(screen.getByTestId('remove-context-ctx-2'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('shows the mid-visit influence hint (live-summary influence + post-stop edits) (TASK-342 GAP #4)', () => {
    render(<ContextPanel consultationId="c-1" />);

    const hint = screen.getByTestId('mid-visit-influence-hint');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toMatch(/live summary/i);
    expect(hint.textContent).toMatch(/review/i);
  });

  it('extracts uploaded text-file contents into the add request metadata (TASK-342 GAP #5)', async () => {
    render(<ContextPanel consultationId="c-1" />);

    const file = new File(['WBC 11.2 x10^9/L (high)'], 'cbc.txt', { type: 'text/plain' });
    const input = document.getElementById('lab-file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    fireEvent.click(screen.getByRole('button', { name: /upload lab\/exam result/i }));

    await waitFor(() => expect(api.addContextItem).toHaveBeenCalled());
    const payload = api.addContextItem.mock.calls.at(-1)![2] as Record<string, any>;
    expect(payload.type).toBe('ATTACHMENT');
    expect(payload.mediaId).toBe('media-1');
    // GAP #5: the file's extracted CONTENTS ride along in metadata (so they reach
    // the live summary + harness), while `content` keeps the human-readable label.
    expect(payload.content).toBe('Lab/exam result: cbc.txt');
    expect(payload.metadata.extractedText).toBe('WBC 11.2 x10^9/L (high)');
  });
});
