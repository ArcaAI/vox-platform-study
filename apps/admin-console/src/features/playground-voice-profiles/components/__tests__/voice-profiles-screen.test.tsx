/**
 * Frame 52 — Playground voice profiles screen (TASK-434, matrix row 36).
 * fetch is stubbed at the network boundary by pathname (the api layer has its
 * own tests); MediaRecorder + getUserMedia are faked per test. Covers the
 * wizard validation rules (≤3 samples, ≤10 MB each, audio/* only), the
 * record flow (mic prompt, REC indicator, produced sample), the enroll
 * multipart submit + reset + list invalidation, activate/deactivate, the
 * destructive delete confirm, and the loading/empty/error states.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { VoiceProfile } from '../../api/types';
import { VoiceProfilesScreen } from '../voice-profiles-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    Reflect.deleteProperty(navigator, 'mediaDevices');
    FakeMediaRecorder.instances = [];
});

function profile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
    return {
        id: 'vp-1',
        userId: 'u-1',
        isActive: true,
        label: 'Default profile',
        modelId: 'mdl_7f3a92',
        createdAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-07-05T09:30:00.000Z',
        ...overrides,
    };
}

const PROFILES: VoiceProfile[] = [
    profile(),
    profile({ id: 'vp-2', isActive: false, label: null, modelId: null, createdAt: '2026-07-03T10:00:00.000Z', updatedAt: '2026-07-03T10:00:00.000Z' }),
];

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

type FetchHandler = (call: RecordedCall, parsed: URL) => Response | undefined;

function stubFetch(handler: FetchHandler = () => undefined): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: init?.body };
            calls.push(call);
            const parsed = new URL(call.url, 'http://test.local');
            const response =
                handler(call, parsed) ??
                (call.method === 'GET' && parsed.pathname === '/api/auth/session'
                    ? Response.json({ user: { username: 'admin' } })
                    : call.method === 'GET' && parsed.pathname === '/api/hope/voice-profile'
                      ? Response.json(PROFILES)
                      : undefined);
            if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
            return response;
        }),
    );
    return calls;
}

function listCalls(calls: RecordedCall[]): RecordedCall[] {
    return calls.filter((call) => call.method === 'GET' && new URL(call.url, 'http://test.local').pathname === '/api/hope/voice-profile');
}

/** Minimal MediaRecorder fake: stop() flushes one webm blob then fires onstop. */
class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];
    static isTypeSupported = () => true;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(public stream: unknown) {
        FakeMediaRecorder.instances.push(this);
    }
    start() {
        this.state = 'recording';
    }
    stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: 'audio/webm' }) });
        this.onstop?.();
    }
}

function stubMicrophone({ reject = false }: { reject?: boolean } = {}) {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const trackStop = vi.fn();
    const getUserMedia = reject
        ? vi.fn(async () => {
              throw new DOMException('Permission denied', 'NotAllowedError');
          })
        : vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    return { getUserMedia, trackStop };
}

function audioFile(name = 'greeting.wav', type = 'audio/wav'): File {
    return new File(['audio-bytes'], name, { type });
}

function oversizedAudioFile(): File {
    const file = audioFile('long-reading.wav');
    Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 });
    return file;
}

function uploadInput(): HTMLInputElement {
    return screen.getByLabelText('Upload audio samples') as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /enroll profile/i }) as HTMLButtonElement;
}

