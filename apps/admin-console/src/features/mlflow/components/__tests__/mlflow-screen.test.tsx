/**
 * MLflow screen (tier 10-19).
 *
 * ─── The decision these tests lock in ───────────────────────────────────────
 *
 * "Embed the MLflow interface" cannot be an iframe, and the screen must SAY so
 * rather than ship a frame that silently renders nothing. Three independent
 * blockers, each sufficient alone:
 *
 *   1. MLflow sets `X-Frame-Options: SAMEORIGIN` on every response by default
 *      from 3.5.0 (`MLFLOW_SERVER_X_FRAME_OPTIONS`); the deployed image is
 *      3.15.2, so a browser refuses a console-origin frame.
 *   2. MLflow has no authentication of its own, and the console's httpOnly
 *      session cookie does not extend to another origin. The ruling fronts it
 *      with Cloudflare Access, whose IdP redirect cannot complete in a
 *      third-party frame.
 *   3. There is no browser-reachable URL at all — MLflow shipped without an
 *      Ingress.
 *
 * So the console renders MLflow's data NATIVELY through the gateway, and the
 * embed verdict is DERIVED FROM THE LIVE PROBE rather than hardcoded: the tests
 * below prove that an operator who clears blocker 1 and blocker 3 gets the
 * embed, with no code change.
 *
 * The second theme is that every listing shape is upstream-owned and optional,
 * so a payload missing fields must degrade rather than crash.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { MlflowExperimentsResponse, MlflowModelVersionsResponse, MlflowRegisteredModelsResponse, MlflowStatus } from '../../api/types';
import { MlflowScreen } from '../mlflow-screen';

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

/** Reachable in-cluster, frame-denied, no browser URL — the shipped posture. */
const STATUS_REACHABLE: MlflowStatus = {
  baseUrl: 'http://hope-mlflow.hope-v2-dev.svc:5000',
  uiUrl: null,
  reachable: true,
  probeStatus: 'ok',
  latencyMs: 18,
  version: '3.15.2',
  frameOptions: 'SAMEORIGIN',
  embeddable: false,
  embedBlockedReason:
    'MLflow answers with X-Frame-Options: SAMEORIGIN, so a browser refuses to render it inside the console. ' +
    'Clearing it means setting MLFLOW_SERVER_X_FRAME_OPTIONS=NONE on the MLflow deployment — an owner decision, not a console setting.',
};

/** Not deployed — the state on a stock cluster, since MLflow is an opt-in profile with no Ingress. */
const STATUS_UNREACHABLE: MlflowStatus = {
  baseUrl: 'http://hope-mlflow.hope-v2-dev.svc:5000',
  uiUrl: null,
  reachable: false,
  probeStatus: 'error',
  latencyMs: 5,
  error: 'The MLflow tracking server is temporarily unavailable. Please retry.',
  frameOptions: null,
  embeddable: false,
  embedBlockedReason: 'There is no browser-reachable MLflow URL configured (MLFLOW_UI_URL).',
};

/** Both blockers cleared by an operator: header off AND a public URL configured. */
const STATUS_EMBEDDABLE: MlflowStatus = {
  ...STATUS_REACHABLE,
  uiUrl: 'https://mlflow.example.test',
  frameOptions: null,
  embeddable: true,
  embedBlockedReason: null,
};

const REGISTERED_MODELS: MlflowRegisteredModelsResponse = {
  registered_models: [
    {
      name: 'medgemma-27b-gguf',
      description: 'Quantized clinical summarizer',
      last_updated_timestamp: '1756540800000',
      aliases: [{ alias: 'production', version: '4' }],
      tags: [{ key: 'format', value: 'gguf' }],
    },
    // Deliberately sparse: MLflow publishes no breaking-change policy, so a row
    // with almost nothing on it must still render.
    { name: 'whisper-large-v3' },
  ],
};

const MODEL_VERSIONS: MlflowModelVersionsResponse = {
  model_versions: [
    {
      name: 'medgemma-27b-gguf',
      version: '4',
      status: 'READY',
      source: 's3://hope-models/medgemma-27b/sha256-abc123/',
      aliases: ['production'],
      last_updated_timestamp: '1756540800000',
    },
    { name: 'medgemma-27b-gguf', version: '3', status: 'FAILED_REGISTRATION', status_message: 'checksum mismatch' },
  ],
};

