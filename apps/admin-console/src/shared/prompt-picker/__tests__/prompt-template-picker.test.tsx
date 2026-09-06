/**
 * `<PromptTemplatePicker>` — the ONE shared prompt-template picker (TASK-890
 * REQ-6, §4.1 L4). Both consumers (agents form, Studio inspector) render this
 * component rather than hand-rolling their own picker.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PromptTemplatePicker } from '../prompt-template-picker';
import type { PromptPickerTemplate } from '../types';

function template(overrides: Partial<PromptPickerTemplate> = {}): PromptPickerTemplate {
  return {
    id: 'tpl-1',
    name: 'SOAP Summary',
    status: 'APPROVED',
    category: 'SUMMARY',
    approvedVersionNumber: 3,
    currentVersionNumber: 3,
    contentPreview: 'You are a clinical assistant...',
    declaredVariables: [
      { name: 'topic', type: 'string', required: true },
      { name: 'depth', type: 'string', required: false },
    ],
    ...overrides,
  };
}

function stubList(templates: PromptPickerTemplate[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: templates, count: templates.length, limit: 200, page: 1 })),
  );
}

function renderPicker(value: string | null, onChange = vi.fn(), extra: Record<string, unknown> = {}) {
  return { onChange, ...renderWithProviders(<PromptTemplatePicker id="prompt" value={value} onChange={onChange} {...extra} />) };
}

async function openSelect(label: string | RegExp) {
  const trigger = await screen.findByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return screen.findByRole('listbox');
}

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('PromptTemplatePicker — the picker', () => {
  it('shows a Skeleton while the list loads, never a spinner', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const { container } = renderPicker(null);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it('falls back to an id box when the list is unavailable, keeping the value editable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const onChange = vi.fn();
    renderPicker('', onChange);
    const box = await screen.findByLabelText(/prompt template id/i);
    fireEvent.change(box, { target: { value: 'tpl-x' } });
    expect(onChange).toHaveBeenCalledWith('tpl-x');
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });

  it('lists the tenant’s templates and reports the chosen id', async () => {
    stubList([template(), template({ id: 'tpl-2', name: 'Cardiology Note' })]);
    const onChange = vi.fn();
    renderPicker(null, onChange);

    const listbox = await openSelect('Prompt template');
    fireEvent.click(within(listbox).getByRole('option', { name: /Cardiology Note/ }));
    expect(onChange).toHaveBeenCalledWith('tpl-2');
  });

  /**
   * J3-6 — the field says "Approved prompt template" and the agent publish gate REFUSES a
   * template that is not APPROVED (`TEMPLATE_NOT_APPROVED`), so offering drafts here invites the
   * author to pick something that cannot be published and only tells them three steps later.
   *
   * A draft is not hidden, it is opted into: a template being drafted right now is a legitimate
   * thing to bind while both are in flight, and the quick view already says "not approved".
   */
  it('offers only APPROVED templates by default — a draft cannot be published on an agent', async () => {
    stubList([template(), template({ id: 'tpl-2', name: 'Cardiology Note', status: 'DRAFT', approvedVersionNumber: null })]);
    renderPicker(null);

    const listbox = await openSelect('Prompt template');
    expect(within(listbox).getByRole('option', { name: /SOAP Summary/ })).toBeTruthy();
    expect(within(listbox).queryByRole('option', { name: /Cardiology Note/ })).toBeNull();
  });

  it('includes drafts when the author asks for them', async () => {
    stubList([template(), template({ id: 'tpl-2', name: 'Cardiology Note', status: 'DRAFT', approvedVersionNumber: null })]);
    const onChange = vi.fn();
    renderPicker(null, onChange);

    fireEvent.click(await screen.findByLabelText(/include drafts/i));
    const listbox = await openSelect('Prompt template');
    fireEvent.click(within(listbox).getByRole('option', { name: /Cardiology Note/ }));
    expect(onChange).toHaveBeenCalledWith('tpl-2');
  });

  it('never orphans an already-bound DRAFT — the current selection is always listed', async () => {
    stubList([template(), template({ id: 'tpl-2', name: 'Cardiology Note', status: 'DRAFT', approvedVersionNumber: null })]);
    renderPicker('tpl-2');

    // The quick view resolves (the bound row is found in the full list, not the narrowed one)…
    expect(await screen.findByText('Cardiology Note')).toBeTruthy();
    // …and the option is present, so re-opening the select does not silently clear the binding.
    const listbox = await openSelect('Prompt template');
    expect(within(listbox).getByRole('option', { name: /Cardiology Note/ })).toBeTruthy();
  });

  it('keeps a row whose status it cannot read — unknown is not a verdict', async () => {
    // A server that grows or renames a status must not empty the picker.
    stubList([{ ...template({ id: 'tpl-3', name: 'Unlabelled' }), status: undefined as never }]);
    renderPicker(null);

    const listbox = await openSelect('Prompt template');
    expect(within(listbox).getByRole('option', { name: /Unlabelled/ })).toBeTruthy();
    expect(screen.queryByLabelText(/include drafts/i)).toBeNull();
  });

  /**
   * TASK-890 J2 — the department axis is moving from `PromptTemplate.departmentId`
   * onto `dept:<slug>` TAGS, so an agent author has to be able to find "the
   * cardiology prompt" in a tenant library of 45. The list read already returns
   * `tags`; this narrows the options client-side (the picker loads the whole
   * library in one page, so the filter is exact, not a page-local guess).
   */
  it('narrows the template options by tag, leaving the selected value resolvable', async () => {
    stubList([
      template({ id: 'tpl-1', name: 'SOAP Summary', tags: ['pre-summary', 'text-v1'] }),
      template({ id: 'tpl-2', name: 'Cardiology Note', tags: ['dept:cardiology'] }),
    ]);
    renderPicker('tpl-1');

    const tagList = await openSelect('Filter by tag');
    fireEvent.click(within(tagList).getByRole('option', { name: 'dept:cardiology' }));

    const listbox = await openSelect('Prompt template');
    expect(within(listbox).queryByRole('option', { name: /SOAP Summary/ })).toBeNull();
    expect(within(listbox).getByRole('option', { name: /Cardiology Note/ })).toBeTruthy();
    // The already-selected template stays resolvable even though it is filtered out.
    expect(screen.getByTestId('prompt-template-quick-view')).toBeTruthy();
  });

  it('offers no tag filter when the library carries no tags', async () => {
    stubList([template({ tags: [] })]);
    renderPicker(null);

    await screen.findByLabelText('Prompt template');
    expect(screen.queryByLabelText('Filter by tag')).toBeNull();
  });

  it('shows the selected template’s tags in the quick view', async () => {
    stubList([template({ tags: ['pre-summary', 'dept:cardiology'] })]);
    renderPicker('tpl-1');

    const quickView = within(await screen.findByTestId('prompt-template-quick-view'));
    expect(quickView.getByText('dept:cardiology')).toBeTruthy();
  });

  it('renders the quick view once a template is selected: status, approval pin, variable chips, preview, and the deep link', async () => {
    stubList([template()]);
    renderPicker('tpl-1');

    const quickView = within(await screen.findByTestId('prompt-template-quick-view'));
    expect(quickView.getByText('Approved')).toBeTruthy();
    expect(quickView.getByText(/serving v3/i)).toBeTruthy();
    expect(quickView.getByText('topic')).toBeTruthy();
    expect(quickView.getByText('depth?')).toBeTruthy();
    expect(quickView.getByText(/You are a clinical assistant/)).toBeTruthy();
    const link = quickView.getByRole('link', { name: /open in prompt templates/i });
    expect(link.getAttribute('href')).toBe('/prompt-templates?template=tpl-1');
  });

  it('shows "not approved" when the template has never been approved', async () => {
    stubList([template({ approvedVersionNumber: null, status: 'DRAFT' })]);
    renderPicker('tpl-1');
    const quickView = within(await screen.findByTestId('prompt-template-quick-view'));
    expect(quickView.getByText('not approved')).toBeTruthy();
  });

  it('reports the resolved quick-view record via onTemplateChange, once, on initial resolution', async () => {
    stubList([template()]);
    const onTemplateChange = vi.fn();
    renderPicker('tpl-1', vi.fn(), { onTemplateChange });
    await screen.findByTestId('prompt-template-quick-view');
    expect(onTemplateChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'tpl-1' }));
  });

  it('falls back to a direct read when the selected id is not in a filtered list', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tpl-1')) return Response.json(template({ id: 'tpl-1', name: 'Direct Read' }));
      return Response.json({ data: [template({ id: 'tpl-2' })], count: 1, limit: 200, page: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPicker('tpl-1');
    expect(await screen.findByText(/You are a clinical assistant/)).toBeTruthy();
  });
});

describe('PromptTemplatePicker — accessibility', () => {
  it('0 axe violations in the light theme, with a selected template on screen', async () => {
    stubList([template()]);
    const { container } = renderPicker('tpl-1');
    await screen.findByTestId('prompt-template-quick-view');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('0 axe violations in the dark theme, on the empty list fallback', async () => {
    document.documentElement.classList.add('dark');
    stubList([]);
    const { container } = renderPicker(null);
    await screen.findByLabelText(/prompt template id/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
