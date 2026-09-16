/**
 * `ContextSchemaRefField` — `core.trigger`'s `config.contextSchema` binding (TASK-890 §3.4).
 * Replaces the generic renderer's raw-json `inline` box + free-text `contextSchemaId` UUID box
 * + bare `versionNumber` number box with: a reference-vs-inline radio, a Select over the
 * TENANT's own context schemas (`@/shared/catalog`), and a version pin ("Follow latest" vs a
 * specific published version).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ContextSchemaRefField } from '../context-schema-ref-field';

function stubFetch(impl?: (url: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (impl) return Response.json(impl(url));
      if (url.includes('/versions')) return Response.json([{ versionNumber: 2 }, { versionNumber: 1 }]);
      return Response.json([
        {
          id: 'schema-1',
          slug: 'consultation-legacy-v1',
          name: 'Consultation (legacy v1)',
          status: 'PUBLISHED',
          pinnedVersionNumber: 1,
          isDefault: true,
        },
        { id: 'schema-2', slug: 'intake-v2', name: 'Intake v2', status: 'PUBLISHED', pinnedVersionNumber: 3, isDefault: false },
      ]);
    }),
  );
}

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function openSelect(label: string | RegExp) {
  const trigger = await screen.findByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return screen.findByRole('listbox');
}

describe('ContextSchemaRefField', () => {
  it('defaults to the reference mode radio on a fresh node', () => {
    stubFetch();
    renderWithProviders(<ContextSchemaRefField idPrefix="n1" config={{}} onConfigChange={vi.fn()} />);
    expect((screen.getByRole('radio', { name: /reference/i }) as HTMLInputElement).getAttribute('data-state')).toBe('checked');
  });

  /**
   * Wave-3 close — a FAILED version read must not be indistinguishable from "this schema has no
   * other versions". Both render only "Follow latest"; only one of them means the author can
   * safely leave the pin alone.
   */
  it('says the version list failed rather than rendering as though there were nothing to pin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/versions')) return new Response('boom', { status: 500 });
        return Response.json([
          {
            id: 'schema-1',
            slug: 'consultation-legacy-v1',
            name: 'Consultation (legacy v1)',
            status: 'PUBLISHED',
            pinnedVersionNumber: 1,
            isDefault: true,
          },
        ]);
      }),
    );
    renderWithProviders(<ContextSchemaRefField idPrefix="n1" config={{ contextSchema: { contextSchemaId: 'schema-1' } }} onConfigChange={vi.fn()} />);
    expect(await screen.findByText(/version list could not be loaded/i)).toBeDefined();
  });

  it('lists the tenant`s own schemas and writes contextSchemaId on selection', async () => {
    stubFetch();
    const onConfigChange = vi.fn();
    renderWithProviders(<ContextSchemaRefField idPrefix="n1" config={{}} onConfigChange={onConfigChange} />);

    const listbox = await openSelect(/context schema/i);
    fireEvent.click(within(listbox).getByRole('option', { name: /Intake v2/ }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalledWith({ contextSchema: { contextSchemaId: 'schema-2' } }));
  });

  it('offers "Follow latest" vs a specific published version once a schema is referenced', async () => {
    stubFetch();
    renderWithProviders(<ContextSchemaRefField idPrefix="n1" config={{ contextSchema: { contextSchemaId: 'schema-1' } }} onConfigChange={vi.fn()} />);
    expect(await screen.findByText(/whichever version is pinned under Context Schemas/i)).toBeTruthy();
    const listbox = await openSelect(/version/i);
    expect(within(listbox).getByRole('option', { name: /^Follow latest/ })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: 'v2' })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: 'v1' })).toBeTruthy();
  });

  /**
   * The helper text is the whole contract an author reads before choosing. It
   * used to say a republish of the SCHEMA "changes what this trigger accepts",
   * which was true of the intent and false of the runtime — the pin was resolved
   * at COMPILE time. Both sentences now say when the change takes effect and
   * what has to happen for it to.
   */
  it('says, for follow-latest, that a new pin takes effect with no republish — naming the current pin', async () => {
    stubFetch();
    renderWithProviders(<ContextSchemaRefField idPrefix="n1" config={{ contextSchema: { contextSchemaId: 'schema-1' } }} onConfigChange={vi.fn()} />);

    expect(
      await screen.findByText(
        'This trigger uses whichever version is pinned under Context Schemas — currently v1. Publishing and pinning a new version takes effect here immediately, with no republish.',
      ),
    ).toBeTruthy();
  });

  it('says, for a pinned version, that only republishing THIS workflow moves it', async () => {
    stubFetch();
    renderWithProviders(
      <ContextSchemaRefField idPrefix="n1" config={{ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }} onConfigChange={vi.fn()} />,
    );

    expect(
      await screen.findByText('This trigger always validates against v2, whatever the schema is pinned to. Republish this workflow to move it.'),
    ).toBeTruthy();
  });

  it('pinning a specific version writes versionNumber', async () => {
    stubFetch();
    const onConfigChange = vi.fn();
    renderWithProviders(
      <ContextSchemaRefField idPrefix="n1" config={{ contextSchema: { contextSchemaId: 'schema-1' } }} onConfigChange={onConfigChange} />,
    );
    const listbox = await openSelect(/version/i);
    fireEvent.click(within(listbox).getByRole('option', { name: 'v2' }));
    await waitFor(() => expect(onConfigChange).toHaveBeenCalledWith({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }));
  });

  it('switching the radio to inline clears the reference and hands the schema field back to a plain JSON editor', async () => {
    stubFetch();
    const onConfigChange = vi.fn();
    renderWithProviders(
      <ContextSchemaRefField idPrefix="n1" config={{ contextSchema: { contextSchemaId: 'schema-1' } }} onConfigChange={onConfigChange} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /inline/i }));
    expect(onConfigChange).toHaveBeenCalledWith({ contextSchema: { inline: {} } });
  });

  it('0 axe violations in reference mode', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ContextSchemaRefField idPrefix="n1" config={{}} onConfigChange={vi.fn()} />);
    await screen.findByLabelText(/context schema/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('0 axe violations in the dark theme, with a schema referenced and a version pinned', async () => {
    document.documentElement.classList.add('dark');
    stubFetch();
    const { container } = renderWithProviders(
      <ContextSchemaRefField idPrefix="n1" config={{ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 2 } }} onConfigChange={vi.fn()} />,
    );
    await screen.findByLabelText(/version/i);
    expect(await axe(container)).toHaveNoViolations();
    document.documentElement.classList.remove('dark');
  });
});
