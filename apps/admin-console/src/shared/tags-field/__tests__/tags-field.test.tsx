/**
 * TASK-1036 R1 — `TagsField`: the one console tag editor. Chips + a combobox over
 * GET admin/prompt-templates/tags, free entry, grammar message, keyboard.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { axe } from 'vitest-axe';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { TagsField } from '../tags-field';
import { validateTag } from '../tag-grammar';

const SUGGESTIONS = [
  { tag: 'text-v1', count: 4 },
  { tag: 'pre-summary', count: 2 },
  { tag: 'dept:cardiology', count: 1 },
];

function stubFetch(suggestions = SUGGESTIONS) {
  const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json(suggestions));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Harness({ initial = [], onChange }: { initial?: string[]; onChange?: (next: string[]) => void }) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <TagsField
      id="t"
      value={tags}
      onChange={(next) => {
        setTags(next);
        onChange?.(next);
      }}
    />
  );
}

const input = () => screen.getByRole('combobox', { name: /tags/i }) as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('validateTag', () => {
  it('accepts behavioural and key:value tags, rejects the rest', () => {
    for (const ok of ['pre-summary', 'text-v1', 'dept-free', 'dept:cardiology', 'tier:v2.1']) expect(validateTag(ok)).toBeNull();
    for (const bad of ['Bad Tag', 'UPPER', 'a:b:c', 'dept:', '-x']) expect(validateTag(bad)).toMatch(/lower-case/i);
  });
});

describe('TagsField', () => {
  it('renders existing tags as chips with remove buttons', () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={['text-v1', 'soap']} onChange={onChange} />);

    expect(screen.getByText('text-v1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag text-v1' }));
    expect(onChange).toHaveBeenCalledWith(['soap']);
  });

  it('shows ranked suggestions from the endpoint when opened, excluding chips already added', async () => {
    const fetchMock = stubFetch();
    renderWithProviders(<Harness initial={['text-v1']} />);

    fireEvent.focus(input());
    press('ArrowDown');

    expect(await screen.findByRole('option', { name: /pre-summary/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /dept:cardiology/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /text-v1/ })).toBeNull();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/hope/admin/prompt-templates/tags');
  });

  it('debounces typing into one q-filtered request', async () => {
    const fetchMock = stubFetch();
    renderWithProviders(<Harness />);

    type('d');
    type('de');
    type('dept');

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('q=dept'))).toBe(true));
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('q=de&') || String(call[0]).endsWith('q=de'))).toBe(false);
  });

  it('adds a suggestion with the keyboard (ArrowDown, Enter)', async () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);

    fireEvent.focus(input());
    press('ArrowDown');
    await screen.findByRole('option', { name: /text-v1/ });
    press('Enter');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['text-v1']));
  });

  it('accepts a free-entry tag with Enter and clears the draft', async () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);

    type('brand-new');
    press('Enter');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['brand-new']));
    expect(input().value).toBe('');
  });

  it('commits a comma-separated paste as several tags', async () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);

    type('a-tag,dept:renal');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['a-tag', 'dept:renal']));
  });

  it('refuses an invalid tag and says what the grammar is', async () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);

    type('Bad Tag');
    expect((await screen.findByRole('alert')).textContent).toMatch(/lower-case/i);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    press('Enter');

    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('Bad Tag');
  });

  it('does not add a duplicate', async () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={['soap']} onChange={onChange} />);

    type('soap');
    press('Enter');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('Backspace on an empty draft removes the last chip', () => {
    stubFetch();
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={['a', 'b']} onChange={onChange} />);

    press('Backspace');

    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<Harness initial={['text-v1']} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('TagsField — E4b chip removal', () => {
  it('gives the remove (×) control a pointer target of at least 24×24 px (WCAG 2.5.8)', () => {
    stubFetch();
    renderWithProviders(<Harness initial={['a-1']} />);
    const remove = screen.getByRole('button', { name: 'Remove tag a-1' });
    expect(remove.className).toMatch(/\bsize-6\b/);
  });

  it('moves focus to the next chip after removing one, to the previous when the last goes, and to the input when none are left', async () => {
    stubFetch();
    renderWithProviders(<Harness initial={['a-1', 'b-2', 'c-3']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag b-2' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag c-3' })));
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag c-3' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag a-1' })));
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag a-1' }));
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });
});
