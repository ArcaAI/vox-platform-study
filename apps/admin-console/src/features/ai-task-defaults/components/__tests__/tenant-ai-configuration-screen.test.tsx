/**
 * Tenant "AI Configuration" hub (tier 30-49, /ai-configuration) —.
 *
 * The single tenant AI surface, absorbing the retired standalone `/stt-config`,
 * `/tts-config` and `/ai-providers` screens into four tabs:
 *   - "Models" — tenant text-generation selection (editable) + read-only effective
 *     guardrail/nlp/harness models & HarnessPolicy. Backed by `AiTaskDefault`.
 *   - "Speech" — tenant STT fallback editor. Backed by `TenantSttConfig`.
 *   - "Voice" — tenant TTS config editor. Backed by `TenantTtsConfig`.
 *   - "Providers" — the one authoritative BYO credential editor (LLM/STT/TTS).
 *     Backed by `GlobalSetting`.
 *
 * Each tab spans a different resource, so every tab is `<RequirePermission
 * action="read" …>`-gated; the nav entry is OR-gated over the four reads.
 * These tests stub `/rbac/check/my-permissions` to drive that gating.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PermissionRule } from '@/shared/auth/ability';
import { AI_TASK_KEYS, READ_ONLY_TASK_KEYS, TEXT_FALLBACK_TASK_KEYS, TEXT_PRIMARY_TASK_KEYS, TEXT_TEST_TASK_KEYS } from '../../api/types';
import type { EffectiveAiTaskDefault, TaskModelOption } from '../../api/types';
import { TenantAiConfigurationScreen } from '../tenant-ai-configuration-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/** Grants every subject/action — the common case (a tenant admin with manage:all). */
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

