/**
 * VoiceEmbeddingPanel Tests (TASK-275)
 *
 * Locks the panel against the new `useVoiceEmbedding` surface
 * (`enroll`, `list`, `delete`, `profiles`, `isLoading`, `isUploading`, `error`)
 * delivered in TASK-265 D2. The legacy `upload(userId,file) / getStatus(userId)
 * / remove(userId)` shape must never be invoked.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// ── shadcn/ui mocks ────────────────────────────────────────────────

vi.mock('@arcaai/ui/card', () => ({
    Card: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div data-testid="card" {...props}>{children}</div>
    ),
    CardContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div data-testid="card-content" {...props}>{children}</div>
    ),
    CardDescription: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <p data-testid="card-description" {...props}>{children}</p>
    ),
    CardHeader: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div data-testid="card-header" {...props}>{children}</div>
    ),
    CardTitle: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <h3 data-testid="card-title" {...props}>{children}</h3>
    ),
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, onClick, disabled, ...props }: any) => (
        <button onClick={onClick} disabled={disabled} {...props}>
            {children}
        </button>
    ),
}));

vi.mock('@arcaai/ui/badge', () => ({
    Badge: ({ children, variant, ...props }: React.PropsWithChildren<{ variant?: string } & Record<string, unknown>>) => (
        <span data-testid="badge" data-variant={variant} {...props}>{children}</span>
    ),
}));

vi.mock('@arcaai/ui/skeleton', () => ({
    Skeleton: ({ className }: { className?: string }) => (
        <div data-testid="skeleton" className={className} />
    ),
}));

vi.mock('lucide-react', () => ({
    AudioWaveform: (props: any) => <svg data-testid="icon-audio-waveform" {...props} />,
    Upload: (props: any) => <svg data-testid="icon-upload" {...props} />,
    Trash2: (props: any) => <svg data-testid="icon-trash" {...props} />,
    RefreshCw: (props: any) => <svg data-testid="icon-refresh" {...props} />,
    Fingerprint: (props: any) => <svg data-testid="icon-fingerprint" {...props} />,
}));

// ── sonner toast mock ──────────────────────────────────────────────

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => mockToastSuccess(...args),
        error: (...args: unknown[]) => mockToastError(...args),
    },
}));

// ── @arcaai/vox useVoiceEmbedding mock ─────────────────────────────

const mockEnroll = vi.fn();
const mockList = vi.fn();
const mockDelete = vi.fn();

interface VoiceProfileForTest {
    id: string;
    label?: string;
    createdAt?: string;
    isActive?: boolean;
}

const defaultVoxState = {
    profiles: [] as VoiceProfileForTest[],
    isLoading: false,
    isUploading: false,
    error: null as Error | null,
    enroll: mockEnroll,
    list: mockList,
    delete: mockDelete,
};

let voxOverrides: Partial<typeof defaultVoxState> = {};

vi.mock('@arcaai/vox', () => ({
    useVoiceEmbedding: () => ({ ...defaultVoxState, ...voxOverrides }),
}));

// ── auth store mock ────────────────────────────────────────────────

vi.mock('@/store/auth-store', () => ({
    useAuthStore: () => ({
        user: { id: 'user-123', email: 'u@test', username: 'u', roles: [], permissions: [] },
    }),
}));

// ── import component under test (after all mocks) ──────────────────

import { VoiceEmbeddingPanel } from '../voice-embedding-panel';

// ── helpers ────────────────────────────────────────────────────────

function renderPanel(overrides: Partial<typeof defaultVoxState> = {}) {
    voxOverrides = overrides;
    return render(<VoiceEmbeddingPanel />);
}

function makeFile(name = 'sample.wav'): File {
    return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'audio/wav' });
}

function selectFile(file: File) {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    if (!input) throw new Error('No file input found');
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: { 0: file, length: 1, item: () => file },
    });
    fireEvent.change(input);
}

// ── tests ──────────────────────────────────────────────────────────

describe('VoiceEmbeddingPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        voxOverrides = {};
        mockEnroll.mockResolvedValue({ id: 'new-profile' });
        mockList.mockResolvedValue([]);
        mockDelete.mockResolvedValue(undefined);
    });

    // ── 1. mount behaviour ─────────────────────────────────────────

    it('calls list() on mount to fetch profiles', () => {
        renderPanel();
        expect(mockList).toHaveBeenCalled();
    });

    // ── 2. loading state ───────────────────────────────────────────

    it('renders Skeleton while profiles are loading', () => {
        renderPanel({ isLoading: true, profiles: [] });
        expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
    });

    // ── 3. empty state ─────────────────────────────────────────────

    it('renders an empty state when there are no profiles and not loading', () => {
        renderPanel({ profiles: [], isLoading: false });
        expect(screen.getByText(/no voice profile/i)).toBeInTheDocument();
    });

    // ── 4. renders profile rows ────────────────────────────────────

    it('renders one row per voice profile', () => {
        renderPanel({
            profiles: [
                { id: 'p-1', label: 'Profile One' },
                { id: 'p-2', label: 'Profile Two' },
            ],
        });
        expect(screen.getByText(/Profile One/i)).toBeInTheDocument();
        expect(screen.getByText(/Profile Two/i)).toBeInTheDocument();
    });

    // ── 4b. active/inactive status badge ───────────────────────────

    it('renders an "Inactive" badge (neutral variant) for a profile whose isActive is false', () => {
        renderPanel({
            profiles: [{ id: 'p-dormant', label: 'Dormant', isActive: false }],
        });
        const badge = screen.getByText('Inactive');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveAttribute('data-variant', 'outline');
        // The hardcoded "Active" badge must no longer appear for an inactive profile.
        expect(screen.queryByText('Active')).not.toBeInTheDocument();
    });

    it('renders an "Active" badge (default variant) for a profile whose isActive is true', () => {
        renderPanel({
            profiles: [{ id: 'p-primary', label: 'Primary', isActive: true }],
        });
        const badge = screen.getByText('Active');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveAttribute('data-variant', 'default');
    });

    // ── 5. sample queue: add ───────────────────────────────────────

    it('adds a queued sample row when a file is selected', () => {
        renderPanel();
        selectFile(makeFile('voice-1.wav'));
        expect(screen.getByText('voice-1.wav')).toBeInTheDocument();
    });

    // ── 6. MAX_SAMPLES gate ────────────────────────────────────────

    it('hides Add Voice Sample button after 3 samples are queued', () => {
        renderPanel();
        selectFile(makeFile('s1.wav'));
        selectFile(makeFile('s2.wav'));
        selectFile(makeFile('s3.wav'));
        expect(screen.queryByText(/Add Voice Sample/i)).not.toBeInTheDocument();
    });

    // ── 7. remove queued sample ────────────────────────────────────

    it('removes a queued sample when its trash button is clicked', () => {
        renderPanel();
        selectFile(makeFile('keepme.wav'));
        selectFile(makeFile('dropme.wav'));

        // Each queued sample row contains a trash icon inside a button. Find
        // the button for "dropme.wav" by walking from its label.
        const row = screen.getByText('dropme.wav').closest('div')!;
        const trashBtn = row.querySelector('button:last-of-type') as HTMLButtonElement;
        fireEvent.click(trashBtn);
        expect(screen.queryByText('dropme.wav')).not.toBeInTheDocument();
        expect(screen.getByText('keepme.wav')).toBeInTheDocument();
    });

    // ── 8. upload (enroll) ─────────────────────────────────────────

    it('calls enroll(file) when the sample Upload button is clicked', async () => {
        renderPanel();
        const file = makeFile('uploadme.wav');
        selectFile(file);

        const row = screen.getByText('uploadme.wav').closest('div')!;
        const uploadBtn = Array.from(row.querySelectorAll('button')).find((b) =>
            /upload/i.test(b.textContent ?? ''),
        ) as HTMLButtonElement;
        fireEvent.click(uploadBtn);

        // Wait a microtask for the async handler
        await Promise.resolve();
        await Promise.resolve();

        expect(mockEnroll).toHaveBeenCalledTimes(1);
        const arg = mockEnroll.mock.calls[0][0];
        // accept either File directly or array containing File
        const passedFile = Array.isArray(arg) ? arg[0] : arg;
        expect((passedFile as File).name).toBe('uploadme.wav');
    });

    // ── 9. upload failure ──────────────────────────────────────────

    it('shows an error toast when enroll() rejects', async () => {
        mockEnroll.mockRejectedValueOnce(new Error('boom'));
        renderPanel();
        selectFile(makeFile('fail.wav'));

        const row = screen.getByText('fail.wav').closest('div')!;
        const uploadBtn = Array.from(row.querySelectorAll('button')).find((b) =>
            /upload/i.test(b.textContent ?? ''),
        ) as HTMLButtonElement;
        fireEvent.click(uploadBtn);

        await Promise.resolve();
        await Promise.resolve();

        expect(mockToastError).toHaveBeenCalled();
    });

    // ── 10. delete profile ─────────────────────────────────────────

    it('calls delete(profileId) when the profile Delete button is clicked', async () => {
        renderPanel({
            profiles: [{ id: 'p-42', label: 'Deletable' }],
        });

        const deleteBtn = screen.getByLabelText('Delete voice profile p-42');
        fireEvent.click(deleteBtn);

        await Promise.resolve();
        await Promise.resolve();

        expect(mockDelete).toHaveBeenCalledWith('p-42');
    });

    // ── 11. delete failure ─────────────────────────────────────────

    it('shows an error toast when delete() rejects', async () => {
        mockDelete.mockRejectedValueOnce(new Error('nope'));
        renderPanel({ profiles: [{ id: 'p-7', label: 'Profile Seven' }] });

        const deleteBtn = screen.getByLabelText('Delete voice profile p-7');
        fireEvent.click(deleteBtn);

        await Promise.resolve();
        await Promise.resolve();

        expect(mockToastError).toHaveBeenCalled();
    });

    // ── 12. disable upload while uploading ─────────────────────────

    it('disables the sample Upload button while isUploading is true', () => {
        renderPanel({ isUploading: true });
        selectFile(makeFile('busy.wav'));

        const row = screen.getByText('busy.wav').closest('div')!;
        const uploadBtn = Array.from(row.querySelectorAll('button')).find((b) =>
            /upload/i.test(b.textContent ?? ''),
        ) as HTMLButtonElement;
        expect(uploadBtn).toBeDisabled();
    });
});
