/**
 * (R2) — the Studio must offer a way to TEST the definition being
 * edited. The sandbox plane already exists end-to-end at `/playground/workbench`
 * (fixture picker, start/status/cancel, per-node rollup inspector,
 * sandbox badge + banner) and accepts `?definitionId=`; what was missing was
 * reachability from the editor.
 *
 * Rule 13 "one authoritative editor per backend resource": the Workbench owns
 * running a definition, so the Studio demotes to a plain-href DEEP LINK — never
 * a cross-feature import, and never a second sandbox client.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioToolbar } from '../studio-toolbar';

afterEach(cleanup);

const base = {
  viewMode: 'canvas' as const,
  onViewModeChange: vi.fn(),
  onValidate: vi.fn(),
  onPublish: vi.fn(),
  publishDisabledReason: null,
  canUndo: false,
  canRedo: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
};

describe('StudioToolbar — sandbox test affordance (W1)', () => {
  it('links to the Workbench for the definition being edited once autosave is settled', () => {
    render(<StudioToolbar {...base} autosaveState="saved" sandboxDefinitionId="def-123" />);

    const link = screen.getByRole('link', { name: /test in workbench/i });
    expect(link.getAttribute('href')).toBe('/playground/workbench?definitionId=def-123');
  });

  it('names the sandbox in the affordance so a sandbox run can never be mistaken for a real one', () => {
    render(<StudioToolbar {...base} autosaveState="saved" sandboxDefinitionId="def-123" />);

    // "Sandbox" must be readable text, not conveyed by an icon or colour alone (rule 11 §7/§11).
    expect(screen.getByRole('link', { name: /test in workbench/i }).getAttribute('title')).toMatch(/sandbox/i);
  });

  it('blocks the link while autosave is still in flight — the sandbox runs the SERVER graph, not the buffer', () => {
    render(<StudioToolbar {...base} autosaveState="saving" sandboxDefinitionId="def-123" />);

    expect(screen.queryByRole('link', { name: /test in workbench/i })).toBeNull();
    expect(screen.getByText(/saving/i)).toBeTruthy();
  });

  it('blocks the link when autosave is in conflict or failed, with a visible reason', () => {
    render(<StudioToolbar {...base} autosaveState="conflict" sandboxDefinitionId="def-123" />);

    expect(screen.queryByRole('link', { name: /test in workbench/i })).toBeNull();
    expect(screen.getByText(/unsaved changes are not in the sandbox run/i)).toBeTruthy();
  });

  it('is offered on a read-only (published) version too — a published graph is the one most worth testing', () => {
    render(<StudioToolbar {...base} autosaveState="idle" readOnly sandboxDefinitionId="def-123" />);

    expect(screen.getByRole('link', { name: /test in workbench/i })).toBeTruthy();
  });

  it('renders nothing when there is no definition id (create-mode)', () => {
    render(<StudioToolbar {...base} autosaveState="idle" sandboxDefinitionId={null} />);

    expect(screen.queryByRole('link', { name: /test in workbench/i })).toBeNull();
  });

  it('0 axe violations', async () => {
    const { container } = render(<StudioToolbar {...base} autosaveState="saved" sandboxDefinitionId="def-123" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
