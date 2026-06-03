/**
 * BackendPipelinesTab (TASK-331 doc-03 #2, #4, #10, #12)
 *
 * The consolidated Backend Pipelines tab: it unions the legacy Audio Pipelines
 * CRUD (list / create / edit / delete via the admin `useAudioPipelines` hooks)
 * with the Backend Pipeline management (set-default / enable-disable toggle /
 * versions via the `@arcaai/vox` `usePipelines` hook). Tenant scoping is the
 * store `tenantId` (single source of truth); a global-scope admin with no
 * tenant sees a "select a tenant" prompt and fires NO request.
 *
 * `@arcaai/vox`, `@arcaai/ui/*`, the admin api hooks, the config editor and the
 * shared admin components are all stubbed so the tab logic can be asserted in
 * isolation.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── controllable doubles ────────────────────────────────────────────
const mockUseAudioPipelines = vi.fn();
const createMutateAsync = vi.fn().mockResolvedValue({ id: 'new' });
const updateMutateAsync = vi.fn().mockResolvedValue({ id: 'p1' });
const deleteMutateAsync = vi.fn().mockResolvedValue(undefined);
const validateMutateAsync = vi.fn().mockResolvedValue({ valid: true });
const usePipelines = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

let mockIsGlobalScope = false;
let mockTenantId = 'tenant-1';
let mockTenantName = 'Acme Health';

vi.mock('../../api/audio-pipelines', () => ({
  useAudioPipelines: (...args: unknown[]) => mockUseAudioPipelines(...args),
  useCreateAudioPipeline: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  useUpdateAudioPipeline: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useDeleteAudioPipeline: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
  useValidateAudioPipelineYaml: () => ({ mutateAsync: validateMutateAsync, isPending: false }),
}));

vi.mock('@arcaai/vox', () => ({ usePipelines: () => usePipelines() }));
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => selector({ isGlobalScope: () => mockIsGlobalScope, tenantId: mockTenantId, tenantName: mockTenantName }),
}));

vi.mock('../pipeline-config-editor', () => ({
  PipelineConfigEditor: ({ value, onChange, readOnly }: any) => (
    <textarea aria-label={readOnly ? 'config-readonly' : 'config-editor'} value={value} readOnly={readOnly} onChange={(e) => onChange?.(e.target.value)} />
  ),
  configToYaml: () => 'version: "1.0"\n',
  DEFAULT_CONFIG: {},
}));

vi.mock('../../components', () => ({
  ConfirmDialog: ({ open, title, description, confirmLabel, onConfirm }: any) =>
    open ? (
      <div role="alertdialog" data-testid="delete-dialog">
        <p>{title}</p>
        <p data-testid="delete-description">{description}</p>
        <button data-testid="confirm-delete" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
  StatusBadge: ({ status }: any) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, variant, size, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, variant, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/input', () => ({ Input: ({ ...p }: any) => <input {...p} /> }));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...p }: any) => <label {...p}>{children}</label> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: ({ ...p }: any) => <div {...p} /> }));
vi.mock('@arcaai/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...p }: any) => <button role="switch" aria-checked={!!checked} onClick={() => onCheckedChange?.(!checked)} {...p} />,
}));
vi.mock('@arcaai/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children }: any) => <div>{children}</div>,
}));

import { BackendPipelinesTab } from '../backend-pipelines-tab';

const p1 = {
  id: 'p1',
  name: 'Default Pipeline',
  slug: 'default',
  description: 'the default',
  configYaml: 'cfg1',
  resourceStatus: 'ENABLED',
  isDefault: true,
  tags: [],
  tenantId: 'tenant-1',
  createdAt: '2026-02-17T00:00:00.000Z',
  updatedAt: '2026-02-18T00:00:00.000Z',
  version: 1,
};
const p2 = {
  id: 'p2',
  name: 'Beta Pipeline',
  slug: 'beta',
  description: '',
  configYaml: 'cfg2',
  resourceStatus: 'ENABLED',
  isDefault: false,
  tags: ['beta'],
  tenantId: 'tenant-1',
  createdAt: '2026-02-17T00:00:00.000Z',
  updatedAt: '2026-02-18T00:00:00.000Z',
  version: 2,
};

const refetch = vi.fn();

function audioPipelinesState(overrides: Record<string, unknown> = {}) {
  return { data: [p1, p2], isLoading: false, isRefetching: false, refetch, ...overrides };
}

function pipelinesHook(overrides: Record<string, unknown> = {}) {
  return {
    setDefault: vi.fn().mockResolvedValue(p2),
    toggle: vi.fn().mockResolvedValue(p2),
    listVersions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('BackendPipelinesTab (TASK-331 doc-03 #2/#4/#10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGlobalScope = false;
    mockTenantId = 'tenant-1';
    mockTenantName = 'Acme Health';
    mockUseAudioPipelines.mockReturnValue(audioPipelinesState());
    usePipelines.mockReturnValue(pipelinesHook());
  });

  it('shows a skeleton while the initial load is in flight', () => {
    mockUseAudioPipelines.mockReturnValue(audioPipelinesState({ data: undefined, isLoading: true }));
    render(<BackendPipelinesTab />);
    expect(screen.getByTestId('backend-pipelines-skeleton')).toBeInTheDocument();
  });

  it('shows a select-tenant prompt for a global-scope admin with no tenant and fires NO request', () => {
    mockIsGlobalScope = true;
    mockTenantId = '';
    render(<BackendPipelinesTab />);
    expect(screen.getByTestId('backend-pipelines-select-tenant')).toBeInTheDocument();
    // The admin list hook is invoked with an empty tenant (disabled internally),
    // and the imperative vox calls are never fired.
    expect(mockUseAudioPipelines).toHaveBeenCalledWith('');
    expect(usePipelines().listVersions).not.toHaveBeenCalled();
  });

  it('shows an empty state when the tenant has no pipelines', () => {
    mockUseAudioPipelines.mockReturnValue(audioPipelinesState({ data: [] }));
    render(<BackendPipelinesTab />);
    expect(screen.getByTestId('backend-pipelines-empty')).toBeInTheDocument();
  });

  it('auto-selects the default pipeline and lists its versions; view + load-into-editor work', async () => {
    const listVersions = vi.fn().mockResolvedValue([
      { id: 'v2', asrPipelineId: 'p1', versionNumber: 2, configYaml: 'cfg1-v2', changeReason: 'tweak', createdAt: '2026-02-18T00:00:00.000Z' },
      { id: 'v1', asrPipelineId: 'p1', versionNumber: 1, configYaml: 'cfg1-v1', createdAt: '2026-02-17T00:00:00.000Z' },
    ]);
    usePipelines.mockReturnValue(pipelinesHook({ listVersions }));

    render(<BackendPipelinesTab />);

    await waitFor(() => expect(listVersions).toHaveBeenCalledWith('p1'));
    expect(await screen.findByTestId('version-row-2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('view-version-btn-1'));
    expect(screen.getByTestId('viewed-version')).toHaveTextContent('cfg1-v1');

    // Load-into-editor switches to edit mode and seeds the editable config.
    fireEvent.click(screen.getByTestId('load-version-btn'));
    await waitFor(() => expect(screen.getByLabelText('config-editor')).toHaveValue('cfg1-v1'));
  });

  it('sets default and toggles the selected pipeline with the OCC version, then refetches', async () => {
    const hook = pipelinesHook();
    usePipelines.mockReturnValue(hook);

    render(<BackendPipelinesTab />);

    // Select the non-default p2 (set-default is disabled while p1/default is active).
    fireEvent.click(await screen.findByTestId('pipeline-row-p2'));

    fireEvent.click(screen.getByTestId('set-default-btn'));
    await waitFor(() => expect(hook.setDefault).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(refetch).toHaveBeenCalled());

    // p2 is ENABLED → toggling requests disable, replaying version 2 for OCC.
    fireEvent.click(screen.getByTestId('toggle-switch'));
    await waitFor(() => expect(hook.toggle).toHaveBeenCalledWith('p2', false, 2));
  });

  it('creates a pipeline (validates YAML, then creates)', async () => {
    render(<BackendPipelinesTab />);

    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    expect(await screen.findByTestId('create-pipeline-dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('create-name'), { target: { value: 'New Pipeline' } });
    fireEvent.change(screen.getByTestId('create-slug'), { target: { value: 'new-pipeline' } });

    fireEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => expect(validateMutateAsync).toHaveBeenCalled());
    await waitFor(() =>
      expect(createMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Pipeline', slug: 'new-pipeline' })),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('deletes the selected pipeline with soft-delete copy', async () => {
    render(<BackendPipelinesTab />);

    fireEvent.click(await screen.findByTestId('pipeline-row-p2'));
    fireEvent.click(screen.getByTestId('delete-btn'));

    expect(await screen.findByTestId('delete-dialog')).toBeInTheDocument();
    // #10 — copy must reflect the backend soft-delete, not "cannot be undone".
    expect(screen.getByTestId('delete-description')).toHaveTextContent(/soft-delete/i);
    expect(screen.getByTestId('delete-description')).not.toHaveTextContent(/cannot be undone/i);

    fireEvent.click(screen.getByTestId('confirm-delete'));
    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith('p2'));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('edits the selected pipeline (validates YAML, then updates with OCC)', async () => {
    render(<BackendPipelinesTab />);

    // p1 auto-selected. Enter edit mode.
    fireEvent.click(await screen.findByTestId('edit-btn'));

    const editor = await screen.findByLabelText('config-editor');
    fireEvent.change(editor, { target: { value: 'cfg1-edited' } });

    fireEvent.click(screen.getByTestId('save-edit-btn'));

    await waitFor(() => expect(validateMutateAsync).toHaveBeenCalledWith('cfg1-edited'));
    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', configYaml: 'cfg1-edited', expectedVersion: 1, ifMatch: '"1"' }),
      ),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('shows the editing tenant name (#12)', () => {
    render(<BackendPipelinesTab />);
    expect(screen.getByTestId('backend-pipelines-tenant')).toHaveTextContent('Acme Health');
  });
});