const ELEVATED_WITH_TENANT_SESSION = {
  ...TENANT_SESSION,
  user: { id: 'u-9', username: 'super_admin', email: 'root@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  effectiveIsElevated: true,
};

const ELEVATED_NO_TENANT_SESSION = {
  ...ELEVATED_WITH_TENANT_SESSION,
  workingTenantId: null,
  workingTenantName: null,
  effectiveTenantId: null,
};

function effectiveOf(taskKey: string, source: 'tenant' | 'system' | null = 'system'): EffectiveAiTaskDefault {
  return {
    tenantId: 'tnt-1',
    taskKey,
    modelSlug: `${taskKey}-model`,
    source,
    configJson: null,
    model: {
      id: `m-${taskKey}`,
      slug: `${taskKey}-model`,
      name: `Model for ${taskKey}`,
      provider: 'lm-studio',
      architecture: null,
      taskType: 'TEXT_GENERATION',
      format: 'GGUF',
      sourceUri: `${taskKey}-model`,
    },
  };
}

function harnessPolicySummary() {
  return {
    id: 'hp-1',
    tenantId: 'tnt-1',
    source: 'tenant' as const,
    entityFaithfulnessThreshold: 0.8,
    coverageThreshold: 0.75,
    citationPresenceThreshold: 0.6,
    numericDoseThreshold: 0.9,
    groundednessThreshold: 0.7,
    safetyEnabled: true,
    phiEnabled: true,
    phiFailClosed: true,
    textProvider: null,
    textModel: null,
    maxRegen: 2,
    gateSlaSeconds: 300,
    gateEscalationSeconds: 600,
    toolAllowlist: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 4,
  };
}

function taskModelOption(): TaskModelOption {
  return {
    id: 'opt-gpt4o',
    name: 'GPT-4o',
    slug: 'gpt-4o',
    provider: 'openai',
    architecture: null,
    taskType: 'TEXT_GENERATION',
    format: 'API',
    sourceUri: 'gpt-4o',
    resourceStatus: 'ENABLED',
  };
}

const STT_EFFECTIVE = { tenantId: 'tnt-1', fallbackPipelineId: null, autoSwitchEnabled: false, consecutiveFailureThreshold: 3 };
const STT_ROW = { tenantId: 'tnt-1', autoSwitchEnabled: false, consecutiveFailureThreshold: 3, version: 0 };
const TTS_EFFECTIVE = {
  tenantId: 'tnt-1',
  routingEn: ['azure'],
  routingMl: ['sarvam'],
  allowedProviders: ['azure', 'sarvam'],
  defaultVoiceEn: 'en-female-1',
  defaultVoiceMl: 'ml-female-1',
  defaultFormat: 'wav',
  defaultSpeed: 1,
  sampleRate: 24000,
  maxInputChars: 2000,
  sarvamPublicApiAllowed: false,
  voiceBindings: {},
};
const TTS_ROW = {
  tenantId: 'tnt-1',
  routingEn: ['azure'],
  routingMl: ['sarvam'],
  allowedProviders: ['azure', 'sarvam'],
  sarvamPublicApiAllowed: false,
  version: 0,
};
const TTS_CATALOG = { providers: [{ provider: 'azure', slug: 'azure', name: 'Azure', voices: [{ id: 'en-female-1', locale: 'en', name: 'Aria' }] }] };

interface RecordedCall {
  url: string;
  method: string;
}

interface StubOptions {
  session?: typeof TENANT_SESSION;
  permissions?: PermissionRule[];
  effectiveFails?: boolean;
}

function stubFetch({ session = TENANT_SESSION, permissions = ALL, effectiveFails }: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const raw = String(input);
      calls.push({ url: raw, method });
      if (raw === '/api/auth/session') return Response.json(session);
      if (raw === '/api/hope/users/me/permission-checks') return Response.json({ userId: 'u-1', tenantId: 'tnt-1', permissions });

      const url = new URL(raw, 'http://test.local');
      const path = url.pathname;

      // --- Models tab (AiTaskDefault) ---
      if (method === 'GET' && path === '/api/hope/admin/ai-task-defaults/row') {
        const taskKey = url.searchParams.get('taskKey') as string;
        return Response.json({ tenantId: 'tnt-1', taskKey, modelSlug: null, version: 0 });
      }
      if (method === 'GET' && path === '/api/hope/admin/ai-task-defaults/options') return Response.json([taskModelOption()]);
      if (method === 'GET' && path === '/api/hope/admin/ai-task-defaults') {
        if (effectiveFails) return new Response('boom', { status: 500 });
        const taskKey = url.searchParams.get('taskKey');
        if (taskKey) return Response.json(effectiveOf(taskKey, null));
        return Response.json(AI_TASK_KEYS.map((key) => effectiveOf(key)));
      }
      if (method === 'GET' && path === '/api/hope/admin/harness/policy') return Response.json(harnessPolicySummary());

      // --- Speech tab (TenantSttConfig) ---
      if (method === 'GET' && path === '/api/hope/admin/stt-config') return Response.json(STT_EFFECTIVE);
      if (method === 'GET' && path === '/api/hope/admin/stt-config/row') return Response.json(STT_ROW);
      if (method === 'GET' && path === '/api/hope/admin/stt-config/fallback-candidates') return Response.json([]);

      // --- Voice tab (TenantTtsConfig) ---
      if (method === 'GET' && path === '/api/hope/admin/tts-config') return Response.json(TTS_EFFECTIVE);
      if (method === 'GET' && path === '/api/hope/admin/tts-config/row') return Response.json(TTS_ROW);
      if (method === 'GET' && path === '/api/hope/admin/tts-config/catalog') return Response.json(TTS_CATALOG);

      // --- Providers tab (unified provider plane) ---
      if (method === 'GET' && path.startsWith('/api/hope/admin/providers/')) {
        const provider = path.split('/').pop() as string;
        return Response.json({ tenantId: 'tnt-1', provider, hasKey: false, keyVersion: null, enabled: false, version: 0 });
      }

      throw new Error(`Unhandled fetch: ${method} ${raw}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TenantAiConfigurationScreen — hub structure', () => {
  it('renders all four tab triggers for a tenant admin with full abilities', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'AI Configuration' })).toBeDefined();
    expect(await screen.findByRole('tab', { name: 'Models' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Speech' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Voice' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Providers' })).toBeDefined();
  });

  it('no longer exposes the retired standalone surfaces (no "Cloud credentials" tab, no /ai-providers deep link)', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    await screen.findByRole('tab', { name: 'Models' });
    expect(screen.queryByRole('tab', { name: /cloud credentials/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /manage credentials in ai providers/i })).toBeNull();
  });
});

describe('TenantAiConfigurationScreen — Models tab (default)', () => {
  it('shows the tenant-editable text-generation cards plus the read-only effective models table', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    // Editable text-generation cards (primary + test bench + fallback).
    for (const key of [...TEXT_PRIMARY_TASK_KEYS, ...TEXT_TEST_TASK_KEYS, ...TEXT_FALLBACK_TASK_KEYS]) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    // Read-only effective rows for the platform-managed keys.
    for (const key of READ_ONLY_TASK_KEYS) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    // If-Match save per editable text-generation card
    // (2 primary + 1 test bench + 2 fallback).
    expect((await screen.findAllByRole('button', { name: /save .* if-match/i })).length).toBe(5);
  });

  it('surfaces an error state with retry when the effective read fails', async () => {
    stubFetch({ effectiveFails: true });
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — Speech / Voice / Providers tabs', () => {
  it('renders the STT fallback editor on the Speech tab', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=speech' });

    expect(await screen.findByRole('heading', { name: /Tenant STT fallback editor/i })).toBeDefined();
  });

  it('renders the TTS config editor on the Voice tab', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=voice' });

    expect(await screen.findByRole('heading', { name: /Tenant TTS config editor/i })).toBeDefined();
  });

  it('renders the LLM/STT/TTS service sub-tabs on the Providers tab', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=providers' });

    expect(await screen.findByRole('tab', { name: 'LLM' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'STT' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'TTS' })).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — per-tab ability gating', () => {
  it('shows only the tab(s) whose resource the caller can read', async () => {
    stubFetch({ permissions: [{ action: 'read', subject: 'TenantSttConfig' }] });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=speech' });

    expect(await screen.findByRole('tab', { name: 'Speech' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Models' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Voice' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Providers' })).toBeNull();
  });
});

describe('TenantAiConfigurationScreen — tenant scoping', () => {
  it('pins the "Acting on" banner for an elevated session with a working tenant', async () => {
    stubFetch({ session: ELEVATED_WITH_TENANT_SESSION });
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByText(/Sunrise Medical Group/)).toBeDefined();
  });

  it('gates an elevated session without a working tenant on the NoTenant empty state', async () => {
    stubFetch({ session: ELEVATED_NO_TENANT_SESSION });
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — accessibility', () => {
  it.each([
    ['models', ''],
    ['speech', '?tab=speech'],
    ['voice', '?tab=voice'],
    ['providers', '?tab=providers'],
  ])('has no axe violations on the %s tab (light theme)', async (_label, searchParams) => {
    stubFetch();
    const { container } = renderWithProviders(<TenantAiConfigurationScreen />, { searchParams });

    await screen.findByRole('heading', { level: 1, name: 'AI Configuration' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<TenantAiConfigurationScreen />);
      await screen.findByRole('heading', { level: 1, name: 'AI Configuration' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
