/**
 * Screen tests for the two AI task-default surfaces:
 *  - the PLATFORM screen (tier 10-19) editing the SYSTEM-tenant rows for all
 *    three task keys (guardrail card labeled global-admin-only),
 *  - the TENANT screen (tier 30-49) editing the NLP keys only (guardrail is
 *    deliberately absent per the owner governance directive).
 * URL-branching fetch stub per the feature-api test pattern.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { AiTaskDefaultRow, AiTaskKey, EffectiveAiTaskDefault, TaskModelOption } from '../../api/types';
import { SYSTEM_TENANT_ID } from '../../api/types';
import { AiTaskDefaultsPlatformScreen } from '../ai-task-defaults-platform-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/** Open a Radix Select trigger and pick an option by its visible label (happy-dom pointer path). */
async function selectOption(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const option = await screen.findByRole('option', { name: optionName });
  fireEvent.pointerUp(option, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(option);
}

function model(overrides: Partial<TaskModelOption> & Pick<TaskModelOption, 'id' | 'slug' | 'name' | 'taskType'>): TaskModelOption {
  return {
    provider: 'lm-studio',
    architecture: null,
    format: 'GGUF',
    sourceUri: overrides.slug,
    resourceStatus: 'ENABLED',
    ...overrides,
  };
}

// widened AI_TASK_KEYS 3 -> 9 to match the backend. The platform
// screen still edits only the three keys below (the remaining six are covered
// by the tenant read-only view); this fixture stays deliberately partial.
const OPTIONS: Partial<Record<AiTaskKey, TaskModelOption[]>> = {
  'guardrail.validate': [
    model({ id: 'm-guard-1', slug: 'granite-guardian-4.1-8b', name: 'Granite Guardian 4.1 8B', taskType: 'GUARDRAIL', architecture: 'granite' }),
    model({ id: 'm-guard-2', slug: 'llama-guard-4', name: 'Llama Guard 4', taskType: 'GUARDRAIL' }),
  ],
  'nlp.ner': [model({ id: 'm-ner-1', slug: 'medical-ner', name: 'Medical NER', taskType: 'TOKEN_CLASSIFICATION', provider: 'built-in' })],
  'nlp.classification': [
    model({ id: 'm-cls-1', slug: 'symps-disease-bert-v3-c41', name: 'Symps Disease BERT', taskType: 'TEXT_CLASSIFICATION', provider: 'built-in' }),
  ],
};

function effectiveOf(taskKey: AiTaskKey, tenantId: string, overrides: Partial<EffectiveAiTaskDefault> = {}): EffectiveAiTaskDefault {
  const first = OPTIONS[taskKey]![0];
  return {
    tenantId,
    taskKey,
    modelSlug: first.slug,
    source: 'system',
    configJson: null,
    model: {
      id: first.id,
      slug: first.slug,
      name: first.name,
      provider: first.provider ?? null,
      architecture: first.architecture ?? null,
      taskType: first.taskType,
      format: first.format,
      sourceUri: first.sourceUri,
    },
    ...overrides,
  };
}

function rowOf(taskKey: AiTaskKey, tenantId: string, overrides: Partial<AiTaskDefaultRow> = {}): AiTaskDefaultRow {
  return {
    tenantId,
    taskKey,
    modelSlug: OPTIONS[taskKey]![0].slug,
    configJson: null,
    version: 3,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

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

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface StubOptions {
  session?: typeof TENANT_SESSION;
  rows?: Partial<Record<AiTaskKey, AiTaskDefaultRow>>;
  /** Tenant id echoed into effective/row payloads (defaults per-request from the URL). */
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = TENANT_SESSION, rows = {}, custom }: StubOptions = {}): RecordedCall[] {
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
      const taskKey = url.searchParams.get('taskKey') as AiTaskKey | null;
      const tenantId = url.searchParams.get('tenantId') ?? 'tnt-1';
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults' && taskKey) {
        return Response.json(effectiveOf(taskKey, tenantId));
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/options' && taskKey) {
        return Response.json(OPTIONS[taskKey] ?? []);
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/row' && taskKey) {
        const row = rows[taskKey] ?? rowOf(taskKey, tenantId);
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

describe('AiTaskDefaultsPlatformScreen', () => {
  it('renders one card per task key, all scoped to the SYSTEM tenant', async () => {
    const calls = stubFetch();
    renderWithProviders(<AiTaskDefaultsPlatformScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'AI task defaults (platform)' })).toBeDefined();
    // TASK-735 Phase 0 (2026-08-16): the guardrail card no longer claims
    // "platform-controlled (global admins only)" — guardrail is now
    // tenant-configurable via the API. This card still edits the SYSTEM
    // (platform-default) row, so its title reflects that instead. Wait on
    // the card's own heading (renders only once its data has loaded) rather
    // than the always-present page-header text, so the assertion still
    // synchronizes with the async card render.
    expect(await screen.findByRole('heading', { name: /guardrail model/i })).toBeDefined();
    expect(screen.getByText(/platform-approved catalog/i)).toBeDefined();
    expect(screen.getByRole('heading', { name: /medical ner/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /classification/i })).toBeDefined();

    await screen.findAllByText('Granite Guardian 4.1 8B');
    // effective + row reads are SYSTEM-scoped; /options takes no tenantId (CLS + shared-read widening).
    const scopedCalls = calls.filter((call) => call.url.startsWith('/api/hope/admin/ai-task-defaults') && !call.url.includes('/options'));
    expect(scopedCalls.length).toBeGreaterThan(0);
    for (const call of scopedCalls) {
      expect(call.url).toContain(`tenantId=${SYSTEM_TENANT_ID}`);
    }
  });

  it('shows the effective model with its source badge', async () => {
    stubFetch();
    renderWithProviders(<AiTaskDefaultsPlatformScreen />);

    expect((await screen.findAllByText('Granite Guardian 4.1 8B')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('system').length).toBeGreaterThanOrEqual(3);
  });

  it('saves a new platform default with If-Match from the row read', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT') {
          return Response.json(rowOf('guardrail.validate', SYSTEM_TENANT_ID, { modelSlug: 'llama-guard-4', version: 4 }), {
            headers: { etag: '"4"' },
          });
        }
        return undefined;
      },
    });
    renderWithProviders(<AiTaskDefaultsPlatformScreen />);

    const trigger = await screen.findByRole('combobox', { name: /default model for guardrail.validate/i });
    await selectOption(trigger, /Llama Guard 4/);
    fireEvent.click(screen.getByRole('button', { name: /save guardrail.validate default/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe(`/api/hope/admin/ai-task-defaults/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`);
    expect(put?.headers.get('if-match')).toBe('"3"');
    expect(put?.body).toEqual({ modelSlug: 'llama-guard-4', expectedVersion: 3 });
  });

  it('surfaces the OCC conflict alert with reload when the PUT returns 412', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'PUT') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
        return undefined;
      },
    });
    renderWithProviders(<AiTaskDefaultsPlatformScreen />);

    const trigger = await screen.findByRole('combobox', { name: /default model for guardrail.validate/i });
    await selectOption(trigger, /Llama Guard 4/);
    fireEvent.click(screen.getByRole('button', { name: /save guardrail.validate default/i }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
  });
});

// =============================================================================
// The platform screen links out to the AI-models hub
// =============================================================================
describe('AiTaskDefaultsPlatformScreen — Manage models link', () => {
  it('links "Manage models" to /ai-models', async () => {
    stubFetch();
    renderWithProviders(<AiTaskDefaultsPlatformScreen />);

    const link = await screen.findByRole('link', { name: /manage models/i });
    expect(link.getAttribute('href')).toBe('/ai-models');
  });
});
