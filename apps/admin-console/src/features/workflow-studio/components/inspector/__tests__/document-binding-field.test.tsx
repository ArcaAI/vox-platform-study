/**
 * DD-2's document binding as a REAL control (TASK-810 §7b item 2).
 *
 * Before this, `documentTemplateId` and `documentVersionNumber` reached the inspector as two
 * generated schema fields: a free-text UUID box and a bare number box. An admin could not see
 * which templates exist, could not tell whether their pin was behind, and could typo a UUID
 * into a published clinical graph.
 *
 * The staleness treatment deliberately mirrors `PromptBindingsRail` (DD-11), including the
 * part that is easy to get wrong: an UNPINNED node is NOT flagged. It is following the
 * template on purpose. Badging it would put a permanent warning on a correct configuration and
 * teach admins to ignore the badge that does mean something.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { DocumentBindingField } from '../document-binding-field';

const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    name: 'Discharge Summary',
    slug: 'discharge_summary',
    status: 'PUBLISHED',
    pinnedVersionNumber: 3,
    isDefault: true,
    ...overrides,
  };
}

function version(versionNumber: number) {
  return { versionNumber, createdAt: '2026-08-01T00:00:00.000Z', changeReason: null };
}

function stubCatalog(templates: unknown[], versions: unknown[] = [version(3), version(2), version(1)]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => (String(input).includes('/versions') ? Response.json(versions) : Response.json(templates))),
  );
}

function render(config: Record<string, unknown>, onConfigChange = vi.fn()) {
  return { onConfigChange, ...renderWithProviders(<DocumentBindingField idPrefix="n1" config={config} onConfigChange={onConfigChange} />) };
}

async function openSelect(label: string | RegExp) {
  const trigger = await screen.findByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return screen.findByRole('listbox');
}

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('DocumentBindingField — the picker', () => {
  it('shows a Skeleton while the catalog loads, never a spinner', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = render({});
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it('offers only SERVABLE templates — a DRAFT one and a never-published one are not bindable', async () => {
    stubCatalog([
      template(),
      template({ id: OTHER_ID, name: 'Draft Note', status: 'DRAFT', pinnedVersionNumber: 2, isDefault: false }),
      template({ id: 'never-published', name: 'Unpublished Note', status: 'PUBLISHED', pinnedVersionNumber: null, isDefault: false }),
    ]);
    render({});

    const listbox = await openSelect('Document template');
    expect(within(listbox).getByRole('option', { name: /Discharge Summary/ })).toBeTruthy();
    expect(within(listbox).queryByRole('option', { name: /Draft Note/ })).toBeNull();
    expect(within(listbox).queryByRole('option', { name: /Unpublished Note/ })).toBeNull();
  });

  it('selecting a template writes documentTemplateId and NO version pin', async () => {
    stubCatalog([template()]);
    const { onConfigChange } = render({ taskKey: 'text.finalize' });

    const listbox = await openSelect('Document template');
    fireEvent.click(within(listbox).getByRole('option', { name: /Discharge Summary/ }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    expect(onConfigChange.mock.calls.at(-1)?.[0]).toEqual({ taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID });
  });

  it('clearing the template removes BOTH keys — no orphan pin is left behind', async () => {
    stubCatalog([template()]);
    const { onConfigChange } = render({ taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID, documentVersionNumber: 3 });

    const listbox = await openSelect('Document template');
    fireEvent.click(within(listbox).getByRole('option', { name: /Tenant default/ }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    expect(onConfigChange.mock.calls.at(-1)?.[0]).toEqual({ taskKey: 'text.finalize' });
  });

  it('keeps a bound template that is no longer in the catalog visible, and says so, instead of blanking it', async () => {
    stubCatalog([template({ id: OTHER_ID, name: 'Something Else' })]);
    render({ documentTemplateId: TEMPLATE_ID });

    expect(await screen.findByText(/not in this tenant’s document-template catalog/i)).toBeTruthy();
    // The id itself stays on screen — an admin cannot fix what they cannot see.
    expect(screen.getAllByText(new RegExp(TEMPLATE_ID)).length).toBeGreaterThan(0);
  });

  it('deep-links to the authoritative editor rather than editing templates here', async () => {
    stubCatalog([template()]);
    render({});
    const link = (await screen.findByRole('link', { name: /manage document templates/i })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/document-templates');
  });
});

describe('DocumentBindingField — the three pin states', () => {
  it('UNPINNED reads as “follows the template” and is NOT flagged', async () => {
    stubCatalog([template({ pinnedVersionNumber: 5 })]);
    render({ documentTemplateId: TEMPLATE_ID });

    // Both the Select trigger and the status line say it — assert the status line, which is the
    // one an admin reads without opening anything.
    expect(await screen.findByText(/Follows the template — currently v5/)).toBeTruthy();
    expect(screen.queryByText(/available/i)).toBeNull();
    expect(screen.queryByText(/rolled back/i)).toBeNull();
  });

  it('PINNED AND CURRENT reports the pin quietly, with no badge', async () => {
    stubCatalog([template({ pinnedVersionNumber: 3 })]);
    render({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 3 });

    expect(await screen.findByText(/Pinned to v3/)).toBeTruthy();
    expect(screen.queryByText(/available/i)).toBeNull();
  });

  it('PINNED BUT BEHIND names the newer version in TEXT, never colour alone', async () => {
    stubCatalog([template({ pinnedVersionNumber: 5 })], [version(5), version(4), version(3)]);
    render({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 3 });

    expect(await screen.findByText('New v5 available')).toBeTruthy();
  });

  it('a pin ABOVE the template’s own pin is reported as a rollback, not as “new version available”', async () => {
    stubCatalog([template({ pinnedVersionNumber: 2 })], [version(3), version(2), version(1)]);
    render({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 3 });

    expect(await screen.findByText(/rolled back to v2/i)).toBeTruthy();
    expect(screen.queryByText(/available/i)).toBeNull();
  });
});

describe('DocumentBindingField — pinning writes only what the admin chose', () => {
  it('choosing a version writes that integer', async () => {
    stubCatalog([template({ pinnedVersionNumber: 3 })]);
    const { onConfigChange } = render({ documentTemplateId: TEMPLATE_ID });

    const listbox = await openSelect(/Pinned document version/);
    fireEvent.click(within(listbox).getByRole('option', { name: /^v2/ }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    expect(onConfigChange.mock.calls.at(-1)?.[0]).toEqual({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 2 });
  });

  it('choosing “follows the template” REMOVES the key — it never writes 0', async () => {
    stubCatalog([template({ pinnedVersionNumber: 3 })]);
    const { onConfigChange } = render({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 2 });

    const listbox = await openSelect(/Pinned document version/);
    fireEvent.click(within(listbox).getByRole('option', { name: /Follows the template/ }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const emitted = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(emitted, 'documentVersionNumber')).toBe(false);
    expect(emitted).toEqual({ documentTemplateId: TEMPLATE_ID });
  });

  it('offers no version control at all until a template is bound — a pin onto nothing is not authorable', async () => {
    stubCatalog([template()]);
    render({});
    await screen.findByLabelText('Document template');
    expect(screen.queryByLabelText(/Pinned document version/)).toBeNull();
  });
});

describe('DocumentBindingField — the empty catalog is a normal state', () => {
  it('says what is being generated today and points at the catalog, as a status and not an error', async () => {
    stubCatalog([]);
    render({});

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/platform SOAP/i);
    expect(banner.textContent).toMatch(/Subjective, Objective, Assessment, Plan/);
    // `Alert` hardcodes role="alert" (assertive, interrupts on mount). A standing description of
    // current state must be polite — WCAG 4.1.3.
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await screen.findByRole('link', { name: /manage document templates/i })).getAttribute('href')).toBe('/document-templates');
  });

  it('treats “templates exist but none is servable” the same way — there is still nothing to bind', async () => {
    stubCatalog([template({ status: 'DRAFT' })]);
    render({});
    expect((await screen.findByRole('status')).textContent).toMatch(/platform SOAP/i);
  });
});

describe('DocumentBindingField — accessibility', () => {
  it('0 axe violations in the light theme, with a stale pin on screen', async () => {
    stubCatalog([template({ pinnedVersionNumber: 5 })], [version(5), version(3)]);
    const { container } = render({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 3 });
    await screen.findByText('New v5 available');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('0 axe violations in the dark theme, on the empty-catalog state', async () => {
    document.documentElement.classList.add('dark');
    stubCatalog([]);
    const { container } = render({});
    await screen.findByRole('status');
    expect(await axe(container)).toHaveNoViolations();
  });
});