const EXPERIMENTS: MlflowExperimentsResponse = {
  experiments: [
    { experiment_id: '1', name: 'summarization-eval', lifecycle_stage: 'active', last_update_time: '1756540800000' },
    { experiment_id: '2', name: 'Default', lifecycle_stage: 'active' },
  ],
};

interface StubOptions {
  status?: MlflowStatus;
  registeredModels?: MlflowRegisteredModelsResponse;
  modelVersions?: MlflowModelVersionsResponse;
  experiments?: MlflowExperimentsResponse;
  custom?: (call: { url: string; method: string }) => Response | undefined;
}

function stubFetch({
  status = STATUS_REACHABLE,
  registeredModels = REGISTERED_MODELS,
  modelVersions = MODEL_VERSIONS,
  experiments = EXPERIMENTS,
  custom,
}: StubOptions = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      const handled = custom?.(call);
      if (handled) return handled;
      if (call.url === '/api/auth/session') return Response.json(SESSION);
      const url = new URL(call.url, 'http://test');
      if (url.pathname === '/api/hope/admin/ai-services/mlflow/status') return Response.json(status);
      if (url.pathname === '/api/hope/admin/ai-services/mlflow/registered-models') return Response.json(registeredModels);
      if (url.pathname === '/api/hope/admin/ai-services/mlflow/model-versions') return Response.json(modelVersions);
      if (url.pathname === '/api/hope/admin/ai-services/mlflow/experiments') return Response.json(experiments);
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MlflowScreen — chrome', () => {
  it('renders one h1 and the four tabs', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'MLflow' })).toBeDefined();
    for (const name of [/Registered models/, /Model versions/, /Experiments/, /Access/]) {
      expect(screen.getByRole('tab', { name })).toBeDefined();
    }
    await screen.findByText('3.15.2');
  });

  it('shows content-shaped skeletons while the status read is in flight', () => {
    stubFetch();
    const { container } = renderWithProviders(<MlflowScreen />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });
});

