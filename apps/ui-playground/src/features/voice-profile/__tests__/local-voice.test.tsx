/**
 * Smoke tests for the LOCAL (in-browser) voice provider UI (TASK-329 P4).
 *
 * These exercise the REAL shared `ImpersonationGuard` wrapping the REAL local
 * cards (exactly how `VoiceProfilePage` wires them) so the impersonation gate is
 * verified, plus the cards' render / progress / quick-test-result states.
 *
 * The heavy Transformers.js/ONNX model never loads here: `@arcaai/vox` is mocked
 * so `useLocalVoiceEmbedding` returns controllable state.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { ImpersonationGuard } from '@/components/impersonation-guard';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import { LocalEnrollCard, QuickTestCard } from '../local-voice';

// ── doctor context (drives the impersonation gate) ────────────────────
vi.mock('@/features/summarization/hooks/use-doctor-context', () => ({
  useDoctorContext: vi.fn(),
}));

// ── react-router Link (guard CTA) ─────────────────────────────────────
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

// ── @arcaai/ui subpaths (stubbed to {} by the playground vitest config) ─
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardDescription: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardTitle: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...props }: any) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...props }: any) => <span {...props}>{children}</span> }));
vi.mock('@arcaai/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...props }: any) => <label {...props}>{children}</label> }));
vi.mock('@arcaai/ui/progress', () => ({
  Progress: ({ value }: { value?: number }) => <div data-testid="progress" data-value={value} role="progressbar" />,
}));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (props: any) => <div data-testid="skeleton" {...props} /> }));

// ── sonner ─────────────────────────────────────────────────────────────
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockToastWarning = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
    warning: (...a: unknown[]) => mockToastWarning(...a),
  },
}));

// ── @arcaai/vox useLocalVoiceEmbedding mock (ONNX never loads) ──────────
const mockEnroll = vi.fn();
const mockQuickTest = vi.fn();

const defaultHookState = {
  supported: true,
  modelId: 'Xenova/wavlm-base-plus-sv',
  status: 'idle' as string,
  progress: null as { progress?: number; file?: string } | null,
  isBusy: false,
  error: null as Error | null,
  enrolled: [] as Array<{ profileId: string; label?: string | null; modelId: string; dim: number; embedding: number[]; createdAt: string }>,
  enroll: mockEnroll,
  quickTest: mockQuickTest,
  preloadModel: vi.fn(),
  clearLocal: vi.fn(),
};

let hookOverrides: Partial<typeof defaultHookState> = {};

vi.mock('@arcaai/vox', () => ({
  useLocalVoiceEmbedding: () => ({ ...defaultHookState, ...hookOverrides }),
}));

const mockUseDoctorContext = vi.mocked(useDoctorContext);

const baseCtx = {
  effectiveUserId: '',
  isImpersonated: false,
  requiresImpersonation: false,
  isAdmin: false,
  isDoctor: false,
  primaryDepartmentId: undefined,
  roles: [] as string[],
};

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeEnrolled(profileId = 'p-1') {
  return { profileId, label: 'Me', modelId: 'Xenova/wavlm-base-plus-sv', dim: 512, embedding: [0, 1], createdAt: new Date().toISOString() };
}

function uploadTo(ariaLabel: string, file: File) {
  const input = screen.getByLabelText(ariaLabel) as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: { 0: file, length: 1, item: () => file } });
  fireEvent.change(input);
}

describe('Voice Profile — LOCAL provider UI (TASK-329 P4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookOverrides = {};
    mockUseDoctorContext.mockReturnValue({ ...baseCtx });
    mockQuickTest.mockResolvedValue(null);
    mockEnroll.mockResolvedValue({ id: 'p-new' });
  });

  // ── impersonation gating (real guard + real cards) ──────────────────

  it('blocks the local workspace until impersonation is active', () => {
    mockUseDoctorContext.mockReturnValue({ ...baseCtx, requiresImpersonation: true, isAdmin: true, roles: ['TENANT_ADMIN'] });

    renderWithClient(
      <ImpersonationGuard featureName="voice profile">
        <LocalEnrollCard />
        <QuickTestCard />
      </ImpersonationGuard>,
    );

    expect(screen.getByText(/Impersonation Required/i)).toBeInTheDocument();
    expect(screen.queryByText(/Local Enrollment/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Quick Test/i)).not.toBeInTheDocument();
  });

  it('renders the local enroll + quick-test cards once impersonation is satisfied', () => {
    mockUseDoctorContext.mockReturnValue({ ...baseCtx, requiresImpersonation: false, isImpersonated: true });

    renderWithClient(
      <ImpersonationGuard featureName="voice profile">
        <LocalEnrollCard />
        <QuickTestCard />
      </ImpersonationGuard>,
    );

    expect(screen.getByText(/Local Enrollment/i)).toBeInTheDocument();
    expect(screen.getByText(/Quick Test/i)).toBeInTheDocument();
  });

  // ── LocalEnrollCard ─────────────────────────────────────────────────

  it('surfaces the local model id and disables enroll with no samples', () => {
    renderWithClient(<LocalEnrollCard />);
    expect(screen.getByText('Xenova/wavlm-base-plus-sv')).toBeInTheDocument();
    const enrollBtn = screen.getByRole('button', { name: /Enroll Locally/i });
    expect(enrollBtn).toBeDisabled();
  });

  it('shows model-load / extraction progress while busy', () => {
    hookOverrides = { isBusy: true, status: 'extracting', progress: { progress: 42, file: 'model.onnx' } };
    renderWithClient(<LocalEnrollCard />);
    const region = screen.getByTestId('local-progress');
    expect(region).toBeInTheDocument();
    expect(within(region).getByText(/Extracting voice embedding/i)).toBeInTheDocument();
    expect(screen.getByTestId('progress')).toHaveAttribute('data-value', '42');
  });

  it('shows the unsupported notice when in-browser extraction is unavailable', () => {
    hookOverrides = { supported: false };
    renderWithClient(<LocalEnrollCard />);
    expect(screen.getByText(/isn.t supported in this environment/i)).toBeInTheDocument();
  });

  // ── QuickTestCard ───────────────────────────────────────────────────

  it('shows an empty state when nothing is enrolled locally', () => {
    hookOverrides = { enrolled: [] };
    renderWithClient(<QuickTestCard />);
    expect(screen.getByTestId('quick-test-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upload Clip/i })).not.toBeInTheDocument();
  });

  it('renders a match result (score + Match badge) after a quick test upload', async () => {
    hookOverrides = { enrolled: [makeEnrolled('p-1')] };
    mockQuickTest.mockResolvedValueOnce({ profileId: 'p-1', score: 0.93, isMatch: true, threshold: 0.75 });

    renderWithClient(<QuickTestCard />);

    uploadTo('Upload audio file for quick test', new File([new Uint8Array([1, 2, 3])], 'probe.wav', { type: 'audio/wav' }));

    const result = await screen.findByTestId('quick-test-result');
    expect(result).toBeInTheDocument();
    expect(mockQuickTest).toHaveBeenCalledTimes(1);
    expect(screen.getByText('93.0%')).toBeInTheDocument();
    expect(screen.getByText(/^Match$/)).toBeInTheDocument();
  });

  it('renders a no-match result when the score is below threshold', async () => {
    hookOverrides = { enrolled: [makeEnrolled('p-9')] };
    mockQuickTest.mockResolvedValueOnce({ profileId: 'p-9', score: 0.41, isMatch: false, threshold: 0.75 });

    renderWithClient(<QuickTestCard />);
    uploadTo('Upload audio file for quick test', new File([new Uint8Array([4, 5, 6])], 'probe2.wav', { type: 'audio/wav' }));

    await screen.findByTestId('quick-test-result');
    expect(screen.getByText('41.0%')).toBeInTheDocument();
    expect(screen.getByText(/No match/i)).toBeInTheDocument();
  });

  // ── F9: friendly profile label (no raw UUID) ────────────────────────
  const PROFILE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('shows the enrolled profile LABEL — not the raw profileId UUID — for the closest match', async () => {
    hookOverrides = { enrolled: [makeEnrolled(PROFILE_UUID)] }; // label: 'Me'
    mockQuickTest.mockResolvedValueOnce({ profileId: PROFILE_UUID, score: 0.9, isMatch: true, threshold: 0.75 });

    renderWithClient(<QuickTestCard />);
    uploadTo('Upload audio file for quick test', new File([new Uint8Array([1])], 'probe.wav', { type: 'audio/wav' }));

    await screen.findByTestId('quick-test-result');
    expect(screen.getByText(/Closest profile:\s*Me/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(PROFILE_UUID))).not.toBeInTheDocument();
  });

  it('falls back to a shortened id when the matched profile has no label', async () => {
    hookOverrides = { enrolled: [{ ...makeEnrolled(PROFILE_UUID), label: null }] };
    mockQuickTest.mockResolvedValueOnce({ profileId: PROFILE_UUID, score: 0.9, isMatch: true, threshold: 0.75 });

    renderWithClient(<QuickTestCard />);
    uploadTo('Upload audio file for quick test', new File([new Uint8Array([1])], 'probe.wav', { type: 'audio/wav' }));

    await screen.findByTestId('quick-test-result');
    expect(screen.getByText(/Closest profile:\s*a1b2c3d4…/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(PROFILE_UUID))).not.toBeInTheDocument();
  });
});
