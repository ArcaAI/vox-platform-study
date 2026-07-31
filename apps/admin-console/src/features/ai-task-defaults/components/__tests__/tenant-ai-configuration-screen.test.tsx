/**
 * Tenant "AI Configuration" screen (tier 30-49, /ai-configuration).
 *
 * Replaces the dead-end EmptyState with three tabs:
 *   - "Effective models" (default): read-only resolution of the guardrail/nlp/
 *     harness task keys, each with its winning cascade tier. No pickers — the
 *     global-admin-only write posture is untouched.
 *   - "SMR models" (TASK-588): tenant-editable primary + optional fallback
 *     summarization selection via `TaskDefaultCard`, CLS-pinned + OCC.
 *   - "Cloud credentials": BYO Azure/Bedrock write-only key cards over the
 * `admin/providers/llm` routes, with OCC (If-Match) on save.
 *
 * §5 tests: loading skeletons, populated table, SMR editable cards, credential
 * Configured/None cards, error+retry, axe 0 violations per tab in BOTH themes,
 * the working-tenant gate + "Acting on" banner, and the OCC conflict path.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { AI_TASK_KEYS, READ_ONLY_TASK_KEYS, SMR_FALLBACK_TASK_KEYS, SMR_PRIMARY_TASK_KEYS } from '../../api/types';
import type { EffectiveAiTaskDefault, TaskModelOption } from '../../api/types';
import type { ProviderConnection } from '../../api/providers-types';
import { LLM_BYO_PROVIDERS } from '../byo-credential-summary';
import { TenantAiConfigurationScreen } from '../tenant-ai-configuration-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

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
  user: { id: 'u-9', username: 'global_admin', email: 'root@arca.ai', roles: ['GLOBAL_ADMIN'] },
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
    safetyProvider: 'azure',
    safetyModel: 'content-safety',
    smrProvider: null,
    smrModel: null,
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

function connectionOf(provider: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    tenantId: 'tnt-1',
    provider,
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    hasKey: false,
    keyVersion: null,
    enabled: false,
    extraJson: null,
    version: 0,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface StubOptions {
  session?: typeof TENANT_SESSION;
  connections?: Record<string, ProviderConnection>;
  effectiveFails?: boolean;
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = TENANT_SESSION, connections = {}, effectiveFails, custom }: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handled = custom?.(call);
      if (handled) return handled;
      if (call.url === '/api/auth/session') return Response.json(session);

      const url = new URL(call.url, 'http://test.local');
      // Editable-card reads (SMR tab): raw row (no ETag → version 0 create path).
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/row') {
        const taskKey = url.searchParams.get('taskKey') as string;
        return Response.json({ tenantId: 'tnt-1', taskKey, modelSlug: null, version: 0 });
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/options') {
        return Response.json([taskModelOption()]);
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults') {
        if (effectiveFails) return new Response('boom', { status: 500 });
        // Single-key read (?taskKey=) returns one object; the all-keys read an array.
        const taskKey = url.searchParams.get('taskKey');
        if (taskKey) return Response.json(effectiveOf(taskKey, null));
        return Response.json(AI_TASK_KEYS.map((key) => effectiveOf(key)));
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/harness/policy') {
        return Response.json(harnessPolicySummary());
      }
      // Unified plane (TASK-572): the console reads LLM credentials at
      // `admin/providers/llm/:provider`.
      if (call.method === 'GET' && url.pathname.startsWith('/api/hope/admin/providers/llm/')) {
        const provider = url.pathname.split('/').pop() as string;
        const row = connections[provider] ?? connectionOf(provider);
        return Response.json(row, { headers: row.version > 0 ? { etag: `"${row.version}"` } : {} });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TenantAiConfigurationScreen — effective models tab', () => {
  it('renders a read-only row for every global-managed (guardrail/nlp/harness) task key, and none of the SMR keys', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'AI Configuration' })).toBeDefined();
    for (const key of READ_ONLY_TASK_KEYS) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    // SMR moved to its own editable tab (TASK-588) — not shown in the read-only table.
    expect(READ_ONLY_TASK_KEYS.some((key) => key.startsWith('smr.'))).toBe(false);
    expect(screen.queryByText('smr.live')).toBeNull();
    expect(screen.queryByText('smr.finalize')).toBeNull();
    expect((await screen.findAllByText('system')).length).toBe(READ_ONLY_TASK_KEYS.length);
  });

  it('is read-only — no model pickers or save controls on the effective tab (guardrail/nlp/harness write-lock untouched)', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    await screen.findByText(READ_ONLY_TASK_KEYS[0]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('also renders the read-only effective HarnessPolicy summary (TASK-547 OD-2) with a deep link to its owning editor', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByText('Entity faithfulness threshold')).toBeDefined();
    const link = screen.getByRole('link', { name: /edit tenant-controlled values/i });
    expect(link.getAttribute('href')).toBe('/harness/policy');
  });

  it('shows skeletons (not a spinner) while the effective read is in flight', () => {
    stubFetch();
    const { container } = renderWithProviders(<TenantAiConfigurationScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status', { name: /loading/i })).toBeNull();
  });

  it('surfaces an error state with retry when the effective read fails', async () => {
    stubFetch({ effectiveFails: true });
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — cloud credentials tab (read-only summary, TASK-592)', () => {
  it('renders a masked Configured/None status summary and exposes no editor or key material', async () => {
    stubFetch({
      connections: {
        azure: connectionOf('azure', { hasKey: true, keyVersion: 4, enabled: true, version: 3, baseUrl: 'https://acme.openai.azure.com' }),
      },
    });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

    for (const { label } of LLM_BYO_PROVIDERS) {
      expect(await screen.findByText(label)).toBeDefined();
    }
    expect(await screen.findByText(/configured · v4/i)).toBeDefined();
    // Every provider EXCEPT the configured azure reads "not configured".
    expect((await screen.findAllByText('not configured')).length).toBe(LLM_BYO_PROVIDERS.length - 1);

    // Read-only: no write-only key inputs and no save/rotate/remove controls.
    expect(document.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(screen.queryByRole('button', { name: /save key|rotate key|remove/i })).toBeNull();
  });

  it('deep-links to the one authoritative editor at /ai-providers (rule 13 dedup)', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

    const link = await screen.findByRole('link', { name: /manage credentials in ai providers/i });
    expect(link.getAttribute('href')).toBe('/ai-providers');
  });

  it('does not pin the "Acting on" banner — the credentials tab no longer mutates', async () => {
    stubFetch({ session: ELEVATED_WITH_TENANT_SESSION });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });

    await screen.findByRole('link', { name: /manage credentials in ai providers/i });
    expect(screen.queryByText(/Sunrise Medical Group/)).toBeNull();
  });
});

describe('TenantAiConfigurationScreen — SMR models tab (TASK-588)', () => {
  it('renders the four tenant-editable SMR cards, each with a model picker and an OCC save', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=smr' });

    // One editable card per SMR key (primary + fallback).
    for (const key of [...SMR_PRIMARY_TASK_KEYS, ...SMR_FALLBACK_TASK_KEYS]) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    // Editable, unlike the read-only effective table: a picker + an If-Match save per card,
    // plus the default-control's 2 pickers (primary + fallback) at the top (TASK-592).
    expect((await screen.findAllByRole('combobox')).length).toBe(6);
    expect((await screen.findAllByRole('button', { name: /save .* if-match/i })).length).toBe(4);
  });

  it('renders the platform-managed text-gen read-only summary below the editable cards (TASK-592)', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=smr' });

    expect(await screen.findByRole('heading', { name: /Platform-managed text generation/i })).toBeDefined();
    // Locked keys shown read-only, controlled by global admins.
    expect(await screen.findByText('guardrail.safety')).toBeDefined();
    expect((await screen.findAllByText('global admin')).length).toBe(READ_ONLY_TASK_KEYS.length);
  });

  it('labels the fallback cards as optional / used when the primary fails', async () => {
    stubFetch();
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=smr' });

    expect(await screen.findByText(/Fallback models/i)).toBeDefined();
    expect(await screen.findByText(/an empty fallback means no fallback provider runs/i)).toBeDefined();
    // Each fallback card names the "primary provider fails" trigger.
    expect((await screen.findAllByText(/when the primary .* provider fails/i)).length).toBe(SMR_FALLBACK_TASK_KEYS.length);
  });

  it('pins the "Acting on" banner (the SMR tab mutates tenant data)', async () => {
    stubFetch({ session: ELEVATED_WITH_TENANT_SESSION });
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=smr' });

    expect(await screen.findByText(/Sunrise Medical Group/)).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — tenant scoping', () => {
  it('gates an elevated session without a working tenant on the NoTenant empty state', async () => {
    stubFetch({ session: ELEVATED_NO_TENANT_SESSION });
    renderWithProviders(<TenantAiConfigurationScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });

  it('shows the "Acting on" banner for an elevated session with a working tenant', async () => {
    stubFetch({ session: ELEVATED_WITH_TENANT_SESSION });
    // The SMR tab mutates tenant data, so it pins the banner (credentials is read-only now).
    renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=smr' });

    expect(await screen.findByText(/Sunrise Medical Group/)).toBeDefined();
  });
});

describe('TenantAiConfigurationScreen — accessibility', () => {
  it.each([
    ['effective models', ''],
    ['smr models', '?tab=smr'],
    ['cloud credentials', '?tab=credentials'],
  ])('has no axe violations on the %s tab (light theme)', async (_label, searchParams) => {
    stubFetch({ connections: { azure: connectionOf('azure', { hasKey: true, enabled: true, version: 3 }) } });
    const { container } = renderWithProviders(<TenantAiConfigurationScreen />, { searchParams });

    await screen.findByRole('heading', { level: 1, name: 'AI Configuration' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch();
      const { container } = renderWithProviders(<TenantAiConfigurationScreen />, { searchParams: '?tab=credentials' });
      await screen.findByRole('heading', { level: 1, name: 'AI Configuration' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
