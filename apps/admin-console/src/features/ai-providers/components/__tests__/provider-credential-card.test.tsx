/**
 * TASK-932 M4 — a destructive confirmation must not silently drop focus.
 *
 * "Reset to default" and "Use platform default" both swap their own trigger
 * button for an inline confirmation row. Before this fix the trigger unmounted
 * and nothing claimed focus, so it fell back to `<body>` — invisible to a
 * screen-reader user and to anyone tabbing through the card. The fix wraps the
 * row in `role="alertdialog"` + `aria-live="assertive"` (so it is announced)
 * and moves focus onto Cancel (never the destructive action) as it mounts.
 *
 * TASK-952 — what the card SENDS, which nothing covered before and which is
 * where the blank-extras 400 and the extras wipe both lived. The second
 * describe block below pins the PUT body itself.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderCredentialCard } from '../provider-credential-card';
import type { ProviderMeta } from '../provider-meta';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const META: ProviderMeta = {
  id: 'azure',
  label: 'Azure OpenAI',
  fields: [{ name: 'baseUrl', label: 'Endpoint', placeholder: 'https://<resource>.openai.azure.com' }],
};

const BUILT_IN_META: ProviderMeta = {
  id: 'lm-studio',
  label: 'LM Studio',
  providerClass: 'engine-served',
  fields: [{ name: 'baseUrl', label: 'Endpoint', placeholder: 'http://hope-lmstudio:1234/v1' }],
};

/** A card whose ONLY field writes into `extraJson` — the `stt:sarvam` shape. */
const EXTRA_FIELD_META: ProviderMeta = {
  id: 'sarvam',
  label: 'Sarvam',
  fields: [{ name: 'model', label: 'Model (optional)', placeholder: 'saaras:v4', store: 'extra' }],
};

/** The same card once Lane B removes its only field — `fields` is EMPTY. */
const NO_FIELDS_META: ProviderMeta = {
  id: 'sarvam',
  label: 'Sarvam',
  fields: [],
};

