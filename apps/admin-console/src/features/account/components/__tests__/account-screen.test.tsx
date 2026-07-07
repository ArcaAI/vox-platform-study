/**
 * TDD screen tests for frame 25 (account half — Account): identity from the
 * BFF session, per-row "My settings" edits over PATCH
 * /user/me/settings/:namespace/:key, and the preferences form over PATCH
 * /user/me/preferences (real fields only: workflowMode/language/dnaStyleId).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserSetting } from '@/features/users/api/types';
import type { SafeSession } from '@/shared/auth/hooks';
import { renderWithProviders } from '@/test/render';
import type { UserPreferences } from '../../api/types';
import { AccountScreen } from '../account-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SESSION: SafeSession = {
    user: { id: 'u-1', username: 'super_admin', email: 'root@hope.dev', roles: ['GLOBAL_ADMIN'], tenantId: null },
    isElevated: true,
    workingTenantId: 'ten-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
};

const SETTING: UserSetting = {
    id: 'set-1',
    projectId: null,
    createdAt: '2026-06-01T08:00:00.000Z',
    updatedAt: '2026-07-01T09:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    name: 'Selected pipeline',
    key: 'selectedPipelineId',
    value: 'pipe-1',
    dataType: 'string',
    namespace: 'arcaai-sdk',
    userId: 'u-1',
};

const PREFERENCES: UserPreferences = {
    workflowMode: 'local',
    language: 'sv-SE',
    remoteConfig: { pipelineId: 'pipe-1', pipelineName: 'Nordic clinical ASR', assignedBy: 'admin', codeSwitchingEnabled: true },
    activeVoiceProfile: { id: 'vp-1', label: 'Clinic mic', modelId: 'm-1', createdAt: '2026-05-20T08:00:00.000Z' },
    transcriptionMode: 'LOCAL',
    transcriptionModeLocked: false,
    updatedAt: '2026-07-01T09:00:00.000Z',
};

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

type Handler = (url: string, method: string) => Response | Promise<Response>;

function stubFetch(handler: Handler): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
            return handler(url, method);
        }),
    );
    return calls;
}

function happyHandler(overrides: { settings?: () => Response } = {}): Handler {
    return (url, method) => {
        if (url === '/api/auth/session') return Response.json(SESSION);
        if (url.includes('/user/me/settings/')) return Response.json({ ...SETTING, value: 'pipe-2' });
        if (url.includes('/user/me/settings')) return (overrides.settings ?? (() => Response.json([SETTING])))();
        if (url.includes('/user/me/preferences')) {
            if (method === 'PATCH') return Response.json(PREFERENCES);
            return Response.json(PREFERENCES);
        }
        throw new Error(`Unexpected fetch in test: ${method} ${url}`);
    };
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('AccountScreen', () => {
    it('renders the session identity card with roles and working tenant', async () => {
        stubFetch(happyHandler());
        renderWithProviders(<AccountScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeDefined();
        const identity = await screen.findByRole('region', { name: 'Identity' });
        expect(within(identity).getByText('super_admin')).toBeDefined();
        expect(within(identity).getByText('root@hope.dev')).toBeDefined();
        expect(within(identity).getByText('GLOBAL_ADMIN')).toBeDefined();
        expect(within(identity).getByText('Sunrise Medical Group')).toBeDefined();
        expect(within(identity).getByText('SA')).toBeDefined();
    });

    it('saving a setting PATCHes the namespaced key and toasts', async () => {
        const calls = stubFetch(happyHandler());
        renderWithProviders(<AccountScreen />);

        const input = await screen.findByLabelText('Value for selectedPipelineId');
        fireEvent.change(input, { target: { value: 'pipe-2' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save selectedPipelineId' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1));
        const patch = calls.find((call) => call.method === 'PATCH');
        expect(patch?.url).toBe('/api/hope/user/me/settings/arcaai-sdk/selectedPipelineId');
        expect(patch?.body).toEqual({ value: 'pipe-2' });
        await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled());
    });

    it('renders read-only pipeline info and saving preferences PATCHes the edited fields with a toast', async () => {
        const calls = stubFetch(happyHandler());
        renderWithProviders(<AccountScreen />);

        // Read-only assignment info from the preferences payload.
        const preferences = await screen.findByRole('region', { name: 'Preferences' });
        expect(within(preferences).getByText('Nordic clinical ASR')).toBeDefined();
        expect(within(preferences).getByText('Clinic mic')).toBeDefined();

        const language = within(preferences).getByLabelText('Language');
        expect((language as HTMLInputElement).value).toBe('sv-SE');
        fireEvent.change(language, { target: { value: 'nb-NO' } });
        fireEvent.click(within(preferences).getByRole('button', { name: 'Save preferences' }));

        await waitFor(() =>
            expect(calls.filter((call) => call.method === 'PATCH' && call.url === '/api/hope/user/me/preferences')).toHaveLength(1),
        );
        const patch = calls.find((call) => call.method === 'PATCH');
        expect(patch?.body).toEqual({ workflowMode: 'local', language: 'nb-NO' });
        await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Preferences saved'));
    });

    it('shows an empty state when the user has no settings yet', async () => {
        stubFetch(happyHandler({ settings: () => Response.json([]) }));
        renderWithProviders(<AccountScreen />);

        expect(await screen.findByText('No settings yet')).toBeDefined();
    });

    it('mirrors the loaded layout with skeletons while the session is in flight', () => {
        stubFetch(() => new Promise<Response>(() => {}));
        const { container } = renderWithProviders(<AccountScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByRole('region', { name: 'Identity' })).toBeNull();
    });
});
