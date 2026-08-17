/**
 * `PromptTemplatePicker` (TASK-719 Task 19) — the Studio's node inspector gets a *picker* over
 * the tenant's prompt templates (never a second editor — design.md: "prompt templates keep
 * their own authoritative editor (picker + deep link)"), plus a plain `href` deep link to
 * `/prompt-templates`. Reads `admin/prompt-templates` directly — no cross-feature import
 * (rule 13 §Structure).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PromptTemplatePicker } from '../prompt-template-picker';

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: [{ id: 't-1', name: 'Discharge summary' }, { id: 't-2', name: 'Progress note' }], count: 2 })),
  );
}

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('PromptTemplatePicker', () => {
  it('renders a visible label and a plain deep link to /prompt-templates', async () => {
    stubFetch();
    renderWithProviders(<PromptTemplatePicker id="p1" label="Prompt template" value="" onChange={vi.fn()} />);
    expect(screen.getByText('Prompt template')).toBeTruthy();
    const link = (await screen.findByRole('link', { name: /manage prompt templates/i })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/prompt-templates');
  });

  it('shows a Skeleton while the catalog loads, never a spinner', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // never resolves
    const { container } = renderWithProviders(<PromptTemplatePicker id="p1" label="Prompt template" value="" onChange={vi.fn()} />);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it('lists the tenant catalog and selecting an option calls onChange with its id', async () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<PromptTemplatePicker id="p1" label="Prompt template" value="" onChange={onChange} />);

    const trigger = await screen.findByLabelText('Prompt template');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Discharge summary' })).toBeTruthy());
    const listbox = screen.getByRole('listbox');
    // Radix `SelectItem` only treats `pointerUp` as a selection when a prior `pointerDown` on
    // the SAME item set its own (item-scoped) pointerType ref to "mouse"; a plain synthetic
    // `click` — jsdom never dispatches real pointer events for one — hits the item's `onClick`
    // branch instead, which fires for any NON-mouse pointer type (its default). Both are real
    // Radix-supported activation paths (mouse pointerup vs. touch/keyboard click); `click` is the
    // one that survives jsdom's lack of a full pointer-event pipeline.
    fireEvent.click(within(listbox).getByRole('option', { name: 'Discharge summary' }));

    expect(onChange).toHaveBeenCalledWith('t-1');
  });

  it('marks required with * and renders server errors via FieldError', async () => {
    stubFetch();
    renderWithProviders(<PromptTemplatePicker id="p1" label="Prompt template" value="" onChange={vi.fn()} required errors={['unknown template id']} />);
    expect(screen.getByText(/^Prompt template/).textContent).toContain('*');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('unknown template id'));
  });

  it('0 axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<PromptTemplatePicker id="p1" label="Prompt template" value="t-1" onChange={vi.fn()} />);
    await screen.findByRole('link', { name: /manage prompt templates/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