function row(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tnt-1',
    service: 'llm',
    provider: 'azure',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    hasKey: false,
    keyVersion: null,
    enabled: false,
    extraJson: null,
    maxConcurrent: null,
    rpmLimit: null,
    tpmLimit: null,
    timeoutS: null,
    version: 0,
    ...over,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET' };
      if (typeof init?.body === 'string') call.body = JSON.parse(init.body);
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

function renderCard(ui: Parameters<typeof ProviderCredentialCard>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<ProviderCredentialCard {...ui} />, { wrapper: Wrapper });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProviderCredentialCard — destructive confirmation focus (M4)', () => {
  it('"Reset to default": moves focus onto Cancel and announces the row, instead of dropping focus to <body>', async () => {
    stubFetch((call) => {
      if (call.url.includes('/admin/providers/llm/lm-studio')) {
        return Response.json(row({ service: 'llm', provider: 'lm-studio', baseUrl: 'http://hope-lmstudio:1234/v1', enabled: true, hasKey: true, version: 3 }), {
          headers: { etag: '"3"' },
        });
      }
      return undefined;
    });
    renderCard({ service: 'llm', meta: BUILT_IN_META, tenantId: '00000000-0000-0000-0000-000000000000', tier: 'platform', resettable: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Reset LM Studio to its built-in default' }));

    const alertdialog = screen.getByRole('alertdialog');
    expect(alertdialog.getAttribute('aria-live')).toBe('assertive');
    const cancel = within(alertdialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('"Use platform default" (remove): moves focus onto Cancel and announces the row, instead of dropping focus to <body>', async () => {
    stubFetch((call) => {
      if (call.url.includes('/admin/providers/llm/azure')) {
        return Response.json(row({ hasKey: true, enabled: true, version: 2 }), { headers: { etag: '"2"' } });
      }
      return undefined;
    });
    renderCard({ service: 'llm', meta: META, tenantId: 'tnt-1', tier: 'tenant', resettable: false });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove the Azure OpenAI connection (use platform default)' }));

    const alertdialog = screen.getByRole('alertdialog');
    expect(alertdialog.getAttribute('aria-live')).toBe('assertive');
    const cancel = within(alertdialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(document.body);
  });
});

/**
 * TASK-952 D-2 / D-2b / D-6 — `extraJson` is not a column, and the card used to
 * write it like one: a blank field became `null` (a 400 from
 * `validateProviderExtras`), the whole envelope was rebuilt from the card's
 * field list (wiping any stored key without a field), and it was omitted when
 * empty (so the last value could never be cleared).
 */
describe('ProviderCredentialCard — the extras envelope it PUTs', () => {
  /** Renders a saved row for `meta`, returns the recorded calls and the Save button. */
  async function mountSavedRow(meta: ProviderMeta, over: Record<string, unknown> = {}) {
    const calls = stubFetch((call) => {
      if (!call.url.includes(`/admin/providers/stt/${meta.id}`)) return undefined;
      const data = row({ service: 'stt', provider: meta.id, hasKey: true, enabled: true, version: 2, ...over });
      return Response.json(data, { headers: { etag: '"2"' } });
    });
    renderCard({ service: 'stt', meta, tenantId: 'tnt-1', tier: 'tenant' });
    const save = await screen.findByRole('button', { name: `Save for ${meta.label} · If-Match` });
    return { calls, save };
  }

  async function putBody(calls: RecordedCall[]): Promise<Record<string, unknown>> {
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    return calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
  }

  it('omits a BLANK extras key rather than sending null (the reported 400)', async () => {
    const { calls, save } = await mountSavedRow(EXTRA_FIELD_META, { extraJson: null });

    fireEvent.click(save);

    const body = await putBody(calls);
    expect(body.extraJson).toEqual({});
    expect(Object.hasOwn(body.extraJson as object, 'model')).toBe(false);
  });

  it('sends a FILLED extras key as its trimmed string', async () => {
    const { calls, save } = await mountSavedRow(EXTRA_FIELD_META, { extraJson: null });

    fireEvent.change(screen.getByLabelText('Model (optional)'), { target: { value: '  saaras:v4  ' } });
    fireEvent.click(save);

    expect((await putBody(calls)).extraJson).toEqual({ model: 'saaras:v4' });
  });

  it('preserves a STORED extras key the card has no field for (the S3 inheritsPlatformStorage wipe)', async () => {
    const { calls, save } = await mountSavedRow(EXTRA_FIELD_META, {
      extraJson: { inheritsPlatformStorage: true, model: 'saaras:v4' },
    });

    fireEvent.click(save);

    expect((await putBody(calls)).extraJson).toEqual({ inheritsPlatformStorage: true, model: 'saaras:v4' });
  });

  it('still sends extraJson when every extras field is blanked, so the stored value CLEARS', async () => {
    const { calls, save } = await mountSavedRow(EXTRA_FIELD_META, { extraJson: { model: 'saaras:v4' } });

    fireEvent.change(screen.getByLabelText('Model (optional)'), { target: { value: '' } });
    fireEvent.click(save);

    const body = await putBody(calls);
    // Present (an OMITTED extraJson leaves the stored value untouched) and empty.
    expect(Object.hasOwn(body, 'extraJson')).toBe(true);
    expect(body.extraJson).toEqual({});
  });

  it('omits extraJson entirely for a provider that declares no extras field', async () => {
    const { calls, save } = await mountSavedRow(META, { extraJson: { leftAlone: true } });

    fireEvent.click(save);

    const body = await putBody(calls);
    expect(Object.hasOwn(body, 'extraJson')).toBe(false);
    expect(body.baseUrl).toBeNull();
  });

  it('renders a card whose fields list is EMPTY with no stray field row', async () => {
    await mountSavedRow(NO_FIELDS_META);

    expect(screen.queryByLabelText('Model (optional)')).toBeNull();
    // The rest of the card is intact: key input, ceilings, enabled switch.
    expect(screen.getByLabelText(/API key/)).toBeTruthy();
    expect(screen.getByText('Ceilings (blank = no opinion)')).toBeTruthy();
    // No stray field row: the only text inputs left are the four ceilings (the
    // key input is a password, so it is not a textbox).
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
  });
});

/** TASK-952 D-3 — the models editor is invisible until the row exists; say so. */
describe('ProviderCredentialCard — unsaved BYO row signposts the models step', () => {
  function mountRow(version: number) {
    stubFetch((call) => {
      if (!call.url.includes('/admin/providers/stt/sarvam')) return undefined;
      return Response.json(row({ service: 'stt', provider: 'sarvam', hasKey: version > 0, enabled: version > 0, version }), {
        headers: { etag: `"${version}"` },
      });
    });
    renderCard({ service: 'stt', meta: EXTRA_FIELD_META, tenantId: 'tnt-1', tier: 'tenant' });
  }

  it('shows the hint on an unsaved row (version 0) of a declarable service', async () => {
    mountRow(0);

    expect(await screen.findByText('The models this connection serves are declared here once the credential is saved.')).toBeTruthy();
    expect(screen.queryByText('Models this connection serves')).toBeNull();
  });

  it('replaces the hint with the models editor once the row exists', async () => {
    mountRow(2);

    expect(await screen.findByText('Models this connection serves')).toBeTruthy();
    expect(screen.queryByText('The models this connection serves are declared here once the credential is saved.')).toBeNull();
  });
});

/**
 * TASK-958 (review) — what the card sends, and what it says back, once a
 * provider can hold more than one connection.
 *
 * Two facts the gateway cannot infer on its own:
 *
 *  - **an UNSAVED row has no vendor to read.** `:slug` is the only hint the
 *    probe route gets, and for a named sibling the slug is not a provider id at
 *    all — so the probe must name the vendor the card is FOR.
 *  - **`CONNECTION_DEFAULT_REQUIRED` is guidance, not a toast.** A provider has
 *    exactly one default; you MOVE it, you do not clear it. The action that
 *    unblocks it is on this very group, so the refusal stays on screen beside
 *    the control that produced it — the same treatment `CONNECTION_IS_DEFAULT`
 *    already gets on remove.
 */
describe('ProviderCredentialCard — the probe names the vendor on an unsaved row (958)', () => {
  function mount(version: number, slug?: string) {
    const calls = stubFetch((call) => {
      if (!call.url.includes(`/admin/providers/llm/${slug ?? META.id}`)) return undefined;
      if (call.method === 'POST') return Response.json({ ok: true, message: 'Connected', probe: 'auth', source: 'request' });
      return Response.json(row({ service: 'llm', provider: 'azure', slug: slug ?? META.id, hasKey: version > 0, enabled: version > 0, version }), {
        headers: { etag: `"${version}"` },
      });
    });
    renderCard({ service: 'llm', meta: META, slug, tenantId: 'tnt-1', tier: 'tenant' });
    return calls;
  }

  async function probeBody(calls: RecordedCall[]): Promise<Record<string, unknown>> {
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    return calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
  }

  it('sends `provider` when the row does not exist yet', async () => {
    const calls = mount(0);

    const key = await screen.findByLabelText(/API key/);
    fireEvent.change(key, { target: { value: 'sk-probe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test the Azure OpenAI connection' }));

    expect(await probeBody(calls)).toMatchObject({ provider: 'azure', apiKey: 'sk-probe' });
  });

  it('omits `provider` once the row is stored — the row already says which vendor it is', async () => {
    const calls = mount(2);

    await screen.findByLabelText(/API key/);
    fireEvent.click(screen.getByRole('button', { name: 'Test the Azure OpenAI connection' }));

    expect(Object.hasOwn(await probeBody(calls), 'provider')).toBe(false);
  });
});

describe('ProviderCredentialCard — CONNECTION_DEFAULT_REQUIRED is in-place guidance (958)', () => {
  it('keeps the refusal on screen beside the control, rather than in a toast that vanishes', async () => {
    stubFetch((call) => {
      if (!call.url.includes('/admin/providers/llm/azure-research')) return undefined;
      if (call.method === 'PUT') {
        return Response.json(
          { statusCode: 400, code: 'CONNECTION_DEFAULT_REQUIRED', message: 'A provider always has exactly one default connection.' },
          { status: 400 },
        );
      }
      return Response.json(row({ service: 'llm', provider: 'azure', slug: 'azure-research', isDefault: false, hasKey: true, enabled: true, version: 2 }), {
        headers: { etag: '"2"' },
      });
    });
    renderCard({ service: 'llm', meta: META, slug: 'azure-research', connectionName: 'Research', tenantId: 'tnt-1', tier: 'tenant', canMakeDefault: true });

    const flip = await screen.findByRole('button', { name: /Make .* the default Azure OpenAI connection/ });
    fireEvent.click(flip);

    const alert = await screen.findByText(/A provider always has exactly one default connection\./);
    expect(alert).toBeDefined();
    expect(alert.textContent).toMatch(/Elect another connection/i);
  });
});
