/**
 * Speech & Voice (`/ai-configuration`, tier 30-49). TASK-862 relocated the
 * screen out of the deleted `features/ai-task-defaults`; TASK-888 moved it again,
 * into `features/tenant-stt-config`, when `TenantTtsConfig` was retired and the
 * Voice tab stopped reading anything at all. These specs pin what it still is:
 * two `<RequirePermission>`-gated tabs, the working-tenant gate, the link to
 * `/ai-providers` (where the provider keys went), the links to the agents that
 * own voice now, and a clean axe run in both themes.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PermissionRule } from '@/shared/auth/ability';
import { SpeechAndVoiceScreen } from '../speech-and-voice-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const ALL: PermissionRule[] = [{ action: 'manage', subject: 'all' }];

const TENANT_SESSION = {
  user: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'] },
  isElevated: false,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: 'tnt-1', departmentId: null },
  effectiveIsElevated: false,
  effectiveTenantId: 'tnt-1' as string | null,
};

const ELEVATED_NO_TENANT_SESSION = {
  ...TENANT_SESSION,
  user: { id: 'u-9', username: 'super_admin', email: 'root@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  effectiveIsElevated: true,
  workingTenantId: null,
  workingTenantName: null,
  effectiveTenantId: null,
};

const STT_EFFECTIVE = { tenantId: 'tnt-1', fallbackPipelineId: null, autoSwitchEnabled: false, consecutiveFailureThreshold: 3 };
const STT_ROW = { tenantId: 'tnt-1', autoSwitchEnabled: false, consecutiveFailureThreshold: 3, version: 0 };

function stubFetch({ session = TENANT_SESSION, permissions = ALL }: { session?: typeof TENANT_SESSION; permissions?: PermissionRule[] } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const raw = String(input);
      if (raw === '/api/auth/session') return Response.json(session);
      if (raw === '/api/hope/users/me/permission-checks') return Response.json({ userId: 'u-1', tenantId: 'tnt-1', permissions });
      const path = new URL(raw, 'http://test.local').pathname;
      if (method === 'GET' && path === '/api/hope/admin/stt-config') return Response.json(STT_EFFECTIVE);
      if (method === 'GET' && path === '/api/hope/admin/stt-config/row') return Response.json(STT_ROW);
      if (method === 'GET' && path === '/api/hope/admin/stt-config/fallback-candidates') return Response.json([]);
      // No `admin/tts-config*` stub at all: TASK-888 deleted the routes with the
      // model, so a regression that re-introduces a read surfaces here as an
      // unhandled fetch rather than quietly passing.
      throw new Error(`Unhandled fetch: ${method} ${raw}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SpeechAndVoiceScreen — structure', () => {
  it('renders exactly the two bindings tabs', async () => {
    stubFetch();
    renderWithProviders(<SpeechAndVoiceScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Speech & Voice' })).toBeDefined();
    expect(await screen.findByRole('tab', { name: 'Speech' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Voice' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Models' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Providers' })).toBeNull();
  });

  it('points at /ai-providers, where the provider keys went (TASK-862)', async () => {
    stubFetch();
    renderWithProviders(<SpeechAndVoiceScreen />);

    const link = await screen.findByRole('link', { name: /providers & keys/i });
    expect(link.getAttribute('href')).toBe('/ai-providers');
  });

  it('renders a retirement notice on BOTH tabs — neither surface is editable any more', async () => {
    stubFetch();
    renderWithProviders(<SpeechAndVoiceScreen />, { searchParams: '?tab=speech' });
    expect(await screen.findByRole('heading', { name: /Speech fallback moved to the ASR agent/i })).toBeDefined();
    cleanup();

    stubFetch();
    renderWithProviders(<SpeechAndVoiceScreen />, { searchParams: '?tab=voice' });
    expect(await screen.findByRole('heading', { name: /Voice settings moved to the text-to-speech agent/i })).toBeDefined();
  });

  it('the Voice tab reads NOTHING and is only the way through to the agents', async () => {
    // TASK-879 made the speech path agent-first and TASK-888 dropped the row, so
    // there is nothing left to show — but the links are the reason an admin who
    // knows this screen still comes back to it.
    stubFetch();
    renderWithProviders(<SpeechAndVoiceScreen />, { searchParams: '?tab=voice' });

    const link = await screen.findByRole('link', { name: /open text-to-speech agents/i });
    expect(link.getAttribute('href')).toBe('/agents?task=TEXT_TO_SPEECH');
    expect(screen.queryByRole('heading', { name: /Retired TTS config row/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('shows only the tab whose resource the caller can read', async () => {
    stubFetch({ permissions: [{ action: 'read', subject: 'TenantSttConfig' }] });
    renderWithProviders(<SpeechAndVoiceScreen />, { searchParams: '?tab=speech' });

    expect(await screen.findByRole('tab', { name: 'Speech' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Voice' })).toBeNull();
  });

  it('gates an elevated session without a working tenant on the NoTenant empty state', async () => {
    stubFetch({ session: ELEVATED_NO_TENANT_SESSION });
    renderWithProviders(<SpeechAndVoiceScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });
});

describe('SpeechAndVoiceScreen — accessibility', () => {
  it.each([
    ['speech', ''],
    ['voice', '?tab=voice'],
  ])('has no axe violations on the %s tab (light theme)', async (_label, searchParams) => {
    stubFetch();
    const { container } = renderWithProviders(<SpeechAndVoiceScreen />, { searchParams });

    await screen.findByRole('heading', { level: 1, name: 'Speech & Voice' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<SpeechAndVoiceScreen />);
      await screen.findByRole('heading', { level: 1, name: 'Speech & Voice' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
