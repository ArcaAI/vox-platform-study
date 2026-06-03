/**
 * FrontendPipelineTab (TASK-331 doc-03 #1, #12)
 *
 * The Frontend Pipeline surface, now a tab of the consolidated Audio Pipelines
 * page. Covers the migrated behaviour (skeleton / empty / hydrate+save with OCC)
 * AND the doc-03 #1 fix: gate on `isGlobalScope()` + store `tenantId`:
 *   - tenant admin → request targets the CLS tenant (`undefined`);
 *   - global scope + selected tenant → request carries that `tenantId`, saves;
 *   - global scope + no tenant → "select a tenant" prompt, fires NO request.
 *
 * `@arcaai/vox` and `@arcaai/ui/*` are stubbed by the playground vitest config,
 * so we provide explicit test doubles.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const useTenantFrontendConfig = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

let mockIsGlobalScope = false;
let mockTenantId = '';

vi.mock('@arcaai/vox', () => ({
  useTenantFrontendConfig: () => useTenantFrontendConfig(),
}));

vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => selector({ isGlobalScope: () => mockIsGlobalScope, tenantId: mockTenantId, user: { roles: ['TENANT_ADMIN'] } }),
}));

vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, variant, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, variant, size, ...p }: any) => <button {...p}>{children}</button>,
}));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/input', () => ({ Input: ({ ...p }: any) => <input {...p} /> }));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...p }: any) => <label {...p}>{children}</label> }));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children, value }: any) => (
    <div data-testid="select" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
}));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: ({ ...p }: any) => <div {...p} /> }));
vi.mock('@arcaai/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...p }: any) => <button role="switch" aria-checked={!!checked} onClick={() => onCheckedChange?.(!checked)} {...p} />,
}));

import { FrontendPipelineTab } from '../frontend-pipeline-tab';

const baseHook = () => ({
  config: null,
  isLoading: false,
  error: null,
  get: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
});

describe('FrontendPipelineTab (TASK-331 doc-03 #1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGlobalScope = false;
    mockTenantId = '';
  });

  it('shows a skeleton while the initial load is in flight', () => {
    useTenantFrontendConfig.mockReturnValue({
      ...baseHook(),
      isLoading: true,
      get: vi.fn(() => new Promise<never>(() => undefined)),
    });

    render(<FrontendPipelineTab />);

    expect(screen.getByTestId('frontend-pipeline-skeleton')).toBeInTheDocument();
  });

  it('a tenant admin loads the CLS tenant config (undefined target)', async () => {
    const hook = baseHook();
    useTenantFrontendConfig.mockReturnValue(hook);

    render(<FrontendPipelineTab />);

    expect(await screen.findByTestId('frontend-pipeline-empty')).toBeInTheDocument();
    expect(hook.get).toHaveBeenCalledWith(undefined);
  });

  it('a global-scope admin with a selected tenant issues the request with that tenantId and saves', async () => {
    mockIsGlobalScope = true;
    mockTenantId = 'tenant-xyz';
    const save = vi.fn().mockResolvedValue({ version: 6 });
    const hook = {
      ...baseHook(),
      config: {
        tenantId: 'tenant-xyz',
        asrModel: 'whisper-small',
        noiseCancel: true,
        vad: false,
        voiceEnrollment: false,
        diarization: true,
        configJson: { language: 'en' },
        version: 5,
      },
      save,
    };
    useTenantFrontendConfig.mockReturnValue(hook);

    render(<FrontendPipelineTab />);

    // The load targets the header-selected tenant.
    await waitFor(() => expect(hook.get).toHaveBeenCalledWith('tenant-xyz'));

    fireEvent.click(await screen.findByTestId('frontend-pipeline-save'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ asrModel: 'whisper-small', noiseCancel: true, diarization: true, expectedVersion: 5 }),
      'tenant-xyz',
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('a global-scope admin with NO tenant selected shows the select-tenant prompt and fires NO request', async () => {
    mockIsGlobalScope = true;
    mockTenantId = '';
    const hook = baseHook();
    useTenantFrontendConfig.mockReturnValue(hook);

    render(<FrontendPipelineTab />);

    expect(await screen.findByTestId('frontend-pipeline-select-tenant')).toBeInTheDocument();
    expect(hook.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('frontend-pipeline-form')).not.toBeInTheDocument();
  });

  it('surfaces a toast when save fails', async () => {
    const save = vi.fn().mockRejectedValue(new Error('conflict'));
    useTenantFrontendConfig.mockReturnValue({
      ...baseHook(),
      config: { tenantId: 't1', asrModel: '', noiseCancel: false, vad: false, voiceEnrollment: false, diarization: false, configJson: {}, version: 2 },
      save,
    });

    render(<FrontendPipelineTab />);
    fireEvent.click(await screen.findByTestId('frontend-pipeline-save'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('conflict'));
  });
});