describe('VoiceProfilesScreen', () => {
    it('renders the header, the playground banner, the biometric chip and the profile list with active badge + fallbacks', async () => {
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Voice Profiles' })).toBeDefined();
        // Template subtitle + shared playground strip (this screen has no tenant gate).
        expect(screen.getByText(/enroll & manage speaker profiles/i)).toBeDefined();
        expect(screen.getByText(/demo sessions run under your own account/i)).toBeDefined();
        expect(screen.getByText(/user-owned only/i)).toBeDefined();

        expect(await screen.findByText('Default profile')).toBeDefined();
        expect(screen.getByText('Active')).toBeDefined();
        // Null label falls back; null modelId renders a pending hint, not a crash.
        expect(screen.getByText('Untitled profile')).toBeDefined();
        expect(screen.getByText('Inactive')).toBeDefined();
        expect(screen.getByText('mdl_7f3a92')).toBeDefined();
        // Footer: status + count on the left, endpoint hints on the right.
        expect(await screen.findByText(/up to date · 2 profiles/i)).toBeDefined();
        expect(screen.getByText('GET /voice-profile · POST /voice-profile/enroll')).toBeDefined();
        // Relative enrollment timestamps (rule 11 §8).
        expect(screen.getAllByText(/enrolled/i).length).toBeGreaterThanOrEqual(1);
    });

    it('keeps layout skeletons while the list is loading', () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        const { container } = renderWithProviders(<VoiceProfilesScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Voice Profiles' })).toBeDefined();
        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    });

    it('shows the empty state when no profiles are enrolled', async () => {
        stubFetch((call, parsed) => {
            if (call.method === 'GET' && parsed.pathname === '/api/hope/voice-profile') return Response.json([]);
            return undefined;
        });
        renderWithProviders(<VoiceProfilesScreen />);

        expect(await screen.findByText('No voice profiles yet')).toBeDefined();
        expect(screen.getByText(/up to 3 audio samples/i)).toBeDefined();
    });

    it('shows the list error state with a retry that refetches', async () => {
        const calls = stubFetch((call, parsed) => {
            if (call.method === 'GET' && parsed.pathname === '/api/hope/voice-profile') {
                return Response.json({ message: 'Voice profile API unreachable' }, { status: 503 });
            }
            return undefined;
        });
        renderWithProviders(<VoiceProfilesScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/voice profile api unreachable/i)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    });

    it('disables the enroll submit until at least one valid sample is staged', async () => {
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        expect(submitButton().disabled).toBe(true);
        expect(screen.getByText(/0 of 3 samples staged/i)).toBeDefined();
        // Template slot rows: all three fixed slots start empty.
        expect(screen.getAllByText('not recorded')).toHaveLength(3);
        expect(screen.getByRole('button', { name: 'Record sample 1' })).toBeDefined();

        fireEvent.change(uploadInput(), { target: { files: [audioFile()] } });

        expect(await screen.findByText('greeting.wav')).toBeDefined();
        expect(screen.getByText(/1 of 3 samples staged/i)).toBeDefined();
        expect(screen.getAllByText('not recorded')).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Record sample 2' })).toBeDefined();
        await waitFor(() => expect(submitButton().disabled).toBe(false));
    });

    it('rejects a non-audio file client-side with an inline destructive message', async () => {
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        expect(uploadInput().getAttribute('accept')).toBe('audio/*');
        fireEvent.change(uploadInput(), { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } });

        expect(await screen.findByText('notes.txt')).toBeDefined();
        expect(screen.getByText(/not an audio file/i)).toBeDefined();
        expect(submitButton().disabled).toBe(true);
    });

    it('rejects a sample over the 10 MB limit client-side', async () => {
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.change(uploadInput(), { target: { files: [oversizedAudioFile()] } });

        expect(await screen.findByText('long-reading.wav')).toBeDefined();
        expect(screen.getByText(/over the 10 MB per-sample limit/i)).toBeDefined();
        expect(submitButton().disabled).toBe(true);
    });

    it('caps staging at 3 samples and surfaces the limit', async () => {
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        const files = [audioFile('s1.wav'), audioFile('s2.wav'), audioFile('s3.wav'), audioFile('s4.wav')];
        fireEvent.change(uploadInput(), { target: { files } });

        expect(await screen.findByText('s3.wav')).toBeDefined();
        expect(screen.queryByText('s4.wav')).toBeNull();
        expect(screen.getAllByRole('button', { name: /^remove /i })).toHaveLength(3);
        expect(screen.getByText(/at most 3 samples/i)).toBeDefined();
    });

    it('removes a staged sample from its per-file card', async () => {
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.change(uploadInput(), { target: { files: [audioFile()] } });
        expect(await screen.findByText('greeting.wav')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Remove greeting.wav' }));
        await waitFor(() => expect(screen.queryByText('greeting.wav')).toBeNull());
        expect(submitButton().disabled).toBe(true);
    });

    it('enrolls via multipart POST with the label, toasts, resets the wizard and refetches the list', async () => {
        const enrolled = profile({ id: 'vp-3', label: 'Front desk mic' });
        const calls = stubFetch((call, parsed) => {
            if (call.method === 'POST' && parsed.pathname === '/api/hope/voice-profile/enroll') {
                return Response.json(enrolled, { status: 201 });
            }
            return undefined;
        });
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.change(uploadInput(), { target: { files: [audioFile()] } });
        await screen.findByText('greeting.wav');
        const labelInput = screen.getByLabelText(/profile name/i) as HTMLInputElement;
        expect(labelInput.maxLength).toBe(100);
        fireEvent.change(labelInput, { target: { value: 'Front desk mic' } });
        fireEvent.click(submitButton());

        await waitFor(() => {
            const enroll = calls.find((call) => call.method === 'POST' && call.url.includes('/voice-profile/enroll'));
            expect(enroll).toBeDefined();
        });
        const enrollCall = calls.find((call) => call.method === 'POST' && call.url.includes('/voice-profile/enroll'));
        const body = enrollCall?.body as FormData;
        expect(body).toBeInstanceOf(FormData);
        expect(body.getAll('files')).toHaveLength(1);
        expect(body.get('label')).toBe('Front desk mic');

        await waitFor(() => expect(toast.success).toHaveBeenCalled());
        // Reset after successful submit (rule 11 §9) + list invalidation.
        await waitFor(() => expect(screen.queryByText('greeting.wav')).toBeNull());
        expect(labelInput.value).toBe('');
        await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    });

    it('surfaces an enroll failure as an error toast and keeps the staged samples', async () => {
        stubFetch((call, parsed) => {
            if (call.method === 'POST' && parsed.pathname === '/api/hope/voice-profile/enroll') {
                return Response.json({ message: 'Audio too short for enrollment' }, { status: 400 });
            }
            return undefined;
        });
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.change(uploadInput(), { target: { files: [audioFile()] } });
        await screen.findByText('greeting.wav');
        fireEvent.click(submitButton());

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Audio too short for enrollment'));
        expect(screen.getByText('greeting.wav')).toBeDefined();
    });

    it('records a sample with MediaRecorder: REC indicator while recording, staged file on stop', async () => {
        stubMicrophone();
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.click(screen.getByRole('button', { name: /record sample/i }));

        expect(await screen.findByText(/REC SAMPLE/)).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));

        expect(await screen.findByText(/recording-\d+\.webm/)).toBeDefined();
        expect(screen.queryByText(/REC SAMPLE/)).toBeNull();
        await waitFor(() => expect(submitButton().disabled).toBe(false));
    });

    it('shows the mic-permission state when getUserMedia is denied', async () => {
        stubMicrophone({ reject: true });
        stubFetch();
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.click(screen.getByRole('button', { name: /record sample/i }));

        expect(await screen.findByText(/microphone access was denied/i)).toBeDefined();
        expect(screen.queryByText(/REC SAMPLE/)).toBeNull();
    });

    it('deactivates the active profile via PATCH :id/deactivate and refetches', async () => {
        const calls = stubFetch((call, parsed) => {
            if (call.method === 'PATCH' && parsed.pathname === '/api/hope/voice-profile/vp-1/deactivate') {
                return Response.json({ success: true });
            }
            return undefined;
        });
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.click(screen.getByRole('button', { name: 'Deactivate Default profile' }));

        await waitFor(() =>
            expect(calls.some((call) => call.method === 'PATCH' && call.url.includes('/voice-profile/vp-1/deactivate'))).toBe(true),
        );
        await waitFor(() => expect(toast.success).toHaveBeenCalled());
        await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    });

    it('activates an inactive profile via PATCH :id/activate', async () => {
        const calls = stubFetch((call, parsed) => {
            if (call.method === 'PATCH' && parsed.pathname === '/api/hope/voice-profile/vp-2/activate') {
                return Response.json({ success: true });
            }
            return undefined;
        });
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.click(screen.getByRole('button', { name: 'Set active Untitled profile' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && call.url.includes('/voice-profile/vp-2/activate'))).toBe(true));
    });

    it('deletes only after the destructive confirm dialog is accepted', async () => {
        const calls = stubFetch((call, parsed) => {
            if (call.method === 'DELETE' && parsed.pathname === '/api/hope/voice-profile/vp-1') {
                return Response.json(PROFILES[0]);
            }
            return undefined;
        });
        renderWithProviders(<VoiceProfilesScreen />);
        await screen.findByText('Default profile');

        fireEvent.click(screen.getByRole('button', { name: 'Delete Default profile' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getByText(/biometric/i)).toBeDefined();

        // Cancel first: no DELETE goes out.
        fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

        fireEvent.click(screen.getByRole('button', { name: 'Delete Default profile' }));
        const reopened = await screen.findByRole('alertdialog');
        fireEvent.click(within(reopened).getByRole('button', { name: /delete profile/i }));

        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/voice-profile/vp-1'))).toBe(true));
        await waitFor(() => expect(toast.success).toHaveBeenCalled());
        await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    });
});