describe('MlflowScreen — the embed verdict comes from the live probe', () => {
  it('never renders an iframe while the server frame-denies', async () => {
    stubFetch();
    const { container } = renderWithProviders(<MlflowScreen />, { searchParams: '?tab=access' });

    await screen.findByText(/X-Frame-Options: SAMEORIGIN/);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('shows the OBSERVED header value, so a changed deployment is visible rather than assumed', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=access' });

    const panel = await screen.findByRole('region', { name: 'Embedding the MLflow interface' });
    expect(within(panel).getByText('SAMEORIGIN')).toBeDefined();
  });

  it('states the second, independent blocker: MLflow has no authentication of its own', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=access' });

    expect(await screen.findByText(/no authentication of its own/)).toBeDefined();
  });

  it('offers no deep link when there is no browser-reachable URL', async () => {
    stubFetch({ status: STATUS_UNREACHABLE });
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=access' });

    await screen.findByText(/no browser-reachable MLflow URL/);
    expect(screen.queryByRole('link', { name: /Open MLflow/ })).toBeNull();
  });

  it('EMBEDS once the deployment clears both blockers — no code change required', async () => {
    stubFetch({ status: STATUS_EMBEDDABLE });
    const { container } = renderWithProviders(<MlflowScreen />, { searchParams: '?tab=access' });

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('https://mlflow.example.test');
    expect(frame.getAttribute('title')).toBeTruthy();
    // Untrusted-ish third-party origin in a frame: sandbox it and keep referrers off.
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('offers a new-tab deep link whenever a browser-reachable URL exists', async () => {
    stubFetch({ status: STATUS_EMBEDDABLE });
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=access' });

    const link = await screen.findByRole('link', { name: /Open MLflow/ });
    expect(link.getAttribute('href')).toBe('https://mlflow.example.test');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

describe('MlflowScreen — not deployed', () => {
  it('says so in a page-level banner instead of looking broken', async () => {
    stubFetch({ status: STATUS_UNREACHABLE });
    renderWithProviders(<MlflowScreen />);

    const banner = await screen.findByRole('status', { name: 'MLflow status' });
    expect(within(banner).getByText(/temporarily unavailable/)).toBeDefined();
    expect(within(banner).getByText(/no Ingress/)).toBeDefined();
  });

  it('does not fire the registry reads at a server the probe says is down', async () => {
    const calls = stubFetch({ status: STATUS_UNREACHABLE });
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=registered-models' });

    await screen.findByRole('status', { name: 'MLflow status' });
    await waitFor(() => expect(calls.some((c) => c.url.includes('/mlflow/status'))).toBe(true));
    expect(calls.some((c) => c.url.includes('/mlflow/registered-models'))).toBe(false);
  });

  it('gives the listing tabs an explicit unreachable empty state', async () => {
    stubFetch({ status: STATUS_UNREACHABLE });
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=registered-models' });

    expect(await screen.findByText('The tracking server did not answer')).toBeDefined();
  });
});

describe('MlflowScreen — registry listings', () => {
  it('lists registered models with their aliases', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=registered-models' });

    await screen.findByText('medgemma-27b-gguf');
    // The alias badge reads "production → v4": the alias alone is not the label.
    expect(screen.getByText(/production/)).toBeDefined();
    expect(screen.getByText('Quantized clinical summarizer')).toBeDefined();
  });

  it('renders a sparse upstream row without crashing', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=registered-models' });

    expect(await screen.findByText('whisper-large-v3')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists model versions with status and the weights source', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=model-versions' });

    await screen.findByText('s3://hope-models/medgemma-27b/sha256-abc123/');
    expect(screen.getByText('READY')).toBeDefined();
    expect(screen.getByText('FAILED_REGISTRATION')).toBeDefined();
    expect(screen.getByText('checksum mismatch')).toBeDefined();
  });

  it('lists experiments', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=experiments' });

    expect(await screen.findByText('summarization-eval')).toBeDefined();
  });

  it('renders an empty state when the registry holds nothing', async () => {
    stubFetch({ registeredModels: {} });
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=registered-models' });

    expect(await screen.findByText('No registered models')).toBeDefined();
  });

  it('surfaces a retryable error when a listing read fails', async () => {
    stubFetch({
      custom: (call) => {
        const url = new URL(call.url, 'http://test');
        if (url.pathname === '/api/hope/admin/ai-services/mlflow/experiments') {
          return Response.json({ message: 'MLflow returned an error.' }, { status: 400 });
        }
        return undefined;
      },
    });
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=experiments' });

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('MLflow returned an error.')).toBeDefined();
  });
});

describe('MlflowScreen — read-only', () => {
  it('offers no destructive control — erasure belongs to the gc CronJob', async () => {
    stubFetch();
    renderWithProviders(<MlflowScreen />, { searchParams: '?tab=model-versions' });

    await screen.findByText('READY');
    for (const name of [/delete/i, /archive/i, /transition/i, /promote/i, /register/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('refreshes on demand', async () => {
    const calls = stubFetch();
    renderWithProviders(<MlflowScreen />);
    await screen.findByText('3.15.2');
    const before = calls.filter((c) => c.url.includes('/mlflow/status')).length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(calls.filter((c) => c.url.includes('/mlflow/status')).length).toBeGreaterThan(before));
  });
});

describe('MlflowScreen — accessibility', () => {
  it('has no axe violations when MLflow is not deployed (the shipped state)', async () => {
    stubFetch({ status: STATUS_UNREACHABLE });
    const { container } = renderWithProviders(<MlflowScreen />);
    await screen.findByRole('status', { name: 'MLflow status' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the registry listing', async () => {
    stubFetch();
    const { container } = renderWithProviders(<MlflowScreen />, { searchParams: '?tab=registered-models' });
    await screen.findByText('medgemma-27b-gguf');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the Access tab, iframe included', async () => {
    stubFetch({ status: STATUS_EMBEDDABLE });
    const { container } = renderWithProviders(<MlflowScreen />, { searchParams: '?tab=access' });
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    // `iframes: false` is a HARNESS constraint, not a waived rule: axe tries to
    // post a message into the frame's window to audit it, and happy-dom's iframe
    // is not a real frame window ("Respondable target must be a frame in the
    // current window"). The frame ELEMENT itself — its accessible name, its
    // sandbox, its position in the document — is still audited here; what is
    // skipped is the third-party document inside it, which is MLflow's own page
    // and not this console's to fix.
    expect(await axe(container, { iframes: false })).toHaveNoViolations();
  });
});
