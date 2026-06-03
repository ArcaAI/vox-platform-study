/**
 * CaseNoteForm — context target (TASK-331 doc-06 F7)
 *
 * `addContextItem` must POST against the `consultationId` *prop*, not the
 * store's active consultation id. The two diverge whenever the rendered
 * consultation isn't the last-loaded session (e.g. a workspace "Add" dialog),
 * so the prop is the only correct target.
 *
 * `@arcaai/vox` + `@arcaai/ui/*` are globally stubbed by the vitest config, so
 * each is mocked here with render-through shims.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const post = vi.hoisted(() => vi.fn());
const storeAddContextItem = vi.hoisted(() => vi.fn());

vi.mock('@arcaai/vox', () => ({
  useArca: () => ({ context: { addCaseNote: vi.fn(), addTranscription: vi.fn() } }),
  useStorage: () => ({ uploadFile: vi.fn() }),
  useStoreApi: () => ({
    getState: () => ({
      apiClient: { post },
      // The store's active consultation id intentionally differs from the prop.
      consultation: { id: 'STORE-CONSULTATION-ID' },
      addContextItem: storeAddContextItem,
    }),
  }),
  CONTEXT_ENDPOINTS: { ADD: (id: string) => `/consultations/${id}/context` },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...p }: any) => <label {...p}>{children}</label> }));
vi.mock('@arcaai/ui/textarea', () => ({ Textarea: (p: any) => <textarea {...p} /> }));
vi.mock('@arcaai/ui/input', () => ({ Input: (p: any) => <input {...p} /> }));
vi.mock('@arcaai/ui/tabs', () => ({
  Tabs: ({ children }: any) => <div>{children}</div>,
  TabsList: ({ children }: any) => <div>{children}</div>,
  TabsTrigger: ({ children }: any) => <button>{children}</button>,
  TabsContent: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectGroup: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

import { CaseNoteForm } from '../components/case-note-form';

describe('CaseNoteForm — context target (TASK-331 doc-06 F7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({ id: 'ctx-1', type: 'WORKNOTE', content: 'hi', source: 'USER' });
  });

  it('posts the new context item against the consultationId prop, not the store id', async () => {
    render(<CaseNoteForm consultationId="PROP-CONSULTATION-ID" />);

    const worknote = document.querySelector('#wn-content') as HTMLTextAreaElement;
    expect(worknote).toBeTruthy();
    fireEvent.change(worknote, { target: { value: 'A standalone work note' } });
    fireEvent.click(screen.getByText('Add Work Note'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/consultations/PROP-CONSULTATION-ID/context', expect.objectContaining({ type: 'WORKNOTE' }));
    // Guard against regression to the store id.
    expect(post).not.toHaveBeenCalledWith('/consultations/STORE-CONSULTATION-ID/context', expect.anything());
  });
});
