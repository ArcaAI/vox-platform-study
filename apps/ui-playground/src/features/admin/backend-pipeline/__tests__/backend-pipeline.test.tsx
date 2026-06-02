/**
 * BackendPipelinePage smoke test (TASK-328 A6)
 *
 * Verifies skeleton/empty states, auto-selection of the default pipeline, the
 * versions list, and that set-default / toggle / validate / save delegate to
 * the `usePipelines` hook with the right args (incl. OCC version). `@arcaai/vox`
 * and `@arcaai/ui/*` are stubbed by the playground vitest config, so we provide
 * explicit test doubles.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const usePipelines = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@arcaai/vox', () => ({ usePipelines: () => usePipelines() }));
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));

vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, variant, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, variant, size, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...p }: any) => <label {...p}>{children}</label> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: ({ ...p }: any) => <div {...p} /> }));
vi.mock('@arcaai/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...p }: any) => (
    <button role="switch" aria-checked={!!checked} onClick={() => onCheckedChange?.(!checked)} {...p} />
  ),
}));
vi.mock('@arcaai/ui/textarea', () => ({
  Textarea: ({ value, onChange, ...p }: any) => <textarea value={value} onChange={onChange} {...p} />,
}));

import BackendPipelinePage from '../index';

const p1 = { id: 'p1', name: 'Default Pipeline', slug: 'default', configYaml: 'cfg1', resourceStatus: 'ENABLED', isDefault: true, version: 1 };
const p2 = { id: 'p2', name: 'Beta Pipeline', slug: 'beta', configYaml: 'cfg2', resourceStatus: 'ENABLED', isDefault: false, version: 2 };

function makeHook(overrides: Record<string, unknown> = {}) {
  return {
    pipelines: [p1, p2],
    isLoading: false,
    error: null,
    list: vi.fn().mockResolvedValue([p1, p2]),
    updatePipeline: vi.fn().mockResolvedValue(p2),
    validateConfig: vi.fn().mockResolvedValue({ valid: true }),
    setDefault: vi.fn().mockResolvedValue(p2),
    toggle: vi.fn().mockResolvedValue(p2),
    listVersions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('BackendPipelinePage (TASK-328 A6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a skeleton while the initial load is in flight', () => {
    usePipelines.mockReturnValue(makeHook({ pipelines: [], isLoading: true, list: vi.fn(() => new Promise<never>(() => undefined)) }));
    render(<BackendPipelinePage />);
    expect(screen.getByTestId('backend-pipeline-skeleton')).toBeInTheDocument();
  });

  it('shows an empty state when the tenant has no pipelines', async () => {
    usePipelines.mockReturnValue(makeHook({ pipelines: [] }));
    render(<BackendPipelinePage />);
    expect(await screen.findByTestId('backend-pipeline-empty')).toBeInTheDocument();
  });

  it('auto-selects the default pipeline and lists its versions', async () => {
    const listVersions = vi.fn().mockResolvedValue([
      { id: 'v2', asrPipelineId: 'p1', versionNumber: 2, configYaml: 'cfg1-v2', changeReason: 'tweak', createdAt: '2026-02-18T00:00:00.000Z' },
      { id: 'v1', asrPipelineId: 'p1', versionNumber: 1, configYaml: 'cfg1-v1', createdAt: '2026-02-17T00:00:00.000Z' },
    ]);
    usePipelines.mockReturnValue(makeHook({ listVersions }));

    render(<BackendPipelinePage />);

    // Default (p1) is auto-selected → its versions load.
    await waitFor(() => expect(listVersions).toHaveBeenCalledWith('p1'));
    expect(await screen.findByTestId('version-row-2')).toBeInTheDocument();

    // Viewing a version reveals its read-only YAML.
    fireEvent.click(screen.getByTestId('view-version-btn-1'));
    expect(screen.getByTestId('viewed-version')).toHaveTextContent('cfg1-v1');
  });

  it('sets default and toggles the selected pipeline with the OCC version', async () => {
    const hook = makeHook();
    usePipelines.mockReturnValue(hook);

    render(<BackendPipelinePage />);

    // Select the non-default p2 (set-default is disabled while p1/default is active).
    fireEvent.click(await screen.findByTestId('pipeline-row-p2'));

    fireEvent.click(screen.getByTestId('set-default-btn'));
    await waitFor(() => expect(hook.setDefault).toHaveBeenCalledWith('p2'));

    // p2 is ENABLED → toggling requests disable, replaying version 2 for OCC.
    fireEvent.click(screen.getByTestId('toggle-switch'));
    await waitFor(() => expect(hook.toggle).toHaveBeenCalledWith('p2', false, 2));
  });

  it('validates and saves YAML (snapshotting a version) for the selected pipeline', async () => {
    const hook = makeHook();
    usePipelines.mockReturnValue(hook);

    render(<BackendPipelinePage />);
    fireEvent.click(await screen.findByTestId('pipeline-row-p2'));

    fireEvent.click(screen.getByTestId('validate-btn'));
    await waitFor(() => expect(hook.validateConfig).toHaveBeenCalledWith('cfg2'));

    fireEvent.click(screen.getByTestId('save-yaml-btn'));
    await waitFor(() => expect(hook.updatePipeline).toHaveBeenCalledWith('p2', { configYaml: 'cfg2', expectedVersion: 2 }));
    expect(toastSuccess).toHaveBeenCalled();
  });
});
