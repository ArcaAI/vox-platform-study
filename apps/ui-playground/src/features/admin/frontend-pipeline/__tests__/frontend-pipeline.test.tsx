/**
 * FrontendPipelinePage smoke test (TASK-328 A6)
 *
 * Verifies skeleton/empty states, form hydration from the loaded config, and
 * that Save delegates to the `useTenantFrontendConfig` hook with the OCC
 * `expectedVersion`. `@arcaai/vox` and `@arcaai/ui/*` are stubbed by the
 * playground vitest config, so we provide explicit test doubles.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const useTenantFrontendConfig = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@arcaai/vox', () => ({
  useTenantFrontendConfig: () => useTenantFrontendConfig(),
}));

vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));

vi.mock('@/store/auth-store', () => ({
  // Tenant admin by default → tenantId resolves to undefined (CLS tenant wins).
  useAuthStore: (selector: any) => selector({ isSuperAdmin: () => false, tenantKey: '', user: { roles: ['TENANT_ADMIN'] } }),
}));

vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, variant, size, ...p }: any) => (
    <button {...p}>{children}</button>
  ),
}));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/input', () => ({
  Input: ({ ...p }: any) => <input {...p} />,
}));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...p }: any) => <label {...p}>{children}</label> }));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children, value }: any) => <div data-testid="select" data-value={value}>{children}</div>,
  SelectTrigger: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
}));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: ({ ...p }: any) => <div {...p} /> }));
vi.mock('@arcaai/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...p }: any) => (
    <button role="switch" aria-checked={!!checked} onClick={() => onCheckedChange?.(!checked)} {...p} />
  ),
}));

import FrontendPipelinePage from '../index';

const baseHook = () => ({
  config: null,
  isLoading: false,
  error: null,
  get: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
});

describe('FrontendPipelinePage (TASK-328 A6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a skeleton while the initial load is in flight', () => {
    useTenantFrontendConfig.mockReturnValue({
      ...baseHook(),
      isLoading: true,
      get: vi.fn(() => new Promise<never>(() => undefined)), // never resolves
    });

    render(<FrontendPipelinePage />);

    expect(screen.getByTestId('frontend-pipeline-skeleton')).toBeInTheDocument();
  });

  it('renders an empty-state notice when no config exists yet', async () => {
    const hook = baseHook();
    useTenantFrontendConfig.mockReturnValue(hook);

    render(<FrontendPipelinePage />);

    expect(await screen.findByTestId('frontend-pipeline-empty')).toBeInTheDocument();
    expect(hook.get).toHaveBeenCalledWith(undefined);
  });

  it('hydrates the form from config and saves with the OCC expectedVersion', async () => {
    const save = vi.fn().mockResolvedValue({ version: 6 });
    useTenantFrontendConfig.mockReturnValue({
      ...baseHook(),
      config: {
        tenantId: 't1',
        asrModel: 'whisper-small',
        noiseCancel: true,
        vad: false,
        voiceEnrollment: false,
        diarization: true,
        configJson: { language: 'en' },
        version: 5,
      },
      save,
    });

    render(<FrontendPipelinePage />);

    fireEvent.click(await screen.findByTestId('frontend-pipeline-save'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ asrModel: 'whisper-small', noiseCancel: true, diarization: true, expectedVersion: 5 }),
      undefined,
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('surfaces a toast when save fails', async () => {
    const save = vi.fn().mockRejectedValue(new Error('conflict'));
    useTenantFrontendConfig.mockReturnValue({
      ...baseHook(),
      config: { tenantId: 't1', asrModel: '', noiseCancel: false, vad: false, voiceEnrollment: false, diarization: false, configJson: {}, version: 2 },
      save,
    });

    render(<FrontendPipelinePage />);
    fireEvent.click(await screen.findByTestId('frontend-pipeline-save'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('conflict'));
  });
});
