/**
 * `PromptTemplatePicker` (workflow-studio) — TASK-890 turned this from a hand-rolled picker with
 * a static `/prompt-templates` link into a THIN WRAPPER over the shared `<PromptTemplatePicker>`
 * (`@/shared/prompt-picker`), the same component the agents form (L5) renders. This file no
 * longer re-tests the picker's own behavior (options list, quick view, axe — all covered by
 * `shared/prompt-picker/__tests__/prompt-template-picker.test.tsx`); it pins only the
 * delegation contract this wrapper is responsible for:
 *   - the inspector renders the SHARED component (not a second implementation)
 *   - the deep link targets `/prompt-templates?template=<id>`, not the old static
 *     `/prompt-templates` (RED before this ticket)
 *   - the `string` <-> `string | null` value adaptation round-trips
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PromptTemplatePicker } from '../prompt-template-picker';

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: [{ id: 't-1', name: 'Discharge summary', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 2, currentVersionNumber: 2 }], count: 1, limit: 200, page: 1 })),
  );
}

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('PromptTemplatePicker (workflow-studio wrapper)', () => {
  it('renders the shared picker, labelled "Prompt template"', async () => {
    stubFetch();
    renderWithProviders(<PromptTemplatePicker id="p1" value="" onChange={vi.fn()} />);
    expect(await screen.findByText('Prompt template')).toBeTruthy();
  });

  it('the deep link targets /prompt-templates?template=<id>, once a template is selected — RED before TASK-890 (was a static /prompt-templates href)', async () => {
    stubFetch();
    renderWithProviders(<PromptTemplatePicker id="p1" value="t-1" onChange={vi.fn()} />);
    const link = (await screen.findByRole('link', { name: /open in prompt templates/i })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/prompt-templates?template=t-1');
  });

  it('adapts the shared component`s null "no selection" to an empty string for the config value contract', async () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<PromptTemplatePicker id="p1" value="" onChange={onChange} />);

    const trigger = await screen.findByLabelText('Prompt template');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /Discharge summary/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('t-1'));
  });

  it('passes disabled and errors through to the shared component', async () => {
    stubFetch();
    renderWithProviders(<PromptTemplatePicker id="p1" value="" onChange={vi.fn()} disabled errors={['unknown template id']} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('unknown template id'));
  });
});
